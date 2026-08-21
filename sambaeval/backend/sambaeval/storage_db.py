"""Database-backed implementation of the ``storage`` public surface.

The executor, API, and CLI call ``storage.<fn>`` unchanged; when
``SAMBAEVAL_STORAGE_BACKEND=db`` (the default) ``storage.py`` rebinds those names
to the functions here (see the dispatch block at the end of ``storage.py``).

Identity mapping: a run is keyed by ``(experiment_id, run_label)`` where
``run_label`` is the timestamp string the executor treats as the "run_id".
Everything the runner resolves by name (providers/scorers/datasets) is scoped to
the *active owner* (``context.active_owner()``) so BYOK works.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import context, crypto
from . import storage_s3
from .config import settings
from .db import session_scope
from .models import Experiment as ExperimentModel
from .models import LlmJudgeScorerDef, Provider as ProviderModel, ResultRow, RunMeta
from .models_db import (
    Dataset,
    Experiment,
    Provider,
    Result,
    Run,
    RunError,
    Scorer,
)
from .run_registry import is_run_active

ORPHAN_GRACE_MS = 15_000

_SCORER_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")


# --------------------------------------------------------------------------- #
# Time / ids  (local copies so this module never imports storage)
# --------------------------------------------------------------------------- #
def iso_now() -> str:
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def new_run_id() -> str:
    return iso_now().replace(":", "-").replace(".", "-")


def _iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def ensure_dirs() -> None:  # no-op in db mode (kept for API compatibility)
    return None


# --------------------------------------------------------------------------- #
# Reconstruction helpers
# --------------------------------------------------------------------------- #
def _run_to_meta(run: Run) -> RunMeta:
    return RunMeta(
        run_id=run.run_label,
        status=run.status if run.status in ("running", "completed", "aborted", "interrupted", "paused") else "running",
        started_at=_iso(run.started_at) or _iso(run.created_at) or iso_now(),
        finished_at=_iso(run.finished_at),
        resumed_at=list(run.resumed_at or []),
        total=run.total,
        completed=run.completed,
        errors=run.errors,
        merged=run.merged,
        partial=run.partial,
        error=run.error,
    )


def _result_to_row(r: Result) -> ResultRow:
    return ResultRow(
        result_id=r.result_id,
        status=r.status,
        provider=r.provider,
        model=r.model,
        example_id=r.example_id,
        output=r.output,
        score=r.score,
        weight=r.weight,
        score_reason=r.score_reason,
        input_tokens=r.input_tokens,
        output_tokens=r.output_tokens,
        latency_ms=r.latency_ms,
        ttft_ms=r.ttft_ms,
        tps=r.tps,
        num_llm_calls=r.num_llm_calls,
    )


def _get_run(session: Session, experiment_id: str, run_label: str) -> Optional[Run]:
    return session.execute(
        select(Run).where(Run.experiment_id == experiment_id, Run.run_label == run_label)
    ).scalar_one_or_none()


def _recount(session: Session, run: Run) -> None:
    total_completed = session.execute(
        select(func.count()).select_from(Result).where(Result.run_id == run.id)
    ).scalar_one()
    total_errors = session.execute(
        select(func.count()).select_from(Result).where(
            Result.run_id == run.id, Result.status == "error"
        )
    ).scalar_one()
    run.completed = int(total_completed)
    run.errors = int(total_errors)


def _row_key(provider: str, model: str, example_id: int) -> str:
    return f"{provider}|{model}|{example_id}"


# --------------------------------------------------------------------------- #
# Providers (owner-scoped, encrypted)
# --------------------------------------------------------------------------- #
DEFAULT_PROVIDERS = [
    ProviderModel(
        name="SambaNova",
        api_url="https://api.sambanova.ai/v1",
        api_key="Obtain from https://cloud.sambanova.ai/apis",
    )
]


def _provider_to_model(p: Provider) -> ProviderModel:
    return ProviderModel(
        name=p.name, api_url=p.api_url, api_key=crypto.decrypt(p.api_key_ciphertext)
    )


def providers_file_exists() -> bool:
    owner = context.active_owner()
    with session_scope() as session:
        n = session.execute(
            select(func.count()).select_from(Provider).where(Provider.owner_id == owner)
        ).scalar_one()
        return int(n) > 0


def list_providers() -> list[ProviderModel]:
    owner = context.active_owner()
    with session_scope() as session:
        rows = session.execute(
            select(Provider).where(Provider.owner_id == owner).order_by(Provider.name)
        ).scalars().all()
        return [_provider_to_model(p) for p in rows]


def list_providers_or_create() -> list[ProviderModel]:
    owner = context.active_owner()
    with session_scope() as session:
        rows = session.execute(
            select(Provider).where(Provider.owner_id == owner).order_by(Provider.name)
        ).scalars().all()
        if not rows:
            for p in DEFAULT_PROVIDERS:
                session.add(
                    Provider(
                        owner_id=owner,
                        name=p.name,
                        api_url=p.api_url,
                        api_key_ciphertext=crypto.encrypt(p.api_key),
                        api_key_last4=crypto.last4(p.api_key),
                    )
                )
            session.flush()
            return list(DEFAULT_PROVIDERS)
        return [_provider_to_model(p) for p in rows]


def save_providers(providers: list[ProviderModel]) -> None:
    owner = context.active_owner()
    incoming = {p.name: p for p in providers}
    with session_scope() as session:
        existing = {
            p.name: p
            for p in session.execute(
                select(Provider).where(Provider.owner_id == owner)
            ).scalars().all()
        }
        for name, p in existing.items():
            if name not in incoming:
                session.delete(p)
        for name, p in incoming.items():
            row = existing.get(name)
            if row is None:
                session.add(
                    Provider(
                        owner_id=owner,
                        name=p.name,
                        api_url=p.api_url,
                        api_key_ciphertext=crypto.encrypt(p.api_key),
                        api_key_last4=crypto.last4(p.api_key),
                    )
                )
            else:
                row.api_url = p.api_url
                row.api_key_ciphertext = crypto.encrypt(p.api_key)
                row.api_key_last4 = crypto.last4(p.api_key)


# --------------------------------------------------------------------------- #
# Scorers (owner-scoped + public)
# --------------------------------------------------------------------------- #
def _validate_scorer_name(name: str) -> None:
    if not name or not _SCORER_NAME_RE.match(name):
        raise ValueError(
            f'Invalid scorer name "{name}". Use letters, digits, dot, underscore, or dash.'
        )


def _scorer_to_def(s: Scorer) -> LlmJudgeScorerDef:
    return LlmJudgeScorerDef(
        name=s.name,
        provider_name=s.provider_name or "",
        model=s.model or "",
        judge_prompt=s.judge_prompt or "",
        max_score=s.max_score or 5,
        additional_kwargs=s.additional_kwargs if isinstance(s.additional_kwargs, dict) else None,
    )


def _visible_scorers(session: Session, owner: uuid.UUID) -> list[Scorer]:
    return session.execute(
        select(Scorer).where(
            (Scorer.owner_id == owner) | (Scorer.visibility == "public")
        )
    ).scalars().all()


def get_scorer(name: str) -> Optional[LlmJudgeScorerDef]:
    _validate_scorer_name(name)
    owner = context.active_owner()
    with session_scope() as session:
        rows = _visible_scorers(session, owner)
        # Prefer the owner's own scorer over a public one with the same name.
        own = next((s for s in rows if s.name == name and s.owner_id == owner), None)
        pub = next((s for s in rows if s.name == name), None)
        s = own or pub
        return _scorer_to_def(s) if s else None


def list_scorers() -> list[LlmJudgeScorerDef]:
    owner = context.active_owner()
    with session_scope() as session:
        rows = _visible_scorers(session, owner)
        by_name: dict[str, Scorer] = {}
        for s in rows:
            cur = by_name.get(s.name)
            if cur is None or (s.owner_id == owner and cur.owner_id != owner):
                by_name[s.name] = s
        return [_scorer_to_def(s) for s in sorted(by_name.values(), key=lambda x: x.name)]


def save_scorer(scorer: LlmJudgeScorerDef) -> None:
    _validate_scorer_name(scorer.name)
    owner = context.active_owner()
    with session_scope() as session:
        row = session.execute(
            select(Scorer).where(Scorer.owner_id == owner, Scorer.name == scorer.name)
        ).scalar_one_or_none()
        if row is None:
            session.add(
                Scorer(
                    owner_id=owner,
                    name=scorer.name,
                    provider_name=scorer.provider_name,
                    model=scorer.model,
                    judge_prompt=scorer.judge_prompt,
                    max_score=scorer.max_score,
                    additional_kwargs=scorer.additional_kwargs,
                    visibility="public" if owner else "public",
                )
            )
        else:
            row.provider_name = scorer.provider_name
            row.model = scorer.model
            row.judge_prompt = scorer.judge_prompt
            row.max_score = scorer.max_score
            row.additional_kwargs = scorer.additional_kwargs


def delete_scorer(name: str) -> None:
    _validate_scorer_name(name)
    owner = context.active_owner()
    with session_scope() as session:
        row = session.execute(
            select(Scorer).where(Scorer.owner_id == owner, Scorer.name == name)
        ).scalar_one_or_none()
        if row is not None:
            session.delete(row)


# --------------------------------------------------------------------------- #
# Datasets (object store + metadata rows)
# --------------------------------------------------------------------------- #
def _dataset_object_key(owner: uuid.UUID, dataset_id: uuid.UUID, name: str, public: bool) -> str:
    if public:
        return f"datasets/public/{dataset_id}/{name}"
    return f"datasets/users/{owner}/{dataset_id}/{name}"


def _visible_datasets(session: Session, owner: uuid.UUID) -> list[Dataset]:
    return session.execute(
        select(Dataset).where(
            (Dataset.owner_id == owner) | (Dataset.visibility == "public")
        )
    ).scalars().all()


def list_datasets() -> list[str]:
    owner = context.active_owner()
    with session_scope() as session:
        names = {d.name for d in _visible_datasets(session, owner)}
        return sorted(names)


def read_dataset(name: str) -> str:
    owner = context.active_owner()
    with session_scope() as session:
        rows = _visible_datasets(session, owner)
        own = next((d for d in rows if d.name == name and d.owner_id == owner), None)
        row = own or next((d for d in rows if d.name == name), None)
        if row is None:
            raise FileNotFoundError(f"Dataset not found: {name}")
        key = row.object_key
    return storage_s3.get_text(key)


def write_dataset(name: str, content: str, *, private: bool = False) -> None:
    owner = context.active_owner()
    public = not private
    fmt = "jsonl" if name.lower().endswith(".jsonl") else "csv"
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    with session_scope() as session:
        row = session.execute(
            select(Dataset).where(Dataset.owner_id == owner, Dataset.name == name)
        ).scalar_one_or_none()
        if row is None:
            ds_id = uuid.uuid4()
            key = _dataset_object_key(owner, ds_id, name, public)
            row = Dataset(
                id=ds_id,
                owner_id=owner,
                name=name,
                format=fmt,
                object_key=key,
                visibility="public" if public else "private",
            )
            session.add(row)
        else:
            key = row.object_key
            row.format = fmt
            row.visibility = "public" if public else "private"
        row.size_bytes = len(content.encode("utf-8"))
        row.content_hash = digest
    storage_s3.put_text(key, content)


def delete_dataset(name: str) -> None:
    owner = context.active_owner()
    with session_scope() as session:
        row = session.execute(
            select(Dataset).where(Dataset.owner_id == owner, Dataset.name == name)
        ).scalar_one_or_none()
        if row is None:
            return
        key = row.object_key
        session.delete(row)
    storage_s3.delete(key)


# --------------------------------------------------------------------------- #
# Experiments
# --------------------------------------------------------------------------- #
def _experiment_to_model(row: Experiment) -> ExperimentModel:
    data = dict(row.config)
    data["id"] = row.id
    data["private"] = row.visibility != "public"
    return ExperimentModel.model_validate(data)


def _visible_experiments(session: Session, owner: uuid.UUID) -> list[Experiment]:
    return session.execute(
        select(Experiment).where(
            (Experiment.owner_id == owner) | (Experiment.visibility == "public")
        )
    ).scalars().all()


def list_experiments() -> list[ExperimentModel]:
    owner = context.active_owner()
    with session_scope() as session:
        rows = _visible_experiments(session, owner)
        out = [_experiment_to_model(r) for r in rows]
        out.sort(key=lambda e: e.id)
        return out


def get_experiment(experiment_id: str) -> Optional[ExperimentModel]:
    owner = context.active_owner()
    with session_scope() as session:
        row = session.get(Experiment, experiment_id)
        if row is None:
            return None
        if row.visibility != "public" and row.owner_id != owner:
            # Not visible to this owner (admin bypass handled at the API layer).
            return None
        return _experiment_to_model(row)


def save_experiment(experiment: ExperimentModel) -> None:
    owner = context.active_owner()
    config = experiment.model_dump(exclude_none=True, exclude={"private"})
    visibility = "private" if experiment.private else "public"
    with session_scope() as session:
        row = session.get(Experiment, experiment.id)
        if row is None:
            session.add(
                Experiment(
                    id=experiment.id,
                    owner_id=owner,
                    name=experiment.name,
                    config=config,
                    visibility=visibility,
                )
            )
        else:
            row.name = experiment.name
            row.config = config
            row.visibility = visibility


def delete_experiment(experiment_id: str) -> None:
    with session_scope() as session:
        row = session.get(Experiment, experiment_id)
        if row is not None:
            session.delete(row)  # cascade drops runs/results/errors


def next_experiment_id() -> str:
    with session_scope() as session:
        existing = {
            r[0] for r in session.execute(select(Experiment.id)).all()
        }
    i = 1
    while str(i) in existing:
        i += 1
    return str(i)


# --------------------------------------------------------------------------- #
# Run lifecycle
# --------------------------------------------------------------------------- #
def create_run(
    experiment: ExperimentModel,
    total_tasks: int,
    *,
    partial: bool = False,
    run_id: Optional[str] = None,
    owner_id: Optional[uuid.UUID] = None,
) -> RunMeta:
    owner = owner_id or context.active_owner()
    label = run_id or new_run_id()
    snapshot = experiment.model_dump(exclude_none=True, exclude={"private"})
    with session_scope() as session:
        run = _get_run(session, experiment.id, label)
        if run is None:
            run = Run(
                experiment_id=experiment.id,
                owner_id=owner,
                run_label=label,
                status="running",
                config_snapshot=snapshot,
                total=total_tasks,
                completed=0,
                errors=0,
                partial=partial,
                started_at=datetime.now(timezone.utc),
                resumed_at=[],
            )
            session.add(run)
        else:
            # Adopt a pre-created (e.g. queued) run row.
            run.status = "running"
            run.total = total_tasks
            run.partial = partial
            run.config_snapshot = snapshot
            if run.started_at is None:
                run.started_at = datetime.now(timezone.utc)
        session.flush()
        return _run_to_meta(run)


def mark_run_resumed(
    experiment_id: str,
    run_id: str,
    total_tasks: int,
    *,
    merged: Optional[bool] = None,
) -> Optional[RunMeta]:
    with session_scope() as session:
        run = _get_run(session, experiment_id, run_id)
        if run is None:
            return None
        run.status = "running"
        run.resumed_at = list(run.resumed_at or []) + [iso_now()]
        run.total = total_tasks
        if merged is not None:
            run.merged = merged
        session.flush()
        return _run_to_meta(run)


def complete_run(
    experiment_id: str, run_id: str, status: str, error: Optional[str] = None
) -> None:
    with session_scope() as session:
        run = _get_run(session, experiment_id, run_id)
        if run is None:
            return
        run.status = status
        run.finished_at = datetime.now(timezone.utc)
        # Always assign: the latest completion wins, so a successful resume
        # clears the reason a previous attempt aborted with.
        run.error = error[:4000] if error else None


def save_run_results(experiment_id: str, run_id: str, rows: list[ResultRow]) -> None:
    with session_scope() as session:
        run = _get_run(session, experiment_id, run_id)
        if run is None:
            return
        session.execute(sa_delete(Result).where(Result.run_id == run.id))
        for r in rows:
            session.add(_result_row_orm(run.id, r))
        session.flush()
        _recount(session, run)


def _result_row_orm(run_uuid: uuid.UUID, r: ResultRow) -> Result:
    return Result(
        run_id=run_uuid,
        result_id=r.result_id,
        status=r.status,
        provider=r.provider,
        model=r.model,
        example_id=r.example_id,
        output=r.output,
        score=r.score,
        weight=r.weight,
        score_reason=r.score_reason,
        input_tokens=r.input_tokens,
        output_tokens=r.output_tokens,
        latency_ms=r.latency_ms,
        ttft_ms=r.ttft_ms,
        tps=r.tps,
        num_llm_calls=r.num_llm_calls,
    )


def upsert_run_result_row(experiment_id: str, run_id: str, row: ResultRow) -> None:
    with session_scope() as session:
        run = _get_run(session, experiment_id, run_id)
        if run is None:
            return
        existing = session.execute(
            select(Result).where(
                Result.run_id == run.id,
                Result.provider == row.provider,
                Result.model == row.model,
                Result.example_id == row.example_id,
            )
        ).scalar_one_or_none()
        if existing is None:
            session.add(_result_row_orm(run.id, row))
        else:
            existing.result_id = row.result_id
            existing.status = row.status
            existing.output = row.output
            existing.score = row.score
            existing.weight = row.weight
            existing.score_reason = row.score_reason
            existing.input_tokens = row.input_tokens
            existing.output_tokens = row.output_tokens
            existing.latency_ms = row.latency_ms
            existing.ttft_ms = row.ttft_ms
            existing.tps = row.tps
            existing.num_llm_calls = row.num_llm_calls
        session.flush()
        _recount(session, run)


def read_run_results(experiment_id: str, run_id: str) -> Optional[list[ResultRow]]:
    with session_scope() as session:
        run = _get_run(session, experiment_id, run_id)
        if run is None:
            return None
        rows = session.execute(
            select(Result).where(Result.run_id == run.id).order_by(Result.result_id)
        ).scalars().all()
        return [_result_to_row(r) for r in rows]


def read_run_results_csv(experiment_id: str, run_id: str) -> Optional[str]:
    rows = read_run_results(experiment_id, run_id)
    if rows is None:
        return None
    from .storage import serialize_rows  # local import avoids import cycle

    return serialize_rows(rows)


def read_run_meta(experiment_id: str, run_id: str) -> Optional[RunMeta]:
    with session_scope() as session:
        run = _get_run(session, experiment_id, run_id)
        return _run_to_meta(run) if run else None


def _reconcile_orphan(session: Session, run: Run) -> None:
    if run.status != "running":
        return
    if is_run_active(run.experiment_id, run.run_label):
        return
    started = run.started_at or run.created_at
    if started is not None:
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        if (time.time() * 1000) - started.timestamp() * 1000 < ORPHAN_GRACE_MS:
            return
    run.status = "interrupted"
    run.finished_at = datetime.now(timezone.utc)


def list_runs(experiment_id: str) -> list[RunMeta]:
    with session_scope() as session:
        runs = session.execute(
            select(Run).where(Run.experiment_id == experiment_id)
        ).scalars().all()
        for run in runs:
            _reconcile_orphan(session, run)
        session.flush()
        metas = [_run_to_meta(r) for r in runs]
    metas.sort(key=lambda m: m.started_at, reverse=True)
    return metas


def find_resumable_run(experiment_id: str) -> Optional[RunMeta]:
    runs = list_runs(experiment_id)
    if not runs:
        return None
    latest = runs[0]
    return latest if latest.status != "completed" else None


def find_latest_run(experiment_id: str) -> Optional[RunMeta]:
    runs = list_runs(experiment_id)
    return runs[0] if runs else None


def find_retryable_run(experiment_id: str) -> Optional[RunMeta]:
    for run in list_runs(experiment_id):
        if run.errors > 0:
            return run
    return None


def read_run_experiment_snapshot(experiment_id: str, run_id: str) -> Optional[ExperimentModel]:
    with session_scope() as session:
        run = _get_run(session, experiment_id, run_id)
        if run is None or not run.config_snapshot:
            return None
        try:
            return ExperimentModel.model_validate(run.config_snapshot)
        except Exception:
            return None


def dataset_key(dataset) -> str:
    if isinstance(dataset, str):
        return dataset
    digest = hashlib.sha256(
        json.dumps(dataset, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    return f"inline:{digest[:16]}"


def run_dataset_key(experiment_id: str, run_id: str) -> Optional[str]:
    snap = read_run_experiment_snapshot(experiment_id, run_id)
    if snap is None:
        return None
    return dataset_key(snap.dataset)


def read_latest_results(experiment_id: str):
    latest = find_latest_run(experiment_id)
    if latest is None:
        return None
    rows = read_run_results(experiment_id, latest.run_id)
    if rows is None:
        return None
    return {"run_id": latest.run_id, "rows": rows}


def delete_run(experiment_id: str, run_id: str) -> str:
    if is_run_active(experiment_id, run_id):
        return "active"
    with session_scope() as session:
        run = _get_run(session, experiment_id, run_id)
        if run is None:
            return "not_found"
        session.delete(run)
        return "deleted"


def merge_run_results(
    experiment_id: str, from_run_id: str, into_run_id: str, overwrite: bool
) -> dict:
    """Port of the file-backed merge (see storage.merge_run_results docstring)."""
    if from_run_id == into_run_id:
        raise ValueError("Cannot merge a run into itself.")
    if is_run_active(experiment_id, from_run_id) or is_run_active(experiment_id, into_run_id):
        raise ValueError("A selected run is still active. Wait for it to finish.")
    if run_dataset_key(experiment_id, from_run_id) != run_dataset_key(experiment_id, into_run_id):
        raise ValueError("The selected runs use different datasets.")

    from_rows = read_run_results(experiment_id, from_run_id)
    into_rows = read_run_results(experiment_id, into_run_id)
    if from_rows is None:
        raise FileNotFoundError("The 'From' run has no results.")
    if into_rows is None:
        raise FileNotFoundError("The 'Into' run has no results.")

    into_by_key = {_row_key(r.provider, r.model, r.example_id): r for r in into_rows}
    conflicts = []
    for fr in from_rows:
        ir = into_by_key.get(_row_key(fr.provider, fr.model, fr.example_id))
        if ir is not None:
            conflicts.append({"from": fr.result_id, "into": ir.result_id})

    if conflicts and not overwrite:
        return {"status": "conflict", "conflicts": conflicts}

    from_keys = {_row_key(fr.provider, fr.model, fr.example_id) for fr in from_rows}
    kept_into = (
        [r for r in into_rows if _row_key(r.provider, r.model, r.example_id) not in from_keys]
        if overwrite
        else list(into_rows)
    )
    next_id = max((r.result_id for r in kept_into), default=-1) + 1
    appended = []
    for fr in from_rows:
        appended.append(fr.model_copy(update={"result_id": next_id}))
        next_id += 1
    merged = kept_into + appended
    merged.sort(key=lambda r: r.result_id)
    save_run_results(experiment_id, into_run_id, merged)

    replaced = len(into_rows) - len(kept_into)
    net_new = len(appended) - replaced
    if net_new:
        with session_scope() as session:
            run = _get_run(session, experiment_id, into_run_id)
            if run:
                run.total = run.total + net_new

    return {
        "status": "merged",
        "added": len(appended),
        "replaced": replaced,
        "total": len(merged),
    }


# --------------------------------------------------------------------------- #
# Per-run error log
# --------------------------------------------------------------------------- #
def record_run_error(
    experiment_id: str,
    run_id: str,
    *,
    example_id: int,
    provider: str,
    model: str,
    error: Optional[dict],
) -> None:
    provider_model = f"{provider}/{model}"
    with session_scope() as session:
        run = _get_run(session, experiment_id, run_id)
        if run is None:
            return
        existing = session.execute(
            select(RunError).where(
                RunError.run_id == run.id,
                RunError.example_id == example_id,
                RunError.provider_model == provider_model,
            )
        ).scalar_one_or_none()
        if error is None:
            if existing is not None:
                session.delete(existing)
            return
        if existing is None:
            session.add(
                RunError(
                    run_id=run.id,
                    example_id=example_id,
                    provider_model=provider_model,
                    phase=error.get("phase"),
                    message=error.get("message"),
                )
            )
        else:
            existing.phase = error.get("phase")
            existing.message = error.get("message")


def read_run_errors(experiment_id: str, run_id: str) -> dict:
    with session_scope() as session:
        run = _get_run(session, experiment_id, run_id)
        if run is None:
            return {}
        rows = session.execute(
            select(RunError).where(RunError.run_id == run.id)
        ).scalars().all()
        out: dict = {}
        for e in rows:
            out.setdefault(str(e.example_id), {})[e.provider_model] = {
                "phase": e.phase,
                "message": e.message,
            }
        return out


def get_run_errors(experiment_id: str, run_id: str) -> dict:
    logged = read_run_errors(experiment_id, run_id)
    if logged:
        return logged
    # Derive from error result rows when no explicit log exists.
    from .storage import _error_from_output  # local import avoids cycle

    out: dict = {}
    for r in read_run_results(experiment_id, run_id) or []:
        if r.status != "error":
            continue
        out.setdefault(str(r.example_id), {})[f"{r.provider}/{r.model}"] = _error_from_output(
            r.output
        )
    return out


# --------------------------------------------------------------------------- #
# Pricing defaults (static file baked into the image)
# --------------------------------------------------------------------------- #
def read_pricing_defaults() -> dict:
    from . import paths  # local import; file-based static asset

    try:
        raw = paths.pricing_defaults_file().read_text(encoding="utf-8")
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


# --------------------------------------------------------------------------- #
# Decoupled queue + DB-backed run control (prodplan §3.3, §3.4)
# --------------------------------------------------------------------------- #
def count_active_runs_for_owner(owner_id: uuid.UUID) -> int:
    """queued + running runs a user owns — for the concurrency quota."""
    with session_scope() as session:
        n = session.execute(
            select(func.count()).select_from(Run).where(
                Run.owner_id == owner_id, Run.status.in_(("queued", "running"))
            )
        ).scalar_one()
        return int(n)


def enqueue_run(
    experiment: ExperimentModel,
    *,
    mode: str,
    params: dict,
    owner_id: uuid.UUID,
    target_run_id: Optional[str] = None,
    update_snapshot: bool = False,
) -> str:
    """Create/mark a run as ``queued`` for a worker to execute, and return its
    run_label. For ``new`` a fresh run row is created; for resume/retry/merged
    the existing target run is re-queued. ``params`` is the executor kwargs
    (concurrency, merge_conflict, selected_models, config).
    """
    snapshot = experiment.model_dump(exclude_none=True, exclude={"private"})
    enqueue_params = {"mode": mode, **params}
    with session_scope() as session:
        if mode == "new":
            label = new_run_id()
            run = Run(
                experiment_id=experiment.id,
                owner_id=owner_id,
                run_label=label,
                status="queued",
                control="none",
                config_snapshot=snapshot,
                mode=mode,
                enqueue_params=enqueue_params,
                selected_models=params.get("selected_models"),
                total=0,
                resumed_at=[],
            )
            session.add(run)
            session.flush()
            return label
        # resume / retry / merged — re-queue the existing target.
        assert target_run_id, "target_run_id required for resume/retry/merged"
        run = _get_run(session, experiment.id, target_run_id)
        if run is None:
            raise FileNotFoundError("run_not_found")
        run.status = "queued"
        run.control = "none"
        run.mode = mode
        run.enqueue_params = enqueue_params
        run.claimed_by = None
        run.finished_at = None
        # For new/resume/merged/retry-live the executor must run the *current*
        # experiment; for retry-default it must run the original snapshot — the
        # API decides and sets update_snapshot accordingly.
        if update_snapshot:
            run.config_snapshot = snapshot
        session.flush()
        return target_run_id


def claim_queued_run(worker_id: str) -> Optional[dict]:
    """Atomically claim the oldest queued run (FOR UPDATE SKIP LOCKED)."""
    with session_scope() as session:
        run = session.execute(
            select(Run)
            .where(Run.status == "queued")
            .order_by(Run.created_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        ).scalar_one_or_none()
        if run is None:
            return None
        run.status = "running"
        run.control = "none"
        run.claimed_by = worker_id
        run.heartbeat_at = datetime.now(timezone.utc)
        if run.started_at is None:
            run.started_at = datetime.now(timezone.utc)
        session.flush()
        return {
            "experiment_id": run.experiment_id,
            "run_label": run.run_label,
            "owner_id": run.owner_id,
            "mode": run.mode or "new",
            "params": dict(run.enqueue_params or {}),
            "config_snapshot": dict(run.config_snapshot or {}),
        }


def set_run_control(experiment_id: str, run_id: str, control: str) -> bool:
    """API-side pause/terminate: set the DB control flag the worker polls."""
    with session_scope() as session:
        run = _get_run(session, experiment_id, run_id)
        if run is None:
            return False
        run.control = control
        return True


def get_run_control(experiment_id: str, run_id: str) -> str:
    with session_scope() as session:
        run = _get_run(session, experiment_id, run_id)
        return run.control if run else "none"


def heartbeat(experiment_id: str, run_id: str) -> None:
    with session_scope() as session:
        run = _get_run(session, experiment_id, run_id)
        if run is not None and run.status == "running":
            run.heartbeat_at = datetime.now(timezone.utc)


def run_status(experiment_id: str, run_id: str) -> Optional[str]:
    with session_scope() as session:
        run = _get_run(session, experiment_id, run_id)
        return run.status if run else None


# --------------------------------------------------------------------------- #
# Visibility / scoping / sharing (prodplan §2, §4)
# --------------------------------------------------------------------------- #
import secrets as _secrets  # noqa: E402


def _owner_label(owner_id: uuid.UUID, viewer: uuid.UUID) -> str:
    from .models_db import SYSTEM_USER_ID
    if owner_id == viewer:
        return "me"
    if owner_id == SYSTEM_USER_ID:
        return "system"
    return "other"


def experiment_meta() -> dict:
    """Map experiment_id -> {visibility, owner_id, share_token} for annotation."""
    with session_scope() as session:
        rows = session.execute(
            select(Experiment.id, Experiment.visibility, Experiment.owner_id, Experiment.share_token)
        ).all()
        return {
            r[0]: {"visibility": r[1], "owner_id": r[2], "share_token": r[3]}
            for r in rows
        }


def list_experiments_scoped(scope: str = "all") -> list[dict]:
    """Visible experiments annotated with visibility/owner label, filtered by
    scope: mine | public | shared | all."""
    viewer = context.active_owner()
    with session_scope() as session:
        rows = _visible_experiments(session, viewer)
        out = []
        for r in rows:
            label = _owner_label(r.owner_id, viewer)
            item = {
                "experiment": _experiment_to_model(r),
                "visibility": r.visibility,
                "owner": label,
                "is_owner": r.owner_id == viewer,
                "share_token": r.share_token,
            }
            out.append(item)
    if scope == "mine":
        out = [x for x in out if x["is_owner"]]
    elif scope == "public":
        out = [x for x in out if x["visibility"] == "public"]
    elif scope == "shared":
        # Shared-with-me: link-shared and not mine and not public.
        out = [x for x in out if x["visibility"] == "link" and not x["is_owner"]]
    out.sort(key=lambda x: x["experiment"].id)
    return out


def set_experiment_visibility(experiment_id: str, visibility: str) -> str:
    """Owner/admin-gated at the API layer. Returns 'ok'|'not_found'."""
    if visibility not in ("private", "link", "public"):
        raise ValueError("visibility must be private|link|public")
    with session_scope() as session:
        row = session.get(Experiment, experiment_id)
        if row is None:
            return "not_found"
        row.visibility = visibility
        if visibility == "link" and not row.share_token:
            row.share_token = _secrets.token_urlsafe(16)
        return "ok"


def ensure_experiment_share_token(experiment_id: str) -> Optional[str]:
    with session_scope() as session:
        row = session.get(Experiment, experiment_id)
        if row is None:
            return None
        if not row.share_token:
            row.share_token = _secrets.token_urlsafe(16)
        if row.visibility == "private":
            row.visibility = "link"
        return row.share_token


def experiment_owner_id(experiment_id: str) -> Optional[uuid.UUID]:
    with session_scope() as session:
        row = session.get(Experiment, experiment_id)
        return row.owner_id if row else None


def get_experiment_by_share_token(token: str) -> Optional[ExperimentModel]:
    with session_scope() as session:
        row = session.execute(
            select(Experiment).where(Experiment.share_token == token)
        ).scalar_one_or_none()
        return _experiment_to_model(row) if row else None
