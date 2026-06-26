"""Add display_name to user_settings

Revision ID: 0002
Revises: 0001
Create Date: 2026-06-25

Idempotent: the 0001 baseline runs ``Base.metadata.create_all()`` from the *live* models,
which already include ``display_name``. So on a fresh DB the column exists by the time this
runs — adding it again raises "duplicate column". We skip when it's already present. On an
older DB stamped at 0001 *before* the model gained the column, it's missing and we add it.
Both paths converge on the same schema.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

revision = "0002"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def _has_column(table: str, column: str) -> bool:
    insp = inspect(op.get_bind())
    if table not in insp.get_table_names():
        return False
    return any(c["name"] == column for c in insp.get_columns(table))


def upgrade() -> None:
    if not _has_column("user_settings", "display_name"):
        op.add_column("user_settings", sa.Column("display_name", sa.String(), nullable=True))


def downgrade() -> None:
    if _has_column("user_settings", "display_name"):
        op.drop_column("user_settings", "display_name")
