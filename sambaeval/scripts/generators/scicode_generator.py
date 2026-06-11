"""SciCode execution OutputGenerator for SambaEval.

SciCode problems are scientific-coding tasks split into ordered sub-steps;
correctness is decided by *executing* the generated code against numeric
reference outputs (`target`) stored in `test_data.h5`. This generator
reproduces that flow for one problem per dataset row:

1. Look up the problem by `self.example_id` in the converted fixture
   (data/datasets/scicode/scicode_problems.jsonl).
2. Generate each sub-step sequentially, feeding the model's own previously
   generated code forward as context (the real SciCode setting). A few steps
   ship "given" code and are used as-is rather than generated.
3. Assemble a self-contained script (inlined h5 helpers + cumulative code +
   the step's test cases against the `target` values from test_data.h5) that
   always writes a PASS/FAIL verdict file, run it in the sandbox, read the
   verdict, and record pass/fail per sub-step.
4. Emit a "{passed}/{total} sub-steps passed" summary, prefixed "PASS" when
   every tested sub-step passes and "FAIL" otherwise. The experiment scores
   this with the heuristic scorer's `ratio:` mode, which reads that fraction
   and awards it as partial credit (e.g. 2/10 -> 0.2 of the row's weight).

REQUIRED ONE-TIME SETUP: download test_data.h5 (~1 GB) from
https://drive.google.com/drive/folders/1W5GZW6_bdiDAiipuFMqdUhvUaHIj6-pR
and set `test_data_h5_path` below to its local path. The file is intentionally
not committed to the repo (it is large and gitignored). See the SciCode
section of the README.

SECURITY: this generator EXECUTES model-generated Python. By default it runs
each step inside an ephemeral, network-less Podman container (via the
llm-sandbox library) — one fresh container per sub-step execution, torn down
immediately after (the "Option B" model). With the executor's worker pool this
naturally bounds concurrent containers to the pool size. There is no Docker
dependency: containers run on Podman, and mounts are passed as plain OCI dicts.
The backend is selectable with the SCICODE_SANDBOX env var:

    podman      (default) — ephemeral Podman container per execution
    subprocess  — UNSANDBOXED local subprocess (dev/CI only; see below)

Regardless of backend, two extra guards apply as defense-in-depth (NOT a
boundary): generated code is statically screened (AST) for disallowed imports
and dangerous builtins, and — for the local subprocess backend only — the
environment is scrubbed of secrets and POSIX resource limits are applied
(memory limits are NOT enforced on macOS). The subprocess backend is not a
security boundary; use it only for trusted benchmarks on a throwaway machine.

Container setup: build the sandbox image once (it bakes in numpy/scipy/sympy/
h5py so no network is needed at run time):

    podman build -t scicode-sandbox -f scripts/generators/scicode_sandbox.Dockerfile .

See the README's "Running model code safely" section for details.
"""

from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid

from base import OutputGenerator, ROOT, load_provider, run_cli


# ---------------------------------------------------------------------------
# >>> EDIT THIS <<<  Absolute path to your downloaded test_data.h5.
# ---------------------------------------------------------------------------
test_data_h5_path = "~/Downloads/test_data.h5"


GENERATORS_DIR = os.path.dirname(os.path.abspath(__file__))
FIXTURE_PATH = os.path.join(
    ROOT, "data", "datasets", "scicode", "scicode_problems.jsonl"
)

# The h5 reader / comparison helpers are inlined into each generated test
# script (rather than imported as a module) so the test is fully self-contained
# and identical across backends. Inlining also sidesteps a bug where
# llm-sandbox's import auto-scanner mishandles an unknown helper module name.
with open(
    os.path.join(GENERATORS_DIR, "scicode_test_utils.py"), encoding="utf-8"
) as _f:
    UTILS_SOURCE = _f.read()
STEP_TIMEOUT_SECONDS = 300
# Extra attempts to re-generate a sub-step whose response yields no code.
EMPTY_GENERATION_RETRIES = 2
# Include SciCode's per-step scientist background in the prompt (the
# "with-background" setting) when the fixture carries it. On by default; a no-op
# when `step_background` is empty. Set SCICODE_WITH_BACKGROUND=0 to force the
# harder no-background setting even when backgrounds are available.
WITH_BACKGROUND = os.environ.get(
    "SCICODE_WITH_BACKGROUND", "1"
).strip().lower() not in ("0", "false", "no", "")

# Code-execution backend: "podman" (default) | "subprocess".
SANDBOX_BACKEND = os.environ.get("SCICODE_SANDBOX", "podman").lower()
# Prebuilt sandbox image (see scripts/generators/scicode_sandbox.Dockerfile).
SANDBOX_IMAGE = os.environ.get("SCICODE_SANDBOX_IMAGE", "scicode-sandbox")
SANDBOX_MEM_LIMIT = os.environ.get("SCICODE_SANDBOX_MEM", "4g")
# Where test_data.h5 is mounted read-only inside the container.
H5_CONTAINER_PATH = "/data/test_data.h5"


