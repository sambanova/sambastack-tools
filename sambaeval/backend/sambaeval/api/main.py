"""FastAPI app serving SambaEval's /api/... routes for the web UI.

The run endpoint streams Server-Sent Events; because the executor is
synchronous (threads), each run executes on a worker thread that feeds
progress/done/error frames through a queue to the SSE generator.
"""

from __future__ import annotations

import asyncio
import json
import queue
import threading
from typing import Any, Optional

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .. import context, paths, run_registry, storage
from ..config import settings

try:  # DB backend helpers (queue/control) — only importable when deps present.
    from .. import storage_db
except Exception:  # pragma: no cover
    storage_db = None  # type: ignore
from ..datasets import load_dataset
from ..executor import ExecutorProgress, run_experiment
from ..models import Experiment, LlmJudgeScorerDef, Provider
from ..run_registry import RunControl
from . import admin as admin_routes
from . import auth as auth_routes

app = FastAPI(title="SambaEval API")

# CORS: with cookie-based sessions we cannot use "*" — pin to the frontend
# origin(s) and allow credentials so the session cookie is sent cross-origin.
_ALLOWED_ORIGINS = list(
    {
        settings.frontend_origin,
        "http://localhost:3001",
        "http://127.0.0.1:3001",
    }
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_routes.router)
app.include_router(admin_routes.router)


@app.on_event("startup")
def _startup() -> None:
    if settings.use_db:
        try:
            from ..bootstrap import bootstrap

            bootstrap()
        except Exception as err:  # noqa: BLE001 — don't crash serving on seed hiccup
            print(f"[api] bootstrap warning: {err}")
        # Native dev convenience: run the worker in-process when asked (compose
        # runs a separate worker service instead).
        import os

        if os.environ.get("SAMBAEVAL_INPROC_WORKER", "").lower() in ("1", "true", "yes"):
            from ..worker import start_in_process_worker

            start_in_process_worker()
            print("[api] in-process worker started")


@app.middleware("http")
async def _auth_middleware(request: Request, call_next):
    """Attach the current user and set the owner scope for the request.

    Data reads in the request thread resolve against ``active_owner`` so
    visibility scoping works. Protected /api routes require a user.
    """
    path = request.url.path
    token = None
    if settings.use_db and path.startswith("/api"):
        user = auth_routes.resolve_user(request)
        request.state.user = user
        if user is not None:
            token = context.set_active_owner(user.id)
        elif path not in auth_routes.PUBLIC_PATHS and not path.startswith("/api/auth"):
            return JSONResponse({"error": "unauthenticated"}, status_code=401)
    try:
        return await call_next(request)
    finally:
        if token is not None:
            context._active_owner.reset(token)


def _current_user(request: Request):
    return getattr(request.state, "user", None)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/generators")
def list_generators(request: Request) -> dict:
    """Enabled generator catalog for the picker (read-only for regular users)."""
    if not settings.use_db:
        return {"generators": []}
    from sqlalchemy import select as _select

    from ..db import session_scope
    from ..models_db import Generator

    with session_scope() as session:
        rows = session.execute(
            _select(Generator).where(Generator.enabled == True)  # noqa: E712
        ).scalars().all()
        return {
            "generators": [
                {
                    "key": g.key,
                    "display_name": g.display_name,
                    "description": g.description,
                    "requires_sandbox": g.requires_sandbox,
                }
                for g in rows
            ]
        }


def _sandbox_block_reason(experiment: Experiment) -> Optional[str]:
    """Why this experiment may not run here, if code execution is disabled.

    ``SANDBOX_ENABLED`` is a deployment capability switch (see config.py and
    deploy/CONTRACT.md); the generator catalog already records which generators
    execute model-written code (``requires_sandbox``). Enforcing the two against
    each other here — once, at enqueue — refuses the run up front with a clear
    reason instead of letting it abort deep inside a worker.
    """
    if settings.sandbox_enabled or not settings.use_db:
        return None
    script_path = (experiment.output_generator or "").strip()
    if not script_path:
        return None
    from sqlalchemy import select as _select

    from ..db import session_scope
    from ..models_db import Generator

    with session_scope() as session:
        g = session.execute(
            _select(Generator).where(Generator.script_path == script_path)
        ).scalars().first()
        if g is None or not g.requires_sandbox:
            return None
        name = g.display_name or g.key
    return (
        f"'{name}' executes model-generated code, but code execution is "
        "disabled in this deployment (SANDBOX_ENABLED=0)."
    )


