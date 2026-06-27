"""add exclude_from_profile to books

Allows users to track a book without including it in taste profiling
or archetype derivation. Defaults to False (existing books are included).

Revision ID: 0006_add_exclude_from_profile
Revises: 0005_reader_archetypes
Create Date: 2026-06-27
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect as sa_inspect


revision = "0006_add_exclude_from_profile"
down_revision = "0005_reader_archetypes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    cols = {c["name"] for c in sa_inspect(bind).get_columns("books")}
    if "exclude_from_profile" not in cols:
        op.add_column(
            "books",
            sa.Column(
                "exclude_from_profile",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )


def downgrade() -> None:
    op.drop_column("books", "exclude_from_profile")
