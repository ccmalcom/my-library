# Hosting & Deployment — MyLibrary

## Overview

Hosted as: **Vercel frontend → Railway web (uvicorn) → Supabase Postgres/auth**.
Invite-only / free launch. Bring-your-own Anthropic key (encrypted at rest). Bundled Google Books key.

Local SQLite single-user mode is still the default when env vars are unset.

Full plan: **`mylibrary-web-distribution-plan.md`**. Deploy runbook: **`mylibrary-phase5-deploy-runbook.md`**.

## Environment variables

`config.Settings` reads these (all optional — unset = local SQLite single-user mode):

- `DATABASE_URL` — Supabase session pooler URL. `db_url` normalizes `postgresql://` / `postgres://` to `postgresql+psycopg://` (only psycopg v3 is installed).
- `SUPABASE_URL` — activates auth; also used to build the JWKS URL.
- `SUPABASE_JWKS_URL` / `SUPABASE_JWT_SECRET` — ES256 (JWKS, preferred) or HS256 fallback.
- `ENCRYPTION_KEY` — base64 32 bytes for AES-256-GCM per-user key storage. Generate: `python -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())"`. Not needed in local mode unless a per-user key is actually stored.
- `REDIS_URL` — activates arq worker pool. Unset = BackgroundTask fallback (intended production mode at invite-only scale).
- `CORS_ORIGINS` — comma-separated frontend origins, trailing slashes stripped. Unset = `localhost:3000`.
- `MYLIBRARY_DATA_DIR` — base dir for catalog cache + DB (set to `/data` on Railway volume).
- `ANTHROPIC_API_KEY` — fallback when no per-user key is stored.
- `GOOGLE_BOOKS_API_KEY` — optional.

## Auth (`auth.py`)

Verifies Supabase access tokens and returns `sub` as `user_id`. Supabase signs with **ES256** (asymmetric); backend verifies against the project's public key fetched from JWKS (`<SUPABASE_URL>/auth/v1/.well-known/jwks.json`, cached via `PyJWKClient`). Legacy **HS256** path (`SUPABASE_JWT_SECRET`) is the fallback. Returns `LOCAL_USER_ID` ("local") when no Supabase auth is configured.

## Multi-tenancy (Phase 2)

- Every user-owned table (`books`, `taste_traits`, `recommendations`, `profile_meta`, `user_settings`, `enrich_jobs`, `reader_archetypes`, `taste_signal`) has a `user_id` column (default `LOCAL_USER_ID`, canonical constant in `config.py`). `Enrichment` is the exception — scoped via its `book_id` FK to `Book`.
- `ProfileMeta` is no longer a singleton — one row per user, looked up by `user_id`.
- `books` uniqueness on `goodreads_book_id` is now **per-user** (`uq_book_user_goodreads`). `Enrichment` has no `user_id` (scoped via its `book_id` FK to `Book`).
- Every core function takes a trailing `user_id: str = LOCAL_USER_ID`. The default keeps the CLI, tests, and unconfigured API working unchanged in local mode.
- `api.py` has a `current_user` FastAPI dependency (`UserId` alias) on every data route. Returns `LOCAL_USER_ID` until `SUPABASE_URL` is set. `session.get()` reads are guarded with a `user_id` ownership check (cross-tenant id access → 404).
- **Supabase RLS:** enabled + no policies — the backend's `postgres` role bypasses RLS; the public anon/publishable key can't reach the data API (PostgREST).
- **No data migration by design:** the old `local`-tenant library is left behind; each Supabase user builds a fresh library on the web.

## Per-user Anthropic key (Phase 3)

