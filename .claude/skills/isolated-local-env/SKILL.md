---
name: isolated-local-env
description: Use when you need to run/test MyLibrary against a throwaway local SQLite library instead of the real dev Supabase Postgres DB — e.g. browser-verifying a feature end-to-end, seeding test data, or any manual smoke test that shouldn't touch shared dev data or spend real Claude credits on someone else's behalf.
---

# Isolated local MyLibrary environment

This project's `.env` normally points local runs at the **real remote dev Supabase Postgres
DB** (`DATABASE_URL` + `SUPABASE_URL` are set there) — not a local SQLite file. Manual
testing (CLI commands, `serve`, `npm run dev`) without taking deliberate steps will silently
read/write that shared dev database. This skill is the checklist for genuinely isolating a
test run so nothing touches it.

## The core trap: `unset` does not work

`mylibrary/config.py` calls `load_dotenv(_PROJECT_ROOT / ".env")` on import. python-dotenv's
default `override=False` only protects an env var that is **already set to something**
(even an empty string) — an **unset** var gets silently backfilled from `.env`. So:

```bash
unset DATABASE_URL   # WRONG — load_dotenv() refills it from .env right after
python -m mylibrary.cli add "Some Book"   # hits the REAL dev Postgres
```

**Always set to an explicit empty string instead:**

```bash
export DATABASE_URL=
export SUPABASE_URL=
export SUPABASE_JWKS_URL=
export SUPABASE_JWT_SECRET=
export MYLIBRARY_DATA_DIR=/path/to/a/throwaway/dir
```

Verify before trusting it — don't skip this:

```bash
python -c "import mylibrary.config as c; s=c.get_settings(); print(s.is_multi_tenant, s.auth_enabled, s.db_url)"
# must print: False False sqlite:///<your throwaway dir>/mylibrary.db
```

## Backend: init + seed a throwaway library

```bash
python -m mylibrary.cli initdb
python -m mylibrary.cli add "Title" --author "Author" --rating 5 --shelf read   # repeat; vary ratings/shelves
python -m mylibrary.cli profile     # real Claude call — needed for traits, cheap
```

To also get an archetype (needed for the reveal finale, `tasteAccent`, etc.), start the
server and hit the endpoint directly — there's no CLI command for it:

```bash
python -m mylibrary.cli serve --port 8010 --no-reload &
curl -s -X POST http://127.0.0.1:8010/profile/archetype
```

Use `--no-reload` (skip the default `reload=True`) to avoid a confusing second
reloader/worker process pair when you need to restart cleanly.

## Frontend: point it at the isolated backend, and disable Supabase auth

`.env.local` has real `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_SUPABASE_URL` values baked in —
override them for the dev-server process, don't edit the file:

```bash
export NEXT_PUBLIC_API_URL=http://127.0.0.1:8010
export NEXT_PUBLIC_SUPABASE_URL=
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
npm run dev -- --port 3000
```

(`utils/supabase/middleware.ts` no-ops — no login redirect — when
`NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` are empty.)

### Three gotchas that look like app bugs but aren't

1. **Turbopack persistent cache can serve a stale `NEXT_PUBLIC_*` value** baked into an
   already-compiled chunk, even after restarting `next dev` with a new env var. If a
   different `NEXT_PUBLIC_API_URL` doesn't seem to take effect, `rm -rf frontend/.next/cache`
   and restart. (Don't trust `.next/static/chunks` greps for what's *currently* being served —
   that directory can also hold stale `next build` production artifacts from earlier in the
   session; check actual browser network requests instead.)

2. **Browse via `http://localhost:PORT`, never `http://127.0.0.1:PORT`.** Next.js dev server
   blocks cross-origin HMR websocket requests from `127.0.0.1` by default
   (`allowedDevOrigins`). Symptom: the page loads, one or two top-level SWR fetches fire, but
   sibling components never fetch at all — stuck on a loading skeleton forever, **zero
   console errors**. It looks exactly like a broken data-fetching bug in application code.

3. **Backend CORS defaults only allow port 3000.** If the isolated frontend runs on any
   other port, its requests get a silent 403 on the CORS preflight (the browser won't log it
   usefully — verify directly: `curl -i -X OPTIONS http://127.0.0.1:8010/stats -H "Origin:
   http://127.0.0.1:3001" -H "Access-Control-Request-Method: GET"`). Either run the frontend
   on port 3000, or set `CORS_ORIGINS` on the backend to match whatever port you actually use.

## Port conflicts on Windows

If a `next dev` instance is already holding a lock in `frontend/.next/dev/` from an earlier
attempt (different port, still running), a new instance refuses to start with "Another next
dev server is already running" and names the PID. Before killing it, confirm with the user
which specific PID and why — broad `Stop-Process` calls matched via a command-line pattern
get denied by Claude Code's auto-mode safety classifier (see the `process-kill-confirmation-
pattern` memory); a narrow, explicitly-confirmed single PID goes through fine.

## Cleanup

Stop the isolated backend/frontend processes (confirm specific PIDs with the user first —
see above) and leave the throwaway `MYLIBRARY_DATA_DIR` directory for the OS temp-cleanup to
reclaim, or delete it directly since it's not part of the repo.
