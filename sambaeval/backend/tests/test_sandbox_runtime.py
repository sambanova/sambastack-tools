"""Tests for the Podman sandbox lifecycle (scripts/generators/sandbox_runtime.py).

Two layers:

  * **Logic tests (default, CI-safe).** Every ``podman`` invocation is stubbed
    by a fake that models a VM's state/memory, so these run fully offline with
    no Podman installed — exactly the ``ubuntu-latest`` GitHub Actions runner,
    where ``podman machine`` doesn't even apply. They assert the *decisions*:
    a stopped VM is right-sized THEN started THEN polled until reachable; a
    running VM is a no-op; auto-start-disabled and no-machine both raise; and
    concurrency is capped with a warning.

  * **Integration test (opt-in, skipped in CI).** Guarded behind
    ``SCICODE_PODMAN_INTEGRATION=1`` so it only runs when a developer explicitly
    asks for it on a machine with Podman — it actually starts the VM. It never
    runs on Actions.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

# sandbox_runtime lives in scripts/generators/, imported the same way the
# executor's in-process loader reaches its generators.
_GENERATORS = Path(__file__).resolve().parents[2] / "scripts" / "generators"
if str(_GENERATORS) not in sys.path:
    sys.path.insert(0, str(_GENERATORS))

import sandbox_runtime as sr  # noqa: E402


class FakePodman:
    """Stand-in for ``sandbox_runtime._podman`` that models one VM.

    Records every argv it is called with (``calls``) and answers ``info`` /
    ``machine inspect|set|start`` from in-memory state, so a test can assert the
    exact command sequence the lifecycle issued.
    """

    def __init__(self, *, running=False, memory=2048, machine_exists=True,
                 start_ok=True):
        self.running = running
        self.memory = memory
        self.machine_exists = machine_exists
        self.start_ok = start_ok
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, *args, timeout=30.0):
        self.calls.append(args)

        def cp(rc=0, out="", err=""):
            return subprocess.CompletedProcess(args, rc, out, err)

        if args == ("info",):
            return cp(0 if self.running else 1)
        if args[:2] == ("machine", "inspect"):
            if not self.machine_exists:
                return cp(1, err="no such machine")
            state = "running" if self.running else "stopped"
            return cp(0, out=json.dumps(
                [{"State": state, "Resources": {"Memory": self.memory}}]
            ))
        if args[:2] == ("machine", "set"):
            for a in args:
                if a.startswith("--memory="):
                    self.memory = int(a.split("=", 1)[1])
            return cp(0)
        if args[:2] == ("machine", "start"):
            if not self.start_ok:
                return cp(1, err="boot failed")
            self.running = True  # subsequent `info` now succeeds
            return cp(0)
        return cp(0)

    # Convenience views over the recorded argv.
    def did(self, *prefix: str) -> bool:
        return any(c[:len(prefix)] == prefix for c in self.calls)

    def index_of(self, *prefix: str) -> int:
        for i, c in enumerate(self.calls):
            if c[:len(prefix)] == prefix:
                return i
        return -1


@pytest.fixture(autouse=True)
def _reset_module_state(monkeypatch):
    """Each test starts with a not-ready module and auto-start on."""
    monkeypatch.setattr(sr, "_ready", False)
    monkeypatch.setattr(sr, "AUTO_START", True)
    monkeypatch.setattr(sr, "MACHINE", "podman-machine-default")
    # Polling never actually sleeps in these tests (the fake reconnects
    # immediately after start), but guard against a real sleep just in case.
    monkeypatch.setattr(sr.time, "sleep", lambda *_: None)
    # These tests model the podman CLI with FakePodman, so the binary is
    # "present" by definition. Stubbed explicitly so the suite stays green on a
    # host without Podman installed (e.g. the ubuntu-latest CI runner).
    monkeypatch.setattr(sr, "_podman_binary", lambda: "/usr/bin/podman")
    yield


def _install(monkeypatch, fake: FakePodman) -> FakePodman:
    monkeypatch.setattr(sr, "_podman", fake)
    return fake


# --------------------------------------------------------------------------- #
# ensure_podman_ready
# --------------------------------------------------------------------------- #
def test_stopped_vm_is_rightsized_then_started_then_ready(monkeypatch):
    fake = _install(monkeypatch, FakePodman(running=False, memory=2048))

    sr.ensure_podman_ready()

    assert sr._ready is True
    # Right-sized up to the cap, and BEFORE the machine was started
    # (`machine set` only applies to a stopped VM).
    assert fake.memory == sr.VM_MEMORY_MB
    set_i = fake.index_of("machine", "set", f"--memory={sr.VM_MEMORY_MB}")
    start_i = fake.index_of("machine", "start")
    assert set_i != -1 and start_i != -1 and set_i < start_i
    # And it polled the daemon (info) after starting.
    assert fake.did("info")


def test_running_vm_is_a_noop(monkeypatch):
    fake = _install(monkeypatch, FakePodman(running=True, memory=4096))

    sr.ensure_podman_ready()

    assert sr._ready is True
    assert not fake.did("machine", "start")
    assert not fake.did("machine", "set")


def test_already_large_vm_is_not_resized(monkeypatch):
    fake = _install(monkeypatch, FakePodman(running=False, memory=8192))

    sr.ensure_podman_ready()

    assert sr._ready is True
    assert fake.memory == 8192  # a deliberately larger VM is left alone
    assert not fake.did("machine", "set")
    assert fake.did("machine", "start")


def test_autostart_disabled_raises_without_starting(monkeypatch):
    monkeypatch.setattr(sr, "AUTO_START", False)
    fake = _install(monkeypatch, FakePodman(running=False))

    with pytest.raises(sr.SandboxUnavailable, match="auto-start is disabled"):
        sr.ensure_podman_ready()

    assert sr._ready is False
    assert not fake.did("machine", "start")


def test_no_machine_and_no_daemon_raises(monkeypatch):
    fake = _install(monkeypatch, FakePodman(running=False, machine_exists=False))

    with pytest.raises(sr.SandboxUnavailable, match="no machine to start"):
        sr.ensure_podman_ready()

    assert sr._ready is False
    assert not fake.did("machine", "start")


def test_failed_start_raises(monkeypatch):
    _install(monkeypatch, FakePodman(running=False, start_ok=False))

    with pytest.raises(sr.SandboxUnavailable, match="failed"):
        sr.ensure_podman_ready()

    assert sr._ready is False


def test_ready_is_cached_second_call_touches_no_podman(monkeypatch):
    fake = _install(monkeypatch, FakePodman(running=False))
    sr.ensure_podman_ready()
    calls_after_first = len(fake.calls)

    sr.ensure_podman_ready()  # cached fast path

    assert len(fake.calls) == calls_after_first  # no further podman calls


# --------------------------------------------------------------------------- #
# cap_concurrency
# --------------------------------------------------------------------------- #
def test_missing_podman_binary_raises_before_touching_the_cli(monkeypatch):
    """No podman on PATH (e.g. the worker running inside a compose container)
    fails fast with runtime-specific guidance, without shelling out at all."""
    fake = _install(monkeypatch, FakePodman(running=True))
    monkeypatch.setattr(sr, "_podman_binary", lambda: None)

    with pytest.raises(sr.SandboxUnavailable) as excinfo:
        sr.ensure_podman_ready()

    assert "no `podman` executable" in str(excinfo.value)
    assert "native host process" in str(excinfo.value)
    assert fake.calls == []       # never shelled out
    assert sr._ready is False


def test_cap_concurrency_clamps_and_warns_above_max(caplog):
    with caplog.at_level("WARNING"):
        assert sr.cap_concurrency(sr.MAX_CONTAINERS + 4) == sr.MAX_CONTAINERS
    assert "at most" in caplog.text


def test_cap_concurrency_passes_through_at_or_below_max(caplog):
    with caplog.at_level("WARNING"):
        assert sr.cap_concurrency(sr.MAX_CONTAINERS) == sr.MAX_CONTAINERS
        assert sr.cap_concurrency(1) == 1
    assert caplog.text == ""  # no warning when within the cap


def test_sizing_invariant_containers_fit_the_vm():
    # The whole point of the caps: MAX_CONTAINERS of PER_CONTAINER_MB fit under
    # the VM ceiling with headroom left for the VM itself.
    assert sr.MAX_CONTAINERS * sr.PER_CONTAINER_MB < sr.VM_MEMORY_MB
    assert sr.container_slots._value == sr.MAX_CONTAINERS


# --------------------------------------------------------------------------- #
# opt-in real-podman integration (skipped by default and on CI)
# --------------------------------------------------------------------------- #
@pytest.mark.skipif(
    os.environ.get("SCICODE_PODMAN_INTEGRATION") != "1",
    reason="opt-in: starts a real Podman VM; not run in CI "
           "(set SCICODE_PODMAN_INTEGRATION=1 on a host with Podman)",
)
def test_real_podman_starts_and_connects():
    sr._ready = False
    sr.ensure_podman_ready()  # real subprocess calls — actually starts the VM
    assert sr._connects() is True
    assert sr._machine_field("State") == "running"
    mem = sr._machine_field("Memory")
    assert mem is not None and mem >= sr._MIN_VM_MEMORY_MB


# --------------------------------------------------------------------------- #
# verdict plumbing — a failing step must say WHY
# --------------------------------------------------------------------------- #
def _scicode():
    import scicode_generator  # noqa: PLC0415 — same sys.path shim as sandbox_runtime

    return scicode_generator


def test_build_script_records_the_exception_type():
    """Without this the verdict is a bare 'FAIL' and a wrong answer from the
    model is indistinguishable from a broken harness (bad test_data.h5 key,
    ImportError) — both score 0 with the same opaque message."""
    g = _scicode()
    gen = g.SciCodeGenerator.__new__(g.SciCodeGenerator)
    src = g.SciCodeGenerator._build_script(
        gen, "import numpy as np", "", "10.1", ["assert target is not None"],
        h5_path="/data/test_data.h5", verdict_path="/sandbox/v",
    )
    assert "except BaseException as _e:" in src
    assert "format_exception_only" in src
    assert "'FAIL\\n' + _err" in src


def test_verdict_parser_surfaces_the_detail():
    g = _scicode()
    assert g.SciCodeGenerator._verdict_to_result("PASS") == (True, "")
    assert g.SciCodeGenerator._verdict_to_result("FAIL\nAssertionError") == (
        False, "AssertionError",
    )
    assert g.SciCodeGenerator._verdict_to_result("FAIL\nKeyError: 'nope'") == (
        False, "KeyError: 'nope'",
    )
    # A detail-less FAIL still degrades to the generic message.
    assert g.SciCodeGenerator._verdict_to_result("FAIL")[1] == (
        "assertion failed or runtime error"
    )
    assert g.SciCodeGenerator._verdict_to_result("TIMEOUT")[1] == "timed out (no verdict)"
