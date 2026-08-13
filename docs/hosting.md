# Hosting & Deployment — ShelfSprite

## Overview

Hosted as: **Vercel frontend → Railway web (uvicorn) → Supabase Postgres/auth**.
Invite-only / free launch. Bring-your-own Anthropic key (encrypted at rest). Bundled Google Books key.

Local SQLite single-user mode is still the default when env vars are unset.

> **Status (wave 5b, 2026-08-12): Railway is being retired.** The Node backend now serves every
> frontend-facing route — all 54 routes in `mylibrary/api.py` are covered by `NODE_DEFAULT_ROUTES`
> in `frontend/lib/backend.ts`, leaving only `/health` and `/healthz`, which are Railway's own
> probes. Once the Node branch merges to `main`, the target architecture is
> **Vercel (Next.js route handlers) → Supabase Postgres/auth**, with no Python service. Everything
> below describing Railway is retained because it is still accurate until that merge lands, and
> because the Alembic notes remain true of any deployment that runs migrations at boot.

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
- `FRONTEND_URL` — deployed frontend origin, no trailing slash (e.g. `https://my-library.vercel.app`). Used to build `redirect_to=<FRONTEND_URL>/auth/callback` on the Supabase invite call, so invited users land somewhere that actually establishes their session — see Admin console notes below. Unset = Supabase falls back to its dashboard-configured Site URL.
- `MYLIBRARY_MONTHLY_SOFT_CAP_USD` — per-user month-to-date soft spend cap in USD. Default `5.0`. Warn-only; never blocks a call.
- `MYLIBRARY_USAGE_WARN_THRESHOLD` — fraction of the cap (0..1) at which the soft-warn flag turns on. Default `0.8`.

### Node backend environment variables

The Next.js route handlers read their own set, which **overlaps but is not identical** to
`config.Settings`. Authoritative list, derived from every environment read under `frontend/lib` and `frontend/app`:

