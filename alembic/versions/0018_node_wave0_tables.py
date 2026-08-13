"""Node backend wave 0: catalog_cache, app_config, rate_limits.

These tables are used only by the Node backend (frontend/lib/server/*): a Postgres-backed
catalog response cache, a key/value app config store (first key: debug_mode), and
fixed-window rate-limit counters. Python code never touches them; the migration lives
here because Alembic is the sole schema authority until cutover.
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0018_node_wave0_tables"
down_revision = "0017_user_directive"
branch_labels = None
depends_on = None

_JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = insp.get_table_names()

    if "catalog_cache" not in tables:
        op.create_table(
            "catalog_cache",
            sa.Column("cache_key", sa.String(), primary_key=True),
            sa.Column("source", sa.String(), nullable=False),
            sa.Column("payload", _JSON, nullable=False),
            sa.Column("fetched_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)")),
        )

    if "app_config" not in tables:
        op.create_table(
            "app_config",
            sa.Column("key", sa.String(), primary_key=True),
            sa.Column("value", _JSON, nullable=False),
            sa.Column("updated_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)")),
        )

    if "rate_limits" not in tables:
        op.create_table(
            "rate_limits",
            sa.Column("bucket_key", sa.String(), primary_key=True),
            sa.Column("window_start", sa.Integer(), primary_key=True),
            sa.Column("count", sa.Integer(), nullable=False, server_default="0"),
        )


def downgrade() -> None:
    op.drop_table("rate_limits")
    op.drop_table("app_config")
    op.drop_table("catalog_cache")