def _exp_json(e: Experiment) -> dict:
    # exclude_none drops keys that are None (e.g. example_count / seed) so they
    # don't appear in the response or the saved experiment file.
    return e.model_dump(exclude_none=True)


def _build_experiment(body: dict, exp_id: str, *, with_example_count: bool) -> Experiment:
    data: dict[str, Any] = {
        "id": exp_id,
        "name": body.get("name") or f"Experiment {exp_id}",
        "models": body.get("models") or [],
        "system_prompt": body.get("system_prompt") or "",
        "dataset": body.get("dataset") if body.get("dataset") is not None else "",
        "scorer": body.get("scorer") or {"type": "heuristic"},
        "output_generator": body.get("output_generator") or "",
        "private": bool(body.get("private")),
    }
    if with_example_count and isinstance(body.get("example_count"), int):
        data["example_count"] = body["example_count"]
    return Experiment.model_validate(data)


# --------------------------------------------------------------------------- #
# Experiments
# --------------------------------------------------------------------------- #
@app.get("/api/experiments")
def list_experiments(request: Request) -> dict:
    # Scope filter (db mode): mine | public | shared | all (default all-visible).
    # Each experiment JSON is annotated with `visibility` and `owner`
    # ("me"|"other"|"system") so the UI can render My/Public/Shared tabs +
    # sharing controls.
    if settings.use_db and storage_db is not None:
        scope = request.query_params.get("scope") or "all"
        out = []
        for item in storage_db.list_experiments_scoped(scope):
            ej = _exp_json(item["experiment"])
            ej["visibility"] = item["visibility"]
            ej["owner"] = item["owner"]
            ej["is_owner"] = item["is_owner"]
            if item["is_owner"] or (_current_user(request) and _current_user(request).is_admin):
                ej["share_token"] = item["share_token"]
            out.append(ej)
        return {"experiments": out}
    return {"experiments": [_exp_json(e) for e in storage.list_experiments()]}


@app.post("/api/experiments")
async def create_experiment(request: Request) -> dict:
    body = await request.json()
    exp_id = body["id"] if isinstance(body.get("id"), str) and body["id"] else storage.next_experiment_id()
    experiment = _build_experiment(body, exp_id, with_example_count=False)
    storage.save_experiment(experiment)
    return {"experiment": _exp_json(experiment)}


@app.get("/api/experiments/{exp_id}")
def get_experiment(exp_id: str, request: Request):
    experiment = storage.get_experiment(exp_id)
    if experiment is None and settings.use_db and storage_db is not None:
        # Allow view via a valid share link (link-shared experiments).
        token = request.query_params.get("token")
        if token:
            experiment = storage_db.get_experiment_by_share_token(token)
    if experiment is None:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"experiment": _exp_json(experiment)}


@app.post("/api/experiments/{exp_id}/visibility")
async def set_experiment_visibility(exp_id: str, request: Request):
    if not (settings.use_db and storage_db is not None):
        return JSONResponse({"error": "not supported"}, status_code=400)
    user = _current_user(request)
    owner_id = storage_db.experiment_owner_id(exp_id)
    if owner_id is None:
        return JSONResponse({"error": "Not found"}, status_code=404)
    if not (user and (user.is_admin or user.id == owner_id)):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    body = await request.json()
    try:
        result = storage_db.set_experiment_visibility(exp_id, body.get("visibility") or "")
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    if result == "not_found":
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"ok": True}


@app.post("/api/experiments/{exp_id}/share")
def share_experiment(exp_id: str, request: Request):
    if not (settings.use_db and storage_db is not None):
        return JSONResponse({"error": "not supported"}, status_code=400)
    user = _current_user(request)
    owner_id = storage_db.experiment_owner_id(exp_id)
    if owner_id is None:
        return JSONResponse({"error": "Not found"}, status_code=404)
    if not (user and (user.is_admin or user.id == owner_id)):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    token = storage_db.ensure_experiment_share_token(exp_id)
    url = f"{settings.frontend_origin}/experiments/{exp_id}?token={token}"
    return {"share_token": token, "url": url}


