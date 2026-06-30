"""Add invites table."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0013_invites"
down_revision = "fbc5292134c4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    if "invites" not in insp.get_table_names():
        op.create_table(
            "invites",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("email", sa.String(), nullable=False),
            sa.Column("invited_by", sa.String(), nullable=False),
            sa.Column("supabase_user_id", sa.String(), nullable=True),
            sa.Column("status", sa.String(), nullable=False, server_default="pending"),
            sa.Column("created_at", sa.DateTime(), server_default=sa.text("(CURRENT_TIMESTAMP)")),
            sa.Column("accepted_at", sa.DateTime(), nullable=True),
            sa.Column("revoked_at", sa.DateTime(), nullable=True),
        )
        op.create_index("ix_invites_email", "invites", ["email"])
        op.create_index("ix_invites_supabase_user_id", "invites", ["supabase_user_id"])


def downgrade() -> None:
    op.drop_index("ix_invites_supabase_user_id", table_name="invites")
    op.drop_index("ix_invites_email", table_name="invites")
    op.drop_table("invites")
