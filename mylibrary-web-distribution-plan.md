# MyLibrary — Web App Distribution Plan

## Goal

Transition MyLibrary from a local-run tool (Chase only) to a publicly hosted web app where
other users can sign up, import their Goodreads library, and get AI-powered recommendations
using their own Anthropic API key.

The core pipeline (`ingest → enrich → profile → recommend`) is solid and stays intact.
This plan is almost entirely backend infrastructure + auth — not new product features.

## Locked decisions (this transition)

These resolve the "open questions" at the bottom and supersede any conflicting wording below:

1. **Auth + DB = Supabase.** Supabase Auth issues the JWT and Supabase Postgres is the
   database — one service for both. (Earlier drafts mentioned Clerk; that is dropped to
   avoid running two vendors.) DB access stays through SQLAlchemy, not the Supabase JS
   client, so **no RLS** — scope every query by `user_id` server-side instead.
2. **Launch = invite-only, free.** Signups are gated behind an invite/allowlist initially to
   control scale and cost. No billing, no Stripe, no paid tier in this phase.
3. **Anthropic key = bring-your-own, always.** Each user supplies their own key (encrypted
   at rest, decrypted only at call time). Never bundle one.
4. **Google Books key = bundle Chase's shared key.** It's optional and low-quota-risk;
   bundling removes first-run friction. Revisit only if quota becomes a problem.

Status: **Phases 2 & 3 landed; Postgres cutover tooling ready.** Multi-tenancy (user_id on all
tables + scoped queries + Alembic baseline + per-request `user_id` dependency) and per-user
Anthropic key storage are done and tested in local mode. The Alembic baseline was verified
against a real Postgres (builds clean, zero autogenerate drift), and `config.db_url` now pins a
raw Supabase connection string onto the psycopg v3 driver. **Cutover is now an operator step**,
not a code task — follow `mylibrary-postgres-cutover-runbook.md` (set `DATABASE_URL` to the
Supabase session pooler → `alembic upgrade head` → smoke-test). Decision: **no data migration** —
the local `user_id="local"` library is left behind; the web flow is tested fresh under a real
Supabase account. Remaining: run the cutover, flip on auth (`SUPABASE_URL` + `ENCRYPTION_KEY`),
then Phases 4–6.

---

## Context (read CLAUDE.md first)