@app.put("/api/experiments/{exp_id}")
async def update_experiment(exp_id: str, request: Request) -> dict:
    body = await request.json()
    experiment = _build_experiment(body, exp_id, with_example_count=True)
    storage.save_experiment(experiment)
    return {"experiment": _exp_json(experiment)}


@app.delete("/api/experiments/{exp_id}")
def delete_experiment(exp_id: str) -> dict:
    storage.delete_experiment(exp_id)
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Run (SSE)
# --------------------------------------------------------------------------- #
_EMPTY = object()
_SENTINEL = object()


def _q_get(q: "queue.Queue"):
    try:
        return q.get(timeout=0.5)
    except queue.Empty:
        return _EMPTY


@app.post("/api/experiments/{exp_id}/run")
async def run(exp_id: str, request: Request):
    qp = request.query_params
    try:
        concurrency = int(qp.get("concurrency") or "4")
    except ValueError:
        concurrency = 4
    concurrency = max(1, min(32, concurrency))
    requested_mode = qp.get("mode")
    mode = (
        requested_mode
        if requested_mode in ("new", "resume", "retry", "merged")
        else "auto"
    )
    run_id: Optional[str] = qp.get("run_id") or None
    merge_conflict = "overwrite" if qp.get("merge_conflict") == "overwrite" else "skip"
    # Optional model subset for a new or merged run (comma-separated
    # "provider|name" keys). Absent => run every model in the experiment (the
    # default). Resume/retry rebuild from the run's own rows, so it's ignored
    # there.
    models_param = qp.get("models")
    selected_models: Optional[list[str]] = (
        [m for m in models_param.split(",") if m]
        if (models_param and mode in ("new", "auto", "merged"))
        else None
    )

    experiment = storage.get_experiment(exp_id)
    if experiment is None:
        return JSONResponse({"error": "Not found"}, status_code=404)

    if selected_models is not None:
        experiment_model_keys = {
            f"{m.provider_name}|{m.name}" for m in experiment.models
        }
        chosen = [m for m in selected_models if m in experiment_model_keys]
        if not chosen:
            return JSONResponse(
                {"error": "Select at least one of the experiment's models."},
                status_code=400,
            )
        selected_models = chosen

    update_snapshot = True  # for the DB enqueue path (retry-default keeps snapshot)

    if mode == "merged":
        # Generate the current experiment's results into an existing target run.
        # The two must share a dataset; the target must exist and be idle.
        if not run_id:
            return JSONResponse(
                {"error": "A merged run requires a target run_id"}, status_code=400
            )
        meta = storage.read_run_meta(exp_id, run_id)
        if meta is None:
            return JSONResponse({"error": "run_not_found"}, status_code=404)
        if _is_active(exp_id, run_id):
            return JSONResponse({"error": "run_is_active"}, status_code=409)
        if storage.run_dataset_key(exp_id, run_id) != storage.dataset_key(
            experiment.dataset
        ):
            return JSONResponse(
                {"error": "Target run uses a different dataset."}, status_code=400
            )

    if mode == "resume":
        if not run_id:
            target = storage.find_resumable_run(exp_id)
            if target is None:
                return JSONResponse({"error": "no_resumable_run"}, status_code=404)
            run_id = target.run_id
        meta = storage.read_run_meta(exp_id, run_id)
        if meta is None:
            return JSONResponse({"error": "run_not_found"}, status_code=404)
        if _is_active(exp_id, run_id):
            return JSONResponse({"error": "run_is_active"}, status_code=409)

    if mode == "retry":
        # Retrying re-runs only the failed rows of a past run, carrying over the
        # rows that already succeeded. By default it reproduces the original
        # conditions via the config snapshot captured when the run started;
        # `config=live` instead applies the experiment's *current* settings
        # (e.g. an edited model param) to those failed rows.
        use_live_config = qp.get("config") == "live"
        update_snapshot = use_live_config
        if not run_id:
            target = storage.find_retryable_run(exp_id)
            if target is None:
                return JSONResponse(
                    {"error": "no_retryable_run"}, status_code=404
                )
            run_id = target.run_id
        meta = storage.read_run_meta(exp_id, run_id)
        if meta is None:
            return JSONResponse({"error": "run_not_found"}, status_code=404)
        if _is_active(exp_id, run_id):
            return JSONResponse({"error": "run_is_active"}, status_code=409)
        if not use_live_config:
            snapshot = storage.read_run_experiment_snapshot(exp_id, run_id)
            if snapshot is not None:
                experiment = snapshot

    if mode == "auto":
        resumable = storage.find_resumable_run(exp_id)
        if resumable is not None:
            return JSONResponse(
                {"error": "resumable_run_exists", "resumable": resumable.model_dump()},
                status_code=409,
            )
        mode = "new"

    blocked = _sandbox_block_reason(experiment)
    if blocked is not None:
        # 403, not 409: this is a policy refusal, not a conflict with existing
        # state. 409 on this endpoint already means "a resumable run exists",
        # which the UI reacts to by offering to resume.
        return JSONResponse({"error": blocked}, status_code=403)

    run_params = {
        "concurrency": concurrency,
        "merge_conflict": merge_conflict,
        "selected_models": selected_models,
    }

    # ---- DB backend: enqueue + SSE-poll (decoupled worker executes) ---------
    if settings.use_db:
        user = _current_user(request)
        owner_id = user.id if user is not None else context.active_owner()
        # Concurrency quota (queued + running) per user.
        active = storage_db.count_active_runs_for_owner(owner_id)
        if active >= settings.max_concurrent_runs_per_user:
            return JSONResponse(
                {
                    "error": (
                        f"max {settings.max_concurrent_runs_per_user} concurrent runs "
                        "reached; wait for one to finish."
                    )
                },
                status_code=429,
            )
        target_run_id = run_id if mode in ("resume", "retry", "merged") else None
        try:
            label = storage_db.enqueue_run(
                experiment,
                mode=mode,
                params=run_params,
                owner_id=owner_id,
                target_run_id=target_run_id,
                update_snapshot=update_snapshot,
            )
        except FileNotFoundError:
            return JSONResponse({"error": "run_not_found"}, status_code=404)

        async def db_stream():
            while True:
                if await request.is_disconnected():
                    break
                m = storage.read_run_meta(exp_id, label)
                if m is None:
                    await asyncio.sleep(0.5)
                    continue
                st = storage_db.run_status(exp_id, label)
                yield "event: progress\ndata: " + json.dumps(
                    {
                        "total": m.total,
                        "completed": m.completed,
                        "errors": m.errors,
                        "status": st,
                        "runId": label,
                    }
                ) + "\n\n"
                if st in ("completed", "aborted", "interrupted", "paused"):
                    rows = storage.read_run_results(exp_id, label) or []
                    yield "event: done\ndata: " + json.dumps(
                        {
                            "runId": label,
                            "meta": m.model_dump(),
                            "results": [r.model_dump() for r in rows],
                        }
                    ) + "\n\n"
                    break
                await asyncio.sleep(0.5)

        return StreamingResponse(
            db_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache, no-transform", "Connection": "keep-alive"},
        )

    # ---- Files backend (legacy): in-thread execution + SSE ------------------
    control = RunControl()
    q: "queue.Queue" = queue.Queue()

    def on_progress(p: ExecutorProgress) -> None:
        q.put((
            "progress",
            {
                "total": p.total,
                "completed": p.completed,
                "errors": p.errors,
                "currentLabel": p.current_label,
                "runId": p.run_id,
            },
        ))

    def legacy_worker() -> None:
        try:
            result = run_experiment(
                experiment,
                concurrency=concurrency,
                mode=mode,
                run_id=run_id,
                merge_conflict=merge_conflict,
                selected_models=selected_models,
                on_progress=on_progress,
                control=control,
            )
            q.put((
                "done",
                {
                    "runId": result.run_id,
                    "meta": result.meta.model_dump(),
                    "results": [r.model_dump() for r in result.results],
                },
            ))
        except Exception as err:  # noqa: BLE001
            q.put(("error", {"message": str(err)}))
        finally:
            q.put(_SENTINEL)

    threading.Thread(target=legacy_worker, daemon=True).start()

    async def event_stream():
        loop = asyncio.get_event_loop()
        while True:
            if await request.is_disconnected():
                break
            item = await loop.run_in_executor(None, _q_get, q)
            if item is _EMPTY:
                continue
            if item is _SENTINEL:
                break
            event, data = item
            yield f"event: {event}\ndata: {json.dumps(data)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "Connection": "keep-alive"},
    )


