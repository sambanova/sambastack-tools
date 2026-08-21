"""DB-backend integration tests (prodplan §10 verification, offline).

Uses the deterministic echo generator so no provider is contacted.
"""

from __future__ import annotations

import threading
import time
import uuid

from sambaeval import context, storage, storage_db
from sambaeval.models import Experiment, Provider
from sambaeval.worker import run_loop

ECHO_GEN = "backend/tests/fixtures/echo_generator.py"


def _echo_experiment(exp_id: str, n: int = 3, private: bool = True) -> Experiment:
    dataset = [
        {"example_id": i, "messages": [{"role": "user", "content": f"q{i}"}], "expected_output": f"q{i}"}
        for i in range(n)
    ]
    return Experiment(
        id=exp_id,
        name="echo",
        models=[{"name": "echo", "provider_name": "Echo"}],
        output_generator=ECHO_GEN,
        dataset=dataset,
        scorer={"type": "heuristic"},
        private=private,
    )


def _run_via_worker(exp: Experiment, owner_id, mode="new", target=None, timeout=25) -> str:
    label = storage_db.enqueue_run(
        exp, mode=mode, params={"concurrency": 3}, owner_id=owner_id, target_run_id=target
    )
    stop = threading.Event()
    t = threading.Thread(target=run_loop, args=(stop,), daemon=True)
    t.start()
    deadline = time.time() + timeout
    try:
        while time.time() < deadline:
            if storage_db.run_status(exp.id, label) in ("completed", "aborted", "interrupted", "paused"):
                break
            time.sleep(0.1)
    finally:
        stop.set()
    return label


def test_experiment_crud_and_scoping(owner_ctx):
    eid = f"crud_{uuid.uuid4().hex[:6]}"
    exp = _echo_experiment(eid, private=True)
    storage.save_experiment(exp)
    got = storage.get_experiment(eid)
    assert got is not None and got.id == eid and got.private is True
    # Owner sees it under "mine"; it is not public.
    scoped = {x["experiment"].id: x for x in storage_db.list_experiments_scoped("mine")}
    assert eid in scoped and scoped[eid]["visibility"] == "private"
    assert eid not in {x["experiment"].id for x in storage_db.list_experiments_scoped("public")}
    storage.delete_experiment(eid)
    assert storage.get_experiment(eid) is None


def test_provider_crypto_roundtrip(owner_ctx):
    storage.save_providers([Provider(name="Echo", api_url="http://x", api_key="s3cr3t-key-99")])
    got = {p.name: p for p in storage.list_providers()}
    assert got["Echo"].api_key == "s3cr3t-key-99"  # decrypts back


def test_dataset_object_store_roundtrip(owner_ctx):
    name = f"ds_{uuid.uuid4().hex[:6]}.jsonl"
    content = '{"example_id":0,"prompt":"hi","expected_output":"ok"}\n'
    storage.write_dataset(name, content, private=True)
    assert storage.read_dataset(name) == content
    assert name in storage.list_datasets()
    storage.delete_dataset(name)


def test_run_end_to_end_and_csv(owner_ctx):
    storage.save_providers([Provider(name="Echo", api_url="http://x", api_key="unused")])
    eid = f"run_{uuid.uuid4().hex[:6]}"
    exp = _echo_experiment(eid, n=4)
    storage.save_experiment(exp)
    label = _run_via_worker(exp, owner_ctx)
    meta = storage.read_run_meta(eid, label)
    assert meta.status == "completed" and meta.completed == 4 and meta.errors == 0
    rows = storage.read_run_results(eid, label)
    assert len(rows) == 4 and all(r.score == 1.0 for r in rows)
    csv = storage.read_run_results_csv(eid, label)
    header = csv.splitlines()[0]
    assert header.startswith("result_id,status,provider,model,example_id,output,score,weight")
    # Integral score serializes as "1" (JS String(n)), not "1.0".
    assert ",1,1," in csv.splitlines()[1]
    storage.delete_experiment(eid)


def test_share_token_view(owner_ctx):
    eid = f"share_{uuid.uuid4().hex[:6]}"
    storage.save_experiment(_echo_experiment(eid, private=True))
    token = storage_db.ensure_experiment_share_token(eid)
    assert token
    # A different owner can view it via the token.
    other = uuid.uuid4()
    with context.owner(other):
        viewed = storage_db.get_experiment_by_share_token(token)
        assert viewed is not None and viewed.id == eid
    storage.delete_experiment(eid)


def test_quota_counter(owner_ctx):
    # Enqueue up to the limit; count reflects queued runs.
    eid = f"quota_{uuid.uuid4().hex[:6]}"
    exp = _echo_experiment(eid)
    storage.save_experiment(exp)
    labels = [
        storage_db.enqueue_run(exp, mode="new", params={"concurrency": 1}, owner_id=owner_ctx)
        for _ in range(3)
    ]
    assert storage_db.count_active_runs_for_owner(owner_ctx) >= 3
    # Clean up the queued runs.
    for lbl in labels:
        storage.delete_run(eid, lbl)
    storage.delete_experiment(eid)