def _resolved_h5_path() -> str:
    """Absolute host path to test_data.h5, expanding '~' and env vars."""
    return os.path.abspath(
        os.path.expandvars(os.path.expanduser(test_data_h5_path))
    )

# Resource limits applied to each test subprocess (POSIX only).
CPU_SECONDS = 120          # RLIMIT_CPU  (CPU time, not wall clock)
MAX_FILE_BYTES = 50 << 20  # RLIMIT_FSIZE (50 MB) — cap accidental disk writes
MAX_PROCESSES = 64         # RLIMIT_NPROC — blunt fork-bomb guard
MAX_ADDR_SPACE = 8 << 30   # RLIMIT_AS (8 GB) — NOT enforced on macOS

# --- AST static screen (defense-in-depth, not a boundary) ------------------
# Modules that are never acceptable in a generated solution.
DENY_MODULES = {
    "os", "sys", "subprocess", "socket", "shutil", "pathlib", "glob",
    "requests", "urllib", "http", "ftplib", "smtplib", "telnetlib", "asyncio",
    "ctypes", "cffi", "multiprocessing", "threading", "pickle", "marshal",
    "shelve", "importlib", "pty", "signal", "mmap", "fcntl", "resource",
    "gc", "builtins", "webbrowser", "tempfile",
}
# Stdlib modules considered safe enough to allow on top of the problem's
# declared dependencies (some models reach for these even when not listed).
ALLOWED_STDLIB = {
    "math", "cmath", "itertools", "functools", "collections", "typing",
    "fractions", "decimal", "numbers", "operator", "copy", "statistics",
    "heapq", "bisect", "array", "enum", "dataclasses", "abc", "warnings",
    "string", "re", "random", "json", "time",
}
# Builtins / globals that should not appear in a scientific function solution
# (checked as both calls and bare-name references).
DENY_BUILTINS = {
    "open", "exec", "eval", "compile", "__import__", "input", "breakpoint",
    "__builtins__", "globals", "vars",
}
# Attribute names used by sandbox-escape tricks.
DENY_DUNDER_ATTRS = {
    "__subclasses__", "__bases__", "__base__", "__mro__", "__globals__",
    "__builtins__", "__reduce__", "__reduce_ex__", "__getattribute__",
}


def _modules_in(code: str) -> set[str]:
    """Top-level module names imported by `code` (best effort)."""
    mods: set[str] = set()
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return mods
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                mods.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            mods.add(node.module.split(".")[0])
    return mods


def screen_code(code: str, allowed_modules: set[str]) -> list[str]:
    """Return a list of static-screening violations ([] = looks clean).

    Allowlist-first on imports (anything outside the problem's declared
    dependencies + a small safe stdlib set is rejected), plus a denylist of
    known-dangerous builtins and dunder-attribute escapes. This is a
    cheap pre-filter and quality signal — it is NOT a security boundary.
    """
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return [f"syntax error: {e.msg}"]

    reasons: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                _check_import(alias.name, allowed_modules, reasons)
        elif isinstance(node, ast.ImportFrom):
            if node.level != 0:
                reasons.append("uses a relative import")
            else:
                _check_import(node.module or "", allowed_modules, reasons)
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            if node.func.id in DENY_BUILTINS:
                reasons.append(f"calls disallowed builtin '{node.func.id}'")
        elif isinstance(node, ast.Name) and node.id in DENY_BUILTINS:
            reasons.append(f"references disallowed builtin '{node.id}'")
        elif isinstance(node, ast.Attribute) and node.attr in DENY_DUNDER_ATTRS:
            reasons.append(f"accesses disallowed attribute '{node.attr}'")
    return sorted(set(reasons))


def _check_import(module: str, allowed: set[str], reasons: list[str]) -> None:
    root = module.split(".")[0]
    if not root:
        return
    if root in DENY_MODULES:
        reasons.append(f"imports blocked module '{module}'")
    elif root not in allowed:
        reasons.append(f"imports module '{module}' not in allowed dependencies")


# --- subprocess hardening --------------------------------------------------
def _safe_env() -> dict:
    """Minimal environment with secrets stripped (no API keys, etc.)."""
    keep = ("PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP",
            "TMP", "SystemRoot", "SYSTEMROOT")
    return {k: os.environ[k] for k in keep if k in os.environ}


