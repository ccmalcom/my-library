"""add enrich_jobs table

Phase 4 — background job queue for enrichment. The frontend polls
GET /enrich/status/{job_id} against this table instead of blocking on a
synchronous POST /enrich request that would time out on cloud HTTP.

Revision ID: 0002_enrich_jobs
Revises: 0001_initial
Create Date: 2026-06-25
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0003_enrich_jobs"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "enrich_jobs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("job_id", sa.String(), unique=True, index=True, nullable=False),
        sa.Column(
            "user_id",
            sa.String(),
            index=True,
            nullable=False,
            server_default="local",
        ),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )


def downgrade() -> None:
    op.drop_table("enrich_jobs")
