"""Add reveal_line to taste_traits

Revision ID: 0016_trait_reveal_line
Revises: 0015_enrichment_corrected_at
Create Date: 2026-07-03
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision: str = "0016_trait_reveal_line"
down_revision: str = "0015_enrichment_corrected_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)
    cols = {c["name"] for c in insp.get_columns("taste_traits")}
    if "reveal_line" not in cols:
        with op.batch_alter_table("taste_traits") as batch_op:
            batch_op.add_column(sa.Column("reveal_line", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("taste_traits") as batch_op:
        batch_op.drop_column("reveal_line")
