"""Ambient request/run owner, so the (unchanged) executor resolves the *runner's*
providers/scorers/datasets without threading a user through every call.

The API sets this per request; the worker sets it to the run's owner before
executing. Falls back to the system user when unset (CLI / seeding).
"""

from __future__ import annotations

import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator, Optional

from .models_db import SYSTEM_USER_ID

_active_owner: ContextVar[Optional[uuid.UUID]] = ContextVar("active_owner", default=None)


def active_owner() -> uuid.UUID:
    return _active_owner.get() or SYSTEM_USER_ID


def set_active_owner(owner_id: Optional[uuid.UUID]):
    return _active_owner.set(owner_id)


@contextmanager
def owner(owner_id: Optional[uuid.UUID]) -> Iterator[None]:
    token = _active_owner.set(owner_id)
    try:
        yield
    finally:
        _active_owner.reset(token)
