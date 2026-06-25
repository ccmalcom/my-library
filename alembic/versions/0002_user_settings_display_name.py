"""Add display_name to user_settings

Revision ID: 0002
Revises: 0001
Create Date: 2026-06-25
"""
from alembic import op
import sqlalchemy as sa

revision = "0002"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("user_settings", sa.Column("display_name", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("user_settings", "display_name")