def _apply_limits() -> None:
    """preexec_fn: cap CPU/file-size/processes/memory in the child (POSIX).

    Note: RLIMIT_AS (address space / memory) is effectively NOT enforced on
    macOS, so the memory cap is best-effort there; CPU-time, file-size, and
    process-count limits do apply. Each setrlimit is guarded because some
    limits are unavailable or restricted on certain platforms.
    """
    import resource

    for res, limit in (
        ("RLIMIT_CPU", CPU_SECONDS),
        ("RLIMIT_FSIZE", MAX_FILE_BYTES),
        ("RLIMIT_NPROC", MAX_PROCESSES),
        ("RLIMIT_AS", MAX_ADDR_SPACE),
    ):
        rlimit = getattr(resource, res, None)
        if rlimit is None:
            continue
        try:
            resource.setrlimit(rlimit, (limit, limit))
        except (ValueError, OSError):
            pass


# --- helpers vendored from SciCode (gen/models.py, parse/parse.py) ---------
_PY_FENCE_RE = re.compile(r"```python\b[ \t]*\r?\n?(.*?)```", re.DOTALL)
_ANY_FENCE_RE = re.compile(r"```[ \t]*\r?\n?(.*?)```", re.DOTALL)
# Some upstream SciCode test cases import a helper from the `scicode` package
# (e.g. `from scicode.compare.cmp import cmp_tuple_or_list`). We vendor that
# helper via scicode_test_utils.py (inlined as UTILS_SOURCE), and never install
# the package, so such an import would raise ModuleNotFoundError and fail the
# step regardless of the model. The vendored name is already in scope, so the
# import is stripped from test cases before execution.
_SCICODE_IMPORT_RE = re.compile(r"^\s*(from|import)\s+scicode\b")


def extract_python_script(response: str) -> str:
    """Pull the final Python code block out of a model response.

    Reasoning models (e.g. MiniMax) often emit intermediate or empty draft
    fences earlier in their answer, so we take the LAST non-empty fenced block
    — the model's final answer — rather than the first. (The original SciCode
    helper took the first fence, which intermittently captured an empty draft
    and produced no code, cascading NameErrors through dependent sub-steps.)
    Prefers ```python fences, falls back to any ``` fence, then the raw text.
    """
    blocks = _PY_FENCE_RE.findall(response)
    if not blocks:
        blocks = _ANY_FENCE_RE.findall(response)
    if blocks:
        non_empty = [b for b in blocks if b.strip()]
        script = non_empty[-1] if non_empty else blocks[-1]
    else:
        script = response
    # Strip top-level imports; dependencies are prepended separately.
    return re.sub(
        r"^\s*(import .*|from .*\s+import\s+.*)", "", script, flags=re.MULTILINE
    )


