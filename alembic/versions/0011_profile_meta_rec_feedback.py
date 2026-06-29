"""Add rec_feedback_updated_at to profile_meta

Revision ID: 0011_profile_meta_rec_feedback
Revises: 0010_taste_signal
Create Date: 2026-06-29
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision: str = "0011_profile_meta_rec_feedback"
down_revision: str = "0010_taste_signal"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)
    cols = {c["name"] for c in insp.get_columns("profile_meta")}
    with op.batch_alter_table("profile_meta") as batch_op:
        if "rec_feedback_updated_at" not in cols:
            batch_op.add_column(
                sa.Column("rec_feedback_updated_at", sa.DateTime(), nullable=True)
            )


def downgrade() -> None:
    with op.batch_alter_table("profile_meta") as batch_op:
        batch_op.drop_column("rec_feedback_updated_at")
