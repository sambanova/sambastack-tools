"""Idempotent bootstrap — seed the system user + generator catalog.

Run on API/worker startup and by the backfill script. Safe to call repeatedly.
The generator catalog mirrors the scripts baked into the image (prodplan §3.8);
the executor still resolves generators by path from the experiment config, so
this table is the admin/UI catalog, not the execution source of truth.
"""

from __future__ import annotations

from sqlalchemy import select

from .db import session_scope
from .models_db import SYSTEM_USER_EMAIL, SYSTEM_USER_ID, Generator, User
from .storage_s3 import ensure_bucket

# key -> (display_name, script_path relative to product root, requires_sandbox)
DEFAULT_GENERATORS = {
    "default": ("Default (chat completion)", "scripts/generators/default_generator.py", False),
    "codegen": ("Code generation", "scripts/generators/default_generator.py", False),
    "scicode": ("SciCode (code execution)", "scripts/generators/scicode_generator.py", True),
    "spider": ("Spider (text-to-SQL)", "scripts/generators/spider_generator.py", False),
    "langchain_agent": (
        "LangChain agent",
        "scripts/generators/langchain_agent_generator.py",
        False,
    ),
}


def seed_system_user(session) -> User:
    u = session.get(User, SYSTEM_USER_ID)
    if u is None:
        u = User(
            id=SYSTEM_USER_ID,
            email=SYSTEM_USER_EMAIL,
            name="System",
            is_admin=True,
        )
        session.add(u)
        session.flush()
    return u


def seed_generators(session) -> None:
    existing = {
        g.key for g in session.execute(select(Generator)).scalars().all()
    }
    for key, (display, path, needs_sandbox) in DEFAULT_GENERATORS.items():
        if key in existing:
            continue
        session.add(
            Generator(
                key=key,
                display_name=display,
                script_path=path,
                requires_sandbox=needs_sandbox,
                enabled=True,
            )
        )


def bootstrap(create_bucket: bool = True) -> None:
    with session_scope() as session:
        seed_system_user(session)
        seed_generators(session)
    if create_bucket:
        try:
            ensure_bucket()
        except Exception:
            # Non-fatal at import/startup; the compose init job also creates it.
            pass
