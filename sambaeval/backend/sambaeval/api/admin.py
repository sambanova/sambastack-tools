"""Admin API (prodplan §7a) — admin-only routes for what regular users can't do:
large/bulk dataset upload (no 50 MB cap), generator enable/disable, promote a
resource to public, and user administration.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select

from .. import storage
from ..db import session_scope
from ..models_db import Dataset, Experiment, Generator, Scorer, User

router = APIRouter(prefix="/api/admin")


def _require_admin(request: Request):
    user = getattr(request.state, "user", None)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    if not user.is_admin:
        return JSONResponse({"error": "admin only"}, status_code=403)
    return None


# --------------------------------------------------------------------------- #
# Generators catalog
# --------------------------------------------------------------------------- #
@router.get("/generators")
def list_generators(request: Request):
    guard = _require_admin(request)
    if guard:
        return guard
    with session_scope() as session:
        rows = session.execute(select(Generator)).scalars().all()
        return {
            "generators": [
                {
                    "key": g.key,
                    "display_name": g.display_name,
                    "description": g.description,
                    "script_path": g.script_path,
                    "requires_sandbox": g.requires_sandbox,
                    "enabled": g.enabled,
                }
                for g in rows
            ]
        }


@router.patch("/generators/{key}")
async def patch_generator(key: str, request: Request):
    guard = _require_admin(request)
    if guard:
        return guard
    body = await request.json()
    with session_scope() as session:
        g = session.get(Generator, key)
        if g is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        if "enabled" in body:
            g.enabled = bool(body["enabled"])
        if "requires_sandbox" in body:
            g.requires_sandbox = bool(body["requires_sandbox"])
        return {"ok": True}


# --------------------------------------------------------------------------- #
# Large / bulk dataset upload (no size cap) — registered public/shared
# --------------------------------------------------------------------------- #
@router.post("/datasets")
async def admin_upload_dataset(request: Request):
    guard = _require_admin(request)
    if guard:
        return guard
    body = await request.json()
    name = body.get("name") or ""
    lower = name.lower()
    if not name or not (lower.endswith(".csv") or lower.endswith(".jsonl")):
        return JSONResponse({"error": "name must end with .csv or .jsonl"}, status_code=400)
    # Admin datasets are public by default and bypass the 50 MB user cap
    # (owner is the admin, set by the auth middleware's active_owner).
    storage.write_dataset(name, body.get("content") or "", private=False)
    # Mark uploaded_by_admin.
    with session_scope() as session:
        row = session.execute(
            select(Dataset).where(Dataset.name == name).order_by(Dataset.created_at.desc())
        ).scalars().first()
        if row is not None:
            row.uploaded_by_admin = True
    return {"name": name}


# --------------------------------------------------------------------------- #
# Promote any resource to public
# --------------------------------------------------------------------------- #
_MODELS = {"experiment": Experiment, "dataset": Dataset, "scorer": Scorer}


@router.post("/promote")
async def promote(request: Request):
    guard = _require_admin(request)
    if guard:
        return guard
    body = await request.json()
    rtype = body.get("resource_type")
    rid = body.get("resource_id")
    model = _MODELS.get(rtype)
    if model is None or not rid:
        return JSONResponse({"error": "resource_type and resource_id required"}, status_code=400)
    with session_scope() as session:
        obj = session.get(model, rid if rtype == "experiment" else uuid.UUID(rid))
        if obj is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        obj.visibility = "public"
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Users
# --------------------------------------------------------------------------- #
@router.get("/users")
def list_users(request: Request):
    guard = _require_admin(request)
    if guard:
        return guard
    with session_scope() as session:
        rows = session.execute(select(User).order_by(User.email)).scalars().all()
        return {
            "users": [
                {"id": str(u.id), "email": u.email, "name": u.name, "is_admin": u.is_admin}
                for u in rows
            ]
        }


@router.patch("/users/{user_id}")
async def patch_user(user_id: str, request: Request):
    guard = _require_admin(request)
    if guard:
        return guard
    body = await request.json()
    with session_scope() as session:
        u = session.get(User, uuid.UUID(user_id))
        if u is None:
            return JSONResponse({"error": "not found"}, status_code=404)
        if "is_admin" in body:
            u.is_admin = bool(body["is_admin"])
        return {"ok": True}
