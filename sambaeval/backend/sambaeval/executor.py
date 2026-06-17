"""Experiment execution engine.

Concurrency model: a ``ThreadPoolExecutor`` runs the I/O-bound per-task work
(generate → score). **The parent thread owns all result writes, progress
callbacks, and cancellation** — worker callables are pure and return a
``ResultRow`` (or ``None`` if cancelled). This keeps shared state trivial and
supports incremental CSV upserts, resume carry-over, and abort.
"""

from __future__ import annotations

import threading
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from typing import Callable, Optional

from . import storage
from .datasets import load_dataset
from .generators import load_generator_class, resolve_generator_path, run_generator
from .models import DatasetRow, Experiment, ModelConfig, ResultRow, RunMeta
from .run_registry import RunControl, register_run, unregister_run
from .scoring import heuristic_score, llm_judge_score, messages_to_transcript


@dataclass
class ExecutorProgress:
    total: int
    completed: int
    errors: int
    run_id: str
    current_label: Optional[str] = None


@dataclass
class RunResult:
    run_id: str
    meta: RunMeta
    results: list[ResultRow]


@dataclass
class _Task:
    result_id: int
    model_index: int
    model: ModelConfig
    row: DatasetRow


def _row_key(provider: str, model: str, example_id: int) -> str:
    return f"{provider}|{model}|{example_id}"


