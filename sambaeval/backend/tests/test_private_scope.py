"""Tests for the private (gitignored) data tree.

An experiment marked ``private`` lives under ``data/private/experiments/`` and
its dataset, scorer, and run results resolve to / land in the mirrored private
subtrees. Public and private items are listed together, with the folder as the
source of truth for the ``private`` flag.

All fully offline via the temp ``SAMBAEVAL_DATA_DIR`` (``data_dir`` fixture) and
the echo generator.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from sambaeval import paths, storage
from sambaeval.api.main import app
from sambaeval.datasets import load_dataset
from sambaeval.models import Experiment, LlmJudgeScorerDef


# --------------------------------------------------------------------------- #
# experiments: scope is decided by the folder
# --------------------------------------------------------------------------- #
def test_private_experiment_saves_to_private_tree(data_dir):
    exp = Experiment(
        id="secret",
        name="secret",
        models=[{"name": "m", "provider_name": "Echo"}],
        dataset=[{"example_id": 1, "prompt": "hi", "expected_output": "hi"}],
        scorer={"type": "heuristic"},
        private=True,
    )
    storage.save_experiment(exp)

    assert paths.experiment_file_path("secret", private=True).exists()
    assert not paths.experiment_file_path("secret", private=False).exists()
    # ``private`` is derived from the folder, not persisted in the JSON.
    raw = json.loads(paths.experiment_file_path("secret", private=True).read_text())
    assert "private" not in raw

    loaded = storage.get_experiment("secret")
    assert loaded is not None and loaded.private is True


def test_public_experiment_saves_to_public_tree(data_dir):
    exp = Experiment(
        id="open",
        name="open",
        models=[{"name": "m", "provider_name": "Echo"}],
        dataset=[{"example_id": 1, "prompt": "hi"}],
        scorer={"type": "heuristic"},
    )
    storage.save_experiment(exp)
    assert paths.experiment_file_path("open", private=False).exists()
    assert not paths.experiment_file_path("open", private=True).exists()
    assert storage.get_experiment("open").private is False


def test_toggling_privacy_moves_the_file(data_dir):
    exp = Experiment(
        id="e",
        name="e",
        models=[{"name": "m", "provider_name": "Echo"}],
        dataset=[{"example_id": 1, "prompt": "hi"}],
        scorer={"type": "heuristic"},
    )
    storage.save_experiment(exp)
    assert paths.experiment_file_path("e", private=False).exists()

    storage.save_experiment(exp.model_copy(update={"private": True}))
    assert paths.experiment_file_path("e", private=True).exists()
    # The stale public copy is removed so it isn't listed twice.
    assert not paths.experiment_file_path("e", private=False).exists()

    ids = [e.id for e in storage.list_experiments()]
    assert ids.count("e") == 1


def test_list_experiments_merges_both_trees(data_dir):
    storage.save_experiment(Experiment(
        id="pub", name="pub", models=[{"name": "m", "provider_name": "Echo"}],
        dataset=[{"example_id": 1, "prompt": "x"}], scorer={"type": "heuristic"},
    ))
    storage.save_experiment(Experiment(
        id="priv", name="priv", models=[{"name": "m", "provider_name": "Echo"}],
        dataset=[{"example_id": 1, "prompt": "x"}], scorer={"type": "heuristic"},
        private=True,
    ))
    by_id = {e.id: e for e in storage.list_experiments()}
    assert by_id["pub"].private is False
    assert by_id["priv"].private is True


# --------------------------------------------------------------------------- #
# datasets / scorers resolve across both trees
# --------------------------------------------------------------------------- #
def test_private_dataset_is_listed_and_loaded(data_dir):
    name = "priv_ds.jsonl"
    row = {"example_id": 1, "prompt": "hi", "expected_output": "hi"}
    paths.dataset_file_path(name, private=True).write_text(
        json.dumps(row) + "\n", encoding="utf-8"
    )
    assert name in storage.list_datasets()
    rows = load_dataset(name)
    assert len(rows) == 1 and rows[0].example_id == 1


def test_private_scorer_is_listed_and_fetched(data_dir):
    scorer = LlmJudgeScorerDef(
        name="priv_judge", provider_name="Echo", model="m",
        judge_prompt="{output}", max_score=5,
    )
    paths.scorer_file_path("priv_judge", private=True).write_text(
        json.dumps(scorer.model_dump()), encoding="utf-8"
    )
    assert any(s.name == "priv_judge" for s in storage.list_scorers())
    fetched = storage.get_scorer("priv_judge")
    assert fetched is not None and fetched.provider_name == "Echo"


# --------------------------------------------------------------------------- #
# a private experiment's runs land under the private results tree
# --------------------------------------------------------------------------- #
def test_private_experiment_runs_land_in_private_results(data_dir, make_experiment, run_handle):
    exp = make_experiment(n_rows=2, exp_id="privrun").model_copy(
        update={"private": True}
    )
    storage.save_experiment(exp)

    result = run_handle(exp, n_rows=2).wait()

    priv_run = paths.private_results_dir() / "privrun" / result.run_id
    pub_run = paths.results_dir() / "privrun" / result.run_id
    assert priv_run.exists() and (priv_run / "results.csv").exists()
    assert not pub_run.exists()
    # storage reads the run back from the private tree transparently.
    assert storage.read_run_results("privrun", result.run_id) is not None


# --------------------------------------------------------------------------- #
# API contract the UI toggles depend on
# --------------------------------------------------------------------------- #
def test_post_dataset_private_lands_in_private_tree(data_dir):
    """POST /api/datasets with private=true writes to the private tree — the
    contract the Datasets page's "Private" checkbox relies on."""
    client = TestClient(app)
    res = client.post(
        "/api/datasets",
        json={"name": "ui_priv.jsonl", "content": '{"example_id":1,"prompt":"hi"}\n',
              "private": True},
    )
    assert res.status_code == 200
    assert paths.dataset_file_path("ui_priv.jsonl", private=True).exists()
    assert not paths.dataset_file_path("ui_priv.jsonl", private=False).exists()


def test_put_experiment_private_flag_round_trips_through_api(data_dir):
    """PUT then GET /api/experiments/{id} with private=true moves the file to
    the private tree and reflects the flag back — the Experiment page toggle."""
    client = TestClient(app)
    body = {
        "name": "ui exp",
        "models": [{"name": "m", "provider_name": "Echo", "system_prompt": "global"}],
        "dataset": "d.jsonl",
        "scorer": {"type": "heuristic"},
        "private": True,
    }
    put = client.put("/api/experiments/uiexp", json=body)
    assert put.status_code == 200
    assert put.json()["experiment"]["private"] is True
    assert paths.experiment_file_path("uiexp", private=True).exists()

    got = client.get("/api/experiments/uiexp").json()["experiment"]
    assert got["private"] is True

    # Untoggling moves it back to the public tree.
    body["private"] = False
    client.put("/api/experiments/uiexp", json=body)
    assert paths.experiment_file_path("uiexp", private=False).exists()
    assert not paths.experiment_file_path("uiexp", private=True).exists()
    assert client.get("/api/experiments/uiexp").json()["experiment"]["private"] is False
