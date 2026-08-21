"""SQLAlchemy ORM schema — the database system-of-record (prodplan §2).

Design choices that keep the existing engine untouched:
  * ``experiments.id`` keeps the current string id (slug) as PK — the executor,
    API routes, and frontend URLs keep working unchanged. Multi-tenant columns
    (owner_id, visibility, share_token) are added with sensible defaults.
  * A ``runs`` row has a surrogate UUID PK plus ``run_label`` — the timestamp
    string ``YYYY-MM-DDTHH-MM-SS-mmmZ`` that the executor/API use as the
    "run_id". ``unique(experiment_id, run_label)`` preserves today's identity.
  * An experiment's full pydantic config is stored verbatim in ``config`` (JSONB)
    so ``Experiment.model_validate(row.config)`` reconstructs it exactly; the
    relational columns exist only for scoping/querying.
  * ``results`` columns are exactly ``RESULT_HEADERS`` so CSV export is a
    straight projection.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

# Well-known system user that owns all seeded (public) data/ content.
SYSTEM_USER_ID = uuid.UUID("00000000-0000-0000-0000-000000000001")
SYSTEM_USER_EMAIL = "system@sambaeval.local"


class Base(DeclarativeBase):
    pass


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


def _now() -> datetime:
    return datetime.now(timezone.utc)


TS = DateTime(timezone=True)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    google_sub: Mapped[str | None] = mapped_column(Text, unique=True, nullable=True)
    domain: Mapped[str | None] = mapped_column(Text, nullable=True)
    name: Mapped[str | None] = mapped_column(Text, nullable=True)
    picture: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, default=_now)
    last_login_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)


class Provider(Base):
    __tablename__ = "providers"
    __table_args__ = (UniqueConstraint("owner_id", "name", name="uq_providers_owner_name"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    api_url: Mapped[str] = mapped_column(Text, nullable=False)
    # Symmetric-encrypted with the app CREDS_KEY (never returned in cleartext).
    api_key_ciphertext: Mapped[bytes] = mapped_column(nullable=False)
    api_key_last4: Mapped[str | None] = mapped_column(String(8), nullable=True)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, default=_now, onupdate=_now)


class Generator(Base):
    __tablename__ = "generators"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    display_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    script_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    requires_sandbox: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class Dataset(Base):
    __tablename__ = "datasets"
    __table_args__ = (UniqueConstraint("owner_id", "name", name="uq_datasets_owner_name"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    format: Mapped[str | None] = mapped_column(String(16), nullable=True)  # jsonl | csv
    object_key: Mapped[str] = mapped_column(Text, nullable=False)  # blob in MinIO/S3
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    row_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    visibility: Mapped[str] = mapped_column(String(16), nullable=False, default="private")
    uploaded_by_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    share_token: Mapped[str | None] = mapped_column(Text, unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, default=_now)


class Scorer(Base):
    __tablename__ = "scorers"
    __table_args__ = (UniqueConstraint("owner_id", "name", name="uq_scorers_owner_name"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    provider_name: Mapped[str | None] = mapped_column(Text, nullable=True)
    model: Mapped[str | None] = mapped_column(Text, nullable=True)
    judge_prompt: Mapped[str | None] = mapped_column(Text, nullable=True)
    max_score: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    additional_kwargs: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    visibility: Mapped[str] = mapped_column(String(16), nullable=False, default="public")
    share_token: Mapped[str | None] = mapped_column(Text, unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, default=_now)


class Experiment(Base):
    __tablename__ = "experiments"

    # Keep the existing string slug id as PK (URLs / executor identity).
    id: Mapped[str] = mapped_column(Text, primary_key=True)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Full Experiment pydantic dump — reconstructs the domain model verbatim.
    config: Mapped[dict] = mapped_column(JSONB, nullable=False)
    visibility: Mapped[str] = mapped_column(String(16), nullable=False, default="private")
    share_token: Mapped[str | None] = mapped_column(Text, unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, default=_now)
    updated_at: Mapped[datetime] = mapped_column(TS, nullable=False, default=_now, onupdate=_now)

    runs: Mapped[list["Run"]] = relationship(
        back_populates="experiment", cascade="all, delete-orphan"
    )


class Run(Base):
    __tablename__ = "runs"
    __table_args__ = (
        UniqueConstraint("experiment_id", "run_label", name="uq_runs_experiment_label"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    experiment_id: Mapped[str] = mapped_column(
        Text, ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # The timestamp string the executor/API treat as the "run_id".
    run_label: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    # DB-backed run control (replaces the in-memory run_registry): none|pause|terminate
    control: Mapped[str] = mapped_column(String(16), nullable=False, default="none")
    config_snapshot: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    mode: Mapped[str | None] = mapped_column(String(16), nullable=True)
    selected_models: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    errors: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    merged: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    partial: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    claimed_by: Mapped[str | None] = mapped_column(Text, nullable=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    visibility: Mapped[str] = mapped_column(String(16), nullable=False, default="private")
    share_token: Mapped[str | None] = mapped_column(Text, unique=True, nullable=True)
    # Params captured at enqueue so the worker can execute without the request.
    enqueue_params: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(TS, nullable=True)
    # Run-level failure reason for a run that never produced per-task rows (e.g.
    # the sandbox preflight failed). Per-task failures live in `run_errors`.
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    resumed_at: Mapped[list | None] = mapped_column(JSONB, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, default=_now)

    experiment: Mapped["Experiment"] = relationship(back_populates="runs")
    results: Mapped[list["Result"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )


class Result(Base):
    __tablename__ = "results"
    __table_args__ = (
        UniqueConstraint(
            "run_id", "provider", "model", "example_id", name="uq_results_natural_key"
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    result_id: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[str] = mapped_column(Text, nullable=False)
    example_id: Mapped[int] = mapped_column(Integer, nullable=False)
    output: Mapped[str] = mapped_column(Text, nullable=False, default="")
    score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    weight: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    score_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    ttft_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    tps: Mapped[float | None] = mapped_column(Float, nullable=True)
    num_llm_calls: Mapped[int | None] = mapped_column(Integer, nullable=True)

    run: Mapped["Run"] = relationship(back_populates="results")


class RunError(Base):
    __tablename__ = "run_errors"
    __table_args__ = (
        UniqueConstraint(
            "run_id", "example_id", "provider_model", name="uq_run_errors_natural_key"
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    example_id: Mapped[int] = mapped_column(Integer, nullable=False)
    provider_model: Mapped[str] = mapped_column(Text, nullable=False)  # "provider/model"
    phase: Mapped[str | None] = mapped_column(String(16), nullable=True)  # generation|scoring
    message: Mapped[str | None] = mapped_column(Text, nullable=True)


class AccessGrant(Base):
    __tablename__ = "access_grants"
    __table_args__ = (
        UniqueConstraint(
            "resource_type", "resource_id", "user_id", name="uq_access_grants"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    resource_type: Mapped[str] = mapped_column(String(16), nullable=False)  # experiment|dataset|scorer|run
    resource_id: Mapped[str] = mapped_column(Text, nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(TS, nullable=False, default=_now)
