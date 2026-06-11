"""Experiment execution engine.

Concurrency model: a ``ThreadPoolExecutor`` runs the I/O-bound per-task work
(generate → score). **The parent thread owns all result writes, progress
callbacks, and cancellation** — worker callables are pure and return a
``ResultRow`` (or ``None`` if cancelled). This keeps shared state trivial and
supports incremental CSV upserts, resume carry-over, and abort.
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Callable, Optional

from . import storage
from .datasets import load_dataset
from .generators import load_generator_class, resolve_generator_path, run_generator
from .models import DatasetRow, Experiment, ModelConfig, ResultRow, RunMeta
from .run_registry import register_run, unregister_run
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
    on_progress: Optional[Callable[[ExecutorProgress], None]] = None,
    cancel_event: Optional[threading.Event] = None,
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
    if mode == "resume":
        if not run_id:
            resumable = storage.find_resumable_run(experiment.id)
            if not resumable:
                raise RuntimeError("No resumable run found")
            run_id = resumable.run_id
        existing = storage.read_run_results(experiment.id, run_id)
        if existing is None:
            raise RuntimeError(f"Run {run_id} has no results to resume from")
        prior_rows = existing
        storage.mark_run_resumed(experiment.id, run_id, total_tasks)
    else:
        meta = storage.create_run(experiment, total_tasks)
        run_id = meta.run_id

    cancel = cancel_event or threading.Event()
    register_run(experiment.id, run_id, cancel)

    prior_by_key = {
        _row_key(r.provider, r.model, r.example_id): r for r in prior_rows
    }

    universe: list[ResultRow] = []
    tasks: list[_Task] = []
    for mi, model in enumerate(experiment.models):
        for ri, row in enumerate(dataset):
            result_id = mi * len(dataset) + ri + 1
            carried = prior_by_key.get(
                _row_key(model.provider_name, model.name, row.example_id)
            )
            if carried and carried.status == "completed":
                universe.append(carried.model_copy(update={"result_id": result_id}))
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

    def run_task(task: _Task) -> Optional[ResultRow]:
        """Pure worker: generate + score, return a ResultRow. None if cancelled."""
        if cancel.is_set():
            return None
        model = task.model
        row = task.row
        output = ""
        score = 0.0
        score_reason: Optional[str] = None
        status = "completed"
        metrics: Optional[dict] = None

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
            if cancel.is_set():
                return None
            output = f"ERROR: {err}"
            score = 0.0
            status = "error"

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
                if cancel.is_set():
                    return None
                output = f"{output}\n\n[JUDGE ERROR: {err}]"
                score = 0.0
                status = "error"

        rounded = round(score * 100) / 100
        return ResultRow(
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

    try:
        max_workers = min(concurrency, len(tasks) or 1)
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = {pool.submit(run_task, t): t for t in tasks}
            for fut in as_completed(futures):
                if cancel.is_set():
                    break
                task = futures[fut]
                label = (
                    f"{task.model.provider_name}/{task.model.name} "
                    f"#{task.row.example_id}"
                )
                row = fut.result()
                if row is None:  # cancelled mid-flight
                    continue
                # Parent owns the write.
                storage.upsert_run_result_row(experiment.id, run_id, row)
                final_rows[row.result_id] = row
                completed += 1
                if row.status == "error":
                    errors += 1
                report(label)
            if cancel.is_set():
                pool.shutdown(wait=False, cancel_futures=True)
    finally:
        unregister_run(experiment.id, run_id)

    storage.complete_run(
        experiment.id, run_id, "aborted" if cancel.is_set() else "completed"
    )

    meta = storage.read_run_meta(experiment.id, run_id)
    if meta is None:
        raise RuntimeError(f"Run {run_id} disappeared mid-execution")

    results = sorted(final_rows.values(), key=lambda r: r.result_id)
    return RunResult(run_id=run_id, meta=meta, results=results)
