"""initial multi-tenant schema

Baseline migration for the hosted Postgres deployment. Creates the full schema as defined
by the SQLAlchemy models — every table already carries `user_id` (multi-tenant from the
start of the hosted DB; there is no pre-user_id prod data to migrate).

This baseline intentionally builds from `Base.metadata` so the migrated schema is, by
construction, identical to the models. Subsequent migrations should be explicit
`op.*` operations (use `alembic revision --autogenerate`), keeping `books` additive-only.

Revision ID: 0001_initial
Revises:
Create Date: 2026-06-24
"""
from __future__ import annotations

from typing import Sequence, Union

from mylibrary.db import Base

revision: str = "0001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    from alembic import op

    Base.metadata.create_all(bind=op.get_bind())


def downgrade() -> None:
    from alembic import op

    Base.metadata.drop_all(bind=op.get_bind())
