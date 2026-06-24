# MyLibrary — Web App Distribution Plan

## Goal

Transition MyLibrary from a local-run tool (Chase only) to a publicly hosted web app where
other users can sign up, import their Goodreads library, and get AI-powered recommendations
using their own Anthropic API key.

The core pipeline (`ingest → enrich → profile → recommend`) is solid and stays intact.
This plan is almost entirely backend infrastructure + auth — not new product features.

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

## Phase 1 — Auth

**Use Supabase Auth.** Chase has prior Supabase experience and it consolidates auth + DB
into one service (vs. Clerk + Neon separately). Supabase Auth gives you `user_id` out of
the box and handles email/password + OAuth. Rolling your own is not worth it.

**Tasks:**
- Add auth provider (Clerk recommended)
- Protect all API routes — every request must carry a valid JWT / session token
- Extract `user_id` from the token server-side on every request
- Add a `/me` endpoint that returns the current user's profile state
- Gate the frontend behind auth (redirect unauthenticated users to sign-in)

---

## Phase 2 — Database migration (SQLite → Postgres, multi-tenant)

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

## Phase 3 — Per-user Anthropic key storage

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
- Decide on Google Books key: either bundle a shared key with a generous quota, or require
  users to supply their own (recommend bundling for now to reduce friction)

---

## Phase 4 — Background job queue for enrichment

Enrichment can run 10+ minutes. Cloud HTTP requests time out (typically 30–60s). Enrichment
must move to a background worker.

**Tasks:**
- Add a job queue. `arq` (async, Redis-backed, lightweight) is recommended over Celery for
  this stack. Alternative: FastAPI `BackgroundTasks` for very short jobs, but enrichment is
  too long.
- Add Redis (Railway Redis or Upstash) for the queue backend
- Move `enrich.py` execution into an `arq` worker task
- Add job state table or use arq's built-in state: `(user_id, job_id, status, progress,
  started_at, finished_at, error)`
- Add endpoints:
  - `POST /enrich/start` — enqueues the job, returns `job_id`
  - `GET /enrich/status/{job_id}` — returns job status + progress
- Update the setup wizard frontend to poll `/enrich/status` instead of waiting on the HTTP
  response
- Similarly move `profile` and `recommend` if they become slow at scale (for now they're
  fast enough to keep synchronous, but flag this)

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

## Open questions (decide before starting)

1. **Google Books key** — bundle a shared key or require users to supply one?
2. **Free tier / pricing** — is this free for all users, or do you plan to charge? (Affects
   infra cost planning)
3. **Invite-only launch?** — consider restricting signups initially to control scale and
   get feedback before fully opening up
4. **Rate limiting** — without it, one user can hammer Open Library / Google Books and get
   the shared IP blocked; add per-user rate limiting on enrich endpoints