`ADMIN_EMAILS`, `ANTHROPIC_API_KEY`, `CRON_SECRET`, `DATABASE_URL`, `ENCRYPTION_KEY`,
`FEEDBACK_PROMPTS_ENABLED`, `FEEDBACK_SNOOZE_HOURS`, `FRONTEND_URL`, `GOOGLE_BOOKS_API_KEY`,
`MYLIBRARY_MODEL`, `MYLIBRARY_MONTHLY_SOFT_CAP_USD`, `MYLIBRARY_REQ_PER_SEC`,
`MYLIBRARY_USAGE_WARN_THRESHOLD`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_JWKS_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_URL`, `TZ`.

Differences from Python that have each cost real debugging time:

- **`SUPABASE_SECRET_KEY`, not `SUPABASE_SERVICE_ROLE_KEY`.** The two backends read different names
  for the same credential. Node sends it on the `apikey` header ONLY — Supabase parses an
  `Authorization` value as a JWT, so an opaque `sb_secret_*` key there yields `Invalid JWT`.
- **`SUPABASE_URL ?? NEXT_PUBLIC_SUPABASE_URL`.** `supabaseAdmin.ts:39` and `auth.ts::jwksUrl` both
  accept either. Without the fallback, auth works while every admin write 502s.
- **`CRON_SECRET` is required, and its absence is not a soft failure** — see below.
- Node has no `REDIS_URL`, `CORS_ORIGINS`, `MYLIBRARY_DATA_DIR`, or `SUPABASE_JWT_SECRET`: there is
  no queue, same-origin routes need no CORS, the catalog cache is a Postgres table
  (`catalog_cache`), and only the JWKS/ES256 path is implemented.

#### `CRON_SECRET` — required, and it fails destructively when unset

Set it in Vercel for **Production and Preview**; generate with `openssl rand -hex 32`. The value is
arbitrary and need not match across environments — each environment both signs and validates with
its own copy. Vercel automatically sends `Authorization: Bearer $CRON_SECRET` to cron endpoints
whenever a variable of that name exists, so the janitor authenticates with no extra wiring.

`isValidCronSecret` fails closed (`enrichmentDispatch.ts:32`), which is benign. `rearmAfterResponse`
**throws** when the variable is absent (`enrichmentDispatch.ts:38`), which used to be destructive:
`deps.dispatch` was awaited with no `try`/`catch`, so any enrichment needing a second chunk 500'd
`POST /enrich/start`, 500'd `GET /enrich/status/{job_id}` through poll repair, and left the job
`running` with `leaseExpiresAt` already nulled — orphaned permanently, with
`uq_enrich_jobs_active_user` blocking that user from starting another enrichment without manual DB
intervention.

**Guarded as of 2026-08-13.** Both call sites now catch dispatch failures. `runClaimedChunk` keeps
the progress write and the null lease, returns `rearmed: false` instead of throwing, and logs.
`repairActiveJobs` catches per job so one bad row no longer aborts the janitor's whole sweep, and
counts the failure in a separate `dispatchFailed` field (`failed` still means "marked error by
`failIfStale`"). A dispatch failure is therefore recoverable rather than fatal.

**It is recoverable, not self-healing.** A null lease is what makes a job reclaimable by
`repairActiveJobs` — but if `CRON_SECRET` is itself the cause of the dispatch failure, the janitor is
401ing too, so nothing healthy is left to reclaim it. The job waits, intact, until the secret is
fixed.

It is invisible to a casual smoke test — a small library finishes in one chunk and never calls
`dispatch` at all. **Any enrichment smoke test must use a library large enough to require a second
chunk.** Measured 2026-08-13: a forced 159-book run took 221s against the 240s `CHUNK_BUDGET_MS`,
finishing in one chunk with `/api/enrich/tick` invoked **zero** times. An 18-second margin is not a
test.

#### The proxy matcher ate every internal tick (fixed 2026-08-13)

**This, not `CRON_SECRET`, is why enrichment continuation had never once run in production.**
`proxy.ts`'s matcher covered `/api/*`, and `updateSession` redirects any request without a Supabase
**session cookie** to `/login`. `rearmAfterResponse` self-fetches `/api/enrich/tick` with a
`CRON_SECRET` bearer and no cookies, so every tick was **307-redirected before the handler ran**.
Same for `/api/enrich/janitor`, which Vercel's cron also invokes cookieless — so the janitor, the
backstop the whole recovery design leans on, had never run either.

Fixed by adding `api` to the matcher's negative lookahead. API routes authenticate themselves via
`withApi` (bearer only — no route under `app/api/` reads cookies or uses `createServerClient`), and
the cron routes validate `CRON_SECRET`. The middleware gates **pages only**.

Two things made this invisible for four waves:

- **A 307 is a successful fetch.** Nothing threw, so the wave-5b dispatch guards never fired and
  nothing was logged. `rearmAfterResponse` now inspects `response.ok` and logs job id + status.
- **`rearmed: true` means "a tick was scheduled", not "a tick succeeded".** The fetch runs inside
  `after()`, post-response, so `runClaimedChunk`'s `try`/`catch` can only ever catch a synchronous
  throw from `requireCronSecret()` — never a network result. Do not "fix" this by awaiting the
  dispatch; that would block the response and defeat the design.

Diagnostic rule earned here: **tick count alone is not evidence of continuation.** A run showed 21
`/api/enrich/tick` invocations with progress frozen at 65/159 — each one a 307, and each one caused
by a status poll triggering poll repair. Require the tick count **and** progress advancing.

`failIfStale` was verified live the same day: a job started 15:29:06 and abandoned was marked
`error` with `Enrichment was interrupted, please retry.` on the first status poll after the strict
1800s threshold (at 16:00:12, 1866s), preserving `progress` at 65/159. That is the only automatic
recovery that currently exists — it fires on a user-initiated poll, not on a timer.

#### The continuation path can only be tested against the production custom domain

`rearmAfterResponse` builds the tick URL as `new URL('/api/enrich/tick', request.url)`
(`enrichmentDispatch.ts:39`) — it self-fetches whatever origin served the request, carrying only
`Authorization: Bearer $CRON_SECRET`.

Vercel SSO deployment protection is enabled for this project, scoped `all_except_custom_domains`.
So on a **preview** deployment that self-fetch is intercepted by the protection layer before the
function runs — it has no protection-bypass token. The tick fails, the job stalls, and the symptom
is **indistinguishable from a broken `CRON_SECRET`**. Do not debug a continuation failure on a
preview URL; the answer will be wrong.

Production is exempt only because it is served from the custom domain `shelfsprite.app`. To exercise
continuation, temporarily lower `CHUNK_BUDGET_MS`, deploy to production, and run a forced enrich
there. The alternative, Vercel's Protection Bypass for Automation, requires `enrichmentDispatch.ts`
to send `x-vercel-protection-bypass`, i.e. a change to the very code path under test.

#### Continuation verified in production (2026-08-13)

Run on `shelfsprite.app` under a temporary `CHUNK_BUDGET_MS = 100_000`, forced, 159 rated books:

| Time (UTC) | Event |
| --- | --- |
| 18:05:42 | `POST /enrich/start` claims the job and runs chunk 1 inline |
| ~18:07:22 | Chunk 1 stops at a book boundary, re-arms |
| 18:07:24 | `POST /api/enrich/tick` → 200, `durationMs` 47385 |
| 18:08:11 | Job `done` at **159/159** |

Progress crossed the chunk boundary rather than merely moving within one chunk: 86 → 109 → 136 →
147 → 158 → 159. Real work, not a replay — the confidence histogram shifted (MEDIUM 46→45, LOW
17→18). `CHUNK_BUDGET_MS` was reverted to `240_000` immediately afterward.

Two corrections to the proof standard this section previously stated:

- **"`/api/enrich/tick` ≥ 2" is the wrong acceptance bar, and reaching `done` is not disqualifying.**
  That bar was extrapolated from a 221s run, predicting 3 chunks / 2 ticks. The verification run
  took 149s — catalog latency varies — so it finished in 2 chunks with exactly **1** tick. The
  honest criterion is the one already stated above: **a tick invocation AND progress advancing
  across the boundary.** A job reaching `done` after a tick is strictly stronger evidence than a
  second tick, because the pre-fix failure mode was a job that never finished.
- **What this run does NOT prove: tick→tick chaining.** The job completed inside the first tick, so
  no tick ever had to re-arm another one. `rearmAfterResponse` firing from `after()` in the *tick*
  route remains unexercised in production. At `240_000` this library finishes in a single chunk and
  cannot test it; reproducing it needs a budget near `40_000` or a substantially larger library.
  Inductive comfort only: `start` and `tick` dispatch through the identical `deps.dispatch` →
  `rearmAfterResponse(request, jobId)` path.

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

Migration chain: `0001_initial_multitenant_schema` → `0002_display_name` → `0003_enrich_jobs` → `0004_...` → `0005_reader_archetypes` → `0006_add_exclude_from_profile` → ... → `0012_book_is_favorite` → `fbc5292134c4_add_enrichment_language` → `0013_invites` → `0014_usage_events` → `0015_enrichment_corrected_at` → `0016_trait_reveal_line` → `0017_user_directive` → `0018_node_wave0_tables` → `0019_add_enrich_job_leases`.

Note `fbc5292134c4` sits between `0012` and `0013` despite its unsequenced name — the chain is
linear, not branched. `0018` and `0019` were authored on `feat/node-backend` and do not exist on
`main`.

### Deploy landmine: the running image must contain the DB's current revision

`start.sh` runs `python -m alembic upgrade head` under `set -euo pipefail` **before** `exec uvicorn`.
Alembic must be able to locate the revision recorded in the database's `alembic_version` table
inside the image's own `alembic/versions/` directory. If it cannot, it raises
`CommandError: Can't locate revision identified by '<rev>'`, the script exits non-zero, uvicorn
never binds `$PORT`, and the platform healthcheck can never pass. `railway.json` sets
`restartPolicyMaxRetries: 3`, so the deploy then fails.

**This bites whenever a migration is applied to production from a branch checkout that the deployed
branch does not contain.** It happened in wave 5b: `0018_node_wave0_tables` was applied to
production by hand from `feat/node-backend`, while Railway deploys from `main`, which stops at
`0017`. Nothing broke immediately because the running container had booted while the DB was still
at `0017` — the failure only surfaced on the next deploy.

Two things make it nastier than a failed deploy:

- **A restart is enough to trigger it.** Restarting re-runs the container CMD, so a healthy instance
  survives only until something restarts it. The service is effectively armed, not merely
  un-deployable.
- **It is silent until then.** There is no check that the deployed branch's migration set covers the
  production revision.

Rule: **never apply a migration to production from a branch the deployment does not track.** If you
must, cherry-pick the revision files onto the deployed branch in the same window. Migration files
alone are inert — the Python app reads none of the wave-0 Node tables — so a migrations-only commit
is a safe repair.

### `enrich_jobs.progress` / `.total`: two legitimate schema lineages

The same migration set produces two different column shapes depending on the database's age, and
both are correct:

- **Fresh DB** — the `0001` baseline's `create_all()` builds `enrich_jobs` from the live models,
  where `db.py:271-272` declare `mapped_column(Integer, default=0)`: an ORM-level default with **no**
  `server_default`, and non-Optional `Mapped[int]` so NOT NULL. `0003` then short-circuits on
  `if _has_table("enrich_jobs")`. Result: **NOT NULL, no server default.**
- **Older DB (including production)** — predates the model, so the table came from `0003`'s
  `op.create_table`, whose lines 47-48 specify `nullable=False, server_default="0"`. Result:
  **NOT NULL, server default `0`.**

The Node code supplies `progress: 0, total: 0` explicitly (wave 4c-2's fix), so it inserts
successfully against either shape. The shape that actually breaks things is the first one combined
with a drizzle schema that declares `.default()` and omits the column from the INSERT — that is the
500 wave 4c-2 hit.

> **Consequence for the drizzle baseline:** generate it from a `pg_dump` of **production**, never
> from a fresh `alembic upgrade head`. A fresh run yields the `create_all` lineage and would bake the
> wrong shape into the baseline.

By contrast, `0019`'s new columns are unambiguous: `lease_expires_at` and `run_limit` are
`nullable=True`; `attempts` and `force` are `nullable=False` with `server_default` `0` / `false`
(`0019_add_enrich_job_leases.py:21,25,30,33`).

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
- **Invite email redirect:** `supabase_admin.invite_user()` passes `redirect_to=<FRONTEND_URL>/auth/callback` on the GoTrue `/invite` call (when `FRONTEND_URL` is set). The invite link's session tokens arrive in the URL *hash*, which the Next.js middleware never sees — `frontend/app/auth/callback/page.tsx` is a public client-only route that lets the Supabase JS client consume the hash, establish the session, and prompt the invited user (who has no password yet) to set one before continuing into the app.
- **Pre-provisioning at invite time:** `POST /admin/invite` accepts optional `display_name` / `anthropic_api_key` (beta launch: the admin supplies the Anthropic key). `create_invite()` writes both under the new Supabase user's id via `user_settings.set_display_name` / `set_anthropic_key` right after the Supabase invite call — no schema change needed, since `UserSettings.user_id` isn't a foreign key. `SetupWizard`'s name/API-key steps auto-skip for that user once they log in.
- **Revoke lifecycle:** When revoking, the sequence is: (1) call `delete_user` to remove the Supabase account, (2) mark the `invites` row as `revoked` + set `revoked_at`, (3) call `purge.delete_account` to drop the user's books + profile + encrypted API key. The row is marked revoked before local data cleanup to ensure retries never re-call Supabase delete if a retry is needed.
- **Routes:** `/admin/me` (get current admin + permissions), `/admin/invite` (create invite, optional pre-provisioned name/API key), `/admin/users` (list all invites + book count), `/admin/revoke` (delete user + purge), `/admin/usage` (Wave 4b — paginated `usage_events` across all users, filterable by `operation`, joined against `invites` for email display), `/admin/feedback` (Wave 4b — paginated `feedback` rows across all users, filterable by `category`, same email join).
- **Wave 4b — usage/feedback browsing:** `usage.admin_list_usage()` and `feedback.admin_list_feedback()` query their tables with no per-user scoping (unlike the existing `cap_status`, which is month-to-date for one user), paginated via `limit`/`offset` (first pagination precedent in the codebase — every other list route returns a full dump). Both join `Invite.supabase_user_id -> Invite.email` to label rows by email instead of a bare `user_id`. Frontend: the single `/admin` page gained a `Users`/`Usage`/`Feedback` tab switcher; the two new tabs live in `frontend/components/admin/` (`UsageTab.tsx`, `FeedbackTab.tsx`, shared `Pagination.tsx`), following the existing `divide-y` row-list convention (no table component exists in this codebase).
