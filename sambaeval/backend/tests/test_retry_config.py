"""The retry endpoint's snapshot-vs-live config choice.

`config=live` applies the experiment's *current* settings to the failed rows;
the default reproduces the config snapshot captured when the run started. These
drive the real HTTP endpoint with the offline echo generator: the run streams
to completion before the POST returns, so we can assert on the stored results.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from sambaeval import storage
from sambaeval.api.main import app
from sambaeval.models import Experiment, ResultRow

FIXTURES_DIR = Path(__file__).parent / "fixtures"
ECHO_GENERATOR = str(FIXTURES_DIR / "echo_generator.py")


def _two_model_exp(exp_id: str = "t") -> Experiment:
    dataset = [
        {
            "example_id": i,
            "messages": [{"role": "user", "content": f"q{i}"}],
            "expected_output": f"q{i}",
        }
        for i in range(3)
    ]
    return Experiment(
        id=exp_id,
        name="two-model",
        models=[
            {"name": "echo-good", "provider_name": "Echo"},
            {"name": "echo-bad", "provider_name": "Echo"},
        ],
        system_prompt="",
        dataset=dataset,
        scorer={"type": "heuristic"},
        output_generator=ECHO_GENERATOR,
    )


def _seed_run(exp: Experiment) -> str:
    """A completed run where every echo-bad row failed; echo-good all passed."""
    rows: list[ResultRow] = []
    rid = 0
    for model in exp.models:
        bad = model.name == "echo-bad"
        for ex in range(3):
            rid += 1
            rows.append(
                ResultRow(
                    result_id=rid,
                    status="error" if bad else "completed",
                    provider="Echo",
                    model=model.name,
                    example_id=ex,
                    output="ERROR: boom" if bad else f"q{ex}",
                    score=0.0 if bad else 1.0,
                    weight=1.0,
                )
            )
    meta = storage.create_run(exp, len(rows))  # snapshots the 2-model config
    storage.save_run_results(exp.id, meta.run_id, rows)
    storage.complete_run(exp.id, meta.run_id, "completed")
    return meta.run_id


def _models_in_run(exp_id: str, run_id: str) -> set[str]:
    return {r.model for r in (storage.read_run_results(exp_id, run_id) or [])}


def test_retry_snapshot_reruns_under_original_models(data_dir, monkeypatch):
    """Default retry uses the run's snapshot, even after the experiment is edited."""
    exp = _two_model_exp()
    run_id = _seed_run(exp)
    # Edit the live experiment down to one model — the snapshot still has both.
    storage.save_experiment(exp.model_copy(update={"models": [exp.models[0]]}))

    client = TestClient(app)
    res = client.post(f"/api/experiments/{exp.id}/run?mode=retry&run_id={run_id}")
    assert res.status_code == 200

    # Both models present: the snapshot drove the retry, so echo-bad's failed
    # rows were re-run (and now pass).
    assert _models_in_run(exp.id, run_id) == {"echo-good", "echo-bad"}
    assert storage.read_run_meta(exp.id, run_id).errors == 0


def test_retry_live_config_applies_current_models(data_dir, monkeypatch):
    """`config=live` retries against the experiment's current (edited) config."""
    exp = _two_model_exp()
    run_id = _seed_run(exp)
    # Drop echo-bad from the live experiment before retrying with config=live.
    storage.save_experiment(exp.model_copy(update={"models": [exp.models[0]]}))

    client = TestClient(app)
    res = client.post(
        f"/api/experiments/{exp.id}/run?mode=retry&run_id={run_id}&config=live"
    )
    assert res.status_code == 200

    # echo-bad is gone from the live config, so its rows are pruned rather than
    # retried — only echo-good remains.
    assert _models_in_run(exp.id, run_id) == {"echo-good"}
    assert storage.read_run_meta(exp.id, run_id).errors == 0
