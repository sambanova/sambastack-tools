"""File-backed storage + run lifecycle.

All state is on disk under ``data/`` (no database). Key invariants:
  * atomic writes (write tmp, then rename);
  * per-run serialized writes via a per-(exp,run) lock so concurrent worker
    threads never clobber the results CSV;
  * the exact results-CSV column order and null handling;
  * run-id format ``YYYY-MM-DDTHH-MM-SS-mmmZ`` and ISO timestamps;
  * orphan-run reconciliation (a "running" run with no live process becomes
    "interrupted" after a grace period).

Deliberate behavioral change from TS: ``list_providers`` does NOT auto-create a
placeholder ``providers.json`` — a missing file raises ``FileNotFoundError``.
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional

from . import paths
from ._csv import parse_csv, stringify_csv
from .models import Experiment, LlmJudgeScorerDef, Provider, ResultRow, RunMeta
from .run_registry import is_run_active

ORPHAN_GRACE_MS = 15_000


# --------------------------------------------------------------------------- #
# Time / ids
# --------------------------------------------------------------------------- #
def iso_now() -> str:
    """Millisecond-precision UTC ISO timestamp with a ``Z`` suffix.

    Matches JavaScript's ``new Date().toISOString()``.
    """
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def new_run_id() -> str:
    return iso_now().replace(":", "-").replace(".", "-")


# --------------------------------------------------------------------------- #
# Dirs / atomic write
# --------------------------------------------------------------------------- #
def ensure_dirs() -> None:
    for d in (
        paths.experiments_dir(),
        paths.datasets_dir(),
        paths.results_dir(),
        paths.scorers_dir(),
    ):
        d.mkdir(parents=True, exist_ok=True)


def atomic_write(target: Path, data: str) -> None:
    tmp = target.with_name(
        f"{target.name}.tmp-{os.getpid()}-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
    )
    try:
        tmp.write_text(data, encoding="utf-8")
        os.replace(tmp, target)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


# --------------------------------------------------------------------------- #
# Per-run lock (serializes results/meta writes for one (exp, run))
# --------------------------------------------------------------------------- #
_locks_guard = threading.Lock()
_run_locks: dict[str, threading.RLock] = {}


def _run_lock(experiment_id: str, run_id: str) -> threading.RLock:
    key = f"{experiment_id}/{run_id}"
    with _locks_guard:
        lock = _run_locks.get(key)
        if lock is None:
            lock = threading.RLock()
            _run_locks[key] = lock
        return lock


@contextmanager
def with_run_lock(experiment_id: str, run_id: str) -> Iterator[None]:
    lock = _run_lock(experiment_id, run_id)
    lock.acquire()
    try:
        yield
    finally:
        lock.release()


# --------------------------------------------------------------------------- #
# Results CSV codec
# --------------------------------------------------------------------------- #
RESULT_HEADERS = [
    "result_id",
    "status",
    "provider",
    "model",
    "example_id",
    "output",
    "score",
    "weight",
    "score_reason",
    "input_tokens",
    "output_tokens",
    "latency_ms",
    "ttft_ms",
    "tps",
    "num_llm_calls",
]


def _js_num(x: float | int) -> str:
    """Stringify a number like JS ``String(n)`` (integral floats lose ``.0``)."""
    f = float(x)
    if math.isfinite(f) and f == int(f):
        return str(int(f))
    return repr(f)


def _num_or_empty(v: Optional[float]) -> str:
    if v is None or not math.isfinite(float(v)):
        return ""
    return _js_num(v)


def _parse_num_or_null(v: Optional[str]):
    if v is None or v == "":
        return None
    try:
        n = float(v)
    except ValueError:
        return None
    if not math.isfinite(n):
        return None
    return int(n) if n.is_integer() else n


def serialize_rows(rows: list[ResultRow]) -> str:
    out_rows: list[list[str]] = []
    for r in rows:
        out_rows.append(
            [
                _js_num(r.result_id),
                r.status,
                r.provider,
                r.model,
                _js_num(r.example_id),
                r.output,
                _js_num(r.score),
                _js_num(r.weight),
                r.score_reason or "",
                _num_or_empty(r.input_tokens),
                _num_or_empty(r.output_tokens),
                _num_or_empty(r.latency_ms),
                _num_or_empty(r.ttft_ms),
                _num_or_empty(r.tps),
                _num_or_empty(r.num_llm_calls),
            ]
        )
    return stringify_csv(RESULT_HEADERS, out_rows)


def parse_rows(raw: str) -> list[ResultRow]:
    _, rows = parse_csv(raw)
    out: list[ResultRow] = []
    for row in rows:
        output = row.get("output", "") or ""
        status = row.get("status") or "completed"
        # weight is an optional column; default to 1.0 when absent or blank.
        weight_raw = row.get("weight")
        weight = 1.0
        if weight_raw not in (None, ""):
            try:
                wn = float(weight_raw)
                if math.isfinite(wn):
                    weight = wn
            except ValueError:
                pass
        reason = row.get("score_reason")
        out.append(
            ResultRow(
                result_id=int(row["result_id"]),
                status=status,
                provider=row.get("provider", "") or "",
                model=row.get("model", "") or "",
                example_id=int(row["example_id"]),
                output=output,
                score=float(row.get("score") or 0),
                weight=weight,
                score_reason=reason if reason else None,
                input_tokens=_parse_num_or_null(row.get("input_tokens")),
                output_tokens=_parse_num_or_null(row.get("output_tokens")),
                latency_ms=_parse_num_or_null(row.get("latency_ms")),
                ttft_ms=_parse_num_or_null(row.get("ttft_ms")),
                tps=_parse_num_or_null(row.get("tps")),
                num_llm_calls=_parse_num_or_null(row.get("num_llm_calls")),
            )
        )
    return out


def _row_key(provider: str, model: str, example_id: int) -> str:
    return f"{provider}|{model}|{example_id}"


# --------------------------------------------------------------------------- #
# Meta / results unlocked helpers
# --------------------------------------------------------------------------- #
def _read_run_meta_unlocked(experiment_id: str, run_id: str) -> Optional[RunMeta]:
    try:
        raw = paths.run_meta_path(experiment_id, run_id).read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        return RunMeta.model_validate_json(raw)
    except Exception:
        return None


def _write_run_meta_unlocked(experiment_id: str, meta: RunMeta) -> None:
    atomic_write(
        paths.run_meta_path(experiment_id, meta.run_id),
        meta.model_dump_json(indent=2),
    )


def _read_results_rows_unlocked(experiment_id: str, run_id: str) -> list[ResultRow]:
    try:
        raw = paths.run_results_path(experiment_id, run_id).read_text(encoding="utf-8")
    except OSError:
        return []
    return parse_rows(raw)


def _recount_meta(meta: RunMeta, rows: list[ResultRow]) -> RunMeta:
    completed = len(rows)
    errors = sum(1 for r in rows if r.status == "error")
    return meta.model_copy(update={"completed": completed, "errors": errors})


# --------------------------------------------------------------------------- #
# Providers / scorers
# --------------------------------------------------------------------------- #
def providers_file_exists() -> bool:
    return paths.providers_file().exists()


def list_providers() -> list[Provider]:
    """Read providers.json. Raises FileNotFoundError if it does not exist.

    This strict reader does NOT auto-create a placeholder; the API's
    ``list_providers_or_create`` does that for the UI.
    """
    pf = paths.providers_file()
    raw = pf.read_text(encoding="utf-8")  # raises FileNotFoundError if missing
    import json

    data = json.loads(raw)
    return [Provider.model_validate(p) for p in data]


_SCORER_NAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")


def _validate_scorer_name(name: str) -> None:
    if not name or not _SCORER_NAME_RE.match(name):
        raise ValueError(
            f'Invalid scorer name "{name}". Use letters, digits, dot, '
            "underscore, or dash."
        )


def get_scorer(name: str) -> Optional[LlmJudgeScorerDef]:
    ensure_dirs()
    _validate_scorer_name(name)
    try:
        raw = paths.scorer_file_path(name).read_text(encoding="utf-8")
    except OSError:
        return None
    import json

    parsed = json.loads(raw)
    max_score = parsed.get("max_score")
    if not (isinstance(max_score, (int, float)) and math.isfinite(max_score) and max_score > 0):
        max_score = 5
    return LlmJudgeScorerDef(
        name=parsed.get("name") or name,
        provider_name=parsed.get("provider_name") or "",
        model=parsed.get("model") or "",
        temperature=parsed.get("temperature") if isinstance(parsed.get("temperature"), (int, float)) else 0,
        judge_prompt=parsed.get("judge_prompt") or "",
        max_score=int(max_score),
    )


# --------------------------------------------------------------------------- #
# Run lifecycle
# --------------------------------------------------------------------------- #
def _reconcile_orphan_run(experiment_id: str, meta: RunMeta) -> RunMeta:
    if meta.status != "running":
        return meta
    if is_run_active(experiment_id, meta.run_id):
        return meta
    try:
        started = datetime.fromisoformat(meta.started_at.replace("Z", "+00:00"))
        started_ms = started.timestamp() * 1000
        if (time.time() * 1000) - started_ms < ORPHAN_GRACE_MS:
            return meta
    except ValueError:
        pass
    with with_run_lock(experiment_id, meta.run_id):
        current = _read_run_meta_unlocked(experiment_id, meta.run_id)
        if current is None or current.status != "running":
            return current or meta
        if is_run_active(experiment_id, meta.run_id):
            return current
        updated = current.model_copy(
            update={"status": "interrupted", "finished_at": iso_now()}
        )
        _write_run_meta_unlocked(experiment_id, updated)
        return updated


def list_runs(experiment_id: str) -> list[RunMeta]:
    ensure_dirs()
    d = paths.experiment_runs_dir(experiment_id)
    try:
        entries = [e.name for e in d.iterdir()]
    except OSError:
        return []
    runs: list[RunMeta] = []
    for entry in entries:
        if entry.startswith("."):
            continue
        meta = _read_run_meta_unlocked(experiment_id, entry)
        if meta:
            runs.append(_reconcile_orphan_run(experiment_id, meta))
    runs.sort(key=lambda m: m.started_at, reverse=True)
    return runs


def read_run_meta(experiment_id: str, run_id: str) -> Optional[RunMeta]:
    with with_run_lock(experiment_id, run_id):
        return _read_run_meta_unlocked(experiment_id, run_id)


def find_resumable_run(experiment_id: str) -> Optional[RunMeta]:
    runs = list_runs(experiment_id)
    if not runs:
        return None
    latest = runs[0]
    return latest if latest.status != "completed" else None


def find_latest_run(experiment_id: str) -> Optional[RunMeta]:
    runs = list_runs(experiment_id)
    return runs[0] if runs else None


def create_run(experiment: Experiment, total_tasks: int) -> RunMeta:
    ensure_dirs()
    run_id = new_run_id()
    d = paths.run_dir(experiment.id, run_id)
    d.mkdir(parents=True, exist_ok=True)
    paths.run_experiment_snapshot_path(experiment.id, run_id).write_text(
        experiment.model_dump_json(indent=2), encoding="utf-8"
    )
    meta = RunMeta(
        run_id=run_id,
        status="running",
        started_at=iso_now(),
        finished_at=None,
        resumed_at=[],
        total=total_tasks,
        completed=0,
        errors=0,
    )
    _write_run_meta_unlocked(experiment.id, meta)
    atomic_write(paths.run_results_path(experiment.id, run_id), serialize_rows([]))
    return meta


def mark_run_resumed(
    experiment_id: str, run_id: str, total_tasks: int
) -> Optional[RunMeta]:
    with with_run_lock(experiment_id, run_id):
        meta = _read_run_meta_unlocked(experiment_id, run_id)
        if meta is None:
            return None
        updated = meta.model_copy(
            update={
                "status": "running",
                "resumed_at": [*meta.resumed_at, iso_now()],
                "total": total_tasks,
            }
        )
        _write_run_meta_unlocked(experiment_id, updated)
        return updated


def complete_run(experiment_id: str, run_id: str, status: str) -> None:
    with with_run_lock(experiment_id, run_id):
        meta = _read_run_meta_unlocked(experiment_id, run_id)
        if meta is None:
            return
        updated = meta.model_copy(update={"status": status, "finished_at": iso_now()})
        _write_run_meta_unlocked(experiment_id, updated)


def save_run_results(experiment_id: str, run_id: str, rows: list[ResultRow]) -> None:
    with with_run_lock(experiment_id, run_id):
        paths.run_dir(experiment_id, run_id).mkdir(parents=True, exist_ok=True)
        atomic_write(paths.run_results_path(experiment_id, run_id), serialize_rows(rows))
        meta = _read_run_meta_unlocked(experiment_id, run_id)
        if meta:
            _write_run_meta_unlocked(experiment_id, _recount_meta(meta, rows))


def upsert_run_result_row(experiment_id: str, run_id: str, row: ResultRow) -> None:
    with with_run_lock(experiment_id, run_id):
        paths.run_dir(experiment_id, run_id).mkdir(parents=True, exist_ok=True)
        existing = _read_results_rows_unlocked(experiment_id, run_id)
        key = _row_key(row.provider, row.model, row.example_id)
        nxt = [r for r in existing if _row_key(r.provider, r.model, r.example_id) != key]
        nxt.append(row)
        nxt.sort(key=lambda r: r.result_id)
        atomic_write(paths.run_results_path(experiment_id, run_id), serialize_rows(nxt))
        meta = _read_run_meta_unlocked(experiment_id, run_id)
        if meta:
            _write_run_meta_unlocked(experiment_id, _recount_meta(meta, nxt))


def read_run_results(experiment_id: str, run_id: str) -> Optional[list[ResultRow]]:
    with with_run_lock(experiment_id, run_id):
        if not paths.run_results_path(experiment_id, run_id).exists():
            return None
        return _read_results_rows_unlocked(experiment_id, run_id)


def read_run_results_csv(experiment_id: str, run_id: str) -> Optional[str]:
    try:
        return paths.run_results_path(experiment_id, run_id).read_text(encoding="utf-8")
    except OSError:
        return None


def read_latest_results(experiment_id: str):
    latest = find_latest_run(experiment_id)
    if latest is None:
        return None
    rows = read_run_results(experiment_id, latest.run_id)
    if rows is None:
        return None
    return {"run_id": latest.run_id, "rows": rows}


def delete_run(experiment_id: str, run_id: str) -> str:
    """Returns 'deleted' | 'active' | 'not_found'."""
    if is_run_active(experiment_id, run_id):
        return "active"
    d = paths.run_dir(experiment_id, run_id)
    with with_run_lock(experiment_id, run_id):
        if not d.exists():
            return "not_found"
        import shutil

        shutil.rmtree(d, ignore_errors=True)
        return "deleted"


# --------------------------------------------------------------------------- #
# Experiments CRUD
# --------------------------------------------------------------------------- #
def list_experiments() -> list[Experiment]:
    ensure_dirs()
    out: list[Experiment] = []
    for entry in paths.experiments_dir().iterdir():
        if entry.name.startswith(".") or entry.suffix != ".json":
            continue
        try:
            raw = json.loads(entry.read_text(encoding="utf-8"))
            slug = entry.stem
            if raw.get("id") != slug:
                raw["id"] = slug
            out.append(Experiment.model_validate(raw))
        except Exception:
            continue  # skip malformed files
    out.sort(key=lambda e: e.id)
    return out


def get_experiment(experiment_id: str) -> Optional[Experiment]:
    ensure_dirs()
    try:
        raw = paths.experiment_file_path(experiment_id).read_text(encoding="utf-8")
    except OSError:
        return None
    try:
        return Experiment.model_validate(json.loads(raw))
    except Exception:
        return None


def save_experiment(experiment: Experiment) -> None:
    ensure_dirs()
    paths.experiment_file_path(experiment.id).write_text(
        json.dumps(experiment.model_dump(exclude_none=True), indent=2),
        encoding="utf-8",
    )


def delete_experiment(experiment_id: str) -> None:
    ensure_dirs()
    paths.experiment_file_path(experiment_id).unlink(missing_ok=True)
    runs = paths.experiment_runs_dir(experiment_id)
    if runs.exists():
        import shutil

        shutil.rmtree(runs, ignore_errors=True)


def next_experiment_id() -> str:
    existing = {e.id for e in list_experiments()}
    i = 1
    while str(i) in existing:
        i += 1
    return str(i)


# --------------------------------------------------------------------------- #
# Providers (write + UI-facing auto-create)
# --------------------------------------------------------------------------- #
DEFAULT_PROVIDERS = [
    Provider(
        name="SambaNova",
        api_url="https://api.sambanova.ai/v1",
        api_key="Obtain from https://cloud.sambanova.ai/apis",
    )
]


def list_providers_or_create() -> list[Provider]:
    """UI-facing read: auto-create a placeholder providers.json if missing.

    Auto-creating keeps the fresh-checkout UI flow working. The strict
    ``list_providers`` (used by the CLI/executor) does NOT do this.
    """
    ensure_dirs()
    pf = paths.providers_file()
    if not pf.exists():
        pf.write_text(
            json.dumps([p.model_dump() for p in DEFAULT_PROVIDERS], indent=2),
            encoding="utf-8",
        )
        return list(DEFAULT_PROVIDERS)
    try:
        return [Provider.model_validate(p) for p in json.loads(pf.read_text(encoding="utf-8"))]
    except Exception:
        return []


def save_providers(providers: list[Provider]) -> None:
    ensure_dirs()
    paths.providers_file().write_text(
        json.dumps([p.model_dump() for p in providers], indent=2), encoding="utf-8"
    )


# --------------------------------------------------------------------------- #
# Scorers CRUD
# --------------------------------------------------------------------------- #
def _scorer_from_raw(raw: dict, fallback_name: str) -> LlmJudgeScorerDef:
    max_score = raw.get("max_score")
    if not (isinstance(max_score, (int, float)) and math.isfinite(max_score) and max_score > 0):
        max_score = 5
    return LlmJudgeScorerDef(
        name=raw.get("name") or fallback_name,
        provider_name=raw.get("provider_name") or "",
        model=raw.get("model") or "",
        temperature=raw.get("temperature") if isinstance(raw.get("temperature"), (int, float)) else 0,
        judge_prompt=raw.get("judge_prompt") or "",
        max_score=int(max_score),
    )


def list_scorers() -> list[LlmJudgeScorerDef]:
    ensure_dirs()
    out: list[LlmJudgeScorerDef] = []
    for entry in paths.scorers_dir().iterdir():
        if entry.name.startswith(".") or entry.suffix != ".json":
            continue
        try:
            out.append(_scorer_from_raw(json.loads(entry.read_text(encoding="utf-8")), entry.stem))
        except Exception:
            continue
    out.sort(key=lambda s: s.name)
    return out


def save_scorer(scorer: LlmJudgeScorerDef) -> None:
    ensure_dirs()
    _validate_scorer_name(scorer.name)
    paths.scorer_file_path(scorer.name).write_text(
        json.dumps(scorer.model_dump(), indent=2), encoding="utf-8"
    )


def delete_scorer(name: str) -> None:
    ensure_dirs()
    _validate_scorer_name(name)
    paths.scorer_file_path(name).unlink(missing_ok=True)


# --------------------------------------------------------------------------- #
# Datasets CRUD
# --------------------------------------------------------------------------- #
def list_datasets() -> list[str]:
    ensure_dirs()
    return sorted(
        e.name
        for e in paths.datasets_dir().iterdir()
        if e.name.lower().endswith((".csv", ".jsonl"))
    )


def read_dataset(name: str) -> str:
    return paths.dataset_file_path(name).read_text(encoding="utf-8")


def write_dataset(name: str, content: str) -> None:
    ensure_dirs()
    paths.dataset_file_path(name).write_text(content, encoding="utf-8")


def delete_dataset(name: str) -> None:
    ensure_dirs()
    paths.dataset_file_path(name).unlink(missing_ok=True)
