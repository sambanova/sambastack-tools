"""In-process registry of executing runs.

Each active run owns a :class:`RunControl` with two ``threading.Event`` signals
the executor's workers poll cooperatively:

  * **terminate** — a hard stop. The pool is shut down without waiting and any
    in-flight task is abandoned (its result is never written, so it re-runs on
    resume). Used by "Cancel Run" (→ status ``aborted``) and by "Terminate
    Threads" while paused (→ status stays ``paused``).
  * **pause** — a graceful drain. No new tasks are picked up, but tasks already
    in flight run to completion and their results are written. When the drain
    finishes the run is marked ``paused`` and can be resumed later.

A run whose ``run.json`` still says "running" but which is absent here has lost
its process (crash / restart) and is reconciled to "interrupted" by storage on
the next listing.

This state is per-process and does not survive a restart — by design.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field


@dataclass
class RunControl:
    """Cooperative stop signals for one executing run."""

    terminate: threading.Event = field(default_factory=threading.Event)
    pause: threading.Event = field(default_factory=threading.Event)


_lock = threading.Lock()
_active: dict[str, RunControl] = {}


def _key(experiment_id: str, run_id: str) -> str:
    return f"{experiment_id}/{run_id}"


def register_run(experiment_id: str, run_id: str, control: RunControl) -> None:
    with _lock:
        _active[_key(experiment_id, run_id)] = control


def unregister_run(experiment_id: str, run_id: str) -> None:
    with _lock:
        _active.pop(_key(experiment_id, run_id), None)


def cancel_run(experiment_id: str, run_id: str) -> bool:
    """Hard-stop a run: force the worker pool down without draining.

    Final status is ``aborted`` unless the run was already paused, in which case
    it stays ``paused`` (the abandoned tasks simply re-run on resume).
    """
    with _lock:
        control = _active.get(_key(experiment_id, run_id))
    if control is None:
        return False
    control.terminate.set()
    return True


def pause_run(experiment_id: str, run_id: str) -> bool:
    """Gracefully pause a run: stop picking up new tasks, drain the in-flight
    ones, then mark the run ``paused`` so it can be resumed."""
    with _lock:
        control = _active.get(_key(experiment_id, run_id))
    if control is None:
        return False
    control.pause.set()
    return True


def is_run_active(experiment_id: str, run_id: str) -> bool:
    with _lock:
        return _key(experiment_id, run_id) in _active
