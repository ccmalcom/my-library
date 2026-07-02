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
- `ADMIN_EMAILS` — comma-separated allowlist of admin email addresses (lowercased). Unset = no admins. Only checked in hosted multi-tenant mode; local dev always treats the unauthenticated user as admin.
- `SUPABASE_SERVICE_ROLE_KEY` — GoTrue admin API key for programmatic user invites + deletes (server-only, never sent to frontend). Required to use `/admin/invite` and `/admin/revoke`.
- `MYLIBRARY_MONTHLY_SOFT_CAP_USD` — per-user month-to-date soft spend cap in USD. Default `5.0`. Warn-only; never blocks a call.
- `MYLIBRARY_USAGE_WARN_THRESHOLD` — fraction of the cap (0..1) at which the soft-warn flag turns on. Default `0.8`.

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

Migration chain: `0001_initial_multitenant_schema` → `0002_display_name` → `0003_enrich_jobs` → `0004_...` → `0005_reader_archetypes` → `0006_add_exclude_from_profile` → ... → `0013_invites`.

## Spend tracking (soft-warn)

- **`usage_events` table** (`UsageEvent` model, `mylibrary/db.py`): one append-only row per Claude call — `user_id`, `model`, `operation`, token counts (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`), computed `cost_usd`, `created_at`. Migration `0014_usage_events` (idempotent, chains after `0013_invites`).
- **`usage.tracked_create(client, *, user_id, operation, **create_kwargs)`** wraps `client.messages.create(...)` and records usage after the call. All 5 Claude call sites route through it: `profile.extract_taste_profile` (`profile_full`), `profile.update_taste_profile` (`profile_update`), `recommend._claude_seed_queries` (`recommend_seed`), `recommend._claude_rerank` (`recommend_rerank`), `archetype.derive_archetype` (`archetype`).
- **`cost_usd(model, usage)`** prices a call from `MODEL_PRICING` (USD per 1M tokens: input/output/cache-write/cache-read), keyed by model name. `claude-sonnet-5` is priced separately via `_sonnet_5_pricing()` (time-boxed promo rate through 2026-08-31, reverting to the Sonnet 4.6 list rate after). Any unlisted model falls back to `DEFAULT_PRICING` (the most expensive tier, so cost is never under-reported). **These are list prices — re-verify against Anthropic's pricing page whenever the model lineup or rates change.**
- **Recording is best-effort**: `record_usage` swallows any DB failure and logs a warning — a usage-tracking bug can never break a profile/recommend/archetype call.
- **`cap_status(user_id)`** sums `cost_usd` for the current UTC calendar month (+ a per-operation breakdown) and compares against `monthly_soft_cap_usd`, returning `{spent_usd, cap_usd, pct, warn, by_operation}`. `warn` flips true at `usage_warn_threshold` fraction of the cap.
- **`GET /settings/usage`** (`UsageOut` schema) exposes `cap_status` to the frontend — powers the `/settings` usage panel and the `UsageWarningBanner`.
- **Soft-warn only — never blocks.** Nothing in `usage.py` or the cap-status flow prevents a profile/recommend/archetype call from running; it is spend visibility, not spend enforcement.

## Admin console (Phase 6)

- **Admin gating:** Allowlist of admin email addresses via `ADMIN_EMAILS` env var (case-insensitive, comma-separated). Verified against the JWT `email` claim in hosted mode. In local single-user mode (no Supabase auth configured), the unauthenticated local user is treated as admin.
- **Supabase user management:** `supabase_admin.py` wraps Supabase GoTrue invite/delete APIs using the `SUPABASE_SERVICE_ROLE_KEY` (server-only, never exposed to frontend). Only admin routes call this module.
- **Invites table:** `invites` table lifecycle: invites are created directly in `active` status when an admin sends an invite. The schema also supports a `pending` status value for potential future use (e.g., before signup completion) but no code path currently sets it. An invite transitions to `revoked` when an admin revokes it. Schema in migration `0013_invites`. Columns: `id`, `email`, `status`, `supabase_user_id` (populated on successful Supabase invite), `invited_by` (admin email), `created_at`, `revoked_at` (NULL until revoked).
- **Revoke lifecycle:** When revoking, the sequence is: (1) call `delete_user` to remove the Supabase account, (2) mark the `invites` row as `revoked` + set `revoked_at`, (3) call `purge.delete_account` to drop the user's books + profile + encrypted API key. The row is marked revoked before local data cleanup to ensure retries never re-call Supabase delete if a retry is needed.
- **Routes:** `/admin/me` (get current admin + permissions), `/admin/invite` (create invite), `/admin/users` (list all invites + book count), `/admin/revoke` (delete user + purge).
