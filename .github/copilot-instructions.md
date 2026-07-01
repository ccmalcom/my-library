# MyLibrary — Copilot Agent Instructions

Trust these instructions. Only search when the information here is incomplete or appears incorrect.

## What this repo is

Personal AI-powered book-analysis engine built on a Goodreads CSV export. Pipeline: ingest → enrich → taste profile → recommend. Exposed as a FastAPI service + Next.js frontend. Deployed: Vercel frontend → Railway (uvicorn) → Supabase Postgres/auth. Local dev uses SQLite with no auth.

## Stack

| Layer | Tech |
|---|---|
| Backend | Python 3.14, FastAPI 0.138, SQLAlchemy 2.0, Pydantic 2, Typer CLI |
| DB | SQLite (local dev) / Postgres via psycopg v3 (hosted — `postgresql+psycopg://`) |
| AI | Anthropic SDK (`claude-sonnet-5` default; haiku for cheap tasks) |
| Frontend | Next.js 16, React 18, TypeScript 5, Tailwind CSS 3, SWR 2, Supabase SSR |
| Migrations | `init_db()` self-migrate (SQLite local); Alembic (Postgres hosted, `alembic/versions/`) |

## Build and validate

### Python backend

```bash
# Bootstrap (one-time)
python -m venv .venv && .venv\Scripts\activate   # Windows
pip install -r requirements.txt

# Run tests — always use the venv python, not bare python/pytest
.venv\Scripts\python -m pytest          # 201 tests, ~27s, all green
# pytest.ini: testpaths=tests, addopts=-q

# Run the API
.venv\Scripts\python -m mylibrary.cli serve     # FastAPI at http://127.0.0.1:8000/docs
```

**Never** use bare `pytest` or `python` — console scripts may not be on PATH. Always `.venv\Scripts\python -m ...` on Windows.

### Frontend

```bash
cd frontend
npm install          # always before build/type-check
npm run type-check   # tsc --noEmit — run this to validate TS changes
npm run build        # next build
npm run dev          # dev server at http://localhost:3000
```

### No CI/CD workflows exist. Validation = Python tests + TypeScript type-check.

## Project layout

```
mylibrary/          # Python package — the entire backend
  db.py             # SQLAlchemy models + init_db() + session_scope()
  config.py         # Settings dataclass, env vars, LOCAL_USER_ID = "local"
  api.py            # FastAPI app, all HTTP routes
  cli.py            # Typer CLI (same core functions as API)
  ingest.py         # Goodreads CSV → books table
  enrich.py         # Open Library + Google Books resolution
  catalog.py        # catalog search clients (search_books, googlebooks_*, openlibrary_*)
  profile.py        # taste profile extraction via Claude tool-use
  recommend.py      # two-stage recommender; tunable constants at top of file
  library.py        # in-app edits: set_book_feedback, add_book, remove_book
  purge.py          # bulk data removal: clear_profile / clear_library / delete_account
  archetype.py      # 4-axis reader archetype via Claude Haiku
  worker.py         # arq background job engine for enrichment
  feedback.py       # beta feedback collection endpoints
  feedback_vocab.py # REJECT_REASONS slug vocabulary (single source of truth)
  auth.py           # Supabase JWT verification → user_id
  user_settings.py  # per-user Anthropic key (AES-256-GCM encrypted)
  stats.py          # read-only dataset stats (field names are a frontend contract)
alembic/versions/   # Postgres migrations (numbered 0001–fbc5…)
frontend/
  app/              # Next.js App Router pages
  components/       # React components (UI in components/ui/)
  lib/api.ts        # typed fetch client — all backend calls go through here
  lib/bookLinks.ts  # Goodreads / StoryGraph link helpers
  utils/supabase/   # Supabase client + middleware
data/               # gitignored runtime data (DB, cache, CSV)
tests/              # pytest suite — conftest.py isolates each test to a tmp SQLite DB
docs/               # architecture.md, conventions.md, hosting.md, frontend.md
```

## Critical rules — read before writing any code