- `UserSettings` table (`user_settings`): one row per user, `anthropic_api_key_encrypted` (AES-256-GCM via `crypto.py`), timestamps.
- `user_settings.py`: `set_anthropic_key` (encrypt+upsert), `clear_anthropic_key`, `anthropic_key_status`, and **`resolve_anthropic_key(user_id)`** — the single place profile/recommend ask "which key for this user?". Returns the user's decrypted stored key, else falls back to `ANTHROPIC_API_KEY` env var.
- Endpoints: `PUT /settings/api-key`, `GET /settings/api-key/status` (`{configured}`, never the key), `DELETE /settings/api-key`.
- Frontend: `/settings` page (`app/(main)/settings`) + NavBar link. Settings page also hosts the **Danger Zone** (`DangerAction` two-step confirm): reset profile / clear library / delete account → routes back to `/` so `LibraryGate` shows first-setup.

## Background jobs + rate limiting (Phase 4)

- `EnrichJob` table (`enrich_jobs`): tracks `(job_id, user_id, status, progress, total, started_at, finished_at, error)`. Status: `pending → running → done | error`. Updated every 5 books.
- `worker.py` — `enrich_books` (arq async task), `run_enrich_job` (blocking core, shared by arq and BackgroundTask fallback), `WorkerSettings`.
- `POST /enrich/start` — creates `EnrichJob`, enqueues via arq when `REDIS_URL` is set, falls back to FastAPI `BackgroundTasks` otherwise. Rate-limited 5/min per user (SlowAPI). Returns `{job_id, status, ...}` immediately.
- **BackgroundTasks is the intended production mode** at invite-only scale. arq stays dormant for future horizontal scale. `worker.recover_orphaned_jobs()` at startup recovers mid-job web restarts (gated on REDIS_URL unset); `worker.fail_if_stale` errors jobs stuck 'running' past 30 min.
- `GET /enrich/status/{job_id}` — returns live `EnrichJobOut`. Frontend polls at 2s intervals.
- `POST /enrich` kept for CLI / local tooling (synchronous, no rate limit).
- **SlowAPI** rate limiting keyed on `user_id`: `/enrich/start` → 5/min; `/catalog/search` → 30/min. `REDIS_URL` not needed for SlowAPI.

## Deploy artifacts (Phase 5)

- `Dockerfile` — single image for both Railway services. Python pinned to **3.12-slim** (not 3.14 used locally) so psycopg/pandas/numpy install from prebuilt wheels. Default `CMD` is `start.sh`.
- `start.sh` — web entrypoint: `alembic upgrade head` then `uvicorn mylibrary.api:app --host 0.0.0.0 --port $PORT`. Only the web service runs this — worker overrides start command to `python -m arq mylibrary.worker.WorkerSettings` so migrations never race.
- `railway.json` — pins Dockerfile builder + ON_FAILURE restart policy.
- `GET /healthz` — unauthenticated liveness probe, no DB hit. Use for Railway healthcheck (not `GET /health`, which requires a token).
- **Catalog cache** lives on a Railway volume at `/data` (`MYLIBRARY_DATA_DIR=/data`), shared between enrich + recommend in the single process; survives redeploys.

**Deploy gotchas:**
- Railway injects `PORT=8080` (overrides Dockerfile `ENV PORT=8000`) — domain target must match the injected port.
- `NEXT_PUBLIC_API_URL` must include `https://` and is inlined at build time (rebuild after changing).
- `CORS_ORIGINS` must be the exact Vercel origin, no trailing slash.

## Alembic migrations

`alembic.ini` + `alembic/env.py` (pulls `settings.db_url`). Run `alembic upgrade head` on deploy. `init_db()` returns early in multi-tenant mode (Alembic is the source of truth); locally it still self-migrates SQLite and backfills `user_id`.

**Baseline gotcha (fixed):** `0001_initial` builds the schema via `Base.metadata.create_all()` from the _live_ models — so as models gained new columns, the baseline started creating them too. On a fresh DB, later migrations tried to add already-existing columns → `duplicate column name`. Fix: **migrations 0002+ are idempotent** — they inspect the bind and skip if the column/table already exists. Any future migration that adds something already in the models' `create_all` baseline must guard the same way.

Migration chain: `0001_initial_multitenant_schema` → `0002_display_name` → `0003_enrich_jobs` → `0004_...` → `0005_reader_archetypes` → `0006_add_exclude_from_profile`.
