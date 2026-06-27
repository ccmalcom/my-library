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

## 2. Upstash — Redis for the job queue (OPTIONAL — scale-only)

> **Default deploy omits this step.** For the invite-only launch, `REDIS_URL` is left
> unset and enrichment runs as a FastAPI BackgroundTask inside the web process. Skip to
> step 3 unless you specifically need a dedicated arq worker (e.g. horizontal scale or
> long-running jobs that exceed the web process lifetime).

1. https://upstash.com → create a **Redis** database (free tier is fine).
   - Pick a region close to your Railway region.
   - Enable **TLS** (default).
2. Copy the connection string in **`rediss://`** form (note the double-s — TLS):
   `rediss://default:<token>@<host>.upstash.io:6379`. This is `REDIS_URL`.

Upstash is serverless (no idle cost) and is what activates the arq worker pool in opt-in mode.

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
   - **Target port: use `8080`** (Railway's default). Railway injects its own `PORT` env var at
     runtime (defaulting to **8080**), and that overrides the Dockerfile's `ENV PORT=8000`, so
     uvicorn actually listens on 8080. The domain's target port MUST equal whatever `PORT` is in
     the container, or you get "Application failed to respond". Either point the domain at 8080,
     OR set a `PORT=8000` variable explicitly (then uvicorn binds 8000 and you target 8000). Do
     not target 8000 while leaving Railway's injected `PORT` at 8080 — that's the mismatch.
4. **Settings → Deploy → Healthcheck Path** → set to **`/healthz`** (the unauthenticated probe;
   do NOT use `/health`, which requires a token and would fail the check in hosted mode).

### 3b. Web service env vars (Settings → Variables)
```
DATABASE_URL          = <Supabase session pooler string, +psycopg driver>
SUPABASE_URL          = https://<ref>.supabase.co
ENCRYPTION_KEY        = <the base64 32-byte key from step 1>
# REDIS_URL           = <the rediss:// Upstash URL from step 2>  # OPTIONAL — omit for BackgroundTask mode
GOOGLE_BOOKS_API_KEY  = <your shared Google Books key>   # bundled (locked decision #4)
CORS_ORIGINS          = https://PLACEHOLDER                # fill in after Vercel (step 5)
MYLIBRARY_DATA_DIR    = /data                              # set after adding the volume below
# ANTHROPIC_API_KEY   = <optional — only for your own admin/testing; users bring their own>
```

### 3b-i. Persistent volume for the catalog cache

Create a volume on the Railway **web** service so the disk-cached Open Library / Google Books
responses survive redeploys (and are shared between enrich and recommend in the single process):

1. Web service → **Volumes** → **Add Volume** → mount path **`/data`**.
2. Add service variable `MYLIBRARY_DATA_DIR=/data` (already shown above).

The DB lives in Supabase/Postgres and is unaffected. The volume holds only the catalog cache
(`/data/cache/`) and any uploaded CSVs; losing it just causes a one-time re-fetch on next enrich.

### 3c. Add the worker service (OPTIONAL — scale-only)

> Skip this step for the default invite-only deploy (no `REDIS_URL` set). Only add a
> separate worker service if you later opt into arq mode by setting `REDIS_URL`.

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
Hit `https://<railway-web-url>/healthz` → `{"status":"ok"}`. The web service log should show
`alembic upgrade head` then uvicorn starting. In BackgroundTask mode (no worker service), confirm
enrichment progresses by starting the setup wizard and watching the progress bar advance to `done`.
If you opted into arq mode, the worker log should show arq connecting to Redis and `0 jobs` waiting.

**Upstash verification (if retired):** after switching to BackgroundTask mode (REDIS_URL unset),
the Upstash command-rate graph should flatline near zero — confirm before deleting the instance.

---

## 4. Vercel — frontend

1. https://vercel.com → **Add New → Project** → import the `mylibrary` repo.
2. **Root Directory → `frontend`** (important — the Next.js app is in the subfolder).
3. Framework preset auto-detects **Next.js**; leave build/output defaults.
4. **Environment Variables:**
   ```
   NEXT_PUBLIC_API_URL                  = https://<railway-web-url>   # MUST include https://, no trailing slash
   NEXT_PUBLIC_SUPABASE_URL             = https://<ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = <Supabase publishable/anon key>
   ```
   **`NEXT_PUBLIC_API_URL` must include the `https://` scheme.** Without it the client treats the
   value as a relative path and appends it to the Vercel origin — you'll see 404s like
   `https://<vercel>/<railway-host>/stats`. **`NEXT_PUBLIC_*` vars are inlined at build time**, so
   after adding/changing them you must **Redeploy** (Deployments → Redeploy); editing the value
   alone does nothing to an already-built deployment.
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
4. Run the setup wizard: CSV upload **or** manual add → enrichment (watch the progress bar; it
   runs as a BackgroundTask in the web process in default mode) → build profile → first
   recommendations.
5. Confirm the dashboard stays populated (doesn't bounce back to `/setup`).

That exercises every Phase 5 service: Vercel (UI) → Railway web (API + auth verify + BackgroundTask
enrich) → Supabase (Postgres + JWT) → Anthropic (profile/recommend).

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Browser console: CORS / "blocked by policy" | `CORS_ORIGINS` missing the exact Vercel origin, or has a trailing slash. |
| All API calls 401 after sign-in | `SUPABASE_URL` wrong/unset on Railway, or token is HS256 (set `SUPABASE_JWT_SECRET`). |
| Railway healthcheck failing / deploy never goes live | Healthcheck path is `/health` (needs auth) instead of `/healthz`; or app crashed on `alembic upgrade` — check logs. |
| Logs show `Context impl SQLiteImpl` / `sqlite3.OperationalError` during `alembic upgrade` | **`DATABASE_URL` is not set on the service** — the app fell back to an ephemeral in-container SQLite instead of Supabase Postgres. Set `DATABASE_URL` (session pooler, `+psycopg`) on the web AND worker services and redeploy. A correct deploy logs `Context impl PostgresqlImpl`. |
| "Application failed to respond" on the domain | Port mismatch (or domain on the wrong service). Railway injects `PORT=8080` and uvicorn binds it (logs: `Uvicorn running on http://0.0.0.0:8080`), but the domain's target port is different. Set the domain target = the port in the log (8080 by default), or pin `PORT=8000` in Variables. Also confirm the domain is on the **web** (uvicorn) service, not the arq worker (which has no HTTP server). |
| `ModuleNotFoundError: psycopg2` | `DATABASE_URL` lacks the `+psycopg` driver; `config.db_url` normalizes a bare `postgresql://`, but verify. |
| Enrichment starts but never progresses | In BackgroundTask mode: check web service logs for errors in `run_enrich_job`. In arq mode: worker service down, or `REDIS_URL` differs between web and worker, or wrong (`redis://` vs `rediss://`). |
| Enrichment job stuck 'running' after redeploy | `recover_orphaned_jobs()` runs at boot and should flip it to 'error'; the frontend shows a Retry button. If it doesn't, check that `REDIS_URL` is unset (gating condition). |
| "Anthropic key not configured" on profile/recommend | User hasn't saved a key in `/settings`, or `ENCRYPTION_KEY` differs from when it was saved (can't decrypt). |
| Saved keys suddenly undecryptable | `ENCRYPTION_KEY` changed. It must stay constant — back it up. |

## Rollback / teardown

- Backend reverts to local SQLite the moment `DATABASE_URL` is unset locally — Railway is
  independent of your dev machine.
- To pause hosting: stop/delete the Railway services and the Vercel project. Supabase data
  persists. The Postgres schema is owned by Alembic (`alembic downgrade base` to wipe).
