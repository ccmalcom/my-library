"""Add is_favorite to books

Revision ID: 0012_book_is_favorite
Revises: 0011_profile_meta_rec_feedback
Create Date: 2026-06-29
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision: str = "0012_book_is_favorite"
down_revision: str = "0011_profile_meta_rec_feedback"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)
    cols = {c["name"] for c in insp.get_columns("books")}
    with op.batch_alter_table("books") as batch_op:
        if "is_favorite" not in cols:
            batch_op.add_column(
                sa.Column("is_favorite", sa.Boolean(), nullable=False, server_default="0")
            )


def downgrade() -> None:
    with op.batch_alter_table("books") as batch_op:
        batch_op.drop_column("is_favorite")
