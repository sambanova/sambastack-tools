"""Convert the SciCode benchmark into the format SambaEval consumes.

SciCode (https://scicode-bench.github.io/) is a scientific-code-generation
benchmark: 80 research problems, each decomposed into ordered sub-steps. A
step is solved by writing a Python function; correctness is checked by
*executing* the function against numeric reference outputs (the `target`
values stored in `test_data.h5`). The real metric is therefore pass/fail
from running code, not text similarity — so there are no "gold answer
strings" to put in `expected_output`; instead `expected_output` is the
literal "PASS" and the scicode_generator runs the tests to decide PASS/FAIL.

This script reads the upstream `problems_all.jsonl` (plus the three hard-coded
"given code" snippets that SciCode injects for problems 13/62/76) and emits:

1. data/datasets/scicode_dev.jsonl  (15 problems)
   data/datasets/scicode_test.jsonl (65 problems)
       The SambaEval datasets — one row per problem:
       {example_id, prompt, expected_output, weight}. These mirror SciCode's
       official dev/test splits: every problem in problems_dev.jsonl goes to
       scicode_dev.jsonl, every problem in problems_test.jsonl to
       scicode_test.jsonl. `example_id` is int(problem_id); the generator uses
       it to look up the problem's sub-steps and tests in the fixture below.

2. data/datasets/scicode/scicode_problems.jsonl
       A self-contained runtime fixture (ALL 80 problems) read by
       scripts/generators/scicode_generator.py: per problem, the ordered
       sub-steps (description, function header, return line, test cases),
       the allowed dependencies, and any injected "given code". This folds
       in everything the generator needs so the loose upstream files
       (problems_all.jsonl, the *.txt snippets) can be deleted.

Usage:
    python scripts/convert_scicode.py   # writes scicode_dev + scicode_test
"""

from __future__ import annotations

import argparse
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCICODE_DIR = os.path.join(ROOT, "data", "datasets", "scicode")
# Legacy single-file source (no backgrounds). Kept as a fallback so the
# committed problem ordering is preserved when present.
SOURCE_JSONL = os.path.join(SCICODE_DIR, "problems_all.jsonl")
# Official HuggingFace source (SciCode1/SciCode): these carry the scientist
# annotated `step_background` the legacy file lacks. See the folder README.
SOURCE_DEV = os.path.join(SCICODE_DIR, "problems_dev.jsonl")
SOURCE_TEST = os.path.join(SCICODE_DIR, "problems_test.jsonl")

DATASET_DEV_OUT = os.path.join(ROOT, "data", "datasets", "scicode_dev.jsonl")
DATASET_TEST_OUT = os.path.join(ROOT, "data", "datasets", "scicode_test.jsonl")
FIXTURE_OUT = os.path.join(SCICODE_DIR, "scicode_problems.jsonl")

# Steps whose code SciCode provides rather than asking the model to generate.
# Keyed by (problem_id, step_number) -> snippet filename in the scicode dir.
# See SciCode eval/scripts/gencode.py (the prob_id/prev_step special-cases).
GIVEN_CODE_FILES = {
    ("13", "13.6"): "13.6.txt",
    ("62", "62.1"): "62.1.txt",
    ("76", "76.3"): "76.3.txt",
}

