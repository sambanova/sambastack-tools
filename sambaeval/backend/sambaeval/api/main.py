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

from .. import paths, run_registry, storage
from ..datasets import load_dataset
from ..executor import ExecutorProgress, run_experiment
from ..models import Experiment, LlmJudgeScorerDef, Provider

app = FastAPI(title="SambaEval API")

# The frontend runs on a different origin (e.g. http://localhost:3001), so
# allow cross-origin requests.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
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
    }
    if with_example_count and isinstance(body.get("example_count"), int):
        data["example_count"] = body["example_count"]
    return Experiment.model_validate(data)


# --------------------------------------------------------------------------- #
# Experiments
# --------------------------------------------------------------------------- #
@app.get("/api/experiments")
def list_experiments() -> dict:
    return {"experiments": [_exp_json(e) for e in storage.list_experiments()]}


@app.post("/api/experiments")
async def create_experiment(request: Request) -> dict:
    body = await request.json()
    exp_id = body["id"] if isinstance(body.get("id"), str) and body["id"] else storage.next_experiment_id()
    experiment = _build_experiment(body, exp_id, with_example_count=False)
    storage.save_experiment(experiment)
    return {"experiment": _exp_json(experiment)}


@app.get("/api/experiments/{exp_id}")
def get_experiment(exp_id: str):
    experiment = storage.get_experiment(exp_id)
    if experiment is None:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"experiment": _exp_json(experiment)}


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
    mode = requested_mode if requested_mode in ("new", "resume") else "auto"
    run_id: Optional[str] = qp.get("run_id") or None

    experiment = storage.get_experiment(exp_id)
    if experiment is None:
        return JSONResponse({"error": "Not found"}, status_code=404)

    if mode == "auto":
        resumable = storage.find_resumable_run(exp_id)
        if resumable is not None:
            return JSONResponse(
                {"error": "resumable_run_exists", "resumable": resumable.model_dump()},
                status_code=409,
            )
        mode = "new"

    cancel_event = threading.Event()
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

    def worker() -> None:
        try:
            result = run_experiment(
                experiment,
                concurrency=concurrency,
                mode=mode,
                run_id=run_id,
                on_progress=on_progress,
                cancel_event=cancel_event,
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

    threading.Thread(target=worker, daemon=True).start()

    async def event_stream():
        loop = asyncio.get_event_loop()
        try:
            while True:
                if await request.is_disconnected():
                    cancel_event.set()
                item = await loop.run_in_executor(None, _q_get, q)
                if item is _EMPTY:
                    continue
                if item is _SENTINEL:
                    break
                event, data = item
                yield f"event: {event}\ndata: {json.dumps(data)}\n\n"
        finally:
            cancel_event.set()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "Connection": "keep-alive"},
    )


@app.post("/api/experiments/{exp_id}/run/cancel")
def cancel(exp_id: str, request: Request):
    run_id = request.query_params.get("run_id")
    if not run_id:
        active = storage.find_resumable_run(exp_id)
        if active is None:
            return JSONResponse({"error": "no_active_run"}, status_code=404)
        run_id = active.run_id
    cancelled = run_registry.cancel_run(exp_id, run_id)
    return {"cancelled": cancelled, "runId": run_id}


# --------------------------------------------------------------------------- #
# Runs + results
# --------------------------------------------------------------------------- #
@app.get("/api/experiments/{exp_id}/runs")
def list_runs(exp_id: str) -> dict:
    return {"runs": [m.model_dump() for m in storage.list_runs(exp_id)]}


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
    if provider.name.lower() != "sambanova" and provider.api_key:
        headers["Authorization"] = f"Bearer {provider.api_key}"
    try:
        res = httpx.get(url, headers=headers, timeout=30.0)
        if res.status_code >= 400:
            return JSONResponse(
                {"error": f"Provider returned {res.status_code} for {url}", "models": []},
                status_code=502,
            )
        data = res.json()
        models = sorted(
            m["id"]
            for m in (data.get("data") or [])
            if isinstance(m.get("id"), str) and m["id"]
        )
        return {"models": models}
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
    storage.write_dataset(name, body.get("content") or "")
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
            ],
        )
    else:
        uvicorn.run(app, host=args.host, port=args.port)