def _resolve_active_run_id(exp_id: str, request: Request) -> Optional[str]:
    run_id = request.query_params.get("run_id")
    if run_id:
        return run_id
    active = storage.find_resumable_run(exp_id)
    return active.run_id if active is not None else None


def _is_active(exp_id: str, run_id: str) -> bool:
    """Whether a run is queued or executing — DB-aware (cross-process) in db
    mode, in-process registry otherwise."""
    if settings.use_db and storage_db is not None:
        return storage_db.run_status(exp_id, run_id) in ("queued", "running")
    return run_registry.is_run_active(exp_id, run_id)


@app.post("/api/experiments/{exp_id}/run/cancel")
def cancel(exp_id: str, request: Request):
    run_id = _resolve_active_run_id(exp_id, request)
    if run_id is None:
        return JSONResponse({"error": "no_active_run"}, status_code=404)
    if settings.use_db:
        # DB-backed control: the worker's poller applies this (cross-process).
        st = storage_db.run_status(exp_id, run_id)
        if st == "queued":
            # Not yet claimed by a worker — finalize directly.
            storage.complete_run(exp_id, run_id, "aborted")
            return {"cancelled": True, "runId": run_id}
        if st == "running":
            storage_db.set_run_control(exp_id, run_id, "terminate")
            return {"cancelled": True, "runId": run_id}
        return {"cancelled": False, "runId": run_id}
    cancelled = run_registry.cancel_run(exp_id, run_id)
    if not cancelled:
        # Not in the in-process registry: the run lost its worker (server
        # restart / crash) but its run.json may still say "running". Finalize it
        # directly so an orphaned run can always be stopped from the UI.
        meta = storage.read_run_meta(exp_id, run_id)
        if meta is not None and meta.status in ("running", "paused"):
            storage.complete_run(exp_id, run_id, "aborted")
            cancelled = True
    return {"cancelled": cancelled, "runId": run_id}


