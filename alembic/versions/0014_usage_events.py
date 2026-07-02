"""Add usage_events table."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0014_usage_events"
down_revision = "0013_invites"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "usage_events" not in insp.get_table_names():
        op.create_table(
            "usage_events",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("user_id", sa.String(), nullable=False, server_default="local"),
            sa.Column("model", sa.String(), nullable=False),
            sa.Column("operation", sa.String(), nullable=False),
            sa.Column("input_tokens", sa.Integer(), server_default="0"),
            sa.Column("output_tokens", sa.Integer(), server_default="0"),
            sa.Column("cache_creation_input_tokens", sa.Integer(), server_default="0"),
            sa.Column("cache_read_input_tokens", sa.Integer(), server_default="0"),
            sa.Column("cost_usd", sa.Float(), server_default="0"),
            sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)")),
        )
        op.create_index("ix_usage_events_user_id", "usage_events", ["user_id"])
        op.create_index("ix_usage_events_created_at", "usage_events", ["created_at"])


def downgrade() -> None:
    op.drop_index("ix_usage_events_created_at", table_name="usage_events")
    op.drop_index("ix_usage_events_user_id", table_name="usage_events")
    op.drop_table("usage_events")
