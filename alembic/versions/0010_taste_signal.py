"""Add taste_signal table."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010_taste_signal"
down_revision = "0009_rec_reject_reasons"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "taste_signal" not in insp.get_table_names():
        op.create_table(
            "taste_signal",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("user_id", sa.String(), nullable=False, server_default="local"),
            sa.Column("direction", sa.String(), nullable=False),
            sa.Column("target_kind", sa.String(), nullable=False),
            sa.Column("target_book_id", sa.Integer(), nullable=True),
            sa.Column("snapshot", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)")),
        )
        op.create_index("ix_taste_signal_user_id", "taste_signal", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_taste_signal_user_id", table_name="taste_signal")
    op.drop_table("taste_signal")