@app.post("/api/experiments/{exp_id}/run/pause")
def pause(exp_id: str, request: Request):
    """Gracefully pause a run: stop dispatching new tasks and let the in-flight
    ones finish. The run is marked ``paused`` and can be resumed later."""
    run_id = _resolve_active_run_id(exp_id, request)
    if run_id is None:
        return JSONResponse({"error": "no_active_run"}, status_code=404)
    if settings.use_db:
        paused = storage_db.set_run_control(exp_id, run_id, "pause")
        return {"paused": paused, "runId": run_id}
    paused = run_registry.pause_run(exp_id, run_id)
    return {"paused": paused, "runId": run_id}


@app.post("/api/experiments/{exp_id}/run/terminate")
def terminate(exp_id: str, request: Request):
    """Force the worker pool down so a pause doesn't block on in-flight tasks.
    The abandoned tasks write no results and re-run when the run is resumed."""
    run_id = _resolve_active_run_id(exp_id, request)
    if run_id is None:
        return JSONResponse({"error": "no_active_run"}, status_code=404)
    if settings.use_db:
        terminated = storage_db.set_run_control(exp_id, run_id, "terminate")
        return {"terminated": terminated, "runId": run_id}
    terminated = run_registry.cancel_run(exp_id, run_id)
    return {"terminated": terminated, "runId": run_id}


