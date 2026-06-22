# SambaEval Backend Test Suite

This document catalogs the automated tests for the SambaEval evaluation engine.

**Total Tests:** 32 automated (pytest)
**Test Status:** ✅ All passing
**Focus:** Run lifecycle (pause, terminate, cancel, resume), retrying the failed
rows of a past run, cancelling orphaned runs, the per-run error log
(`errors.json`), and merging runs (combining two finished runs, and running a
new "merged" run into an existing one).
**Runtime:** Fully offline. No provider, network, or API key is contacted.

## Table of Contents
- [Test Philosophy](#test-philosophy)
- [Running the Tests](#running-the-tests)
- [Test Infrastructure](#test-infrastructure)
  - [The Echo Generator](#the-echo-generator-deterministic-offline-output)
  - [The Concurrency Gate](#the-concurrency-gate)
  - [Fixtures](#fixtures)
  - [API-level tests](#api-level-tests)
- [Run Lifecycle Tests](#run-lifecycle-tests)
- [Retry Failed Tests](#retry-failed-tests)
- [Retry Config Tests](#retry-config-tests)
- [Orphan Cancel Tests](#orphan-cancel-tests)
- [Error Log Tests](#error-log-tests)
- [Merge Results Tests](#merge-results-tests)
- [Merged Run Tests](#merged-run-tests)
- [Continuous Integration](#continuous-integration)

---

## Test Philosophy

✅ **Test real behavior, not mocks.** The tests drive the actual `run_experiment`
executor end-to-end — the thread pool, the cooperative stop signals
(`RunControl`), incremental CSV result writes, and resume carry-over. Only the
LLM call itself is replaced, by a deterministic generator.

✅ **Deterministic, not timing-dependent.** Concurrency-sensitive cases pin down
exactly which tasks are in flight using a file-based barrier (the "gate")
instead of `sleep()` races, so the suite is stable in CI.

✅ **Offline and key-free.** Every run uses the echo generator and a throwaway
data directory, so the suite needs no `providers.json`, no network, and no API
key.

---

## Running the Tests

From `sambaeval/backend`:

```bash
uv sync --extra test          # install the package + pytest
uv run python -m pytest tests/ -v
```

---

## Test Infrastructure

### The Echo Generator (deterministic, offline output)

`tests/fixtures/echo_generator.py` is an `OutputGenerator` subclass that returns
the content of the last user message verbatim instead of calling a model. A
dataset row whose `expected_output` equals that prompt therefore scores a
deterministic `1.0` under the heuristic scorer, which lets tests assert on exact
results without ever contacting a provider.

### The Concurrency Gate

When `SAMBAEVAL_TEST_GATE_DIR` is set, the echo generator parks each task on a
file barrier *after* it has been admitted to the thread pool:

1. it touches `started-<example_id>` to announce it began;
2. it spins until a `release` file appears (with a 30 s safety timeout).

A test starts a run with two workers, waits until exactly two `started-*`
markers exist (so it knows precisely two tasks are mid-flight and parked), fires
the stop signal, then creates `release` to let them drain. This makes the
in-flight set deterministic. The gate is inert when the env var is unset, so the
non-gated tests run instantly.

### Fixtures

Defined in `tests/conftest.py`:

| Fixture | Purpose |
| --- | --- |
| `data_dir` | Points `SAMBAEVAL_DATA_DIR` at a temp dir and writes a dummy `providers.json`. |
| `make_experiment` | Factory for an N-row experiment over the echo generator + heuristic scorer. |
| `run_handle` | Runs an experiment on a background thread; exposes its `RunControl`, the active run id, and a `wait()` that joins with a timeout. |
| `gate` | Creates a gate directory, sets the env var, and releases the gate on teardown so no task is left parked. |

### API-level tests

The retry, orphan-cancel, and error-log suites drive the real FastAPI app
through `fastapi.testclient.TestClient` (`tests/test_retry_config.py`,
`tests/test_orphan_cancel.py`, `tests/test_error_log.py`) so the HTTP routes —
not just the executor — are covered. The run endpoint streams to completion
before `client.post` returns, so a test can assert on the stored results
immediately afterward. These still use the echo generator and a throwaway data
dir, so they remain offline and key-free.

---

## Run Lifecycle Tests

File: `tests/test_pause_resume.py`

### 1. `test_full_run_completes`
A run with no interference finishes with status `completed`, all 8 rows present
and scored `1.0`, zero errors, and no per-row metrics (the echo generator makes
no LLM call).

### 2. `test_pause_drains_inflight_only`
With two workers parked mid-flight, a **pause** is requested and the gate
released. The two admitted tasks finish and write their results; the other six
are skipped. Asserts status `paused`, `completed == 2`, that only two tasks ever
started, and that the persisted rows match those two tasks and score `1.0`.
Verifies a pause is a graceful drain, not a hard stop — no in-flight tokens are
wasted.

### 3. `test_terminate_abandons_inflight_without_blocking`
With two tasks parked on the gate, a pause followed by a **terminate**
("Terminate Threads") is fired and the gate is **never released**. The run must
still return promptly (within the `wait()` timeout) — guarding against the bug
where terminate would block joining the stuck threads. Asserts the run returns,
`completed == 0` (in-flight work abandoned), and status stays `paused` (so it
remains resumable).

### 4. `test_cancel_aborts`
A **cancel** with no prior pause force-stops the run. Asserts the run returns
promptly with status `aborted` and `completed == 0`.

### 5. `test_paused_run_is_resumable`
After pausing a run, `storage.find_resumable_run` returns that exact run with
status `paused`. Verifies the paused run is the one the UI will offer to resume.

### 6. `test_resume_carries_over_completed_rows`
Two-phase test. Phase 1 pauses after two rows complete. The `started-*` markers
are then cleared. Phase 2 resumes the same run to completion. Asserts the final
run is `completed` with all 8 rows scored `1.0`, **and** that the two
already-completed rows were carried over rather than regenerated — phase 2 only
re-ran the six rows that weren't done (`rerun_ids == all_ids - done_ids`).

---

## Retry Failed Tests

File: `tests/test_retry_failed.py`

"Retry Failed" re-runs only the `error` rows of a past run (even a completed
one), carries over the rows that already succeeded, and updates the same run in
place. These drive the executor directly with `mode="retry"`, seeding a finished
run whose `error` rows pass cleanly when regenerated.

### 1. `test_find_retryable_run_matches_completed_run_with_errors`
`storage.find_retryable_run` returns a completed run that has failures (and is
distinct from `find_resumable_run`, which ignores completed runs); a run with no
errors is not retryable.

### 2. `test_snapshot_round_trips`
`create_run` captures an experiment snapshot that
`storage.read_run_experiment_snapshot` can reload (same id and model list) — the
config a retry reproduces.

### 3. `test_retry_reruns_only_failed_rows`
With four completed and four error rows seeded, a retry re-runs **only** the four
failed rows (verified via the gate's `started-*` markers), carries the completed
ones over, and finishes `completed` with zero errors and every row scored `1.0`.

### 4. `test_retry_with_no_run_id_targets_latest_failed_run`
Omitting the run id retries the most recent run that has failures; asserts the
failed rows re-ran and the run ends with zero errors.

---

## Retry Config Tests

File: `tests/test_retry_config.py` (drives the HTTP run endpoint)

A retry reproduces the run's original config by default, or applies the
experiment's current settings with `config=live`. Both seed a completed run with
two models (one whose rows all failed), then edit the live experiment down to one
model before retrying.

### 1. `test_retry_snapshot_reruns_under_original_models`
Default retry (`mode=retry`) uses the run's **snapshot**, so the failed model's
rows are re-run even though the live experiment was edited to drop that model —
both models remain in the run and errors drop to zero.

### 2. `test_retry_live_config_applies_current_models`
`mode=retry&config=live` retries against the experiment's **current** config, so
the dropped model's rows are pruned rather than retried — only the surviving
model remains, with zero errors.

---

## Orphan Cancel Tests

File: `tests/test_orphan_cancel.py` (drives the HTTP cancel endpoint)

A run that lost its worker (server restart / crash) is absent from the in-process
registry but its `run.json` may still say `running`. The cancel endpoint must be
able to finalize it so the UI is never stuck with an orphan it can't stop.

### 1. `test_cancel_finalizes_orphaned_running_run`
Cancelling a `running` run that isn't in the registry finalizes it to `aborted`
(rather than no-opping), returning `cancelled: true`.

### 2. `test_cancel_no_active_run_is_404`
Cancelling when there is no active or unfinished run returns HTTP 404.

---

## Error Log Tests

File: `tests/test_error_log.py` (the storage helpers run directly; the endpoint
tests drive the HTTP route)

Every failed task is logged to `results/{exp}/{run}/errors.json`, keyed by
`example_id` then by `provider/model`, with a `{phase, message}` value (`phase`
is `generation` or `scoring`). The file is created lazily on the first error and
deleted when the last error clears. A model pointed at a missing provider fails
in the generation phase, which exercises the log fully offline. When the log is
absent (a run predating the feature, or one written by an older server), the
errors endpoint reconstructs it from the error rows in `results.csv`.

### 1. `test_errors_json_written_with_expected_schema`
A run with one working model and one pointed at a missing provider writes
`errors.json` with both example ids keyed under `NopeProvider/broken-model`,
each entry `phase == "generation"` with the provider name in the message.
Asserts the log lines up with the run meta's error count.

### 2. `test_record_run_error_set_and_clear`
`storage.record_run_error` records an entry, `read_run_errors` reads it back
verbatim, and recording `error=None` (a task that later succeeded) clears the
entry and removes the now-empty file.

### 3. `test_clearing_absent_error_is_a_noop`
Clearing an error that was never recorded does nothing and never creates an
empty `errors.json`.

### 4. `test_errors_endpoint_returns_flattenable_log`
`GET /api/experiments/{id}/errors?run_id=…` serves the recorded log; omitting
`run_id` falls back to the latest run and returns the same payload.

### 5. `test_errors_endpoint_empty_when_no_errors`
A clean run reports an empty `errors` object (which drives the hidden UI
section), and no `errors.json` file is written.

### 6. `test_errors_reconstructed_from_results_when_log_missing`
A run with error rows but no `errors.json` still surfaces its failures:
`get_run_errors` reconstructs the log from `results.csv`, recovering the phase
and message from each error row's `output` (`ERROR: …` → generation,
`[JUDGE ERROR: …]` → scoring).

### 7. `test_logged_errors_take_precedence_over_reconstruction`
When `errors.json` exists it's returned verbatim, not re-derived from the result
rows — the canonical log wins over the CSV fallback.

---

## Merge Results Tests

File: `tests/test_merge_results.py`

The Results-section **Merge Results** action folds one finished run's rows into
another via `storage.merge_run_results`, **without** re-running anything. Rows
are keyed by `(provider, model, example_id)`; the "From" rows are renumbered
past the "Into" run's maximum `result_id` while the "Into" rows keep their ids,
and a conflict is a key present in both runs. These drive the storage helper
directly with hand-seeded result rows — no executor or provider involved.

### 1. `test_merge_appends_and_renumbers_without_conflicts`
Merging two conflict-free runs keeps the Into rows' ids, appends the From rows
with ids continuing past the Into maximum (`0,1 → 2,3`), bumps the Into run's
`total` by the number of new rows, and leaves the From run untouched.

### 2. `test_merge_conflict_blocks_without_overwrite`
With one shared `(provider, model, example_id)`, an un-checked overwrite returns
`{"status": "conflict", "conflicts": [{"from", "into"}]}` and writes nothing —
the Into run still has exactly its original rows.

### 3. `test_merge_overwrite_replaces_conflicting_rows`
With overwrite enabled, the From row wins the conflict (its output replaces the
Into row's), non-conflicting Into rows are kept, the new From row is appended,
and all `result_id`s stay unique.

### 4. `test_merge_rejects_self_merge`
Merging a run into itself raises `ValueError`.

### 5. `test_merge_rejects_dataset_mismatch`
Merging runs over differently-sized datasets (hence different dataset keys)
raises `ValueError`.

### 6. `test_run_dataset_key_matches_experiment_dataset`
`storage.run_dataset_key` (derived from a run's snapshot) equals
`storage.dataset_key` of the live experiment's dataset — the equality the UI
uses to offer only same-dataset runs.

### 7. `test_dataset_key_filename_vs_inline`
`dataset_key` is the filename for file-backed datasets and a stable,
content-addressed `inline:…` hash for inline datasets (equal rows → equal key,
differing rows → differing key).

---

## Merged Run Tests

File: `tests/test_merged_run.py`

`mode="merged"` generates the current experiment's results into an existing
target run, in place: new keys are generated, conflicts are resolved **before**
any prompt runs ("skip" keeps the target row, "overwrite" re-generates it), and
target rows the experiment doesn't cover are preserved. The run is flagged
`merged` so a later resume rebuilds it the same safe way. These drive the real
`run_experiment` executor with the echo generator; seeded rows carry sentinel
outputs so a test can tell whether a row was preserved or regenerated.

### 1. `test_merged_run_adds_new_model_and_preserves_existing`
Merging a new model into a target that holds a different model over the same
dataset keeps the existing model's rows verbatim, generates the new model's rows
(scored `1.0`), keeps every `result_id` unique, and sets the run's `total`/
`completed` to the combined size with `merged == True`.

### 2. `test_merged_run_skip_keeps_conflicting_rows`
When every produced key already exists in the target, **skip** runs no prompts —
every row keeps its stale sentinel output and the count is unchanged.

### 3. `test_merged_run_overwrite_regenerates_conflicting_rows`
With **overwrite**, each conflicting row is re-generated (echo → the prompt,
scored `1.0`) reusing its original `result_id`, so the row is replaced in place.

### 4. `test_resume_merged_run_preserves_uncovered_rows`
A paused merged run (one model done and preserved, plus a completed and an
errored row of the merged model) is resumed via the normal resume path. The
rows the current grid doesn't cover **survive** (the data-loss guard), the
completed row is carried over, the errored row re-runs to success, no
`result_id`s collide, and the `merged` flag persists.

---

## Continuous Integration

These tests run in GitHub Actions via
[`.github/workflows/sambaeval-ci.yml`](../../../.github/workflows/sambaeval-ci.yml)
on pushes and pull requests to `main` that touch `sambaeval/**`. The job installs
the package with the `test` extra (`uv sync --extra test`) and runs
`pytest tests/`.
