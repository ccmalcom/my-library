"""Add user_directive table."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0017_user_directive"
down_revision = "0016_trait_reveal_line"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "user_directive" not in insp.get_table_names():
        op.create_table(
            "user_directive",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("user_id", sa.String(), nullable=False, server_default="local"),
            sa.Column("nl_text", sa.Text(), nullable=True),
            sa.Column("constraints", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)")),
            sa.Column("updated_at", sa.DateTime(), nullable=True),
        )
        op.create_index(
            "ix_user_directive_user_id", "user_directive", ["user_id"], unique=True
        )


def downgrade() -> None:
    op.drop_index("ix_user_directive_user_id", table_name="user_directive")
    op.drop_table("user_directive")