- Python FastAPI backend (`mylibrary/api.py`) + Next.js frontend (`frontend/`)
- SQLite via SQLAlchemy 2.0 — must migrate to Postgres for multi-user
- Every table currently has no `user_id` — multi-tenancy requires adding it everywhere
- Enrichment is long-running (can be 10+ min for large libraries) — needs background jobs
- `ANTHROPIC_API_KEY` currently comes from `.env` — must be stored per-user, encrypted
- `GOOGLE_BOOKS_API_KEY` is optional (Chase's key) — decide whether to bundle a shared key
  or require users to supply their own

---

## Locked decisions (carry forward from CLAUDE.md)

All locked decisions from CLAUDE.md apply. Additionally:
- Users must supply their own Anthropic API key — never bundle one
- Goodreads CSV is still the only *Goodreads* ingest path (the API is dead, no scraping).
  Note this is no longer the only way to populate a library: **manual add** (search-and-pick
  against Open Library / Google Books → `library.add_book`) lets users without a Goodreads
  account build a library, and the setup wizard offers it as an alternate first-run path.
- No scraping Goodreads
- Import must never clobber `app_rating` / `app_review`

---

## Phase 1 — Auth ✅ DONE (pending Supabase project verification)

Landed: backend ES256/JWKS token verification (`auth.py`); per-request `current_user`
dependency on every route. **Frontend wired** (email + password): `utils/supabase/client.ts`
(browser client, auth-only), `lib/api.ts` forwards the session token as `Authorization:
Bearer`, `middleware.ts` refreshes sessions + redirects unauthenticated users to `/login`,
`app/login` sign-in page, NavBar sign-out. All of it no-ops in local mode (no Supabase env),
so dev stays unauthenticated. Remaining: confirm a real token verifies end to end against
the live Supabase project, and invite the first users (signups are dashboard-invite only).

Original notes:

**Use Supabase Auth.** Chase has prior Supabase experience and it consolidates auth + DB
into one service. Supabase Auth gives you `user_id` (the `sub` claim) out of the box and
handles email/password + OAuth. Rolling your own is not worth it. This project's Supabase
signs access tokens with **ES256** (asymmetric), so the backend verifies each request's token
against the project's PUBLIC key from the JWKS endpoint (`auth.py`, cached via `PyJWKClient`)
— no shared secret, and it does not call Supabase per request. Set `SUPABASE_URL`; a legacy
HS256 `SUPABASE_JWT_SECRET` path remains as a fallback.

**Tasks:**
- Verify the Supabase JWT in a FastAPI dependency; reject requests without a valid token
- Extract `user_id` (the JWT `sub`) server-side and inject it into every handler
- Protect all data routes with that dependency (health/docs stay public)
- Gate signups behind an invite allowlist (Supabase allowlist or an `invites` table check)
- Add a `/me` endpoint that returns the current user's profile/onboarding state
- Gate the frontend behind auth (Supabase client; redirect unauthenticated users to sign-in)
- Forward the access token as `Authorization: Bearer` from the Next.js `lib/api.ts` client

---

## Phase 2 — Database migration (SQLite → Postgres, multi-tenant) ✅ DONE

Landed: `user_id` on `books` / `taste_traits` / `recommendations` / `profile_meta`;
`ProfileMeta` de-singletonized (per-user); per-user uniqueness on `goodreads_book_id`;
every core function + every API route scopes by `user_id` (incl. the dedup walks);
Alembic baseline (`0001_initial_multitenant_schema`) created and `init_db` retired in
hosted mode. Postgres engine activates automatically when `DATABASE_URL` is set. Local
SQLite mode is unchanged and still self-migrates. Original task list kept below for record.

This is the biggest change. Every table that holds user data needs a `user_id` column and
all queries need to be scoped to it.

**Tables to migrate:**
- `books` — add `user_id`; primary key becomes `(user_id, book_id)` or surrogate
- `taste_traits` — add `user_id`
- `profile_meta` — add `user_id` (currently a singleton row)
- `recommendations` — add `user_id`

**Tables that don't need user_id:**
- None — every table is user-scoped data

**Tasks:**
- Switch SQLAlchemy engine from SQLite to Postgres (`asyncpg` driver recommended)
- Add `user_id` column to all tables; update all queries to filter by it
- Write Alembic migrations (don't use `init_db` drop+recreate in production — that was fine
  locally but will destroy data)
- Update `init_db` to run migrations rather than recreate tables
- `books` is never dropped — migration must be additive only
- Test that Chase's existing local data can be seeded into the new schema
- **`library.add_book` dedup must become a scoped query.** It currently walks every `books`
  row in Python (`session.query(Book).all()` → normalize title/surname) to reject
  duplicates — fine for one user on SQLite, but under multi-tenancy it must filter by
  `user_id` (and ideally push the normalized-key match into the query / a stored normalized
  column) so one user's add doesn't scan the whole table. Same applies to the title+surname
  walks in `enrich._normalize_title` callers and `api._ensure_library_book`.

**Hosting the DB:**
- Supabase Postgres (same project as auth — one less service to manage)
- Note on RLS: since all DB access goes through SQLAlchemy (not the Supabase JS client
  directly), skip row-level security and just filter by `user_id` in queries. Simpler and
  still correct. RLS only adds value if the frontend hits Supabase directly.

---

## Phase 3 — Per-user Anthropic key storage ✅ DONE

Landed: `user_settings` table (encrypted key + timestamps); `user_settings.py`
(`set_anthropic_key` / `clear_anthropic_key` / `anthropic_key_status` /
`resolve_anthropic_key`); `profile`/`recommend` resolve the per-user key (env fallback in
local mode); `PUT`/`GET`/`DELETE /settings/api-key`; `/settings` page + NavBar link.
Requires `ENCRYPTION_KEY` (base64 32 bytes) in the deployment env. Original task list below.

Users enter their Anthropic API key in app settings. It is stored encrypted in the DB and
decrypted server-side only when a Claude call is made. It is never returned to the frontend.

**Tasks:**
- Add `user_settings` table: `(user_id, anthropic_api_key_encrypted, created_at, updated_at)`
- Add server-side encryption/decryption utility (AES-256-GCM; key comes from an env var
  `ENCRYPTION_KEY` set in the deployment environment — never in the repo)
- Add `PUT /settings/api-key` endpoint (accepts key, encrypts, stores)
- Add `GET /settings/api-key/status` endpoint (returns `{configured: bool}` — never the key)
- Add API key settings UI in the frontend (entry form + confirmation that it's saved)
- Gate `profile`, `reprofile`, and `recommend` endpoints — return a clear error if no key
  is configured, with a link to settings
- Google Books key: **bundle Chase's shared key** (locked decision #4) — it stays a single
  deployment env var, not a per-user setting. Users only ever enter their Anthropic key.

---

## Phase 4 — Background job queue for enrichment ✅ DONE

Landed: `EnrichJob` table (`enrich_jobs`) tracks `(job_id, user_id, status, progress, total,
started_at, finished_at, error)`; Alembic migration `0003_add_enrich_jobs` (revision
`0003_enrich_jobs`, chains after the pre-existing `0002` display_name migration); `worker.py`
(`enrich_books` arq task + `run_enrich_job` blocking core + `WorkerSettings`); new endpoints
`POST /enrich/start` (rate-limited 5/min, enqueues arq or falls back to BackgroundTask) and
`GET /enrich/status/{job_id}`; old `POST /enrich` kept for CLI/local tooling only. SlowAPI
rate limiting added: `/enrich/start` at 5/min, `/catalog/search` at 30/min, both keyed on
`user_id` (stashed on `request.state` by the `current_user` dependency). `REDIS_URL` env var
activates the arq pool at startup; when unset, enrichment runs via FastAPI BackgroundTasks
(no Redis needed for local dev). Setup wizard `EnrichStep` now polls with a real progress bar
instead of spinning blindly. arq worker started with:
    python -m arq mylibrary.worker.WorkerSettings

Per-user rate limiting on `/catalog/search` (30/min) done here as locked by the plan.

Note: `profile` and `recommend` are still synchronous — they run in 30-60s and are well
within cloud timeout limits. Revisit if they become bottlenecks at scale.

---

## Phase 5 — Hosting / deployment

**Architecture:**
- **API (FastAPI + arq worker)** → Railway (web service + worker service, same repo)
- **Frontend (Next.js)** → Vercel
- **Database + Auth** → Supabase
- **Queue** → Upstash Redis (serverless, no idle cost)

**Tasks:**
- Add `Dockerfile` for the Python API
- Add `Procfile` or Railway config with two processes: `web` (uvicorn) and `worker` (arq)
- Set environment variables in Railway: `DATABASE_URL`, `ENCRYPTION_KEY`, `REDIS_URL`,
  `GOOGLE_BOOKS_API_KEY`, `ANTHROPIC_API_KEY` (Chase's own key for admin use only, optional)
- Deploy frontend to Vercel; set `NEXT_PUBLIC_API_URL` to the Railway API URL
- Configure CORS on the FastAPI app to allow the Vercel domain
- Set up a custom domain if desired

---

## Phase 6 — First-run UX polish

The setup wizard already handles CSV import and enrichment. With auth + background jobs in
place, review the full first-run flow end to end:

1. Sign up
2. Enter Anthropic API key (settings)
3. Upload Goodreads CSV (setup wizard)
4. Enrichment runs in background, frontend polls progress
5. Profile build (user-initiated)
6. First recommendations

There are now **two** first-run paths to test end to end: the CSV import flow above, and the
**manual "I don't have a Goodreads export" path** (`ManualStep` → search-and-pick →
`add_book`), which lands a usable rated starter library without enrichment (manual adds carry
catalog metadata already). Both must leave the dashboard non-empty without bouncing back to
`/setup`.

**Tasks:**
- Add a "where to find your Goodreads CSV" tooltip/link in the setup wizard
  (Goodreads → Account → Settings → Import/Export)
- Make the API key entry the first step of setup, before CSV upload **or** manual add
- Ensure the enrichment progress bar reflects real background job progress
- Test the full flow with a fresh account and a real Goodreads export
- Test the manual-add first-run path with a fresh account (add a few rated books → finish →
  profile build → first recommendations) — it must not require the enrichment step
- Rate-limit `/catalog/search` per user (it hits Open Library + Google Books on each
  keystroke-debounced query) for the same shared-IP reason as the enrich endpoints

---

## Sequencing

```
Phase 1 (Auth)
    ↓
Phase 2 (Postgres + multi-tenancy)   ← unblocks everything else
    ↓
Phase 3 (API key storage)
    ↓
Phase 4 (Background jobs)
    ↓
Phase 5 (Hosting)
    ↓
Phase 6 (UX polish) → Release
```

Phases 3 and 4 can be worked in parallel once Phase 2 is done.

---

## What does NOT change

- `ingest.py`, `enrich.py`, `profile.py`, `recommend.py`, `catalog.py`, `library.py`,
  `stats.py` — core pipeline logic stays intact
- The two-stage recommender architecture
- Taste profile structure and trait editing
- The frontend routes and components (minor changes only for auth gating + job polling)
- SQLAlchemy models (add `user_id` column, but models otherwise stay the same)

---

## Open questions — RESOLVED

1. **Google Books key** — ✅ Bundle Chase's shared key (decision #4).
2. **Free tier / pricing** — ✅ Free, no billing this phase (decision #2).
3. **Invite-only launch?** — ✅ Yes, invite-only at launch (decision #2).
4. **Rate limiting** — ✅ Still required. Per-user rate limiting on `enrich` and
   `/catalog/search` (shared-IP protection for Open Library / Google Books). Implement in
   Phase 4 alongside the job queue (e.g. SlowAPI or a Redis token bucket keyed on `user_id`).
