"""add reader_archetypes table

Reader archetype feature -- 4-axis personality scoring (Lens/Engine/Range/Resonance)
derived from taste traits via Claude Haiku. One row per user, upserted on re-derive.

Revision ID: 0005_reader_archetypes
Revises: 0004_add_rec_description
Create Date: 2026-06-26
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision: str = "0005_reader_archetypes"
down_revision: Union[str, None] = "0004_add_rec_description"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table: str) -> bool:
    return table in inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    # Idempotent: the 0001 baseline create_all() picks up new models, so on a fresh DB
    # this table may already exist by the time 0005 runs.
    if _has_table("reader_archetypes"):
        return
    op.create_table(
        "reader_archetypes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(),
            nullable=False,
            server_default="local",
        ),
        sa.Column("code", sa.String(), nullable=False),
        sa.Column("archetype_name", sa.String(), nullable=False),
        sa.Column("archetype_tagline", sa.Text(), nullable=False),
        sa.Column("axis_lens", sa.Float(), nullable=False),
        sa.Column("axis_engine", sa.Float(), nullable=False),
        sa.Column("axis_range", sa.Float(), nullable=False),
        sa.Column("axis_resonance", sa.Float(), nullable=False),
        sa.Column("lens_rationale", sa.Text(), nullable=True),
        sa.Column("engine_rationale", sa.Text(), nullable=True),
        sa.Column("range_rationale", sa.Text(), nullable=True),
        sa.Column("resonance_rationale", sa.Text(), nullable=True),
        sa.Column("derived_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("user_id", name="uq_reader_archetype_user"),
    )


def downgrade() -> None:
    op.drop_table("reader_archetypes")
