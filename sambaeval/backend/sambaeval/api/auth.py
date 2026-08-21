"""Authentication routes + session cookie + request user resolution.

Two backends (``AUTH_BACKEND``):
  * ``dev``    — every request is the fixed dev user (gated to SAMBAEVAL_ENV=local).
  * ``google`` — Google OAuth: /login redirects to Google, /callback verifies the
                 code, enforces the Workspace-domain allowlist, and sets a signed
                 session cookie.

The session cookie is a signed, HTTP-only token carrying the user id (prodplan
§3.2). Authz stays in FastAPI — no external identity dependency at runtime.
"""

from __future__ import annotations

import uuid
from typing import Optional

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse
from itsdangerous import BadSignature, URLSafeTimedSerializer

from .. import authz, context
from ..config import settings
from ..db import session_scope
from ..models_db import User

COOKIE_NAME = "sambaeval_session"
SESSION_MAX_AGE = 60 * 60 * 24 * 7  # 7 days

router = APIRouter(prefix="/api/auth")

# Paths that do not require an authenticated user.
PUBLIC_PATHS = {
    "/api/auth/me",
    "/api/auth/dev-login",
    "/api/auth/logout",
    "/api/auth/google/login",
    "/api/auth/callback",
    "/api/app-version",
    "/api/health",
}


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(settings.session_secret, salt="sambaeval-session")


def _issue_cookie(resp, user_id: uuid.UUID) -> None:
    token = _serializer().dumps({"uid": str(user_id)})
    resp.set_cookie(
        COOKIE_NAME,
        token,
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=not settings.is_local,
        path="/",
    )


def _user_from_cookie(request: Request) -> Optional[authz.CurrentUser]:
    raw = request.cookies.get(COOKIE_NAME)
    if not raw:
        return None
    try:
        data = _serializer().loads(raw, max_age=SESSION_MAX_AGE)
    except BadSignature:
        return None
    uid = data.get("uid")
    if not uid:
        return None
    with session_scope() as session:
        u = session.get(User, uuid.UUID(uid))
        if u is None:
            return None
        return authz.CurrentUser(
            id=u.id, email=u.email, name=u.name or u.email, is_admin=u.is_admin, domain=u.domain
        )


def resolve_user(request: Request) -> Optional[authz.CurrentUser]:
    """The current user for a request, or None. Used by the middleware."""
    if settings.auth_backend == "dev" and settings.is_local:
        with session_scope() as session:
            return authz.dev_user(session)
    return _user_from_cookie(request)


def _user_json(u: authz.CurrentUser) -> dict:
    return {
        "id": str(u.id),
        "email": u.email,
        "name": u.name,
        "is_admin": u.is_admin,
        "domain": u.domain,
    }


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@router.get("/me")
def me(request: Request):
    user = getattr(request.state, "user", None) or resolve_user(request)
    if user is None:
        return JSONResponse({"error": "unauthenticated"}, status_code=401)
    return {"user": _user_json(user), "auth_backend": settings.auth_backend}


@router.post("/dev-login")
def dev_login(request: Request):
    """Local convenience: establish a session for the fixed dev user."""
    if not (settings.auth_backend == "dev" and settings.is_local):
        return JSONResponse({"error": "dev login disabled"}, status_code=403)
    with session_scope() as session:
        user = authz.dev_user(session)
    resp = JSONResponse({"user": _user_json(user)})
    _issue_cookie(resp, user.id)
    return resp


@router.post("/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


@router.get("/google/login")
def google_login(request: Request):
    if not settings.google_client_id:
        return JSONResponse({"error": "google oauth not configured"}, status_code=503)
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": settings.oauth_redirect_url,
        "response_type": "code",
        "scope": "openid email profile",
        "access_type": "online",
        "prompt": "select_account",
    }
    # hd hints Google to prefer the org domain; we still verify server-side.
    if len(settings.allowed_domains) == 1:
        params["hd"] = settings.allowed_domains[0]
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + httpx.QueryParams(params).__str__()
    return RedirectResponse(url)


@router.get("/callback")
def google_callback(request: Request):
    code = request.query_params.get("code")
    if not code:
        return JSONResponse({"error": "missing code"}, status_code=400)
    if not settings.google_client_id or not settings.google_client_secret:
        return JSONResponse({"error": "google oauth not configured"}, status_code=503)
    token_res = httpx.post(
        "https://oauth2.googleapis.com/token",
        data={
            "code": code,
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret,
            "redirect_uri": settings.oauth_redirect_url,
            "grant_type": "authorization_code",
        },
        timeout=30.0,
    )
    if token_res.status_code >= 400:
        return JSONResponse({"error": "token exchange failed"}, status_code=502)
    access_token = token_res.json().get("access_token")
    info = httpx.get(
        "https://openidconnect.googleapis.com/v1/userinfo",
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30.0,
    ).json()
    email = (info.get("email") or "").lower()
    if not info.get("email_verified") or not authz.domain_allowed(email):
        return JSONResponse(
            {"error": f"Login restricted to {', '.join(settings.allowed_domains)}"},
            status_code=403,
        )
    with session_scope() as session:
        u = authz.get_or_create_user(
            session,
            email=email,
            name=info.get("name"),
            google_sub=info.get("sub"),
            domain=email.split("@", 1)[1],
            picture=info.get("picture"),
        )
        uid = u.id
    resp = RedirectResponse(settings.frontend_origin)
    _issue_cookie(resp, uid)
    return resp
