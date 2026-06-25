# MyLibrary — Postgres Cutover Runbook

Stand up the multi-tenant schema in Supabase Postgres and run the app against it. **No data
migration**: the local SQLite library (`user_id="local"`) is intentionally left behind — the
plan is to test the full `upload → enrich → profile → recommend` flow fresh on the web under a
real Supabase account. The fresh Postgres DB starts empty by design.

Everything runs from the repo root on Windows (PowerShell), inside the project venv.

---

## 0. Prereqs

- Supabase project exists (you already have `DB_PASSWORD` in `.env`).
- Deps installed in the venv: `pip install -r requirements.txt` (pulls `psycopg[binary]` +
  `alembic`).

## 1. Get the right connection string

Supabase Dashboard → **Connect** (top bar) → **ORMs / psql**. Three options are shown — the
choice matters:

| Option | Host / port | Use it? |
|---|---|---|
| **Direct** | `db.<ref>.supabase.co:5432` | ❌ IPv6-only unless you bought the IPv4 add-on; fails from most home/office networks. |
| **Session pooler** | `aws-0-<region>.pooler.supabase.com:5432`, user `postgres.<ref>` | ✅ **Use this.** IPv4, persistent connections, supports DDL + prepared statements — correct for both Alembic and the long-lived SQLAlchemy pool. |
| **Transaction pooler** | `...pooler.supabase.com:6543` | ❌ pgbouncer in transaction mode; breaks prepared statements / DDL under psycopg3. Only for short serverless calls. |

So: copy the **Session pooler** string (port **5432**).

## 2. Set `DATABASE_URL` in `.env`

Uncomment line 17 and set it to the session-pooler string. The driver **must** be
`postgresql+psycopg` (psycopg v3 — psycopg2 is not installed). `config.db_url` now auto-pins a
bare `postgresql://` / `postgres://` to `+psycopg`, but write it explicitly anyway:

```
DATABASE_URL=postgresql+psycopg://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Footguns:
- **URL-encode the password** if it contains `@ : / # ? %` etc. (e.g. `@` → `%40`). An unencoded
  special char silently corrupts host/auth parsing.
- SSL is required; psycopg negotiates it automatically. If you hit an SSL error, append
  `?sslmode=require`.
- Setting `DATABASE_URL` flips **all** local CLI/server runs to Postgres. The test suite is
  unaffected (`conftest` force-unsets it), but comment it back out when you want plain local
  SQLite dev.

## 3. Build the schema

```powershell
cd C:\Users\chase\Documents\Code\coding-projects\mylibrary
.venv\Scripts\Activate.ps1
python -m alembic upgrade head
```

Expected tail: `Running upgrade -> 0001_initial, initial multi-tenant schema`.

This creates `books`, `enrichment`, `taste_traits`, `recommendations`, `profile_meta`,
`user_settings`, plus `alembic_version`. `init_db()` no-ops in multi-tenant mode, so Alembic is
the sole schema authority from here on.

## 4. Verify

```powershell
python -m alembic current
```

Expect `0001_initial (head)`. Then smoke-test the connection (auth still off, so no token
needed — every request is `user_id="local"`):

```powershell
python -m mylibrary.cli serve
# in a browser or another shell:
#   GET http://127.0.0.1:8000/health  -> {"status":"ok","books":0, ...}
```

`books: 0` is correct — fresh DB, no data migrated. The query succeeding proves the app reached
Postgres and the schema is present. (The `db` field still echoes the local SQLite filename —
cosmetic only; ignore it in hosted mode.)

The DB cutover is **done** at this point.

---

## 5. Flip on auth + test the real flow on the web (next step, not strictly the cutover)

To actually exercise upload → enrich → profile under your real account:

1. Set the rest of the hosted env in `.env`:
   - `SUPABASE_URL=https://<ref>.supabase.co` — turns on JWT verification. Now every data route
     (incl. `/health`) requires a Bearer token, and you're scoped to your Supabase user UUID.
   - `ENCRYPTION_KEY=<base64 32 bytes>` — needed once you save your Anthropic key via the
     `/settings` UI (it's encrypted at rest). Generate:
     `python -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"`
   - Frontend: `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
2. Create/invite your user in Supabase (Authentication → Users) — launch is invite-only.
3. Sign in through the frontend, enter your Anthropic key in `/settings`, then run the setup
   wizard (CSV upload or manual add) → enrich → profile → recommend.

Heads-up (expected, not a bug): logged in as your Supabase UUID, your old `local` library is
invisible — it lives under a different tenant. That's multi-tenancy working. You chose not to
migrate it, so you're building a fresh library on the web.

Note: enrichment on a large CSV can exceed cloud HTTP timeouts — that's what **Phase 4
(background jobs)** addresses. For local-against-Postgres testing it runs fine synchronously.

## Rollback

The DB is empty, so this is low-risk. To rebuild: `python -m alembic downgrade base` then
`python -m alembic upgrade head`, or drop the tables in the Supabase SQL editor. To return to
local SQLite, just comment out `DATABASE_URL`.
