"""In-process registry of executing runs.

Each active run is registered with a ``threading.Event`` that the executor's
workers poll; cancellation sets the event (a cooperative cancel signal). A run
whose ``run.json`` still says "running" but which is
absent here has lost its process (crash / restart) and is reconciled to
"interrupted" by storage on the next listing.

This state is per-process and does not survive a restart — by design.
"""

from __future__ import annotations

import threading

_lock = threading.Lock()
_active: dict[str, threading.Event] = {}


def _key(experiment_id: str, run_id: str) -> str:
    return f"{experiment_id}/{run_id}"


def register_run(experiment_id: str, run_id: str, cancel_event: threading.Event) -> None:
    with _lock:
        _active[_key(experiment_id, run_id)] = cancel_event


def unregister_run(experiment_id: str, run_id: str) -> None:
    with _lock:
        _active.pop(_key(experiment_id, run_id), None)


def cancel_run(experiment_id: str, run_id: str) -> bool:
    with _lock:
        event = _active.get(_key(experiment_id, run_id))
    if event is None:
        return False
    event.set()
    return True


def is_run_active(experiment_id: str, run_id: str) -> bool:
    with _lock:
        return _key(experiment_id, run_id) in _active