def load_problem(example_id) -> dict | None:
    if example_id is None:
        return None
    target = str(example_id)
    with open(FIXTURE_PATH, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            prob = json.loads(line)
            if prob["problem_id"] == target:
                return prob
    return None


class SciCodeGenerator(OutputGenerator):
    @staticmethod
    def _step_description(step: dict) -> str:
        """A sub-step's description, with its SciCode scientist background
        appended when present and the with-background setting is on.

        The background carries the knowledge and conventions (e.g. the unit
        system a formula should use) the scientists deemed necessary for the
        step. Including it is SciCode's "with-background" setting; omitting it is
        the harder "no-background" setting. No-op when the fixture has no
        background for the step (so a background-less fixture behaves as before).
        """
        description = step["step_description_prompt"]
        background = (step.get("step_background") or "").strip()
        if WITH_BACKGROUND and background:
            return f"{description}\n\nBackground:\n{background}"
        return description

    def _build_step_prompt(
        self, sub_steps: list[dict], code_by_step: list[str], step_idx: int,
        dependencies: str,
    ) -> str:
        output_lines: list[str] = []
        for i in range(step_idx):
            output_lines.append(self._step_description(sub_steps[i]))
            output_lines.append(code_by_step[i])
            output_lines.append("------")
        problem_steps_str = "\n\n".join(output_lines[:-1])  # drop trailing sep

        step = sub_steps[step_idx]
        next_step_str = (
            self._step_description(step)
            + "\n\n"
            + f"{step['function_header']}\n\n{step['return_line']}"
        )
        return PROMPT_TEMPLATE.format(
            problem_steps_str=problem_steps_str,
            next_step_str=next_step_str,
            dependencies=dependencies,
        )

    def _generate_step_code(self, system_prompt: str, prompt: str) -> str:
        messages: list[dict] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})
        kwargs = self.completion_kwargs()
        # Intentionally do NOT set max_tokens: reasoning models (e.g.
        # MiniMax-M2.7) emit their chain-of-thought as ordinary content, so a
        # small cap truncates them mid-thought before any code block is
        # produced. Leave it unset so the provider's default applies, unless
        # the model's additional_kwargs explicitly sets one.
        #
        # Retry if extraction comes back empty. These models are not fully
        # deterministic even at temperature 0 / fixed seed, and occasionally
        # return a response with no usable code block; an empty step would
        # leave its function undefined and cascade NameErrors through every
        # dependent sub-step, so it is worth a couple of cheap re-rolls.
        for _ in range(EMPTY_GENERATION_RETRIES + 1):
            response = self.stream_completion(messages, **kwargs)
            code = extract_python_script(response)
            if code.strip():
                return code
        return code

    # Lines that build the per-sub-step test body shared by the production and
    # debugging script assemblers: append the h5 target loads + each test case.
    def _test_body_lines(
        self, cumulative_code: str, step_number: str,
        test_cases: list[str], h5_path: str,
    ) -> list[str]:
        guarded: list[str] = list(cumulative_code.splitlines())
        guarded.append(
            f"targets = process_hdf5_to_tuple({step_number!r}, "
            f"{len(test_cases)}, {h5_path!r})"
        )
        for idx, test in enumerate(test_cases):
            guarded.append(f"target = targets[{idx}]")
            guarded.extend(
                line for line in test.splitlines()
                if not _SCICODE_IMPORT_RE.match(line)
            )
        return guarded

    def _build_script(
        self, dependencies: str, cumulative_code: str, step_number: str,
        test_cases: list[str], h5_path: str, verdict_path: str,
    ) -> str:
        """Assemble a self-contained test script for one sub-step.

        The script inlines the h5/comparison helpers and runs the model's
        cumulative code plus the step's test assertions inside a
        try/except/finally that ALWAYS writes "PASS"/"FAIL" to `verdict_path`.
        The verdict file — not the process exit code — is the source of truth,
        because the sandbox exec path reports exit codes unreliably. `h5_path`
        and `verdict_path` are resolved for the execution environment (host
        paths for the subprocess backend, in-container paths for a sandbox).
        """
        guarded = self._test_body_lines(
            cumulative_code, step_number, test_cases, h5_path
        )
        guarded.append("_ok = True")
        lines = [
            UTILS_SOURCE,
            "",
            dependencies,
            "",
            "_ok = False",
            "try:",
            *(f"    {line}" for line in guarded),
            "except BaseException:",
            "    _ok = False",
            "finally:",
            f"    open({verdict_path!r}, 'w').write('PASS' if _ok else 'FAIL')",
            "",
        ]
        return "\n".join(lines)

    @staticmethod
    def _read_verdict(session, verdict_path: str) -> str:
        """Copy the PASS/FAIL verdict file back out of the container.

        The sandbox exec call's exit code is unreliable, so the script always
        writes a verdict file instead. We retry the copy briefly because the
        exec can return just before the file is flushed.
        """
        deadline = time.monotonic() + STEP_TIMEOUT_SECONDS
        with tempfile.TemporaryDirectory() as tmp:
            local = os.path.join(tmp, "verdict")
            while time.monotonic() < deadline:
                try:
                    session.copy_from_runtime(verdict_path, local)
                    with open(local, encoding="utf-8") as f:
                        return f.read().strip()
                except Exception:
                    time.sleep(0.3)
        return "TIMEOUT"

    def _run_step_tests(
        self, dependencies: str, cumulative_code: str, step_number: str,
        test_cases: list[str],
    ) -> tuple[bool, str]:
        """Execute one sub-step's tests. Returns (passed, error_summary)."""
        if SANDBOX_BACKEND == "podman":
            return self._run_in_sandbox(
                dependencies, cumulative_code, step_number, test_cases
            )
        if SANDBOX_BACKEND == "subprocess":
            return self._run_in_subprocess(
                dependencies, cumulative_code, step_number, test_cases
            )
        return False, (
            f"unknown SCICODE_SANDBOX backend {SANDBOX_BACKEND!r} "
            "(use 'podman' or 'subprocess')"
        )

    @staticmethod
    def _verdict_to_result(verdict: str) -> tuple[bool, str]:
        """Map a verdict-file string to (passed, error_summary).

        Handles the bare "PASS"/"FAIL"/"TIMEOUT" forms, plus the
        "FAIL\\n<traceback>" form that SciCodeDebugger's instrumented script
        writes, so the same parser serves both production and debugging.
        """
        if verdict == "PASS":
            return True, ""
        if verdict == "TIMEOUT":
            return False, "timed out (no verdict)"
        if verdict.startswith("FAIL"):
            detail = verdict[len("FAIL"):].lstrip("\n")
            return False, detail or "assertion failed or runtime error"
        return False, "assertion failed or runtime error"

    def _run_in_sandbox(
        self, dependencies: str, cumulative_code: str, step_number: str,
        test_cases: list[str],
    ) -> tuple[bool, str]:
        """Run the step in a fresh, network-less Podman container."""
        try:
            from llm_sandbox import SandboxSession
        except ImportError as e:
            return False, (
                f"podman backend needs llm-sandbox: {e}. "
                "Install it (pip install 'llm-sandbox[podman]') or set "
                "SCICODE_SANDBOX=subprocess."
            )

        run_id = uuid.uuid4().hex
        verdict_path = f"/sandbox/{run_id}.verdict"
        script = self._build_script(
            dependencies, cumulative_code, step_number, test_cases,
            h5_path=H5_CONTAINER_PATH, verdict_path=verdict_path,
        )
        # Hardening for executing untrusted, model-generated code. The real
        # isolation boundary is the container (the AST screen above is only a
        # quality filter); these knobs make a breakout harder and cap resource
        # abuse. All pass straight through to podman-py's container create, so no
        # image rebuild is required.
        #
        # NOTE: assumes Podman runs ROOTLESS — container-root is then a mapped
        # unprivileged host UID. Running rootful (root or `sudo podman`) weakens
        # every guard below.
        #
        # Several stronger guards are deliberately omitted because this
        # podman-py / crun stack can't apply them without breaking execution:
        #   - `tmpfs` is rejected by podman-py outright;
        #   - a read-only rootfs (`read_only=True`) fails at runtime here
        #     (crun "unlink /dev/console: Read-only file system") and would also
        #     need writable scratch, which on macOS can't be a system temp dir
        #     (the Podman VM only exposes $HOME);
        #   - `security_opt` is treated as SELinux labels, so "no-new-privileges"
        #     is invalid;
        #   - a non-root `user` can't write the verdict into the root-owned
        #     /sandbox workdir.
        # Rootless + cap_drop=ALL + no network + mem/pids/cpu/file-descriptor
        # caps keeps the boundary strong: container-root is an unprivileged host
        # UID with no capabilities and no network.
        runtime_configs = {
            # Mount the (large, gitignored) reference data read-only — never
            # copied into the container. Plain OCI mount dict (no docker-py).
            "mounts": [
                {
                    "type": "bind",
                    "source": _resolved_h5_path(),
                    "target": H5_CONTAINER_PATH,
                    "read_only": True,
                }
            ],
            "network_mode": "none",          # untrusted code gets no network
            "cap_drop": ["ALL"],             # scientific code needs no caps
            "mem_limit": SANDBOX_MEM_LIMIT,
            "pids_limit": 256,               # blunt fork-bomb guard
            # ~2 CPUs (quota/period in µs) so a step can't peg the host.
            "cpu_quota": 200000,
            "cpu_period": 100000,
            # Cap open files (and processes) to bound fd/fork exhaustion.
            # Generous enough not to break numpy/scipy/h5py imports. podman-py
            # expects capitalized ulimit keys (Name/Soft/Hard).
            "ulimits": [
                {"Name": "nofile", "Soft": 2048, "Hard": 4096},
                {"Name": "nproc", "Soft": 512, "Hard": 1024},
            ],
            "environment": {"MPLBACKEND": "Agg", "MPLCONFIGDIR": "/tmp"},
        }
        try:
            with SandboxSession(
                lang="python",
                backend="podman",
                image=SANDBOX_IMAGE,
                runtime_configs=runtime_configs,
                skip_environment_setup=True,  # image already has the stack
                # Own the kill deadline here rather than relying on llm-sandbox's
                # implicit default; expired execution is force-killed and raised
                # as an exception we turn into a step failure below.
                execution_timeout=STEP_TIMEOUT_SECONDS,
                verbose=False,
            ) as session:
                # run() handles writing + copying + executing the script. Its
                # exit code is unreliable on the Podman path, so we read the
                # verdict file the script always writes instead.
                session.run(script)
                verdict = self._read_verdict(session, verdict_path)
        except Exception as e:  # container/setup failure — surface it as a fail
            return False, f"sandbox error: {e}"

        return self._verdict_to_result(verdict)

    def _run_in_subprocess(
        self, dependencies: str, cumulative_code: str, step_number: str,
        test_cases: list[str],
    ) -> tuple[bool, str]:
        """UNSANDBOXED local execution. Not a security boundary — dev/CI only."""
        with tempfile.TemporaryDirectory() as tmp:
            verdict_path = os.path.join(tmp, "verdict")
            script = self._build_script(
                dependencies, cumulative_code, step_number, test_cases,
                h5_path=_resolved_h5_path(), verdict_path=verdict_path,
            )
            script_path = os.path.join(tmp, f"{step_number}.py")
            with open(script_path, "w", encoding="utf-8") as f:
                f.write(script)
            try:
                subprocess.run(
                    [sys.executable, script_path],
                    capture_output=True,
                    text=True,
                    timeout=STEP_TIMEOUT_SECONDS,
                    cwd=tmp,
                    env=_safe_env(),
                    preexec_fn=_apply_limits if os.name == "posix" else None,
                )
            except subprocess.TimeoutExpired:
                return False, "timeout"
            try:
                with open(verdict_path, encoding="utf-8") as f:
                    verdict = f.read().strip()
            except OSError:
                return False, "no verdict (script crashed before writing)"
            return self._verdict_to_result(verdict)

    # --- problem setup / generation (shared by scoring and debugging) ------
    def _problem_context(self):
        """Resolve `self.example_id` to (prob, dependencies, sub_steps,
        allowed_modules), or None if no such problem in the fixture.

        allowed_modules is the AST-screen allowlist: the problem's declared
        dependencies + safe stdlib, minus anything explicitly blocked.
        """
        prob = load_problem(self.example_id)
        if prob is None:
            return None
        dependencies = prob["required_dependencies"]
        sub_steps = prob["sub_steps"]
        allowed_modules = (
            _modules_in(dependencies) | ALLOWED_STDLIB
        ) - DENY_MODULES
        return prob, dependencies, sub_steps, allowed_modules

    def generate_all_steps(
        self, system_prompt: str, sub_steps: list[dict], dependencies: str,
    ) -> list[str]:
        """Generate (or take given) code for every sub-step, in order, so each
        step sees the prior steps' code as context. Returns code_by_step.

        Split out from `generate_output` so debugging can reuse it (or skip it
        entirely by passing previously generated code to `debug_steps`).
        """
        code_by_step: list[str] = []
        for idx, step in enumerate(sub_steps):
            if step.get("given_code"):
                code_by_step.append(step["given_code"])
                continue
            prompt = self._build_step_prompt(
                sub_steps, code_by_step, idx, dependencies
            )
            code_by_step.append(self._generate_step_code(system_prompt, prompt))
        return code_by_step

    def generate_output(self, system_prompt: str, messages: list[dict]) -> str:
        if not os.path.isfile(_resolved_h5_path()):
            return (
                "FAIL\ntest_data.h5 not found at "
                f"{_resolved_h5_path()!r}. Download it and set "
                "test_data_h5_path in scicode_generator.py (see the SciCode "
                "section of the README)."
            )

        ctx = self._problem_context()
        if ctx is None:
            return (
                f"FAIL\nNo SciCode problem with id {self.example_id!r} in the "
                "fixture. Re-run scripts/convert_scicode.py."
            )
        _prob, dependencies, sub_steps, allowed_modules = ctx

        # 1. Generate code for every sub-step.
        code_by_step = self.generate_all_steps(
            system_prompt, sub_steps, dependencies
        )

        # 2. Screen + test each (non-given) sub-step with cumulative code.
        passed, failed = [], []
        for idx, step in enumerate(sub_steps):
            if step.get("given_code"):
                continue  # given code is reference; SciCode does not test it
            violations = screen_code(code_by_step[idx], allowed_modules)
            if violations:
                failed.append(f"{step['step_number']} (screen: {violations[0]})")
                continue
            cumulative = (
                dependencies + "\n\n" + "\n\n".join(code_by_step[: idx + 1])
            )
            ok, _err = self._run_step_tests(
                dependencies, cumulative, step["step_number"], step["test_cases"]
            )
            (passed if ok else failed).append(step["step_number"])

        total = len(passed) + len(failed)
        if failed:
            return (
                f"FAIL\n{len(passed)}/{total} sub-steps passed; "
                f"failed steps: {', '.join(failed)}"
            )
        return f"PASS\n{len(passed)}/{total} sub-steps passed"


