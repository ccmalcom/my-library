"""Add user_weight and verdict_updated_at to taste_traits

Revision ID: 0008_trait_user_weight
Revises: 0007_add_feedback
Create Date: 2026-06-29
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision: str = "0008_trait_user_weight"
down_revision: str = "0007_add_feedback"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)
    cols = {c["name"] for c in insp.get_columns("taste_traits")}
    with op.batch_alter_table("taste_traits") as batch_op:
        if "user_weight" not in cols:
            batch_op.add_column(
                sa.Column("user_weight", sa.Float(), nullable=False, server_default="1.0")
            )
        if "verdict_updated_at" not in cols:
            batch_op.add_column(
                sa.Column("verdict_updated_at", sa.DateTime(), nullable=True)
            )


def downgrade() -> None:
    with op.batch_alter_table("taste_traits") as batch_op:
        batch_op.drop_column("verdict_updated_at")
        batch_op.drop_column("user_weight")
