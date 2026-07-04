"""Add enrichment_corrected_at to profile_meta

Revision ID: 0015_profile_meta_enrichment_corrected
Revises: 0014_usage_events
Create Date: 2026-07-03
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision: str = "0015_profile_meta_enrichment_corrected"
down_revision: str = "0014_usage_events"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)
    cols = {c["name"] for c in insp.get_columns("profile_meta")}
    with op.batch_alter_table("profile_meta") as batch_op:
        if "enrichment_corrected_at" not in cols:
            batch_op.add_column(
                sa.Column("enrichment_corrected_at", sa.DateTime(), nullable=True)
            )


def downgrade() -> None:
    with op.batch_alter_table("profile_meta") as batch_op:
        batch_op.drop_column("enrichment_corrected_at")