# SciCode's no-background prompt template (eval/data/multistep_template.txt).
PROMPT_TEMPLATE = """\
PROBLEM DESCRIPTION:
You will be provided with problem steps along with background knowledge necessary for solving the problem. Your task will be to develop a Python solution focused on the next step of the problem-solving process.

PROBLEM STEPS AND FUNCTION CODE:
Here, you'll find the Python code for the initial steps of the problem-solving process. This code is integral to building the solution.

{problem_steps_str}

NEXT STEP - PROBLEM STEP AND FUNCTION HEADER:
This part will describe the next step in the problem-solving process. A function header will be provided, and your task is to develop the Python code for this next step based on the provided description and function header.

{next_step_str}

DEPENDENCIES:
Use only the following dependencies in your solution. Do not include these dependencies at the beginning of your code.

{dependencies}

RESPONSE GUIDELINES:
Now, based on the instructions and information provided above, write the complete and executable Python program for the next step in a single block.
Your response should focus exclusively on implementing the solution for the next step, adhering closely to the specified function header and the context provided by the initial steps.
Your response should NOT include the dependencies and functions of all previous steps. If your next step function calls functions from previous steps, please make sure it uses the headers provided without modification.
DO NOT generate EXAMPLE USAGE OR TEST CODE in your response. Please make sure your response python code in format of ```python```."""


