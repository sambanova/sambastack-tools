"""Large read-only benchmark fixtures, cached on local disk (prodplan §7a).

Some generators need a *file on disk* rather than a row in Postgres: SciCode
bind-mounts ``test_data.h5`` (~1 GB of reference outputs) read-only into every
sandbox container, and Spider needs ``chinook.db``. These are too large for the
database, are deliberately excluded from the seed bundle, and must never be
baked into an image.

The object store is the source of truth::

    s3://<bucket>/fixtures/scicode/test_data.h5

and this module is the bridge from that key to a local path:

  * an operator uploads once — ``sambaeval-seed push-fixture`` (see
    seed_bundle.py), which streams the file and records its sha256;
  * at run time :func:`ensure_fixture` returns a local path, downloading from
    the object store only on a cache miss.

The same code runs locally and in the cluster — only ``FIXTURE_CACHE_DIR``
differs (a directory on your Mac; a mounted volume in the worker pod). That is
deliberate: it removes the "download it by hand and set an env var" step that
otherwise only exists in local dev.
"""

from __future__ import annotations

import hashlib
import logging
import os
import tempfile
import threading

from . import storage_s3
from .config import settings

log = logging.getLogger(__name__)

FIXTURES_PREFIX = "fixtures"
_CHUNK = 1024 * 1024

# Serialises same-process racers (the executor's thread pool). Cross-process /
# cross-pod races are handled by downloading to a unique temp file and
# atomically renaming, so a partially written file is never observable.
_lock = threading.Lock()


class FixtureUnavailable(RuntimeError):
    """The fixture is neither cached locally nor present in the object store."""


def fixture_key(name: str) -> str:
    """Object key for a fixture, e.g. ``scicode/test_data.h5`` -> ``fixtures/…``."""
    return f"{FIXTURES_PREFIX}/{name.strip('/')}"


def cache_path(name: str) -> str:
    """Where ``name`` is cached locally (not a guarantee that it exists)."""
    return os.path.join(settings.fixture_cache_dir, name.strip("/").replace("/", os.sep))


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_fixture(name: str, *, verify: bool = False) -> str:
    """Return a local path to fixture ``name``, downloading it if needed.

    Fast path is a plain ``os.path.isfile`` — a warm cache costs no network
    call, which matters because SciCode asks for the fixture once per run and
    the file is ~1 GB. Pass ``verify=True`` to re-check the cached file's
    sha256 against the object's recorded digest (slow: it reads the whole file).

    Raises :class:`FixtureUnavailable` when the fixture is missing everywhere,
    with the operator command needed to publish it.
    """
    local = cache_path(name)
    key = fixture_key(name)

    if os.path.isfile(local) and not verify:
        return local

    with _lock:
        # Re-check under the lock: another thread may have just fetched it.
        if os.path.isfile(local):
            if not verify:
                return local
            expected = _recorded_sha256(key)
            if expected is None or sha256_file(local) == expected:
                return local
            log.warning("Fixture %s failed checksum verification; re-downloading", name)

        meta = storage_s3.head(key)
        if meta is None:
            raise FixtureUnavailable(
                f"fixture {name!r} is not cached at {local!r} and not present in "
                f"the object store at s3://{settings.s3_bucket}/{key}. Publish it "
                f"once with: sambaeval-seed push-fixture <local-file> --name {name}"
            )

        os.makedirs(os.path.dirname(local) or ".", exist_ok=True)
        size = meta.get("ContentLength") or 0
        log.info("Fetching fixture %s (%.1f MiB) from s3://%s/%s",
                 name, size / (1024 * 1024), settings.s3_bucket, key)

        # Download to a unique temp file in the destination directory, then
        # rename: os.replace is atomic within a filesystem, so a concurrent
        # reader (another pod on a shared volume) never sees a partial file.
        fd, tmp = tempfile.mkstemp(
            dir=os.path.dirname(local) or ".", prefix=".partial-"
        )
        os.close(fd)
        try:
            storage_s3.download_file(key, tmp)
            expected = (meta.get("Metadata") or {}).get("sha256")
            if expected:
                actual = sha256_file(tmp)
                if actual != expected:
                    raise FixtureUnavailable(
                        f"fixture {name!r} downloaded but its sha256 does not match "
                        f"the recorded digest (expected {expected}, got {actual}); "
                        "the object store copy may be corrupt — re-upload it."
                    )
            os.replace(tmp, local)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    return local


def _recorded_sha256(key: str) -> str | None:
    meta = storage_s3.head(key)
    return (meta.get("Metadata") or {}).get("sha256") if meta else None
