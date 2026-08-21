"""Shared fixtures for the executor pause/resume test suite.

Every test runs fully offline: a temp ``SAMBAEVAL_DATA_DIR`` holds all state and
the experiments use the deterministic :mod:`echo_generator` fixture, so no
provider is ever contacted and no API key is needed.
"""

from __future__ import annotations

import os

# These tests exercise the original file-backed storage against a temp
# SAMBAEVAL_DATA_DIR. Pin the storage backend to "files" BEFORE importing
# sambaeval so the DB dispatch in storage.py stays inactive (no Postgres needed).
os.environ.setdefault("SAMBAEVAL_STORAGE_BACKEND", "files")

import threading
import time
from pathlib import Path

import pytest

import sambaeval.run_registry as run_registry
from sambaeval import executor, storage
from sambaeval.models import Experiment, Provider
from sambaeval.run_registry import RunControl

FIXTURES_DIR = Path(__file__).parent / "fixtures"
ECHO_GENERATOR = str(FIXTURES_DIR / "echo_generator.py")


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    """Point SambaEval at a throwaway data dir with one dummy provider."""
    monkeypatch.setenv("SAMBAEVAL_DATA_DIR", str(tmp_path))
    storage.ensure_dirs()
    # The strict provider reader the executor uses requires a real file.
    storage.save_providers(
        [Provider(name="Echo", api_url="http://localhost", api_key="unused")]
    )
    return tmp_path


@pytest.fixture
def make_experiment():
    """Factory for an experiment over the echo generator + heuristic scorer.

    Each row's ``expected_output`` equals the echoed prompt, so every completed
    row scores a deterministic 1.0.
    """

    def _make(n_rows: int = 8, exp_id: str = "t") -> Experiment:
        dataset = [
            {
                "example_id": i,
                "messages": [{"role": "user", "content": f"q{i}"}],
                "expected_output": f"q{i}",
            }
            for i in range(n_rows)
        ]
        return Experiment(
            id=exp_id,
            name="test experiment",
            models=[{"name": "echo-model", "provider_name": "Echo"}],
            system_prompt="",
            dataset=dataset,
            scorer={"type": "heuristic"},
            output_generator=ECHO_GENERATOR,
        )

    return _make


class RunHandle:
    """Runs an experiment on a background thread, exposing its control + result."""

    def __init__(self, experiment: Experiment, *, concurrency: int, mode: str, run_id):
        self.experiment = experiment
        self.control = RunControl()
        self._box: dict = {}
        self._thread = threading.Thread(
            target=self._go, args=(concurrency, mode, run_id), daemon=True
        )

    def _go(self, concurrency, mode, run_id):
        try:
            self._box["result"] = executor.run_experiment(
                self.experiment,
                concurrency=concurrency,
                mode=mode,
                run_id=run_id,
                control=self.control,
            )
        except Exception as err:  # surfaced in wait()
            self._box["error"] = err

    def start(self) -> "RunHandle":
        self._thread.start()
        return self

    def active_run_id(self, timeout: float = 5.0) -> str:
        """Block until the run has registered itself, then return its id."""
        prefix = f"{self.experiment.id}/"
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for key in list(run_registry._active.keys()):
                if key.startswith(prefix):
                    return key[len(prefix):]
            if "error" in self._box:
                raise self._box["error"]
            time.sleep(0.01)
        raise AssertionError("run never became active")

    def wait(self, timeout: float = 15.0):
        self._thread.join(timeout)
        assert not self._thread.is_alive(), "run_experiment did not return in time"
        if "error" in self._box:
            raise self._box["error"]
        return self._box["result"]


@pytest.fixture
def run_handle(make_experiment):
    handles: list[RunHandle] = []

    def _run(experiment=None, *, concurrency=4, mode="new", run_id=None, n_rows=8):
        exp = experiment if experiment is not None else make_experiment(n_rows=n_rows)
        h = RunHandle(exp, concurrency=concurrency, mode=mode, run_id=run_id).start()
        handles.append(h)
        return h

    yield _run
    # Make sure nothing is left running between tests.
    for h in handles:
        h._thread.join(timeout=5)


class Gate:
    """File-based barrier the echo generator parks on (see echo_generator.py)."""

    def __init__(self, directory: Path):
        self.dir = directory

    def started_ids(self) -> set[int]:
        return {
            int(p.name.split("-", 1)[1]) for p in self.dir.glob("started-*")
        }

    def wait_started(self, n: int, timeout: float = 10.0) -> set[int]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            ids = self.started_ids()
            if len(ids) >= n:
                return ids
            time.sleep(0.01)
        raise AssertionError(
            f"only {len(self.started_ids())} task(s) started, expected {n}"
        )

    def clear_started(self) -> None:
        for p in self.dir.glob("started-*"):
            p.unlink()

    def release(self) -> None:
        (self.dir / "release").write_text("1", encoding="utf-8")


@pytest.fixture
def gate(tmp_path, monkeypatch):
    gdir = tmp_path / "gate"
    gdir.mkdir()
    monkeypatch.setenv("SAMBAEVAL_TEST_GATE_DIR", str(gdir))
    g = Gate(gdir)
    yield g
    # Release on teardown so any task still parked on the gate can exit cleanly.
    g.release()
