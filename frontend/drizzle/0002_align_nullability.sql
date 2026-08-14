-- Align production's column nullability with schema.ts.
--
-- WHY THIS IS HAND-WRITTEN: `drizzle-kit generate` cannot produce this migration.
-- It diffs schema.ts against 0001_snapshot.json, and those two already agree --
-- every column below is declared `.notNull()` in schema.ts and recorded NOT NULL
-- in the snapshot. The divergence is against the PRODUCTION DATABASE, which
-- `generate` never reads. So generate emits nothing and the drift stays invisible.
--
-- WHERE THE DRIFT CAME FROM: production was built by Alembic, and the revisions
-- that added these columns omitted NOT NULL -- the SQLAlchemy models declared
-- `nullable=False` / `default=0`, which SQLAlchemy enforces at the ORM layer and
-- which emits no DDL. A database created fresh from 0000_baseline already has
-- these columns NOT NULL, so this migration is a no-op there and a repair on any
-- Alembic-lineage database. `SET NOT NULL` on an already-NOT NULL column is a
-- no-op in Postgres, so applying this twice is safe.
--
-- SAFETY: verified 2026-08-13 against production before writing -- zero NULL rows
-- in every column below (usage_events 51 rows, invites 10, taste_signal 0,
-- user_directive 0). Columns carrying a server DEFAULT would backfill regardless.
--
-- NOT CHANGED HERE, deliberately: production also carries server defaults that
-- schema.ts does not declare (`enrich_jobs.status` and `invites.status` DEFAULT
-- 'pending'; the five usage_events numerics DEFAULT 0). Declaring those in
-- schema.ts would make them OPTIONAL in drizzle's `$inferInsert` and dissolve the
-- tsc guard that forces call sites to pass values explicitly -- the same guard
-- that had to be hand-rebuilt as `NewJobValues` after the POST /enrich/start bug.
-- The divergence is inert (the app always supplies these values) and is recorded
-- in schema.ts rather than resolved.

ALTER TABLE "invites" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "taste_signal" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user_directive" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "input_tokens" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "output_tokens" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "cache_creation_input_tokens" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "cache_read_input_tokens" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_events" ALTER COLUMN "cost_usd" SET NOT NULL;
