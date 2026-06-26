# MyLibrary — Phase 5 Deployment Runbook

Stand up the hosted multi-tenant app: **API + worker on Railway**, **frontend on Vercel**,
**DB + auth on Supabase**, **queue on Upstash Redis**. The in-repo artifacts (`Dockerfile`,
`start.sh`, `railway.json`, `/healthz`, env-driven CORS) are already committed — this runbook is
the operator side: provision services, set env vars, wire them together, invite users.

Assumes the Postgres cutover (`mylibrary-postgres-cutover-runbook.md`) concepts are understood:
the same Supabase **session pooler** `DATABASE_URL` is reused here.

---

## Order of operations

```
1. Supabase   (already exists — just collect values + set ES256 if needed)
2. Upstash    (provision Redis, copy rediss:// URL)
3. Railway    (deploy API web + worker from the repo, set env, get public URL)
4. Vercel     (deploy frontend, point it at the Railway URL + Supabase)
5. Back to Railway: set CORS_ORIGINS to the Vercel domain
6. Invite your first user in Supabase, smoke-test the full flow
```

CORS is circular (Railway needs the Vercel domain; Vercel needs the Railway URL), so Railway
goes up first with a placeholder, then you fill in `CORS_ORIGINS` after Vercel gives you a domain.

---

## 1. Supabase — collect the values you'll need

You already have the project (used in the Postgres cutover). Gather:

- **`DATABASE_URL`** — Dashboard → **Connect** → **Session pooler** (port **5432**), driver
  `postgresql+psycopg://`. URL-encode special chars in the password. (Same string from the
  cutover runbook.)
- **`SUPABASE_URL`** — `https://<ref>.supabase.co` (Project Settings → API → Project URL).
- **Publishable (anon) key** — Project Settings → API → `publishable` / anon key. This is the
  frontend's `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (public, safe in the browser).

