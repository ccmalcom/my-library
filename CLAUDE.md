# CLAUDE.md — MyLibrary

Project context for AI assistants working in this repo. Read this first.

## What this is

MyLibrary is a personal, AI-powered book-analysis engine built on a Goodreads CSV
export. Portfolio project demonstrating a grounded, evaluated AI application:
retrieval-augmented recommendation, structured taste modeling, human-in-the-loop
labeling, and evaluation of a problem with no clean ground truth.

Working name is "MyLibrary" (the original "BetterReads" is taken).

Current state is the **offline pipeline + recommender**: `ingest -> enrich -> taste
profile -> recommend`. MVP1 (ingest/enrich/profile) is done, and Phase 5 — the two-stage
recommender (`recommend.py`) — has landed. No web UI yet. NL discovery, the feedback
surface, and the eval harness are the remaining phases.

## Locked decisions (do not relitigate)

1. **Goodreads API is dead.** CSV export is the only ingest path. Never scrape Goodreads
   or call its API.
2. **Goodreads is import-once.** The CSV is a cold-start seed; MyLibrary owns ratings and
   feedback going forward. Import must never clobber in-app `app_rating`.
3. **The recommender is two-stage** (retrieval of real catalog candidates, then Claude
   reranks/explains). The LLM is NOT the recommender. Landed in `recommend.py`: stage-1
   retrieval is hybrid (deterministic metadata expansion + Claude-seeded _search queries_,
   all resolved against the live catalog so no invented titles survive); stage 2 is the
   Claude rerank/explain, grounded in trait ids + book ids. Keep it this way.
4. **Taste profile is metadata-driven, not review-text-driven** — the library has ~no
   written reviews, so signal comes from ratings + enriched metadata grouped by tier.
5. **Enrichment is the foundation.** Every book gets a `resolution_confidence`
   (HIGH/MEDIUM/LOW); ambiguous matches are scored LOW on purpose so a later feedback
   step surfaces them.
6. **Evals are the differentiator** (later phase).

## Stack & architecture

- Python engine, exposed as a **FastAPI service** (`mylibrary/api.py`) with a matching
  **Typer CLI** (`mylibrary/cli.py`). Same core functions back both.
- The intended frontend is a separate **TypeScript / Next.js** app that calls this engine
  over HTTP (Pattern B). The Python side owns the SQLite schema; the frontend reads it /
  calls the API. Keep that seam clean — don't have two languages run migrations.
- SQLite via SQLAlchemy 2.0 (`mylibrary/db.py`). DB and API cache live under `data/`
  (gitignored).

### Pipeline modules

- `ingest.py` — Goodreads CSV -> `books`, idempotent on `Book Id`. Handles Excel-escaped
  `="..."` ISBNs, `My Rating == 0` = unrated, `Exclusive Shelf`.
- `catalog.py` — Open Library + Google Books clients. Disk-caches every raw response,
  throttles (configurable rate), retries with backoff, tracks per-host 429s.
- `enrich.py` — resolves each rated book, scores confidence, commits per book (resumable).
- `profile.py` — groups rated books by star tier, uses Claude tool-use to infer
  tier-distinguishing, evidence-cited taste traits.
- `recommend.py` — two-stage recommender. Stage 1 retrieval = metadata expansion
  (`catalog.openlibrary_subject` / `googlebooks_subject` / `googlebooks_author`) +
  Claude-seeded queries (`catalog.googlebooks_query`), merged + deduped against the
  library. Stage 2 = Claude rerank/explain. Persists each run to `recommendations`
  (grouped by `run_id`). Anthropic key is checked at point of use, so the key only
  matters when a Claude stage actually runs.
- `stats.py` — read-only dataset stats.

## Conventions / gotchas

- **Run via `python -m`** (`python -m mylibrary.cli ...`, `python -m pytest`). The console
  scripts (pytest.exe, uvicorn.exe) may not be on PATH.
- **Windows PowerShell**: no `&&`. Chain with `;` + `if ($?) { ... }`, or run commands
  separately. Use a venv (`.venv`) and install deps into it.
- **Enrichment commits per book** so Ctrl+C is safe and re-runs resume (already-enriched
  books are skipped; unresolved/LOW are committed and won't auto-retry without `--force`).
- **Request rate** is tunable via `--rps` or `MYLIBRARY_REQ_PER_SEC` (default 8/s). The
  enrich summary's `http` block reports 429s per host — lower the rate if they appear.
- **Failed resolutions are committed as unresolved rows** (so they don't auto-retry).
  Re-attempt just those with `enrich --retry-unresolved` instead of `--force` (which
  redoes the whole library). Open Library is flaky; transient timeouts are common.
- **Secrets** live in `.env` (gitignored): `ANTHROPIC_API_KEY` required for `profile` and
  `recommend`; `GOOGLE_BOOKS_API_KEY` optional.
- **`recommend` never re-recommends a library book** (dedup is by normalized title +
  author surname, reusing `enrich._normalize_title` / `_surname`). The `recommendations`
  table is disposable until the feedback phase — `init_db` drops+recreates it if its shape
  is stale, same as `taste_traits`.
- Currently developed on **Python 3.14** — first suspect for any odd runtime behavior.

## Commands

```bash
pip install -r requirements.txt
python -m mylibrary.cli ingest          # data/goodreads_library_export.csv
python -m mylibrary.cli enrich          # --rps N, --limit N, --force, --retry-unresolved
python -m mylibrary.cli profile         # needs ANTHROPIC_API_KEY
python -m mylibrary.cli traits          # print the saved taste profile + evidence
python -m mylibrary.cli recommend       # --n N; two-stage recs, needs ANTHROPIC_API_KEY
python -m mylibrary.cli recs            # reprint the latest recommend run
python -m mylibrary.cli stats
python -m mylibrary.cli serve           # FastAPI at http://127.0.0.1:8000/docs
python -m pytest                        # ingest + matching + catalog + recommender
```

## Working agreements

- After changing pipeline code, run `python -m pytest` before calling it done.

- Prefer extending the core functions (so both CLI and API benefit) over CLI-only logic.
