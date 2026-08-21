"""Tests for the large-fixture resolver (sambaeval/fixtures.py).

The object store is stubbed with an in-memory fake, so these run offline: they
assert the *decisions* — a warm cache costs no network call, a miss downloads
and atomically renames, a recorded digest is verified, and a fixture that
exists nowhere raises with the operator command needed to publish it.
"""

from __future__ import annotations

import hashlib
import os
from types import SimpleNamespace

import pytest

from sambaeval import fixtures


class FakeStore:
    """Stand-in for ``sambaeval.storage_s3`` holding objects in memory."""

    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.metadata: dict[str, dict] = {}
        self.head_calls: list[str] = []
        self.download_calls: list[str] = []

    def put(self, key: str, data: bytes, sha256: str | None = None):
        self.objects[key] = data
        self.metadata[key] = {"sha256": sha256} if sha256 else {}

    def head(self, key: str):
        self.head_calls.append(key)
        if key not in self.objects:
            return None
        return {
            "ContentLength": len(self.objects[key]),
            "Metadata": self.metadata.get(key, {}),
        }

    def download_file(self, key: str, local_path: str) -> str:
        self.download_calls.append(key)
        with open(local_path, "wb") as fh:
            fh.write(self.objects[key])
        return local_path


@pytest.fixture
def store(monkeypatch, tmp_path):
    fake = FakeStore()
    monkeypatch.setattr(fixtures, "storage_s3", fake)
    # Settings is a frozen dataclass, so point the module at a stand-in rather
    # than trying to mutate the real one.
    monkeypatch.setattr(
        fixtures,
        "settings",
        SimpleNamespace(fixture_cache_dir=str(tmp_path / "cache"), s3_bucket="test"),
    )
    return fake


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def test_key_and_cache_path_layout(store, tmp_path):
    assert fixtures.fixture_key("scicode/test_data.h5") == "fixtures/scicode/test_data.h5"
    # Leading slashes are tolerated and never escape the cache dir.
    assert fixtures.fixture_key("/scicode/x.h5") == "fixtures/scicode/x.h5"
    assert fixtures.cache_path("scicode/test_data.h5").startswith(
        str(tmp_path / "cache")
    )


def test_cache_miss_downloads_then_returns_path(store):
    payload = b"reference-data" * 100
    store.put("fixtures/scicode/test_data.h5", payload)

    path = fixtures.ensure_fixture("scicode/test_data.h5")

    assert os.path.isfile(path)
    assert open(path, "rb").read() == payload
    assert store.download_calls == ["fixtures/scicode/test_data.h5"]


def test_warm_cache_makes_no_network_call(store):
    store.put("fixtures/scicode/test_data.h5", b"payload")
    first = fixtures.ensure_fixture("scicode/test_data.h5")
    store.head_calls.clear()
    store.download_calls.clear()

    second = fixtures.ensure_fixture("scicode/test_data.h5")

    assert second == first
    # The fast path is a plain isfile() — no head, no re-download. This matters:
    # the real fixture is ~1 GB and is resolved once per run.
    assert store.head_calls == []
    assert store.download_calls == []


def test_recorded_digest_is_verified_on_download(store):
    payload = b"good-bytes"
    store.put("fixtures/scicode/test_data.h5", payload, sha256=_sha(payload))

    path = fixtures.ensure_fixture("scicode/test_data.h5")

    assert open(path, "rb").read() == payload


def test_corrupt_object_is_rejected_and_leaves_no_file(store):
    # Digest recorded at upload no longer matches the stored bytes.
    store.put("fixtures/scicode/test_data.h5", b"corrupted", sha256=_sha(b"original"))

    with pytest.raises(fixtures.FixtureUnavailable) as excinfo:
        fixtures.ensure_fixture("scicode/test_data.h5")

    assert "sha256" in str(excinfo.value)
    # The partial download must not be left behind as a usable cache entry.
    assert not os.path.exists(fixtures.cache_path("scicode/test_data.h5"))


def test_missing_everywhere_raises_with_the_publish_command(store):
    with pytest.raises(fixtures.FixtureUnavailable) as excinfo:
        fixtures.ensure_fixture("scicode/test_data.h5")

    msg = str(excinfo.value)
    assert "push-fixture" in msg
    assert "scicode/test_data.h5" in msg


def test_verify_re_downloads_a_locally_corrupted_cache(store):
    payload = b"good-bytes"
    store.put("fixtures/scicode/test_data.h5", payload, sha256=_sha(payload))
    path = fixtures.ensure_fixture("scicode/test_data.h5")

    # Simulate on-disk corruption (bad volume, truncated write).
    with open(path, "wb") as fh:
        fh.write(b"tampered")
    store.download_calls.clear()

    again = fixtures.ensure_fixture("scicode/test_data.h5", verify=True)

    assert open(again, "rb").read() == payload
    assert store.download_calls == ["fixtures/scicode/test_data.h5"]


def test_no_partial_files_remain_in_the_cache_dir(store):
    store.put("fixtures/scicode/test_data.h5", b"payload")
    fixtures.ensure_fixture("scicode/test_data.h5")

    cache_dir = os.path.dirname(fixtures.cache_path("scicode/test_data.h5"))
    leftovers = [n for n in os.listdir(cache_dir) if n.startswith(".partial-")]
    assert leftovers == []