Auth signing: the backend (`auth.py`) verifies **ES256** tokens against the project JWKS at
`<SUPABASE_URL>/auth/v1/.well-known/jwks.json` — no shared secret to copy. New Supabase projects
default to ES256, so setting `SUPABASE_URL` is enough. (If yours is an older HS256 project, set
`SUPABASE_JWT_SECRET` instead; you'll know because JWKS verification fails.)

Generate the **`ENCRYPTION_KEY`** once (used to encrypt each user's Anthropic key at rest) and
save it — losing it makes stored keys undecryptable:

```powershell
python -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"
```

---

## 2. Upstash — Redis for the job queue

1. https://upstash.com → create a **Redis** database (free tier is fine).
   - Pick a region close to your Railway region.
   - Enable **TLS** (default).
2. Copy the connection string in **`rediss://`** form (note the double-s — TLS):
   `rediss://default:<token>@<host>.upstash.io:6379`. This is `REDIS_URL`.

Upstash is serverless (no idle cost) and is what activates the arq worker pool. Without it the
API would fall back to in-process BackgroundTasks — fine locally, but on Railway you want the
separate worker service, so `REDIS_URL` is required in production.

---

## 3. Railway — API web service + worker service

Both services build from the **same repo and Dockerfile**; only the start command differs.

### 3a. Create the project + web service
1. https://railway.app → **New Project** → **Deploy from GitHub repo** → pick the `mylibrary` repo.
2. Railway detects `railway.json` and builds with the `Dockerfile`. This first service is your
   **web** service. The default container command is `start.sh` (runs `alembic upgrade head`
   then uvicorn on `$PORT`) — leave the start command blank to use it.
3. **Settings → Networking → Generate Domain** to get a public URL like
   `https://mylibrary-api-production.up.railway.app`. Save it — Vercel needs it.
4. **Settings → Deploy → Healthcheck Path** → set to **`/healthz`** (the unauthenticated probe;
   do NOT use `/health`, which requires a token and would fail the check in hosted mode).

### 3b. Web service env vars (Settings → Variables)
```
DATABASE_URL          = <Supabase session pooler string, +psycopg driver>
SUPABASE_URL          = https://<ref>.supabase.co
ENCRYPTION_KEY        = <the base64 32-byte key from step 1>
REDIS_URL             = <the rediss:// Upstash URL from step 2>
GOOGLE_BOOKS_API_KEY  = <your shared Google Books key>   # bundled (locked decision #4)
CORS_ORIGINS          = https://PLACEHOLDER                # fill in after Vercel (step 5)
# ANTHROPIC_API_KEY   = <optional — only for your own admin/testing; users bring their own>
```
Do **not** set `MYLIBRARY_DATA_DIR` — the container's local `data/` (catalog cache) is ephemeral
and that's fine; the DB is Postgres.

### 3c. Add the worker service
1. In the same project: **New → GitHub Repo → same `mylibrary` repo** (a second service off the
   same source).
2. **Settings → Deploy → Custom Start Command:**
   ```
   python -m arq mylibrary.worker.WorkerSettings
   ```
   This overrides the Dockerfile's default `start.sh`, so the worker runs arq instead of uvicorn
   and never runs migrations (only the web service migrates — avoids a race).
3. **Worker env vars:** it needs the same data-plane vars. Easiest: copy
   `DATABASE_URL`, `SUPABASE_URL`, `ENCRYPTION_KEY`, `REDIS_URL`, `GOOGLE_BOOKS_API_KEY`.
   It does **not** need `CORS_ORIGINS` (no HTTP) and does not serve a port — leave networking off
   and do **not** set a healthcheck path on the worker.

### 3d. Verify
After both deploy, hit `https://<railway-web-url>/healthz` → `{"status":"ok"}`. The web service
log should show `alembic upgrade head` running to `0003_...` then uvicorn starting. The worker log
should show arq connecting to Redis and `0 jobs` waiting.

---

## 4. Vercel — frontend

1. https://vercel.com → **Add New → Project** → import the `mylibrary` repo.
2. **Root Directory → `frontend`** (important — the Next.js app is in the subfolder).
3. Framework preset auto-detects **Next.js**; leave build/output defaults.
4. **Environment Variables:**
   ```
   NEXT_PUBLIC_API_URL                  = https://<railway-web-url>   # no trailing slash
   NEXT_PUBLIC_SUPABASE_URL             = https://<ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = <Supabase publishable/anon key>
   ```
5. Deploy. Note the production domain Vercel assigns, e.g. `https://mylibrary.vercel.app`.

---

## 5. Close the CORS loop (back to Railway)

On the Railway **web** service, set:
```
CORS_ORIGINS = https://mylibrary.vercel.app
```
Add any preview domains you'll test against, comma-separated and with **no trailing slashes**,
e.g. `https://mylibrary.vercel.app,https://mylibrary-git-main-you.vercel.app`. Redeploy the web
service (Railway redeploys on a variable change automatically). Without this the browser blocks
every API call with a CORS error.

---

## 6. Invite your first user + smoke-test

1. Supabase → **Authentication → Users → Add user** (or send an invite). Launch is invite-only:
   there is no public sign-up form, so users only exist if you create them here.
2. Open the Vercel URL, sign in with that user.
3. **`/settings`** → paste an Anthropic API key (it's encrypted with `ENCRYPTION_KEY` at rest).
4. Run the setup wizard: CSV upload **or** manual add → enrichment (watch the progress bar; it's
   driven by the Railway **worker**) → build profile → first recommendations.
5. Confirm the dashboard stays populated (doesn't bounce back to `/setup`).

That exercises every Phase 5 service: Vercel (UI) → Railway web (API + auth verify) → Supabase
(Postgres + JWT) → Railway worker (arq enrich via Upstash Redis) → Anthropic (profile/recommend).

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Browser console: CORS / "blocked by policy" | `CORS_ORIGINS` missing the exact Vercel origin, or has a trailing slash. |
| All API calls 401 after sign-in | `SUPABASE_URL` wrong/unset on Railway, or token is HS256 (set `SUPABASE_JWT_SECRET`). |
| Railway healthcheck failing / deploy never goes live | Healthcheck path is `/health` (needs auth) instead of `/healthz`; or app crashed on `alembic upgrade` — check logs. |
| Logs show `Context impl SQLiteImpl` / `sqlite3.OperationalError` during `alembic upgrade` | **`DATABASE_URL` is not set on the service** — the app fell back to an ephemeral in-container SQLite instead of Supabase Postgres. Set `DATABASE_URL` (session pooler, `+psycopg`) on the web AND worker services and redeploy. A correct deploy logs `Context impl PostgresqlImpl`. |
| `ModuleNotFoundError: psycopg2` | `DATABASE_URL` lacks the `+psycopg` driver; `config.db_url` normalizes a bare `postgresql://`, but verify. |
| Enrichment starts but never progresses | Worker service down, or `REDIS_URL` differs between web and worker, or wrong (`redis://` vs `rediss://`). |
| "Anthropic key not configured" on profile/recommend | User hasn't saved a key in `/settings`, or `ENCRYPTION_KEY` differs from when it was saved (can't decrypt). |
| Saved keys suddenly undecryptable | `ENCRYPTION_KEY` changed. It must stay constant — back it up. |

## Rollback / teardown

- Backend reverts to local SQLite the moment `DATABASE_URL` is unset locally — Railway is
  independent of your dev machine.
- To pause hosting: stop/delete the Railway services and the Vercel project. Supabase data
  persists. The Postgres schema is owned by Alembic (`alembic downgrade base` to wipe).