def _load_jsonl(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def dev_problem_ids(fixture: list[dict]) -> set[str]:
    """The problem ids belonging to SciCode's `dev` split (as strings).

    Prefers the authoritative `problems_dev.jsonl`. When only the legacy
    `problems_all.jsonl` is present (no split files), falls back to the first
    15 problems of the fixture — load_problems() orders dev before test, so the
    leading block is the dev set under the HF source; the legacy ordering has
    no dev/test designation, so this is a best-effort split.
    """
    if os.path.exists(SOURCE_DEV):
        return {str(p["problem_id"]) for p in _load_jsonl(SOURCE_DEV)}
    return {p["problem_id"] for p in fixture[:15]}


def load_problems() -> list[dict] | None:
    """The problem records to build the fixture from, or None if no source is
    present.

    Prefers the HuggingFace splits, **dev before test**, so the dev set (15
    problems) is always the leading block — entering "15" as the first-N to run
    selects exactly the dev set. These records carry the scientist
    `step_background` inline. Falls back to the legacy `problems_all.jsonl`
    (no backgrounds, its own ordering) only when the splits are absent.
    """
    parts: list[dict] = []
    for path in (SOURCE_DEV, SOURCE_TEST):  # dev first, then test
        if os.path.exists(path):
            parts.extend(_load_jsonl(path))
    if parts:
        return parts
    if os.path.exists(SOURCE_JSONL):
        return _load_jsonl(SOURCE_JSONL)
    return None


def read_given_code(filename: str) -> str:
    with open(os.path.join(SCICODE_DIR, filename), "r", encoding="utf-8") as f:
        return f.read()


# Upstream test cases sometimes import a helper from the `scicode` package
# (e.g. `from scicode.compare.cmp import cmp_tuple_or_list`). The generator
# vendors that helper (scicode_test_utils.py) and never installs the package,
# so the import would raise ModuleNotFoundError. Strip it here so the fixture
# is self-contained; the generator also strips it defensively at run time.
_SCICODE_IMPORT_RE = re.compile(r"^\s*(from|import)\s+scicode\b")


def strip_scicode_imports(test_case: str) -> str:
    return "\n".join(
        line for line in test_case.splitlines()
        if not _SCICODE_IMPORT_RE.match(line)
    )


def build_fixture_row(prob: dict) -> dict:
    """One self-contained fixture record the generator can run end-to-end."""
    pid = str(prob["problem_id"])
    sub_steps = []
    for s in prob["sub_steps"]:
        step_number = s["step_number"]
        given = GIVEN_CODE_FILES.get((pid, step_number))
        sub_steps.append(
            {
                "step_number": step_number,
                "step_description_prompt": s["step_description_prompt"],
                # SciCode's per-step scientist background (the "with-background"
                # setting); empty string when the source (legacy problems_all)
                # omits it.
                "step_background": (s.get("step_background") or "").strip(),
                "function_header": s["function_header"],
                "return_line": s["return_line"],
                "test_cases": [
                    strip_scicode_imports(t) for t in s["test_cases"]
                ],
                # When set, the generator uses this code verbatim instead of
                # prompting the model for this step (SciCode "given" steps).
                "given_code": read_given_code(given) if given else None,
            }
        )
    return {
        "problem_id": pid,
        "problem_name": prob["problem_name"],
        "problem_description_main": prob["problem_description_main"],
        "problem_io": prob.get("problem_io", ""),
        "required_dependencies": prob["required_dependencies"],
        "general_tests": prob.get("general_tests", []),
        "sub_steps": sub_steps,
    }


def build_dataset_row(prob: dict) -> dict:
    """One SambaEval dataset row. The prompt is informational (shown in the

    UI / transcript); the generator rebuilds the real per-step prompts from
    the fixture. Scoring is heuristic `ratio:`, so prompt text does not
    affect the score.
    """
    prompt = prob["problem_description_main"].strip()
    problem_io = (prob.get("problem_io") or "").strip()
    if problem_io:
        prompt = f"{prompt}\n\n{problem_io}"
    return {
        "example_id": int(prob["problem_id"]),
        "prompt": prompt,
        # The scicode_generator runs the tests and emits a
        # "{passed}/{total} sub-steps passed" summary; the heuristic scorer's
        # ratio: prefix turns that fraction into partial credit.
        "expected_output": "ratio:",
        "weight": 1.0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.parse_args()

    # The fixture is the canonical, self-contained artifact. Build it from the
    # raw upstream source when present (problems_all.jsonl, or the HF dev+test
    # splits), layering in the scientist `step_background`; otherwise reuse the
    # existing fixture (so re-subsetting still works after the raw source and
    # snippet files have been cleaned up).
    problems = load_problems()
    if problems is not None:
        rows = [build_fixture_row(prob) for prob in problems]
        with open(FIXTURE_OUT, "w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row) + "\n")
        n_bg = sum(
            1 for row in rows for s in row["sub_steps"] if s["step_background"]
        )
        print(f"Wrote fixture:  {os.path.relpath(FIXTURE_OUT, ROOT)} "
              f"({len(rows)} problems, {n_bg} step backgrounds)")
    elif not os.path.exists(FIXTURE_OUT):
        raise SystemExit(
            "No source found: place problems_all.jsonl or the HF "
            "problems_dev.jsonl + problems_test.jsonl in "
            f"{os.path.relpath(SCICODE_DIR, ROOT)} (see its README), "
            f"or keep the prebuilt {os.path.relpath(FIXTURE_OUT, ROOT)}."
        )

    with open(FIXTURE_OUT, "r", encoding="utf-8") as f:
        fixture = [json.loads(line) for line in f if line.strip()]

    # Split the fixture into SciCode's dev/test sets and write one dataset file
    # per split, preserving the fixture's problem ordering within each.
    dev_ids = dev_problem_ids(fixture)
    dev_rows = [p for p in fixture if p["problem_id"] in dev_ids]
    test_rows = [p for p in fixture if p["problem_id"] not in dev_ids]

    for out_path, rows in ((DATASET_DEV_OUT, dev_rows), (DATASET_TEST_OUT, test_rows)):
        with open(out_path, "w", encoding="utf-8") as f:
            for prob in rows:
                f.write(json.dumps(build_dataset_row(prob)) + "\n")
        ids = [p["problem_id"] for p in rows]
        print(f"Wrote dataset:  {os.path.relpath(out_path, ROOT)} "
              f"({len(rows)} problems: {', '.join(ids)})")


if __name__ == "__main__":
    main()