# --------------------------------------------------------------------------- #
# Runs + results
# --------------------------------------------------------------------------- #
def _run_token_usage(exp_id: str, run_id: str) -> list[dict]:
    """Per-(provider, model) token totals for one run, used by the Results UI to
    derive a per-run cost from the editable prices. Returns [] when the run has
    no results yet."""
    rows = storage.read_run_results(exp_id, run_id) or []
    agg: dict[tuple[str, str], dict[str, float]] = {}
    for r in rows:
        key = (r.provider, r.model)
        bucket = agg.setdefault(key, {"input_tokens": 0.0, "output_tokens": 0.0})
        if r.input_tokens is not None:
            bucket["input_tokens"] += r.input_tokens
        if r.output_tokens is not None:
            bucket["output_tokens"] += r.output_tokens
    return [
        {
            "provider": provider,
            "model": model,
            "input_tokens": v["input_tokens"],
            "output_tokens": v["output_tokens"],
        }
        for (provider, model), v in agg.items()
    ]


@app.get("/api/experiments/{exp_id}/runs")
def list_runs(exp_id: str) -> dict:
    out = []
    for m in storage.list_runs(exp_id):
        entry = m.model_dump()
        entry["token_usage"] = _run_token_usage(exp_id, m.run_id)
        # Stable per-run dataset identifier so the Merge Results UI can restrict
        # merging to runs over the same dataset.
        entry["dataset_key"] = storage.run_dataset_key(exp_id, m.run_id)
        out.append(entry)
    return {"runs": out}


@app.delete("/api/experiments/{exp_id}/runs")
def delete_run(exp_id: str, request: Request):
    run_id = request.query_params.get("run_id")
    if not run_id:
        return JSONResponse({"error": "Missing 'run_id' query parameter"}, status_code=400)
    result = storage.delete_run(exp_id, run_id)
    if result == "active":
        return JSONResponse(
            {"error": "Run is still active. Cancel it before deleting."}, status_code=409
        )
    if result == "not_found":
        return JSONResponse({"error": "Run not found"}, status_code=404)
    return {"deleted": True, "runId": run_id}


@app.post("/api/experiments/{exp_id}/runs/merge")
async def merge_runs(exp_id: str, request: Request):
    """Merge one run's results into another (in place).

    Body: ``{"from_run_id": str, "into_run_id": str, "overwrite": bool}``.
    Returns 200 ``{"status": "merged", ...}`` on success, or 409
    ``{"status": "conflict", "conflicts": [{"from", "into"}, ...]}`` when
    overwrite is off and the runs share a (provider, model, example_id) tuple.
    """
    body = await request.json()
    from_run_id = body.get("from_run_id")
    into_run_id = body.get("into_run_id")
    overwrite = bool(body.get("overwrite", False))
    if not from_run_id or not into_run_id:
        return JSONResponse(
            {"error": "Both 'from_run_id' and 'into_run_id' are required."},
            status_code=400,
        )
    try:
        result = storage.merge_run_results(
            exp_id, from_run_id, into_run_id, overwrite
        )
    except FileNotFoundError as e:
        return JSONResponse({"error": str(e)}, status_code=404)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    if result.get("status") == "conflict":
        return JSONResponse(result, status_code=409)
    return result


@app.get("/api/experiments/{exp_id}/results")
def results(exp_id: str, request: Request):
    qp = request.query_params
    fmt = qp.get("format")
    run_id = qp.get("run_id")

    if fmt == "csv":
        target = run_id
        if not target:
            latest = storage.find_latest_run(exp_id)
            target = latest.run_id if latest else None
        if not target:
            return JSONResponse({"error": "No results"}, status_code=404)
        csv = storage.read_run_results_csv(exp_id, target)
        if csv is None:
            return JSONResponse({"error": "No results"}, status_code=404)
        return Response(
            content=csv,
            media_type="text/csv; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="{exp_id}_{target}_results.csv"'
            },
        )

    if run_id:
        rows = storage.read_run_results(exp_id, run_id)
        if rows is None:
            return {"results": None, "runId": run_id}
        return {"results": [r.model_dump() for r in rows], "runId": run_id}

    latest = storage.read_latest_results(exp_id)
    if latest is None:
        return {"results": None, "runId": None}
    return {"results": [r.model_dump() for r in latest["rows"]], "runId": latest["run_id"]}


