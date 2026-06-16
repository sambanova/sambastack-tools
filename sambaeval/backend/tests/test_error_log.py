"""Tests for the per-run errors.json log.

Errors are written to ``results/{exp}/{run}/errors.json`` keyed by example_id,
then by ``provider/model``, with a ``{phase, message}`` value. A model pointed
at a missing provider fails in the *generation* phase, which is the simplest way
to exercise the log fully offline (no provider is ever contacted).
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from sambaeval import executor, paths, storage
from sambaeval.api.main import app
from sambaeval.models import Experiment, ResultRow

ECHO_GENERATOR = str(Path(__file__).parent / "fixtures" / "echo_generator.py")


def _make_mixed_experiment(exp_id: str = "errlog") -> Experiment:
    """One row, two models: a working Echo model and one with a bad provider."""
    dataset = [
        {
            "example_id": 0,
            "messages": [{"role": "user", "content": "q0"}],
            "expected_output": "q0",
        },
        {
            "example_id": 1,
            "messages": [{"role": "user", "content": "q1"}],
            "expected_output": "q1",
        },
    ]
    return Experiment(
        id=exp_id,
        name="error log test",
        models=[
            {"name": "echo-model", "provider_name": "Echo"},
            {"name": "broken-model", "provider_name": "NopeProvider"},
        ],
        system_prompt="",
        dataset=dataset,
        scorer={"type": "heuristic"},
        output_generator=ECHO_GENERATOR,
    )


def test_errors_json_written_with_expected_schema(data_dir):
    exp = _make_mixed_experiment()
    result = executor.run_experiment(exp, concurrency=4, mode="new")

    errors_path = paths.run_errors_path(exp.id, result.run_id)
    assert errors_path.exists(), "errors.json should be created when a task fails"

    data = json.loads(errors_path.read_text(encoding="utf-8"))

    # Both example ids failed for the broken model; neither failed for Echo.
    assert set(data.keys()) == {"0", "1"}
    for ex_key in ("0", "1"):
        assert set(data[ex_key].keys()) == {"NopeProvider/broken-model"}
        entry = data[ex_key]["NopeProvider/broken-model"]
        assert entry["phase"] == "generation"
        assert "NopeProvider" in entry["message"]

    # The errors.json count lines up with the run meta's error tally.
    assert result.meta.errors == 2


def test_record_run_error_set_and_clear(data_dir, make_experiment):
    """Recording then clearing an error round-trips and removes the file."""
    exp = make_experiment(n_rows=1)
    meta = storage.create_run(exp, 1)
    run_id = meta.run_id

    storage.record_run_error(
        exp.id,
        run_id,
        example_id=0,
        provider="Echo",
        model="echo-model",
        error={"phase": "scoring", "message": "judge blew up"},
    )
    data = storage.read_run_errors(exp.id, run_id)
    assert data == {
        "0": {"Echo/echo-model": {"phase": "scoring", "message": "judge blew up"}}
    }

    # A subsequent success clears the entry and drops the now-empty file.
    storage.record_run_error(
        exp.id, run_id, example_id=0, provider="Echo", model="echo-model", error=None
    )
    assert storage.read_run_errors(exp.id, run_id) == {}
    assert not paths.run_errors_path(exp.id, run_id).exists()


def test_clearing_absent_error_is_a_noop(data_dir, make_experiment):
    """Clearing when nothing is recorded never creates an empty file."""
    exp = make_experiment(n_rows=1)
    meta = storage.create_run(exp, 1)
    storage.record_run_error(
        exp.id, meta.run_id, example_id=0, provider="Echo", model="echo-model", error=None
    )
    assert not paths.run_errors_path(exp.id, meta.run_id).exists()


def test_errors_endpoint_returns_flattenable_log(data_dir):
    """GET /errors serves the recorded log; an unspecified run defaults to latest."""
    exp = _make_mixed_experiment(exp_id="errlog_api")
    storage.save_experiment(exp)
    result = executor.run_experiment(exp, concurrency=4, mode="new")

    client = TestClient(app)
    res = client.get(
        f"/api/experiments/{exp.id}/errors?run_id={result.run_id}"
    )
    assert res.status_code == 200
    body = res.json()
    assert body["runId"] == result.run_id
    assert set(body["errors"].keys()) == {"0", "1"}
    assert body["errors"]["0"]["NopeProvider/broken-model"]["phase"] == "generation"

    # No run_id falls back to the latest run.
    assert client.get(f"/api/experiments/{exp.id}/errors").json()["errors"] == body[
        "errors"
    ]


def test_errors_endpoint_empty_when_no_errors(data_dir, make_experiment):
    """A clean run reports an empty errors object (drives the hidden UI section)."""
    exp = make_experiment(n_rows=2, exp_id="clean_api")
    storage.save_experiment(exp)
    result = executor.run_experiment(exp, concurrency=4, mode="new")

    client = TestClient(app)
    body = client.get(
        f"/api/experiments/{exp.id}/errors?run_id={result.run_id}"
    ).json()
    assert body["errors"] == {}
    assert not paths.run_errors_path(exp.id, result.run_id).exists()


def test_errors_reconstructed_from_results_when_log_missing(data_dir, make_experiment):
    """A run with error rows but no errors.json (e.g. predating the log, or an
    older server) still surfaces its failures, reconstructed from results.csv."""
    exp = make_experiment(n_rows=3)
    meta = storage.create_run(exp, 3)
    storage.save_run_results(
        exp.id,
        meta.run_id,
        [
            ResultRow(
                result_id=1, status="completed", provider="Echo", model="m",
                example_id=0, output="q0", score=1.0, weight=1.0,
            ),
            # Generation failure: output is "ERROR: <msg>".
            ResultRow(
                result_id=2, status="error", provider="Echo", model="m",
                example_id=1, output="ERROR: Overloaded", score=0.0, weight=1.0,
            ),
            # Scoring failure: judge marker appended after the model output.
            ResultRow(
                result_id=3, status="error", provider="Echo", model="m",
                example_id=2, output="some output\n\n[JUDGE ERROR: bad json]",
                score=0.0, weight=1.0,
            ),
        ],
    )
    # No errors.json exists for this run.
    assert not paths.run_errors_path(exp.id, meta.run_id).exists()

    errs = storage.get_run_errors(exp.id, meta.run_id)
    assert errs == {
        "1": {"Echo/m": {"phase": "generation", "message": "Overloaded"}},
        "2": {"Echo/m": {"phase": "scoring", "message": "bad json"}},
    }


def test_logged_errors_take_precedence_over_reconstruction(data_dir, make_experiment):
    """When errors.json exists, it's returned verbatim (not re-derived)."""
    exp = make_experiment(n_rows=1)
    meta = storage.create_run(exp, 1)
    storage.save_run_results(
        exp.id,
        meta.run_id,
        [
            ResultRow(
                result_id=1, status="error", provider="Echo", model="m",
                example_id=0, output="ERROR: from csv", score=0.0, weight=1.0,
            ),
        ],
    )
    storage.record_run_error(
        exp.id, meta.run_id, example_id=0, provider="Echo", model="m",
        error={"phase": "generation", "message": "from log"},
    )
    errs = storage.get_run_errors(exp.id, meta.run_id)
    assert errs["0"]["Echo/m"]["message"] == "from log"
