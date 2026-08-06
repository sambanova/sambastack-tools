"""Deterministic, offline output generator for the test suite.

Hits no provider and needs no API key: ``generate_output`` returns the content
of the last user message verbatim ("echo"). A dataset row whose
``expected_output`` equals that content therefore scores a deterministic 1.0
under the heuristic scorer, which lets the tests assert on exact results.

Optional concurrency gate (used by the pause / terminate tests)
---------------------------------------------------------------
When ``SAMBAEVAL_TEST_GATE_DIR`` is set, each call blocks *after* it has been
admitted to the pool so a test can pin down exactly which tasks are in flight:

  1. it touches ``<gate>/started-<example_id>`` to announce it has begun;
  2. it then spins until ``<gate>/release`` appears (or a safety timeout).

A test starts a run, waits until N ``started-*`` markers exist (so it knows
exactly N tasks are mid-flight and parked), fires pause/terminate, then creates
``release`` to let the parked tasks drain. This makes the concurrency behaviour
deterministic without relying on sleep/timing races.

The gate is inert when the env var is unset, so non-gated tests run instantly.
"""

from __future__ import annotations

import os
import time

from base import OutputGenerator, run_cli

_GATE_POLL_S = 0.02
# Safety valve so a misbehaving test can never hang CI forever.
_GATE_TIMEOUT_S = 30.0


class EchoGenerator(OutputGenerator):
    def generate_output(self, system_prompt: str, messages: list[dict]) -> str:
        self._gate()
        last_user = ""
        for m in messages:
            if m.get("role") == "user":
                last_user = m.get("content") or ""
        return last_user

    def _gate(self) -> None:
        gate_dir = os.environ.get("SAMBAEVAL_TEST_GATE_DIR")
        if not gate_dir:
            return
        started = os.path.join(gate_dir, f"started-{self.example_id}")
        release = os.path.join(gate_dir, "release")
        with open(started, "w", encoding="utf-8") as f:
            f.write("1")
        deadline = time.monotonic() + _GATE_TIMEOUT_S
        while not os.path.exists(release):
            if time.monotonic() > deadline:
                return
            time.sleep(_GATE_POLL_S)


if __name__ == "__main__":
    run_cli(EchoGenerator)