@app.get("/api/experiments/{exp_id}/errors")
def run_errors(exp_id: str, request: Request) -> dict:
    """The errors.json log for one run (defaults to the latest run).

    Shape: ``{ "<example_id>": { "<provider>/<model>": {"phase", "message"} } }``.
    Empty when the run recorded no errors (or has no log file)."""
    run_id = request.query_params.get("run_id")
    if not run_id:
        latest = storage.find_latest_run(exp_id)
        run_id = latest.run_id if latest else None
    if not run_id:
        return {"errors": {}, "runId": None}
    return {"errors": storage.get_run_errors(exp_id, run_id), "runId": run_id}


# --------------------------------------------------------------------------- #
# Providers
# --------------------------------------------------------------------------- #
@app.get("/api/providers")
def list_providers() -> dict:
    return {"providers": [p.model_dump() for p in storage.list_providers_or_create()]}


@app.put("/api/providers")
async def put_providers(request: Request) -> dict:
    body = await request.json()
    providers = [Provider.model_validate(p) for p in (body.get("providers") or [])]
    storage.save_providers(providers)
    return {"providers": [p.model_dump() for p in providers]}


@app.get("/api/pricing-defaults")
def pricing_defaults() -> dict:
    """Default token prices ($/1M) keyed by provider -> model -> {input, output}.

    Populated by scripts/update_pricing.py from the token-costs crawled snapshots
    of the OpenAI/Anthropic pricing pages. The Results cost UI reads its defaults
    from here (falling back to live /models pricing for anything not listed)."""
    return {"pricing": storage.read_pricing_defaults()}


@app.get("/api/providers/models")
def provider_models(request: Request):
    provider_name = request.query_params.get("provider")
    if not provider_name:
        return JSONResponse({"error": "Missing 'provider' query parameter"}, status_code=400)
    providers = storage.list_providers_or_create()
    provider = next((p for p in providers if p.name == provider_name), None)
    if provider is None:
        return JSONResponse({"error": f"Unknown provider: {provider_name}"}, status_code=404)

    url = provider.api_url.rstrip("/") + "/models"
    headers: dict[str, str] = {}
    is_anthropic = (
        "anthropic" in provider.api_url.lower()
        or provider.name.lower() == "anthropic"
    )
    if is_anthropic and provider.api_key:
        # Anthropic's /models endpoint uses x-api-key + a version header,
        # not the OpenAI-style Authorization: Bearer (which 401s here even
        # though it works on the OpenAI-compat /chat/completions layer).
        headers["x-api-key"] = provider.api_key
        headers["anthropic-version"] = "2023-06-01"
    elif provider.name.lower() != "sambanova" and provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"
    try:
        res = httpx.get(url, headers=headers, timeout=30.0)
        if res.status_code >= 400:
            return JSONResponse(
                {"error": f"Provider returned {res.status_code} for {url}", "models": []},
                status_code=502,
            )
        data = res.json()
        entries = [
            m
            for m in (data.get("data") or [])
            if isinstance(m.get("id"), str) and m["id"]
        ]
        models = sorted(m["id"] for m in entries)
        # Surface per-token pricing when the provider reports it (SambaNova's
        # /models returns {"pricing": {"prompt": "<$/token>", "completion":
        # "<$/token>"}}). Convert to USD per 1,000,000 tokens — the unit the
        # Results cost UI edits in. Providers that omit pricing (OpenAI,
        # Anthropic, …) simply contribute nothing here.
        pricing: dict[str, dict[str, float]] = {}
        for m in entries:
            p = m.get("pricing")
            if not isinstance(p, dict):
                continue
            entry: dict[str, float] = {}
            for ui_key, src_key in (("input", "prompt"), ("output", "completion")):
                try:
                    per_token = float(p[src_key])
                except (KeyError, TypeError, ValueError):
                    continue
                entry[ui_key] = per_token * 1_000_000
            if entry:
                pricing[m["id"]] = entry
        return {"models": models, "pricing": pricing}
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"error": str(err), "models": []}, status_code=502)