# ---------------------------------------------------------------------------
# Debugging
# ---------------------------------------------------------------------------
# Instrumentation prepended to a step's test script when running under
# SciCodeDebugger. The production runner collapses every failure into a bare
# "FAIL"; this shim makes a failing comparison raise with the *values* that
# diverged, so the captured traceback explains WHY a step failed (e.g. a wrong
# physical constant produces "actual[:8]=[178. ...] target[:8]=[179. ...]")
# instead of an opaque AssertionError. Wrapped in try/except so a problem whose
# tests don't use numpy / cmp_tuple_or_list is unaffected.
_DEBUG_COMPARISON_SHIMS = '''
# --- SciCodeDebugger instrumentation: surface actual-vs-target on mismatch ---
try:
    import numpy as _np_dbg
    _orig_allclose = _np_dbg.allclose
    def _dbg_allclose(a, b, *args, **kwargs):
        ok = _orig_allclose(a, b, *args, **kwargs)
        if not ok:
            try:
                _a = _np_dbg.ravel(_np_dbg.asarray(a, dtype=float))[:8].tolist()
                _b = _np_dbg.ravel(_np_dbg.asarray(b, dtype=float))[:8].tolist()
                _msg = "actual[:8]=%r target[:8]=%r" % (_a, _b)
            except Exception:
                _msg = "actual=%r target=%r" % (a, b)
            raise AssertionError("np.allclose mismatch: " + _msg)
        return ok
    _np_dbg.allclose = _dbg_allclose
except Exception:
    pass
try:
    _orig_cmp_tuple_or_list = cmp_tuple_or_list
    def cmp_tuple_or_list(v1, v2):
        r = _orig_cmp_tuple_or_list(v1, v2)
        if not r:
            raise AssertionError(
                "cmp_tuple_or_list mismatch: actual=%r target=%r" % (v1, v2)
            )
        return r
except Exception:
    pass
'''


