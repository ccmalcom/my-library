"""add feedback and feedback_prompt_state tables

Beta-feedback feature (Task 1). Stores user-submitted feedback (bugs, ideas,
praise, confusing UX) and per-user prompt state so targeted prompts can be
snoozed, suppressed, or marked submitted.

Revision ID: 0007_add_feedback
Revises: 0006_add_exclude_from_profile
Create Date: 2026-06-27
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect

revision: str = "0007_add_feedback"
down_revision: Union[str, None] = "0006_add_exclude_from_profile"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_table(table: str) -> bool:
    return table in inspect(op.get_bind()).get_table_names()


def upgrade() -> None:
    # Idempotent: if the 0001 baseline create_all() already built these tables
    # (because the models existed at baseline time), skip creation to avoid errors.

    if not _has_table("feedback"):
        op.create_table(
            "feedback",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "user_id",
                sa.String(),
                index=True,
                nullable=False,
                server_default="local",
            ),
            sa.Column("category", sa.String(), nullable=False),
            sa.Column("body", sa.Text(), nullable=False),
            sa.Column("trigger", sa.String(), nullable=True),
            sa.Column("run_id", sa.String(), nullable=True),
            sa.Column("page", sa.String(), nullable=True),
            sa.Column("app_version", sa.String(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
            ),
        )

    if not _has_table("feedback_prompt_state"):
        op.create_table(
            "feedback_prompt_state",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "user_id",
                sa.String(),
                nullable=False,
                server_default="local",
            ),
            sa.Column("trigger", sa.String(), nullable=False),
            # NOT NULL with default '' — NULLs are treated as distinct in unique
            # indexes by both Postgres and SQLite, which would let duplicate
            # (user, trigger) rows bypass the constraint. '' is the sentinel.
            sa.Column("run_id", sa.String(), nullable=False, server_default=""),
            sa.Column("status", sa.String(), nullable=False),
            sa.Column("snooze_until", sa.DateTime(), nullable=True),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.UniqueConstraint(
                "user_id", "trigger", "run_id",
                name="uq_feedback_prompt_state",
            ),
        )


def downgrade() -> None:
    if _has_table("feedback_prompt_state"):
        op.drop_table("feedback_prompt_state")
    if _has_table("feedback"):
        op.drop_table("feedback")
