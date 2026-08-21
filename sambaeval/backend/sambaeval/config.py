"""Central configuration, resolved from environment variables.

One place that reads the environment so the rest of the code never touches
``os.environ`` directly. Values are read once at import into a frozen
``Settings`` singleton (``settings``). Local dev, CI, and the deployed cluster
differ only in these env vars — the code is identical (see prodplan §3.10 /
§8a).

Env vars (all optional; sensible local defaults):
  SAMBAEVAL_ENV          local | prod           (default: local)
  DATABASE_URL           postgresql+psycopg://user:pass@host:port/db
  SAMBAEVAL_STORAGE_BACKEND   db | files        (default: files)
  AUTH_BACKEND           dev | google           (default: dev)
  DEV_USER_EMAIL         fixed dev user (AUTH_BACKEND=dev)
  CREDS_KEY              base64 Fernet key for provider-key encryption
  SESSION_SECRET         signing key for the session cookie
  S3_ENDPOINT_URL        http://localhost:9000   (MinIO)
  S3_BUCKET              sambaeval
  S3_ACCESS_KEY / S3_SECRET_KEY / S3_REGION
  ALLOWED_DOMAINS        comma list (default: sambanovasystems.com,sambanova.ai)
  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / OAUTH_REDIRECT_URL
  FRONTEND_ORIGIN        http://localhost:3001
  FIXTURE_CACHE_DIR      local cache for large fixtures (default: ~/.cache/sambaeval/fixtures)
  SANDBOX_ENABLED        0 | 1                   (default: 0 — deferred for PoV)
  SANDBOX_BACKEND        podman | subprocess | k8s_job   (default: podman)
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache


def _bool(name: str, default: bool = False) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _list(name: str, default: list[str]) -> list[str]:
    v = os.environ.get(name)
    if not v:
        return default
    return [x.strip() for x in v.split(",") if x.strip()]


@dataclass(frozen=True)
class Settings:
    env: str = field(default_factory=lambda: os.environ.get("SAMBAEVAL_ENV", "local"))

    # --- storage backend selector -------------------------------------------
    # "db" routes storage.py through the Postgres/S3 repositories (the multi-user
    # web app; set explicitly by the compose/.env and Helm values). "files" keeps
    # the single-user on-disk behavior — the default so the CLI and the simple
    # local UI work with zero infra out of the box.
    storage_backend: str = field(
        default_factory=lambda: os.environ.get("SAMBAEVAL_STORAGE_BACKEND", "files")
    )

    # --- database -----------------------------------------------------------
    database_url: str = field(
        default_factory=lambda: os.environ.get(
            "DATABASE_URL",
            "postgresql+psycopg://sambaeval:sambaeval@localhost:5433/sambaeval",
        )
    )

    # --- auth ---------------------------------------------------------------
    auth_backend: str = field(
        default_factory=lambda: os.environ.get("AUTH_BACKEND", "dev")
    )
    dev_user_email: str = field(
        default_factory=lambda: os.environ.get("DEV_USER_EMAIL", "dev@sambanova.ai")
    )
    dev_user_name: str = field(
        default_factory=lambda: os.environ.get("DEV_USER_NAME", "Dev User")
    )
    allowed_domains: list[str] = field(
        default_factory=lambda: _list(
            "ALLOWED_DOMAINS", ["sambanovasystems.com", "sambanova.ai"]
        )
    )
    google_client_id: str = field(
        default_factory=lambda: os.environ.get("GOOGLE_CLIENT_ID", "")
    )
    google_client_secret: str = field(
        default_factory=lambda: os.environ.get("GOOGLE_CLIENT_SECRET", "")
    )
    oauth_redirect_url: str = field(
        default_factory=lambda: os.environ.get(
            "OAUTH_REDIRECT_URL", "http://localhost:8000/api/auth/callback"
        )
    )
    session_secret: str = field(
        default_factory=lambda: os.environ.get(
            "SESSION_SECRET", "dev-insecure-session-secret-change-me"
        )
    )
    admin_emails: list[str] = field(
        default_factory=lambda: _list("ADMIN_EMAILS", [])
    )

    # --- crypto -------------------------------------------------------------
    # A Fernet key (base64, 32 bytes). If unset locally we derive a stable dev
    # key so encryption still works without ceremony (never do this in prod —
    # the Makefile mints a real one into the K8s Secret).
    creds_key: str = field(default_factory=lambda: os.environ.get("CREDS_KEY", ""))

    # --- object storage (MinIO / S3) ----------------------------------------
    s3_endpoint_url: str = field(
        default_factory=lambda: os.environ.get("S3_ENDPOINT_URL", "http://localhost:9100")
    )
    s3_bucket: str = field(
        default_factory=lambda: os.environ.get("S3_BUCKET", "sambaeval")
    )
    s3_access_key: str = field(
        default_factory=lambda: os.environ.get("S3_ACCESS_KEY", "sambaeval")
    )
    s3_secret_key: str = field(
        default_factory=lambda: os.environ.get("S3_SECRET_KEY", "sambaeval-secret")
    )
    s3_region: str = field(
        default_factory=lambda: os.environ.get("S3_REGION", "us-east-1")
    )

    # --- web / cors ---------------------------------------------------------
    frontend_origin: str = field(
        default_factory=lambda: os.environ.get("FRONTEND_ORIGIN", "http://localhost:3001")
    )

    # --- quotas -------------------------------------------------------------
    max_concurrent_runs_per_user: int = field(
        default_factory=lambda: int(os.environ.get("MAX_CONCURRENT_RUNS_PER_USER", "4"))
    )
    max_upload_bytes: int = field(
        default_factory=lambda: int(os.environ.get("MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
    )

    # --- large fixtures (prodplan §7a) --------------------------------------
    # Where fixtures pulled from s3://<bucket>/fixtures/ are cached on local
    # disk. Generators need a real file path (SciCode bind-mounts test_data.h5
    # into each sandbox container), so the object is materialised here once per
    # worker. In the cluster this points at a mounted volume; locally it is a
    # directory under $HOME, which makes the local and prod paths identical.
    fixture_cache_dir: str = field(
        default_factory=lambda: os.environ.get("FIXTURE_CACHE_DIR")
        or os.path.expanduser("~/.cache/sambaeval/fixtures")
    )

    # --- sandbox (code execution; deferred for PoV) -------------------------
    # sandbox_enabled gates whether generators that execute model-written code
    # (generators.requires_sandbox) may be run at all; the API enforces it at
    # run-enqueue. sandbox_backend selects HOW code runs and is consumed by the
    # standalone generator scripts, which read the env var directly because they
    # never import this package (scripts/generators/scicode_generator.py); the
    # narrower SCICODE_SANDBOX overrides it there. "k8s_job" is reserved by
    # deploy/CONTRACT.md and not implemented.
    sandbox_enabled: bool = field(default_factory=lambda: _bool("SANDBOX_ENABLED", False))
    sandbox_backend: str = field(
        default_factory=lambda: os.environ.get("SANDBOX_BACKEND", "podman")
    )

    @property
    def is_local(self) -> bool:
        return self.env == "local"

    @property
    def use_db(self) -> bool:
        return self.storage_backend == "db"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


# Module-level singleton for convenient import.
settings = get_settings()