### Python / SQLAlchemy

- **Session context manager**: always `with session_scope() as session:`. Never `with get_session() as session:` — `get_session()` returns a bare `Session` with no `__exit__` and will fail.
- **Eager loading**: use `selectinload()` when accessing relationships in a loop. Lazy loading inside a loop causes an N+1 query per row.
- **New ORM columns require a migration block in `init_db()`** for SQLite local mode. After adding a column to a model, add an `ALTER TABLE … ADD COLUMN` block inside the `if "<table>" in insp.get_table_names():` pattern in `db.py`. And add a corresponding Alembic migration in `alembic/versions/` for Postgres.
- **`max(1, int(x))`** — always floor-guard integer-truncated share calculations to prevent zero-dropping candidates.
- Every core function takes `user_id: str = LOCAL_USER_ID` as a trailing parameter. Never omit it when adding new functions.
- All user-owned tables have a `user_id` column. **When you add a new user-scoped table, wire it into `purge.delete_account()`** or you silently break the invariant that delete_account removes all user data.

### Data invariants

- **`books` is never dropped** — it holds the only irreplaceable data. Add columns via `ALTER TABLE ADD COLUMN` only; never `DROP TABLE books` or recreate it.
- **Review requires a rating** — `set_book_feedback` and `add_book` raise `ValueError` (→ 422) if a review is set without a rating.
- **`TasteSignal` rows are durable** — never deleted by `clear_library` or `clear_profile`; only by `delete_account`.
- **`stats.py` field names are a frontend contract**: `total`, `rated`, `unrated`, `mean_rating`, `by_star`, `shelves`. Never rename them.

### Recommender

- **The LLM is not the recommender.** Stage 1 is deterministic retrieval against the live catalog; only real books survive. Stage 2 is Claude rerank/explain. Never have Claude invent titles.
- Two normalizers serve different purposes — **never swap them**: `catalog._norm_full` (search, subtitle-preserving); `enrich._normalize_title` (enrichment, splits on `:`).
- Tunable constants (`_COLD_START_LOVED`, `_COLD_START_RATED`, `_MAX_PER_AUTHOR`, `_MAX_LIBRARY_AUTHOR_SHARE`) live only in `recommend.py`. Never duplicate them in tests or callers.
- In `_assemble()`, the raw candidate dict's `source` key becomes `catalog_source` and `resolved_id` becomes `catalog_id`. When adding new fields, add them to **both** the initial `by_key[key] = {…}` block and the dedup merge `else` branch or they are silently dropped.
- Language filter: `None`-language candidates always pass through. Never silently drop them.

### TypeScript / TSX

- **No non-ASCII characters inside JS string literals in `.tsx` files** — Turbopack rejects them. Em dashes, curly quotes, etc. are fine in JSX text nodes (between tags) but not inside `"…"` or `'…'` string values. Use ASCII equivalents or unicode escapes.
- **No IIFEs inside JSX** — Turbopack rejects `{(() => { … })()}`. Compute derived values as plain variables at the top of the component function.
- `Modal` in `components/ui/Modal.tsx` takes `labelId` + `onClose` + optional `className`. No `title` prop — render the heading as a child with `id={labelId}`.
- SWR cache invalidation after mutations: use `mutate("stats", api.stats(), { revalidate: false })`, not bare `mutate("stats")` — a bare call won't refetch a key no mounted component subscribes to.

### Environment

- Local mode: no env vars needed; DB is `data/mylibrary.db`; user_id = `"local"`.
- Hosted mode: `DATABASE_URL` activates Postgres (auto-normalized to `postgresql+psycopg://`); `SUPABASE_URL` activates auth; `ENCRYPTION_KEY` required for per-user API key storage.
- Tests: `conftest.py` sets `MYLIBRARY_DATA_DIR` to a tmp dir and clears `DATABASE_URL`, `SUPABASE_URL`, `REDIS_URL`, etc. — tests always run against a fresh in-memory-equivalent SQLite DB and are fully hermetic.