class SciCodeDebugger(SciCodeGenerator):
    """A SciCodeGenerator that explains *why* sub-steps fail.

    SciCodeGenerator collapses each problem into a PASS/FAIL summary, which is
    all the scorer needs but useless for debugging. This subclass reuses the
    exact same generation and sandboxed-execution machinery but:

      * runs every step's tests through an instrumented script that captures
        the full traceback (and the diverging actual-vs-target values for
        numeric comparisons) instead of swallowing it into "FAIL";
      * separates the slow generation step from the cheap re-test/inspect step,
        with optional on-disk caching of generated code, so you can iterate on
        diagnosis without re-calling the model;
      * returns structured per-step reports (and pretty-prints them).

    Typical use (in a REPL or a throwaway script)::

        from scicode_generator import SciCodeDebugger
        dbg = SciCodeDebugger.for_example("12")
        code, reports = dbg.run(system_prompt=SYS, cache_path="/tmp/p12.json")
        print(dbg.format_report(reports))
        # ...tweak code[i] by hand, then re-test without regenerating:
        print(dbg.format_report(dbg.diagnose(code, step_numbers=["12.1"])))

    Execution respects the SCICODE_SANDBOX backend like the base class; for
    quick local debugging `SCICODE_SANDBOX=subprocess` is usually fastest.
    """

    @classmethod
    def for_example(
        cls, example_id, *, provider_name: str = "SambaNova",
        model_name: str = "MiniMax-M2.7", temperature: float = 0.0,
        seed: int | None = 42,
    ) -> "SciCodeDebugger":
        """Build a debugger for one problem id, loading the provider from
        data/providers.json. Defaults match the scicode_example experiment."""
        provider = load_provider(provider_name)
        model = {
            "name": model_name, "temperature": temperature,
            "seed": seed, "provider_name": provider_name,
        }
        dbg = cls(provider, model)
        dbg.example_id = str(example_id)
        return dbg

    # Always instrument: a debugger exists to explain failures. Production code
    # paths (generate_output) still work on an instance of this class because
    # _verdict_to_result understands the "FAIL\n<traceback>" form too.
    def _build_script(
        self, dependencies: str, cumulative_code: str, step_number: str,
        test_cases: list[str], h5_path: str, verdict_path: str,
    ) -> str:
        guarded = self._test_body_lines(
            cumulative_code, step_number, test_cases, h5_path
        )
        guarded.append("_ok = True")
        lines = [
            UTILS_SOURCE,
            "",
            dependencies,
            "",
            _DEBUG_COMPARISON_SHIMS,
            "",
            "_ok = False",
            "_err = ''",
            "try:",
            *(f"    {line}" for line in guarded),
            "except BaseException:",
            "    _ok = False",
            "    import traceback as _tb",
            "    _err = _tb.format_exc()",
            "finally:",
            f"    open({verdict_path!r}, 'w').write("
            "'PASS' if _ok else 'FAIL\\n' + _err)",
            "",
        ]
        return "\n".join(lines)

    def generate(
        self, system_prompt: str, *, cache_path: str | None = None,
        use_cache: bool = True,
    ) -> list[str]:
        """Generate code for every sub-step (the slow, model-bound step).

        If `cache_path` is given and exists (and `use_cache`), the generated
        code is loaded from there instead of re-calling the model; otherwise it
        is generated and written to `cache_path` for next time.
        """
        if cache_path and use_cache and os.path.isfile(cache_path):
            with open(cache_path, encoding="utf-8") as f:
                return json.load(f)
        ctx = self._problem_context()
        if ctx is None:
            raise ValueError(
                f"No SciCode problem with id {self.example_id!r} in the fixture."
            )
        _prob, dependencies, sub_steps, _allowed = ctx
        code_by_step = self.generate_all_steps(
            system_prompt, sub_steps, dependencies
        )
        if cache_path:
            with open(cache_path, "w", encoding="utf-8") as f:
                json.dump(code_by_step, f)
        return code_by_step

    def diagnose(
        self, code_by_step: list[str], step_numbers: list[str] | None = None,
    ) -> list[dict]:
        """Re-screen and re-run already-generated step code; return a per-step
        diagnostic that surfaces *why* each step failed. Does NOT call the
        model — pass the `code_by_step` from `generate()` (or a cached copy).

        `step_numbers` optionally restricts which sub-steps run (e.g. ["12.1"]).
        Each report dict has: {step_number, status, code, screen_violations,
        error}, where status is 'pass' | 'fail' | 'screen_fail' | 'given' and
        `error` is the captured traceback (with actual-vs-target values) for a
        'fail'.
        """
        ctx = self._problem_context()
        if ctx is None:
            raise ValueError(
                f"No SciCode problem with id {self.example_id!r} in the fixture."
            )
        _prob, dependencies, sub_steps, allowed_modules = ctx

        reports: list[dict] = []
        for idx, step in enumerate(sub_steps):
            sn = step["step_number"]
            if step_numbers is not None and sn not in step_numbers:
                continue
            code = code_by_step[idx]
            if step.get("given_code"):
                reports.append(self._report(sn, "given", code))
                continue
            violations = screen_code(code, allowed_modules)
            if violations:
                reports.append(self._report(
                    sn, "screen_fail", code, screen_violations=violations
                ))
                continue
            cumulative = (
                dependencies + "\n\n" + "\n\n".join(code_by_step[: idx + 1])
            )
            ok, err = self._run_step_tests(
                dependencies, cumulative, sn, step["test_cases"]
            )
            reports.append(self._report(
                sn, "pass" if ok else "fail", code,
                error="" if ok else err,
            ))
        return reports

    def run(
        self, system_prompt: str | None = None, *,
        code_by_step: list[str] | None = None,
        cache_path: str | None = None,
        step_numbers: list[str] | None = None,
    ) -> tuple[list[str], list[dict]]:
        """Convenience: generate (unless `code_by_step` is supplied) then
        diagnose. Returns (code_by_step, reports). Keep the returned
        `code_by_step` to re-`diagnose()` without regenerating."""
        if code_by_step is None:
            if system_prompt is None:
                raise ValueError(
                    "Pass system_prompt to generate, or code_by_step to reuse "
                    "already-generated code."
                )
            code_by_step = self.generate(system_prompt, cache_path=cache_path)
        return code_by_step, self.diagnose(code_by_step, step_numbers)

    @staticmethod
    def _report(
        step_number: str, status: str, code: str, *,
        screen_violations: list[str] | None = None, error: str = "",
    ) -> dict:
        return {
            "step_number": step_number, "status": status, "code": code,
            "screen_violations": screen_violations or [], "error": error,
        }

    @staticmethod
    def format_report(reports: list[dict], *, full_traceback: bool = False) -> str:
        """One line per sub-step: status + the last traceback line (or the full
        traceback when `full_traceback`). Ends with a pass/total tally."""
        lines: list[str] = []
        n_pass = n_total = 0
        for r in reports:
            status = r["status"]
            if status in ("pass", "fail"):
                n_total += 1
                n_pass += status == "pass"
            if status == "screen_fail":
                detail = f"screen: {r['screen_violations'][0]}"
            elif r["error"]:
                detail = (
                    r["error"].strip() if full_traceback
                    else r["error"].strip().splitlines()[-1]
                )
            else:
                detail = ""
            lines.append(f"{r['step_number']:>7} | {status:<11} | {detail}")
        lines.append(f"\n{n_pass}/{n_total} sub-steps passed")
        return "\n".join(lines)


if __name__ == "__main__":
    run_cli(SciCodeGenerator)
