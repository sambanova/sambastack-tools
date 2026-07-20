"""Podman sandbox lifecycle for the SciCode code-execution backend.

The SciCode scorer runs each model's generated code inside a rootless Podman
container. Those containers all live in ONE shared Podman VM (a host
singleton, ``podman-machine-default``) — there is never more than one VM, and
each sub-step gets its own short-lived container inside it.

This module owns two concerns the generator itself shouldn't:

  * bringing that single VM up before any container runs (``ensure_podman_ready``)
    — auto-started and right-sized on demand, idempotently and thread-safely, so
    a run no longer silently scores every step 0 just because the VM was down; and
  * bounding parallelism (``cap_concurrency`` + ``container_slots``) so at most
    ``MAX_CONTAINERS`` containers run at once and their memory fits the VM.

Sizing is chosen so the parallel containers fit the VM without oversubscription:
``MAX_CONTAINERS * PER_CONTAINER_MB`` (plus VM overhead) stays under
``VM_MEMORY_MB``. The VM is grown toward ``VM_MEMORY_MB`` when it is smaller,
but never sized above it (the "no more than 4 GB" cap); a VM a user has
deliberately made larger is left alone.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
import time

log = logging.getLogger(__name__)

# --- sizing knobs ----------------------------------------------------------
# The Podman sandbox is memory-bound: this experiment supports at most
# MAX_CONTAINERS parallel containers, each capped at PER_CONTAINER_MB, inside a
# VM sized to VM_MEMORY_MB (the hard ceiling — we never grow the VM past it).
MAX_CONTAINERS = 4
PER_CONTAINER_MB = 800
VM_MEMORY_MB = 4096  # hard cap: never size the shared VM above 4 GB
# Memory the VM must have to fit MAX_CONTAINERS in parallel (container RAM only;
# the VM's own overhead is the headroom between this and VM_MEMORY_MB).
_MIN_VM_MEMORY_MB = MAX_CONTAINERS * PER_CONTAINER_MB  # 3200

# --- behaviour knobs (overridable for CI / headless) -----------------------
AUTO_START = os.environ.get("SCICODE_AUTO_START_PODMAN", "1").strip().lower() not in (
    "0", "false", "no", "",
)
START_TIMEOUT = int(os.environ.get("SCICODE_PODMAN_START_TIMEOUT", "180"))
MACHINE = os.environ.get("SCICODE_PODMAN_MACHINE", "podman-machine-default")

# One shared VM ⇒ start it at most once. `_lock` serialises concurrent tasks
# (the executor runs a thread pool in-process) racing to start it; `_ready`
# is the fast path once it is up. `container_slots` is the hard backstop that
# keeps concurrent containers at MAX_CONTAINERS no matter what concurrency the
# caller was told to use.
_lock = threading.Lock()
_ready = False
container_slots = threading.BoundedSemaphore(MAX_CONTAINERS)


class SandboxUnavailable(RuntimeError):
    """The Podman sandbox could not be made ready (auto-start failed/timed out)."""


def _podman(*args: str, timeout: float = 30.0) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["podman", *args], capture_output=True, text=True, timeout=timeout
    )


def _connects() -> bool:
    """True if the Podman daemon answers (VM up, or native-Linux daemon)."""
    try:
        return _podman("info").returncode == 0
    except Exception:
        return False


def _machine_field(field: str):
    """Return one field of the shared VM's inspect record, or None if there is
    no machine (e.g. native Linux) or it can't be read."""
    try:
        r = _podman("machine", "inspect", MACHINE)
        if r.returncode != 0:
            return None
        data = json.loads(r.stdout)
        if not data:
            return None
        record = data[0]
        if field == "State":
            return (record.get("State") or "").lower() or None
        if field == "Memory":
            mem = (record.get("Resources") or {}).get("Memory")
            return int(mem) if mem is not None else None
    except Exception:
        return None
    return None


