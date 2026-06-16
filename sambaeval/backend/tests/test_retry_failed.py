"""Functional tests for the "Retry Failed" flow.

Retrying re-runs only the ``error`` rows of a past run (even a completed one),
carries over the rows that already succeeded, and updates the same run in place.
These exercise the real executor against the offline echo generator.
"""

from __future__ import annotations

from sambaeval import executor, storage
from sambaeval.models import ResultRow


def _seed_run_with_errors(exp, completed_ids, error_ids):
    """Create a finished run whose rows are part completed, part error.

    The error rows' echoed output will match their ``expected_output`` when
    re-run, so a retry turns them into clean 1.0 completions.
    """
    total = len(completed_ids) + len(error_ids)
    meta = storage.create_run(exp, total)
    rows = []
    for ex in sorted(completed_ids | error_ids):
        is_err = ex in error_ids
        rows.append(
            ResultRow(
                result_id=ex + 1,
                status="error" if is_err else "completed",
                provider="Echo",
                model="echo-model",
                example_id=ex,
                output="ERROR: boom" if is_err else f"q{ex}",
                score=0.0 if is_err else 1.0,
                weight=1.0,
            )
        )
    storage.save_run_results(exp.id, meta.run_id, rows)
    storage.complete_run(exp.id, meta.run_id, "completed")
    return meta.run_id


def test_find_retryable_run_matches_completed_run_with_errors(
    data_dir, make_experiment
):
    """A completed run with failures is retryable; one with none is not."""
    exp = make_experiment(n_rows=4)
    assert storage.find_retryable_run(exp.id) is None

    run_id = _seed_run_with_errors(exp, {0, 1}, {2, 3})
    found = storage.find_retryable_run(exp.id)
    assert found is not None
    assert found.run_id == run_id
    # The latest run is completed, so it is NOT resumable — only retryable.
    assert storage.find_resumable_run(exp.id) is None


def test_snapshot_round_trips(data_dir, make_experiment):
    """create_run captures a snapshot the retry path can reload."""
    exp = make_experiment(n_rows=4)
    meta = storage.create_run(exp, 4)
    snap = storage.read_run_experiment_snapshot(exp.id, meta.run_id)
    assert snap is not None
    assert snap.id == exp.id
    assert [m.name for m in snap.models] == [m.name for m in exp.models]


def test_retry_reruns_only_failed_rows(data_dir, make_experiment, gate):
    """Retry re-runs the error rows, carries over completed ones, and finishes."""
    exp = make_experiment(n_rows=8)
    completed_ids = {0, 1, 2, 3}
    error_ids = {4, 5, 6, 7}
    run_id = _seed_run_with_errors(exp, completed_ids, error_ids)

    # The gate stays released, so retry runs straight through; clear any markers
    # so started_ids() reflects exactly what this retry re-ran.
    gate.release()
    gate.clear_started()

    result = executor.run_experiment(exp, concurrency=4, mode="retry", run_id=run_id)

    # Same run, now clean: every row completed, no errors left.
    assert result.run_id == run_id
    assert result.meta.status == "completed"
    assert result.meta.completed == 8
    assert result.meta.errors == 0
    assert sorted((r.example_id, r.score) for r in result.results) == [
        (i, 1.0) for i in range(8)
    ]
    # Only the previously-failed rows were regenerated; completed rows carried.
    assert gate.started_ids() == error_ids


def test_retry_with_no_run_id_targets_latest_failed_run(
    data_dir, make_experiment, gate
):
    """Omitting run_id retries the most recent run that has failures."""
    exp = make_experiment(n_rows=4)
    run_id = _seed_run_with_errors(exp, {0, 1}, {2, 3})

    gate.release()
    gate.clear_started()

    result = executor.run_experiment(exp, concurrency=4, mode="retry")

    assert result.run_id == run_id
    assert result.meta.errors == 0
    assert gate.started_ids() == {2, 3}
