"""Cancelling a run that has lost its worker (server restart / crash).

Such a run is absent from the in-process registry but its run.json may still say
"running". The cancel endpoint must be able to finalize it so the UI is never
stuck with an orphaned run it can't stop.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from sambaeval import storage
from sambaeval.api.main import app
from sambaeval.models import Experiment

ECHO = "scripts/generators/echo_generator.py"  # unused; never executed here


def _exp(exp_id: str = "t") -> Experiment:
    return Experiment(
        id=exp_id,
        name="orphan",
        models=[{"name": "m", "provider_name": "Echo"}],
        system_prompt="",
        dataset=[{"example_id": 0, "messages": [], "expected_output": "x"}],
        scorer={"type": "heuristic"},
        output_generator="",
    )


def test_cancel_finalizes_orphaned_running_run(data_dir):
    exp = _exp()
    storage.save_experiment(exp)
    meta = storage.create_run(exp, 1)  # status "running", not in the registry
    assert storage.read_run_meta(exp.id, meta.run_id).status == "running"

    client = TestClient(app)
    res = client.post(
        f"/api/experiments/{exp.id}/run/cancel?run_id={meta.run_id}"
    )
    assert res.status_code == 200
    assert res.json()["cancelled"] is True

    # The orphan is now terminal, so it no longer blocks the UI.
    assert storage.read_run_meta(exp.id, meta.run_id).status == "aborted"


def test_cancel_no_active_run_is_404(data_dir):
    exp = _exp("empty")
    storage.save_experiment(exp)
    client = TestClient(app)
    res = client.post(f"/api/experiments/{exp.id}/run/cancel")
    assert res.status_code == 404
