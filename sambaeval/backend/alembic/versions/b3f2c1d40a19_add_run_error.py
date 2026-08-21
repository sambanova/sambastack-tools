"""add runs.error (run-level failure reason)

A run can fail before any task dispatches (e.g. the code-execution sandbox
can't be prepared). Those aborts used to be printed to the worker's stdout and
dropped, leaving the UI with a bare "aborted". ``run_errors`` is per-task
(example_id + provider_model are NOT NULL), so the run-level reason lives here.

Revision ID: b3f2c1d40a19
Revises: a727494d8211
Create Date: 2026-08-20 10:45:00.000000
"""
from alembic import op
import sqlalchemy as sa

revision = 'b3f2c1d40a19'
down_revision = 'a727494d8211'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('runs', sa.Column('error', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('runs', 'error')
