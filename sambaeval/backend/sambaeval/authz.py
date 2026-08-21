"""Authentication context + visibility/ownership rules (prodplan §2, §3.2).

The ``current_user`` contract every request/route consumes, plus the central
access-control predicate. Two auth backends selected by ``AUTH_BACKEND``:
  * ``dev``    — a fixed local dev user (bypasses the domain allowlist). Gated to
                 SAMBAEVAL_ENV=local so it can never be enabled in a deployment.
  * ``google`` — real Google OAuth (session cookie); see api/auth.py.

The visibility rule (applied on every read):
    view(R) iff R.visibility == public
             or viewer == R.owner
             or (R.visibility == link and a valid share_token was presented)
             or viewer.is_admin
Edit/delete require ownership (or admin).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .models_db import SYSTEM_USER_EMAIL, SYSTEM_USER_ID, User


@dataclass(frozen=True)
class CurrentUser:
    id: uuid.UUID
    email: str
    name: str
    is_admin: bool
    domain: Optional[str] = None

    @property
    def is_system(self) -> bool:
        return self.id == SYSTEM_USER_ID


class AuthError(Exception):
    """Raised when a request cannot be authenticated (→ 401)."""


class ForbiddenError(Exception):
    """Raised when an authenticated user lacks access (→ 403)."""


# --------------------------------------------------------------------------- #
# User lookup / creation
# --------------------------------------------------------------------------- #
def _to_current(u: User) -> CurrentUser:
    return CurrentUser(
        id=u.id, email=u.email, name=u.name or u.email, is_admin=u.is_admin, domain=u.domain
    )


def get_or_create_user(
    session: Session,
    *,
    email: str,
    name: Optional[str] = None,
    google_sub: Optional[str] = None,
    domain: Optional[str] = None,
    picture: Optional[str] = None,
) -> User:
    email = email.strip().lower()
    u = session.execute(select(User).where(User.email == email)).scalar_one_or_none()
    if u is None:
        u = User(
            email=email,
            name=name or email.split("@")[0],
            google_sub=google_sub,
            domain=domain or (email.split("@")[1] if "@" in email else None),
            picture=picture,
            is_admin=email in {e.lower() for e in settings.admin_emails},
        )
        session.add(u)
        session.flush()
    else:
        if google_sub and not u.google_sub:
            u.google_sub = google_sub
        if name and not u.name:
            u.name = name
        u.last_login_at = datetime.now(timezone.utc)
    return u


def domain_allowed(email: str) -> bool:
    if "@" not in email:
        return False
    return email.split("@", 1)[1].lower() in {d.lower() for d in settings.allowed_domains}


# --------------------------------------------------------------------------- #
# Backend resolution — returns the CurrentUser for a request
# --------------------------------------------------------------------------- #
def dev_user(session: Session) -> CurrentUser:
    """The fixed local dev user (AUTH_BACKEND=dev)."""
    u = get_or_create_user(
        session, email=settings.dev_user_email, name=settings.dev_user_name
    )
    # Dev user is admin locally so the whole admin surface is exercisable.
    if not u.is_admin:
        u.is_admin = True
    return _to_current(u)


# --------------------------------------------------------------------------- #
# Access-control predicate
# --------------------------------------------------------------------------- #
def can_view(
    *,
    viewer: CurrentUser,
    owner_id: uuid.UUID,
    visibility: str,
    share_token_ok: bool = False,
) -> bool:
    if viewer.is_admin:
        return True
    if visibility == "public":
        return True
    if viewer.id == owner_id:
        return True
    if visibility == "link" and share_token_ok:
        return True
    return False


def can_edit(*, viewer: CurrentUser, owner_id: uuid.UUID) -> bool:
    return viewer.is_admin or viewer.id == owner_id


def require_view(**kwargs) -> None:
    if not can_view(**kwargs):
        raise ForbiddenError("You do not have access to this resource.")


def require_owner(*, viewer: CurrentUser, owner_id: uuid.UUID) -> None:
    if not can_edit(viewer=viewer, owner_id=owner_id):
        raise ForbiddenError("Only the owner (or an admin) can modify this resource.")
