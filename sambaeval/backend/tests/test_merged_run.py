"""Tests for the "Merged Run" executor mode and resuming a merged run.

``mode="merged"`` generates the current experiment's results into an existing
target run, in place: brand-new ``(provider, model, example_id)`` keys are
generated, conflicts are resolved *before* any prompt runs ("skip" keeps the
target row, "overwrite" re-generates it), and target rows the experiment doesn't
cover are preserved. The run is flagged ``merged`` so a later resume rebuilds it
the same safe way instead of pruning the rows the current grid doesn't cover.

Offline: the echo generator returns the prompt verbatim, so a freshly generated
row scores 1.0, while seeded rows carry sentinel outputs so we can tell whether
they were preserved or regenerated.
"""

from __future__ import annotations

from sambaeval import executor, storage
from sambaeval.models import ModelConfig, ResultRow


def _row(result_id, model, example_id, *, status="completed", output="SEED", score=0.0):
    return ResultRow(
        result_id=result_id,
        status=status,
        provider="Echo",
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


def _seed(make_experiment, rows, *, n_rows=4, total=None):
    exp = make_experiment(n_rows=n_rows)
    meta = storage.create_run(exp, total if total is not None else len(rows))
    storage.save_run_results("t", meta.run_id, rows)
    return meta.run_id


def _with_models(make_experiment, names, *, n_rows=4):
    exp = make_experiment(n_rows=n_rows)
    return exp.model_copy(
        update={"models": [ModelConfig(name=n, provider_name="Echo") for n in names]}
    )


def _by_key(rows):
    return {(r.provider, r.model, r.example_id): r for r in rows}


def test_merged_run_adds_new_model_and_preserves_existing(data_dir, make_experiment):
    # Target holds model "A" for examples 0..3; the merge adds the default
    # echo-model over the same dataset, so the A rows are entirely uncovered.
    target = _seed(make_experiment, [_row(i, "A", i, output=f"A{i}") for i in range(4)])
    exp_b = _with_models(make_experiment, ["echo-model"])

    executor.run_experiment(exp_b, mode="merged", run_id=target, merge_conflict="skip")

    rows = storage.read_run_results("t", target)
    keys = _by_key(rows)
    # Model A rows are preserved verbatim.
    for i in range(4):
        assert keys[("Echo", "A", i)].output == f"A{i}"
    # echo-model rows were generated and scored 1.0.
    for i in range(4):
        assert keys[("Echo", "echo-model", i)].score == 1.0
    # Unique ids; total/completed reflect the merged size and the flag is set.
    ids = [r.result_id for r in rows]
    assert len(ids) == len(set(ids))
    meta = storage.read_run_meta("t", target)
    assert meta.total == 8 and meta.completed == 8 and meta.merged is True


def test_merged_run_skip_keeps_conflicting_rows(data_dir, make_experiment):
    # Every key the experiment produces already exists in the target (stale).
    target = _seed(
        make_experiment, [_row(i, "echo-model", i, output="STALE") for i in range(4)]
    )
    exp = make_experiment(n_rows=4)

    executor.run_experiment(exp, mode="merged", run_id=target, merge_conflict="skip")

    rows = storage.read_run_results("t", target)
    # Skip ran no prompts: every row is still the stale sentinel.
    assert [r.output for r in rows] == ["STALE"] * 4
    assert storage.read_run_meta("t", target).total == 4


def test_merged_run_overwrite_regenerates_conflicting_rows(data_dir, make_experiment):
    target = _seed(
        make_experiment, [_row(i, "echo-model", i, output="STALE") for i in range(4)]
    )
    exp = make_experiment(n_rows=4)

    executor.run_experiment(
        exp, mode="merged", run_id=target, merge_conflict="overwrite"
    )

    keys = _by_key(storage.read_run_results("t", target))
    for i in range(4):
        r = keys[("Echo", "echo-model", i)]
        # Re-generated (echo → prompt "q{i}", score 1.0), reusing the same id.
        assert r.output == f"q{i}"
        assert r.score == 1.0
        assert r.result_id == i


def test_merged_run_selected_models_only_runs_chosen(data_dir, make_experiment):
    # Target holds stale rows for two models; the merge selects only "echo-model"
    # with overwrite. The chosen model is regenerated; the deselected "A" rows
    # are preserved verbatim even though the conflict policy is "overwrite".
    target = _seed(
        make_experiment,
        [
            _row(0, "A", 0, output="STALE"),
            _row(1, "A", 1, output="STALE"),
            _row(2, "echo-model", 0, output="STALE"),
            _row(3, "echo-model", 1, output="STALE"),
        ],
        n_rows=2,
    )
    exp = _with_models(make_experiment, ["A", "echo-model"], n_rows=2)

    executor.run_experiment(
        exp,
        mode="merged",
        run_id=target,
        merge_conflict="overwrite",
        selected_models=["Echo|echo-model"],
    )

    keys = _by_key(storage.read_run_results("t", target))
    # Deselected model A: untouched despite the overwrite policy.
    assert keys[("Echo", "A", 0)].output == "STALE"
    assert keys[("Echo", "A", 1)].output == "STALE"
    # Selected echo-model: regenerated (echo → prompt "q{i}", score 1.0).
    assert keys[("Echo", "echo-model", 0)].output == "q0"
    assert keys[("Echo", "echo-model", 1)].score == 1.0


def test_new_run_selected_models_only_runs_chosen(data_dir, make_experiment):
    # A fresh run with two models in the experiment but only "echo-model"
    # selected produces just that model's rows; the run is flagged partial (not
    # merged) so its subset shape survives a later resume.
    exp = _with_models(make_experiment, ["A", "echo-model"], n_rows=2)

    result = executor.run_experiment(
        exp, mode="new", selected_models=["Echo|echo-model"]
    )

    rows = storage.read_run_results("t", result.run_id)
    assert {(r.model, r.example_id) for r in rows} == {
        ("echo-model", 0),
        ("echo-model", 1),
    }
    assert all(r.score == 1.0 for r in rows)
    meta = storage.read_run_meta("t", result.run_id)
    assert meta.total == 2 and meta.completed == 2
    assert meta.partial is True and meta.merged is False


def test_new_run_all_models_is_not_partial(data_dir, make_experiment):
    # Selecting nothing (all models) leaves the run neither partial nor merged.
    exp = _with_models(make_experiment, ["A", "echo-model"], n_rows=2)
    result = executor.run_experiment(exp, mode="new")
    meta = storage.read_run_meta("t", result.run_id)
    assert meta.partial is False and meta.merged is False
    assert meta.total == 4


def test_resume_subset_new_run_does_not_re_expand(data_dir, make_experiment):
    # The subset new run above, once interrupted, must resume as the same subset
    # even though the experiment still lists model "A".
    exp = _with_models(make_experiment, ["A", "echo-model"], n_rows=2)
    first = executor.run_experiment(
        exp, mode="new", selected_models=["Echo|echo-model"]
    )

    executor.run_experiment(exp, mode="resume", run_id=first.run_id)

    rows = storage.read_run_results("t", first.run_id)
    # Model A was never added back in by the resume.
    assert {r.model for r in rows} == {"echo-model"}


def test_resume_merged_run_preserves_uncovered_rows(data_dir, make_experiment):
    # A merged run paused partway: model "A" done (preserved), echo-model/0 done,
    # echo-model/1 errored. Flagged merged + paused, like a real paused merge.
    seeded = (
        [_row(i, "A", i, output=f"A{i}") for i in range(4)]
        + [_row(4, "echo-model", 0, output="q0", score=1.0)]
        + [_row(5, "echo-model", 1, status="error", output="ERROR: boom")]
    )
    target = _seed(make_experiment, seeded, total=6)
    storage.mark_run_resumed("t", target, 6, merged=True)
    storage.complete_run("t", target, "paused")

    # Live experiment: echo-model over examples 0,1 (the merge's covered grid).
    exp = make_experiment(n_rows=2)
    executor.run_experiment(exp, mode="resume", run_id=target)

    rows = storage.read_run_results("t", target)
    keys = _by_key(rows)
    # The data-loss guard: the model-A rows the grid doesn't cover survive.
    for i in range(4):
        assert keys[("Echo", "A", i)].output == f"A{i}"
    # Completed echo-model/0 carried over; errored echo-model/1 re-run to success.
    assert keys[("Echo", "echo-model", 0)].output == "q0"
    assert keys[("Echo", "echo-model", 1)].status == "completed"
    assert keys[("Echo", "echo-model", 1)].score == 1.0
    # No id collision between preserved rows and rebuilt grid rows.
    ids = [r.result_id for r in rows]
    assert len(ids) == len(set(ids))
    meta = storage.read_run_meta("t", target)
    assert meta.status == "completed" and meta.errors == 0 and meta.merged is True