# --------------------------------------------------------------------------- #
# Datasets
# --------------------------------------------------------------------------- #
@app.get("/api/datasets")
def get_datasets(request: Request):
    qp = request.query_params
    name = qp.get("name")
    if name and qp.get("count"):
        try:
            rows = load_dataset(name)
            return {"count": len(rows)}
        except Exception as err:  # noqa: BLE001
            return JSONResponse({"error": str(err) or "Failed to read dataset"}, status_code=400)
    if name:
        try:
            content = storage.read_dataset(name)
        except OSError:
            return JSONResponse({"error": "Not found"}, status_code=404)
        media = (
            "application/x-ndjson; charset=utf-8"
            if name.lower().endswith(".jsonl")
            else "text/csv; charset=utf-8"
        )
        return Response(content=content, media_type=media)
    return {"datasets": storage.list_datasets()}


@app.post("/api/datasets")
async def post_dataset(request: Request):
    body = await request.json()
    name = body.get("name") or ""
    lower = name.lower()
    if not name or not (lower.endswith(".csv") or lower.endswith(".jsonl")):
        return JSONResponse({"error": "Dataset name must end with .csv or .jsonl"}, status_code=400)
    storage.write_dataset(name, body.get("content") or "", private=bool(body.get("private")))
    return {"name": name}


@app.delete("/api/datasets")
def delete_dataset(request: Request):
    name = request.query_params.get("name")
    if not name:
        return JSONResponse({"error": "name required"}, status_code=400)
    storage.delete_dataset(name)
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Scorers
# --------------------------------------------------------------------------- #
@app.get("/api/scorers")
def get_scorers() -> dict:
    return {"scorers": [s.model_dump() for s in storage.list_scorers()]}


@app.put("/api/scorers")
async def put_scorers(request: Request):
    body = await request.json()
    incoming = [LlmJudgeScorerDef.model_validate(s) for s in (body.get("scorers") or [])]

    seen: set[str] = set()
    for s in incoming:
        if not s.name:
            return JSONResponse({"error": "Every scorer needs a name."}, status_code=400)
        if s.name in seen:
            return JSONResponse({"error": f'Duplicate scorer name "{s.name}".'}, status_code=400)
        seen.add(s.name)

    for prior in storage.list_scorers():
        if prior.name not in seen:
            storage.delete_scorer(prior.name)
    try:
        for s in incoming:
            storage.save_scorer(s)
    except Exception as err:  # noqa: BLE001
        return JSONResponse({"error": str(err)}, status_code=400)

    return {"scorers": [s.model_dump() for s in storage.list_scorers()]}


# --------------------------------------------------------------------------- #
# App version
# --------------------------------------------------------------------------- #
@app.get("/api/app-version")
def app_version():
    version_file = paths.data_dir().parent / "VERSION"
    if not version_file.exists():
        return JSONResponse({"success": False, "error": "VERSION file not found"}, status_code=404)
    version = version_file.read_text(encoding="utf-8").strip()
    if not version:
        return JSONResponse({"success": False, "error": "VERSION file is empty"}, status_code=500)
    return {"success": True, "version": version}


def serve() -> None:
    """Console entry point: run the API with uvicorn.

    ``sambaeval-server [--host H] [--port P] [--reload]``. ``--reload`` is a dev
    mode that auto-restarts the server when any file under the backend package
    or the generator scripts changes (so edits to generators are picked up
    without a manual restart).
    """
    import argparse

    import uvicorn

    parser = argparse.ArgumentParser(
        prog="sambaeval-server", description="SambaEval HTTP API"
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Dev mode: auto-restart on changes to backend/ or scripts/generators/.",
    )
    args = parser.parse_args()

    if args.reload:
        # reload requires the app as an import string, and we point the watcher
        # at the package source + the generator scripts.
        root = paths.data_dir().parent
        uvicorn.run(
            "sambaeval.api.main:app",
            host=args.host,
            port=args.port,
            reload=True,
            reload_dirs=[
                str(root / "backend" / "sambaeval"),
                str(root / "scripts" / "generators"),
                str(root / "scripts" / "private"),
            ],
        )
    else:
        uvicorn.run(app, host=args.host, port=args.port)