def _rightsize_stopped_machine() -> None:
    """Grow the (stopped) VM toward VM_MEMORY_MB. No-op if already >= it.

    `podman machine set` only applies to a stopped machine, so this runs on the
    auto-start path before `machine start`. Failure is non-fatal — we log and
    start with whatever the VM has (the undersize warning fires later).
    """
    current = _machine_field("Memory")
    if current is None or current >= VM_MEMORY_MB:
        return
    r = _podman("machine", "set", f"--memory={VM_MEMORY_MB}", MACHINE)
    if r.returncode == 0:
        log.info(
            "Right-sized Podman VM %s memory %d MiB -> %d MiB",
            MACHINE, current, VM_MEMORY_MB,
        )
    else:
        log.warning(
            "Could not right-size Podman VM %s (%s); starting as-is",
            MACHINE, (r.stderr or "").strip(),
        )


def _warn_if_undersized() -> None:
    current = _machine_field("Memory")
    if current is not None and current < _MIN_VM_MEMORY_MB:
        log.warning(
            "Podman VM %s has %d MiB but %d parallel containers need ~%d MiB. "
            "Stop the VM and re-run to let it right-size, or lower concurrency.",
            MACHINE, current, MAX_CONTAINERS, _MIN_VM_MEMORY_MB,
        )


def ensure_podman_ready() -> None:
    """Idempotently bring the shared Podman VM up (and right-sized), waiting
    until it actually answers. Safe to call from many threads.

    Raises ``SandboxUnavailable`` if the VM can't be made ready — the caller
    (backend preflight) turns that into a run-level abort instead of letting
    every task fail with a silent zero.
    """
    global _ready
    if _ready:
        return
    with _lock:
        if _ready:  # another thread started it while we waited on the lock
            return
        if _connects():  # already running, or native-Linux daemon
            _warn_if_undersized()
            _ready = True
            return

        state = _machine_field("State")
        if state is None:
            raise SandboxUnavailable(
                "Podman is not reachable and there is no machine to start. "
                "Start the Podman daemon, or set SCICODE_SANDBOX=subprocess."
            )
        if not AUTO_START:
            raise SandboxUnavailable(
                f"Podman machine {MACHINE!r} is not running and auto-start is "
                "disabled. Run `podman machine start`, or set "
                "SCICODE_SANDBOX=subprocess."
            )
        if state == "stopped":
            _rightsize_stopped_machine()
            log.info("Auto-starting Podman machine %s ...", MACHINE)
            try:
                r = _podman("machine", "start", MACHINE, timeout=START_TIMEOUT)
            except subprocess.TimeoutExpired:
                raise SandboxUnavailable(
                    f"`podman machine start {MACHINE}` timed out after "
                    f"{START_TIMEOUT}s."
                )
            if r.returncode != 0:
                raise SandboxUnavailable(
                    f"`podman machine start {MACHINE}` failed: "
                    f"{(r.stderr or '').strip()}"
                )

        # `machine start` returns once the VM is up, but poll the daemon socket
        # to be sure it actually answers before we hand it containers.
        deadline = time.monotonic() + START_TIMEOUT
        while time.monotonic() < deadline:
            if _connects():
                _warn_if_undersized()
                _ready = True
                return
            time.sleep(2)
        raise SandboxUnavailable(
            f"Podman machine {MACHINE!r} started but did not become reachable "
            f"within {START_TIMEOUT}s."
        )


def cap_concurrency(requested: int) -> int:
    """Clamp a requested concurrency to what the Podman sandbox supports,
    warning once when the caller asked for more than MAX_CONTAINERS."""
    if requested > MAX_CONTAINERS:
        log.warning(
            "This experiment runs in the Podman sandbox, which supports at most "
            "%d parallel containers; capping concurrency %d -> %d for this run.",
            MAX_CONTAINERS, requested, MAX_CONTAINERS,
        )
        return MAX_CONTAINERS
    return requested
