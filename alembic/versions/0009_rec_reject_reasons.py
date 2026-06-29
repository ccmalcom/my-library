"""Add reject_reasons to recommendations."""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0009_rec_reject_reasons"
down_revision = "0008_trait_user_weight"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("recommendations")}
    if "reject_reasons" not in cols:
        with op.batch_alter_table("recommendations") as batch_op:
            batch_op.add_column(sa.Column("reject_reasons", sa.JSON(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("recommendations") as batch_op:
        batch_op.drop_column("reject_reasons")