def run_experiment(
    experiment: Experiment,
    *,
    concurrency: int = 4,
    mode: str = "new",
    run_id: Optional[str] = None,
    merge_conflict: str = "skip",
    on_progress: Optional[Callable[[ExecutorProgress], None]] = None,
    control: Optional[RunControl] = None,
) -> RunResult:
    concurrency = max(1, concurrency)
    full_dataset = load_dataset(experiment.dataset)
    if isinstance(experiment.example_count, int) and experiment.example_count >= 0:
        dataset = full_dataset[: experiment.example_count]
    else:
        dataset = full_dataset

    providers = storage.list_providers()
    provider_by_name = {p.name: p for p in providers}

    total_tasks = len(experiment.models) * len(dataset)

    prior_rows: list[ResultRow] = []
    # "resume" continues an unfinished run; "retry" re-runs the failed rows of
    # any past run (including a completed one). Both carry over the rows that
    # already succeeded and re-dispatch everything else — for a finished run
    # that "everything else" is exactly the error rows.
    if mode in ("resume", "retry"):
        if not run_id:
            target = (
                storage.find_retryable_run(experiment.id)
                if mode == "retry"
                else storage.find_resumable_run(experiment.id)
            )
            if not target:
                raise RuntimeError(
                    "No run with failed rows found to retry"
                    if mode == "retry"
                    else "No resumable run found"
                )
            run_id = target.run_id
        existing = storage.read_run_results(experiment.id, run_id)
        if existing is None:
            raise RuntimeError(f"Run {run_id} has no results to {mode} from")
        prior_rows = existing
        storage.mark_run_resumed(experiment.id, run_id, total_tasks)
    elif mode == "merged":
        # Generate the current experiment's results into an existing target run,
        # in place. The target's run_id is required; its rows become the prior
        # set we merge against. `total_tasks` (and the resumed marker) are set
        # below once the merged task list is built.
        if not run_id:
            raise RuntimeError("A merged run requires a target run_id")
        existing = storage.read_run_results(experiment.id, run_id)
        if existing is None:
            raise RuntimeError(f"Target run {run_id} has no results to merge into")
        prior_rows = existing
    else:
        meta = storage.create_run(experiment, total_tasks)
        run_id = meta.run_id

    control = control or RunControl()
    terminate = control.terminate
    pause = control.pause
    register_run(experiment.id, run_id, control)

    prior_by_key = {
        _row_key(r.provider, r.model, r.example_id): r for r in prior_rows
    }

    universe: list[ResultRow] = []
    tasks: list[_Task] = []
    if mode == "merged":
        # Merge the current experiment's generation into the target run. Each
        # (provider, model, example_id) the experiment produces is checked
        # against the target *before* running a prompt:
        #   * brand-new key   → run it; the row is appended with a result_id past
        #                       the target's current maximum (no collision);
        #   * conflict + skip → keep the target's row untouched, run nothing;
        #   * conflict + overwrite → re-run and replace in place, reusing the
        #                       target row's result_id so its id stays stable.
        # Target rows the experiment doesn't touch (models/examples only present
        # in the target) are preserved verbatim.
        next_id = max((r.result_id for r in prior_rows), default=0) + 1
        covered: set[str] = set()
        for mi, model in enumerate(experiment.models):
            for row in dataset:
                key = _row_key(model.provider_name, model.name, row.example_id)
                covered.add(key)
                existing_row = prior_by_key.get(key)
                if existing_row is None:
                    tasks.append(_Task(next_id, mi, model, row))
                    next_id += 1
                elif merge_conflict == "overwrite":
                    tasks.append(_Task(existing_row.result_id, mi, model, row))
                else:  # skip
                    universe.append(existing_row)
        for r in prior_rows:
            if _row_key(r.provider, r.model, r.example_id) not in covered:
                universe.append(r)
        total_tasks = len(universe) + len(tasks)
        storage.mark_run_resumed(experiment.id, run_id, total_tasks)
    else:
        for mi, model in enumerate(experiment.models):
            for ri, row in enumerate(dataset):
                result_id = mi * len(dataset) + ri + 1
                carried = prior_by_key.get(
                    _row_key(model.provider_name, model.name, row.example_id)
                )
                if carried and carried.status == "completed":
                    universe.append(
                        carried.model_copy(update={"result_id": result_id})
                    )
                else:
                    tasks.append(_Task(result_id, mi, model, row))

    generator_cls = load_generator_class(
        resolve_generator_path(experiment.output_generator)
    )

    # Prune orphans and lay down carried rows so a mid-run crash is consistent.
    storage.save_run_results(experiment.id, run_id, universe)

    final_rows: dict[int, ResultRow] = {r.result_id: r for r in universe}
    completed = len(universe)
    errors = 0

    def report(label: Optional[str] = None) -> None:
        if on_progress:
            on_progress(
                ExecutorProgress(
                    total=total_tasks,
                    completed=completed,
                    errors=errors,
                    run_id=run_id,
                    current_label=label,
                )
            )

    report()

    def run_task(task: _Task) -> Optional[tuple[ResultRow, Optional[dict]]]:
        """Pure worker: generate + score, return (ResultRow, error) — None if skipped.

        The second tuple element is the structured error detail
        (``{"phase", "message"}``) for the errors.json log when the task failed,
        or ``None`` when it succeeded (which also clears any stale entry on a
        resume/retry).

        Checked once *before* any work begins: if a pause or terminate has been
        requested, this not-yet-started task is skipped (returns None, writes
        nothing, and re-runs on resume). A task already past this point runs to
        completion on a pause — its tokens are not wasted; only a terminate
        abandons in-flight work.
        """
        if terminate.is_set() or pause.is_set():
            return None
        model = task.model
        row = task.row
        output = ""
        score = 0.0
        score_reason: Optional[str] = None
        status = "completed"
        metrics: Optional[dict] = None
        error_info: Optional[dict] = None

        try:
            provider = provider_by_name.get(model.provider_name)
            if provider is None:
                raise RuntimeError(
                    f'Provider "{model.provider_name}" not found in providers.json'
                )
            output, metrics = run_generator(
                generator_cls=generator_cls,
                provider=provider,
                model=model,
                experiment_system_prompt=experiment.system_prompt,
                row=row,
            )
        except Exception as err:  # noqa: BLE001 — surface as an ERROR row
            # A terminate tears the pool down mid-call, so swallow the spurious
            # error and drop the task. A pause lets the call finish, so a real
            # failure here is recorded as a genuine ERROR row.
            if terminate.is_set():
                return None
            output = f"ERROR: {err}"
            score = 0.0
            status = "error"
            error_info = {"phase": "generation", "message": str(err)}

        if status == "completed":
            try:
                scorer = experiment.scorer
                if scorer is not None and scorer.type == "llm":
                    definition = scorer.definition
                    if definition is None:
                        if not scorer.scorer_name:
                            raise RuntimeError(
                                'Experiment uses an LLM judge but neither '
                                '"scorer.definition" nor "scorer.scorer_name" is set'
                            )
                        definition = storage.get_scorer(scorer.scorer_name)
                        if definition is None:
                            raise RuntimeError(
                                f'Scorer "{scorer.scorer_name}" not found in data/scorers/'
                            )
                    judge_provider = provider_by_name.get(definition.provider_name)
                    if judge_provider is None:
                        raise RuntimeError(
                            f'Judge provider "{definition.provider_name}" not found '
                            "in providers.json"
                        )
                    judged = llm_judge_score(
                        scorer=definition,
                        provider=judge_provider,
                        prompt=messages_to_transcript(row.messages),
                        expected=row.expected_output,
                        output=output,
                        weight=row.weight,
                    )
                    score = judged.score
                    score_reason = judged.score_reason
                else:
                    score = heuristic_score(row.expected_output, output, row.weight)
            except Exception as err:  # noqa: BLE001
                if terminate.is_set():
                    return None
                output = f"{output}\n\n[JUDGE ERROR: {err}]"
                score = 0.0
                status = "error"
                error_info = {"phase": "scoring", "message": str(err)}

        rounded = round(score * 100) / 100
        result_row = ResultRow(
            result_id=task.result_id,
            status=status,
            provider=model.provider_name,
            model=model.name,
            example_id=row.example_id,
            output=output,
            score=rounded,
            weight=row.weight,
            score_reason=score_reason,
            input_tokens=(metrics or {}).get("input_tokens"),
            output_tokens=(metrics or {}).get("output_tokens"),
            latency_ms=(metrics or {}).get("latency_ms"),
            ttft_ms=(metrics or {}).get("ttft_ms"),
            tps=(metrics or {}).get("tps"),
            num_llm_calls=(metrics or {}).get("num_llm_calls"),
        )
        return result_row, error_info

    max_workers = min(concurrency, len(tasks) or 1)
    pool = ThreadPoolExecutor(max_workers=max_workers)
    try:
        futures = {pool.submit(run_task, t): t for t in tasks}
        pending = set(futures)
        # Poll instead of blocking in as_completed: a terminate fired while
        # every worker is parked in a slow LLM call must still break us out
        # promptly (within one poll) rather than waiting for those calls. A
        # pause sets no terminate, so it simply drains — queued tasks
        # short-circuit to None and the in-flight ones land their results.
        while pending and not terminate.is_set():
            done, pending = wait(pending, timeout=0.25, return_when=FIRST_COMPLETED)
            for fut in done:
                task = futures[fut]
                label = (
                    f"{task.model.provider_name}/{task.model.name} "
                    f"#{task.row.example_id}"
                )
                outcome = fut.result()
                if outcome is None:  # skipped (paused) or abandoned (terminated)
                    continue
                row, error_info = outcome
                # Parent owns the write.
                storage.upsert_run_result_row(experiment.id, run_id, row)
                # Record the error (or clear a stale one if this resume succeeded).
                storage.record_run_error(
                    experiment.id,
                    run_id,
                    example_id=row.example_id,
                    provider=row.provider,
                    model=row.model,
                    error=error_info,
                )
                final_rows[row.result_id] = row
                completed += 1
                if row.status == "error":
                    errors += 1
                report(label)
    finally:
        unregister_run(experiment.id, run_id)
        # On a terminate, do NOT wait for the in-flight tasks — abandon them so
        # the caller isn't blocked on slow LLM calls (their tokens are wasted
        # and they re-run on resume). A pause / normal finish has already
        # drained, so the join is a no-op there.
        pool.shutdown(wait=not terminate.is_set(), cancel_futures=True)

    # A pause is resumable, so it wins over a terminate fired during the drain
    # ("Terminate Threads" only hurries a pause along — it doesn't abort it).
    if pause.is_set():
        final_status = "paused"
    elif terminate.is_set():
        final_status = "aborted"
    else:
        final_status = "completed"
    storage.complete_run(experiment.id, run_id, final_status)

    meta = storage.read_run_meta(experiment.id, run_id)
    if meta is None:
        raise RuntimeError(f"Run {run_id} disappeared mid-execution")

    results = sorted(final_rows.values(), key=lambda r: r.result_id)
    return RunResult(run_id=run_id, meta=meta, results=results)
