"""Decoupled run worker (prodplan §3.4).

Claims ``queued`` runs from the DB (``FOR UPDATE SKIP LOCKED``), executes them
with the existing ``run_experiment`` engine, and writes progress/results to the
DB. One worker processes one run at a time, so worker replicas == concurrent-run
capacity. Pause/terminate are DB-backed: the API sets ``runs.control`` and a
per-run poller thread here translates it into the executor's cooperative signals
(replacing the in-memory ``run_registry`` for cross-process control).

Run standalone: ``sambaeval-worker`` (alongside ``sambaeval-server``), or in the
API process for the native dev loop via ``start_in_process_worker()``.
"""

from __future__ import annotations

import os
import socket
import threading
import time
import uuid
from typing import Optional

from . import context, storage
from .bootstrap import bootstrap
from .executor import ExecutorProgress, run_experiment
from .models import Experiment
from .run_registry import RunControl
from . import storage_db

POLL_INTERVAL_S = 0.5
CONTROL_POLL_S = 0.25


def _worker_id() -> str:
    return f"{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"


def _run_one(claim: dict, worker_id: str) -> None:
    experiment_id = claim["experiment_id"]
    run_label = claim["run_label"]
    owner_id = claim["owner_id"]
    mode = claim["mode"]
    params = claim["params"] or {}
    snapshot = claim["config_snapshot"] or {}

    try:
        experiment = Experiment.model_validate({**snapshot, "id": experiment_id})
    except Exception as err:  # noqa: BLE001
        reason = f"Invalid run configuration snapshot: {err}"
        storage.complete_run(experiment_id, run_label, "aborted", reason)
        print(f"[worker] run {experiment_id}/{run_label} bad snapshot: {err}")
        return

    control = RunControl()
    stop_poller = threading.Event()

    def control_poller() -> None:
        # Translate the DB control flag into the executor's in-memory signals.
        while not stop_poller.is_set():
            flag = storage_db.get_run_control(experiment_id, run_label)
            if flag == "pause":
                control.pause.set()
            elif flag == "terminate":
                control.terminate.set()
            storage_db.heartbeat(experiment_id, run_label)
            stop_poller.wait(CONTROL_POLL_S)

    poller = threading.Thread(target=control_poller, daemon=True)
    poller.start()

    def on_progress(_p: ExecutorProgress) -> None:
        storage_db.heartbeat(experiment_id, run_label)

    # Resolve providers/scorers/datasets as the run's owner (BYOK).
    token = context.set_active_owner(owner_id)
    try:
        run_experiment(
            experiment,
            concurrency=int(params.get("concurrency") or 4),
            mode=mode,
            run_id=run_label,
            merge_conflict=params.get("merge_conflict") or "skip",
            selected_models=params.get("selected_models"),
            on_progress=on_progress,
            control=control,
        )
    except Exception as err:  # noqa: BLE001
        # Record why on the run itself — this print used to be the only trace,
        # and it dies with the worker's log.
        storage.complete_run(experiment_id, run_label, "aborted", str(err))
        print(f"[worker] run {experiment_id}/{run_label} failed: {err}")
    finally:
        stop_poller.set()
        context._active_owner.reset(token)


def run_loop(stop: Optional[threading.Event] = None, *, worker_id: Optional[str] = None) -> None:
    stop = stop or threading.Event()
    worker_id = worker_id or _worker_id()
    print(f"[worker] {worker_id} polling for queued runs...")
    while not stop.is_set():
        try:
            claim = storage_db.claim_queued_run(worker_id)
        except Exception as err:  # noqa: BLE001 — keep the loop alive on transient DB errors
            print(f"[worker] claim error: {err}")
            stop.wait(POLL_INTERVAL_S)
            continue
        if claim is None:
            stop.wait(POLL_INTERVAL_S)
            continue
        _run_one(claim, worker_id)


def start_in_process_worker() -> threading.Event:
    """Spawn the worker loop in a daemon thread (native dev loop convenience)."""
    stop = threading.Event()
    threading.Thread(target=run_loop, args=(stop,), daemon=True).start()
    return stop


def main() -> None:
    from .config import settings

    if not settings.use_db:
        raise SystemExit("sambaeval-worker requires the DB storage backend (SAMBAEVAL_STORAGE_BACKEND=db).")
    bootstrap()
    stop = threading.Event()
    try:
        run_loop(stop)
    except KeyboardInterrupt:
        stop.set()
        print("\n[worker] shutting down.")


if __name__ == "__main__":
    main()
