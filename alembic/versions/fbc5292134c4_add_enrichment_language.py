"""add enrichment language

Revision ID: fbc5292134c4
Revises: 0012_book_is_favorite
Create Date: 2026-06-29 21:51:20.412542
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'fbc5292134c4'
down_revision: Union[str, None] = '0012_book_is_favorite'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns("enrichment")]
    if "language" not in cols:
        op.add_column("enrichment", sa.Column("language", sa.String(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = [c["name"] for c in insp.get_columns("enrichment")]
    if "language" in cols:
        op.drop_column("enrichment", "language")
