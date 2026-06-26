"""Functional tests for run pause / terminate / cancel / resume.

These exercise the real executor end-to-end (thread pool, cooperative stop
signals, incremental CSV writes, resume carry-over) against the deterministic
offline echo generator — no provider, no API key, no network.

The concurrency-sensitive cases use the file-based gate (see
``fixtures/echo_generator.py``): a run is started with two workers, the test
waits until exactly two tasks are parked mid-flight, then fires the stop signal.
That pins the in-flight set deterministically instead of racing on sleeps.
"""

from __future__ import annotations

import sambaeval.run_registry as run_registry
from sambaeval import storage


def _scores(rows):
    return sorted((r.example_id, r.score) for r in rows)


def test_full_run_completes(data_dir, run_handle):
    """A run with no interference finishes, scoring every row 1.0."""
    h = run_handle(concurrency=4, n_rows=8)
    result = h.wait()

    assert result.meta.status == "completed"
    assert result.meta.completed == 8
    assert result.meta.errors == 0
    assert _scores(result.results) == [(i, 1.0) for i in range(8)]
    # The echo generator makes no LLM call, so no per-row metrics are recorded.
    assert all(r.input_tokens is None for r in result.results)


def test_pause_drains_inflight_only(data_dir, run_handle, gate):
    """Pause lets the in-flight tasks finish and skips the rest → status paused."""
    h = run_handle(concurrency=2, n_rows=8)
    gate.wait_started(2)
    run_id = h.active_run_id()

    assert run_registry.pause_run("t", run_id) is True
    gate.release()
    result = h.wait()

    assert result.meta.status == "paused"
    assert result.meta.completed == 2
    # Only the two admitted tasks ever ran; the other six were never started.
    started = gate.started_ids()
    assert len(started) == 2
    rows = storage.read_run_results("t", run_id)
    assert {r.example_id for r in rows} == started
    assert all(r.score == 1.0 for r in rows)


def test_terminate_abandons_inflight_without_blocking(data_dir, run_handle, gate):
    """Terminate returns promptly even while tasks are parked, and stays paused.

    The gate is never released during the test, so the two in-flight tasks stay
    blocked. If terminate waited on them (the bug this guards against) wait()
    would time out. Their results are abandoned → completed stays 0, and the run
    is still ``paused`` so it can be resumed.
    """
    h = run_handle(concurrency=2, n_rows=8)
    gate.wait_started(2)
    run_id = h.active_run_id()

    run_registry.pause_run("t", run_id)
    run_registry.cancel_run("t", run_id)  # "Terminate Threads"
    result = h.wait(timeout=5)

    assert result.meta.status == "paused"
    assert result.meta.completed == 0


def test_cancel_aborts(data_dir, run_handle, gate):
    """Cancel with no prior pause force-stops the run → status aborted."""
    h = run_handle(concurrency=2, n_rows=8)
    gate.wait_started(2)
    run_id = h.active_run_id()

    assert run_registry.cancel_run("t", run_id) is True
    result = h.wait(timeout=5)

    assert result.meta.status == "aborted"
    assert result.meta.completed == 0


def test_paused_run_is_resumable(data_dir, run_handle, gate):
    """A paused run is reported as the resumable run for its experiment."""
    h = run_handle(concurrency=2, n_rows=8)
    gate.wait_started(2)
    run_id = h.active_run_id()
    run_registry.pause_run("t", run_id)
    gate.release()
    h.wait()

    resumable = storage.find_resumable_run("t")
    assert resumable is not None
    assert resumable.run_id == run_id
    assert resumable.status == "paused"


def test_resume_carries_over_completed_rows(data_dir, run_handle, gate):
    """Resuming a paused run reuses completed rows and only re-runs the rest."""
    # Phase 1: pause after two tasks complete.
    h1 = run_handle(concurrency=2, n_rows=8)
    gate.wait_started(2)
    run_id = h1.active_run_id()
    run_registry.pause_run("t", run_id)
    gate.release()
    paused = h1.wait()
    assert paused.meta.status == "paused" and paused.meta.completed == 2
    done_ids = {r.example_id for r in storage.read_run_results("t", run_id)}

    # Forget which tasks have started so phase 2 reveals exactly what re-runs.
    # The gate stays released, so resume runs straight through.
    gate.clear_started()

    # Phase 2: resume the same run to completion.
    h2 = run_handle(concurrency=4, mode="resume", run_id=run_id)
    result = h2.wait()

    assert result.meta.status == "completed"
    assert result.meta.completed == 8
    assert _scores(result.results) == [(i, 1.0) for i in range(8)]
    # The two already-completed rows were carried over, not regenerated:
    # phase 2 only re-runs the six that weren't done yet.
    rerun_ids = gate.started_ids()
    assert done_ids.isdisjoint(rerun_ids)
    assert rerun_ids == set(range(8)) - done_ids
