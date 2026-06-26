"""Tests for combining two finished runs via ``storage.merge_run_results``.

This is the Results-section "Merge Results" path: it folds one completed run's
rows into another *without* re-running anything. Rows are keyed by
``(provider, model, example_id)``; the "From" rows are renumbered to sit past the
"Into" run's maximum ``result_id`` while the "Into" rows keep their ids, and a
conflict is a key present in both runs. Fully offline — no executor, provider, or
network is involved.
"""

from __future__ import annotations

import pytest

from sambaeval import storage
from sambaeval.models import ResultRow


def _row(result_id, model, example_id, *, provider="Echo", output="x", score=1.0):
    return ResultRow(
        result_id=result_id,
        status="completed",
        provider=provider,
        model=model,
        example_id=example_id,
        output=output,
        score=score,
        weight=1.0,
        score_reason=None,
        input_tokens=None,
        output_tokens=None,
        latency_ms=None,
        ttft_ms=None,
        tps=None,
        num_llm_calls=None,
    )


def _seed_run(make_experiment, rows, *, n_rows=4):
    """Create a run (with a snapshot, so dataset checks work) and seed its rows."""
    exp = make_experiment(n_rows=n_rows)
    meta = storage.create_run(exp, len(rows))
    storage.save_run_results(exp.id, meta.run_id, rows)
    return meta.run_id


def _by_key(rows):
    return {(r.provider, r.model, r.example_id): r for r in rows}


def test_merge_appends_and_renumbers_without_conflicts(data_dir, make_experiment):
    into = _seed_run(make_experiment, [_row(0, "A", 0), _row(1, "A", 1)])
    frm = _seed_run(make_experiment, [_row(0, "B", 0), _row(1, "B", 1)])

    res = storage.merge_run_results("t", frm, into, overwrite=False)
    assert res["status"] == "merged"

    keys = _by_key(storage.read_run_results("t", into))
    # Into's rows keep their ids; the From rows are appended past the max id (1).
    assert keys[("Echo", "A", 0)].result_id == 0
    assert keys[("Echo", "A", 1)].result_id == 1
    assert keys[("Echo", "B", 0)].result_id == 2
    assert keys[("Echo", "B", 1)].result_id == 3
    # Into's meta total is bumped by the two genuinely new rows.
    assert storage.read_run_meta("t", into).total == 4
    # The From run is left untouched.
    assert {r.result_id for r in storage.read_run_results("t", frm)} == {0, 1}


def test_merge_conflict_blocks_without_overwrite(data_dir, make_experiment):
    into = _seed_run(make_experiment, [_row(0, "A", 0), _row(1, "A", 1)])
    # From has one new row (B/0) and one that conflicts with Into's A/0.
    frm = _seed_run(make_experiment, [_row(0, "B", 0), _row(1, "A", 0)])

    res = storage.merge_run_results("t", frm, into, overwrite=False)
    assert res["status"] == "conflict"
    # The conflicting pair is reported as {from result_id, into result_id}.
    assert res["conflicts"] == [{"from": 1, "into": 0}]
    # Nothing was written: Into still has exactly its two original rows.
    assert {r.result_id for r in storage.read_run_results("t", into)} == {0, 1}


def test_merge_overwrite_replaces_conflicting_rows(data_dir, make_experiment):
    into = _seed_run(
        make_experiment, [_row(0, "A", 0, output="OLD"), _row(1, "A", 1)]
    )
    frm = _seed_run(
        make_experiment, [_row(0, "A", 0, output="NEW"), _row(1, "B", 0)]
    )

    res = storage.merge_run_results("t", frm, into, overwrite=True)
    assert res["status"] == "merged"

    rows = storage.read_run_results("t", into)
    keys = _by_key(rows)
    assert keys[("Echo", "A", 0)].output == "NEW"  # conflict overwritten by From
    assert keys[("Echo", "A", 1)].output == "x"  # untouched Into row kept
    assert ("Echo", "B", 0) in keys  # new From row appended
    ids = [r.result_id for r in rows]
    assert len(ids) == len(set(ids))  # no duplicate result_ids


def test_merge_rejects_self_merge(data_dir, make_experiment):
    into = _seed_run(make_experiment, [_row(0, "A", 0)])
    with pytest.raises(ValueError):
        storage.merge_run_results("t", into, into, overwrite=True)


def test_merge_rejects_dataset_mismatch(data_dir, make_experiment):
    # Two runs over differently-sized inline datasets → different dataset keys.
    into = _seed_run(make_experiment, [_row(0, "A", 0)], n_rows=4)
    frm = _seed_run(make_experiment, [_row(0, "B", 0)], n_rows=3)
    with pytest.raises(ValueError):
        storage.merge_run_results("t", frm, into, overwrite=True)


def test_run_dataset_key_matches_experiment_dataset(data_dir, make_experiment):
    exp = make_experiment(n_rows=4)
    meta = storage.create_run(exp, 0)
    # The key derived from the run's snapshot equals the live experiment's key,
    # which is how the UI restricts merges to same-dataset runs.
    assert storage.run_dataset_key("t", meta.run_id) == storage.dataset_key(
        exp.dataset
    )


def test_dataset_key_filename_vs_inline():
    assert storage.dataset_key("foo.jsonl") == "foo.jsonl"
    # Inline datasets hash to a stable, content-addressed key.
    assert storage.dataset_key([{"a": 1}]).startswith("inline:")
    assert storage.dataset_key([{"a": 1}]) == storage.dataset_key([{"a": 1}])
    assert storage.dataset_key([{"a": 1}]) != storage.dataset_key([{"a": 2}])
