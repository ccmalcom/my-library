"""add description column to recommendations

Phase 4 redesign addendum -- SwipeCard now shows the book description so users
know what a recommended book is about before swiping. The column is nullable so
existing rows and candidates without a description degrade gracefully.

Revision ID: 0004_add_rec_description
Revises: 0003_enrich_jobs
Create Date: 2026-06-26
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision: str = "0004_add_rec_description"
down_revision: Union[str, None] = "0003_enrich_jobs"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table: str, column: str) -> bool:
    cols = [c["name"] for c in inspect(op.get_bind()).get_columns(table)]
    return column in cols


def upgrade() -> None:
    if not _has_column("recommendations", "description"):
        op.add_column("recommendations", sa.Column("description", sa.Text(), nullable=True))


def downgrade() -> None:
    if _has_column("recommendations", "description"):
        op.drop_column("recommendations", "description")
