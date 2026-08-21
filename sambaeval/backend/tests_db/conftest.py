"""Fixtures for the DB-backend integration tests.

These exercise the Postgres/MinIO storage layer, so they require the local infra
to be up (``docker compose -f deploy/local/docker-compose.infra.yml up -d``).
The whole module is skipped when the DB is unreachable, so a plain
``pytest tests_db`` is a no-op without infra rather than a failure.

Run:  cd backend && python -m pytest tests_db -q
      (with DATABASE_URL / S3_ENDPOINT_URL pointing at the local infra)
"""

from __future__ import annotations

import os

# Force the DB backend BEFORE importing sambaeval (settings are cached at import).
os.environ["SAMBAEVAL_STORAGE_BACKEND"] = "db"
os.environ.setdefault("SAMBAEVAL_ENV", "local")
os.environ.setdefault("AUTH_BACKEND", "dev")
os.environ.setdefault(
    "DATABASE_URL", "postgresql+psycopg://sambaeval:sambaeval@localhost:5433/sambaeval"
)
os.environ.setdefault("S3_ENDPOINT_URL", "http://localhost:9100")

import uuid

import pytest

try:
    from sqlalchemy import text

    from sambaeval import bootstrap
    from sambaeval.db import get_engine

    with get_engine().connect() as conn:
        conn.execute(text("SELECT 1"))
    bootstrap.bootstrap()
    _INFRA_OK = True
except Exception as err:  # noqa: BLE001
    _INFRA_OK = False
    _INFRA_ERR = str(err)


def pytest_collection_modifyitems(config, items):
    if not _INFRA_OK:
        skip = pytest.mark.skip(reason=f"local DB/MinIO infra not reachable: {_INFRA_ERR}")
        for item in items:
            item.add_marker(skip)


@pytest.fixture
def owner_ctx():
    """Run a test as a throwaway user so rows don't collide across tests."""
    from sambaeval import context
    from sambaeval.authz import get_or_create_user
    from sambaeval.db import session_scope

    email = f"test-{uuid.uuid4().hex[:8]}@sambanova.ai"
    with session_scope() as session:
        u = get_or_create_user(session, email=email, name="Test")
        uid = u.id
    with context.owner(uid):
        yield uid
