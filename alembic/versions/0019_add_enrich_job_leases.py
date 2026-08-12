"""Add enrichment job leases, durable options, and active-job guard."""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0019_add_enrich_job_leases"
down_revision = "0018_node_wave0_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Idempotent: the 0001 baseline create_all() (from live models) already builds
    # these columns on a fresh DB. Only add columns and indexes that are missing.
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("enrich_jobs")}
    if "lease_expires_at" not in columns:
        op.add_column("enrich_jobs", sa.Column("lease_expires_at", sa.DateTime(), nullable=True))
    if "attempts" not in columns:
        op.add_column(
            "enrich_jobs",
            sa.Column("attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
        )
    if "force" not in columns:
        op.add_column(
            "enrich_jobs",
            sa.Column("force", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        )
    if "run_limit" not in columns:
        op.add_column("enrich_jobs", sa.Column("run_limit", sa.Integer(), nullable=True))

    indexes = {index["name"] for index in inspector.get_indexes("enrich_jobs")}
    if "uq_enrich_jobs_active_user" not in indexes:
        op.create_index(
            "uq_enrich_jobs_active_user",
            "enrich_jobs",
            ["user_id"],
            unique=True,
            postgresql_where=sa.text("status IN ('pending', 'running')"),
            sqlite_where=sa.text("status IN ('pending', 'running')"),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    indexes = {index["name"] for index in inspector.get_indexes("enrich_jobs")}
    if "uq_enrich_jobs_active_user" in indexes:
        op.drop_index("uq_enrich_jobs_active_user", table_name="enrich_jobs")

    columns = {column["name"] for column in inspector.get_columns("enrich_jobs")}
    if "run_limit" in columns:
        op.drop_column("enrich_jobs", "run_limit")
    if "force" in columns:
        op.drop_column("enrich_jobs", "force")
    if "attempts" in columns:
        op.drop_column("enrich_jobs", "attempts")
    if "lease_expires_at" in columns:
        op.drop_column("enrich_jobs", "lease_expires_at")
