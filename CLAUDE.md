# CLAUDE.md — MyLibrary

Project context for AI assistants working in this repo. Read this first.

## What this is

MyLibrary is a personal, AI-powered book-analysis engine built on a Goodreads CSV
export. Portfolio project demonstrating a grounded, evaluated AI application:
retrieval-augmented recommendation, structured taste modeling, human-in-the-loop
labeling, and evaluation of a problem with no clean ground truth.

Working name is "MyLibrary" (the original "BetterReads" is taken).

Current state is the **offline pipeline + recommender + a web UI**: `ingest -> enrich ->
taste profile -> recommend`. MVP1 (ingest/enrich/profile) is done, Phase 5 — the two-stage
recommender (`recommend.py`) — has landed, and a **Next.js frontend** (`frontend/`) now
calls the API. In-app **re-rating + reviewing** and an **incremental re-profile** have
landed (`library.py`, `profile.update_taste_profile`). NL discovery, the full feedback/
labeling surface, and the eval harness are the remaining phases.

## Locked decisions (do not relitigate)

1. **Goodreads API is dead.** CSV export is the only ingest path. Never scrape Goodreads
   or call its API.
2. **Goodreads is import-once.** The CSV is a cold-start seed; MyLibrary owns ratings and
   feedback going forward. Import must never clobber in-app `app_rating` or `app_review`.
3. **The recommender is two-stage** (retrieval of real catalog candidates, then Claude
   reranks/explains). The LLM is NOT the recommender. Landed in `recommend.py`: stage-1
   retrieval is hybrid (deterministic metadata expansion + Claude-seeded _search queries_,
   all resolved against the live catalog so no invented titles survive); stage 2 is the
   Claude rerank/explain, grounded in trait ids + book ids. Keep it this way.
4. **Taste profile is metadata-driven** — the imported library has ~no written reviews, so
   the cold-start signal comes from ratings + enriched metadata grouped by tier. Once the
   user writes in-app reviews (`app_review`), those ARE fed in as direct signal and weighted
   above metadata inference; the metadata-first default just covers the common no-review case.
5. **Enrichment is the foundation.** Every book gets a `resolution_confidence`
   (HIGH/MEDIUM/LOW); ambiguous matches are scored LOW on purpose so a later feedback
   step surfaces them.
6. **Evals are the differentiator** (later phase).

## Stack & architecture

- Python engine, exposed as a **FastAPI service** (`mylibrary/api.py`) with a matching
  **Typer CLI** (`mylibrary/cli.py`). Same core functions back both.
- The frontend is a separate **TypeScript / Next.js** app in `frontend/` that calls this
  engine over HTTP (Pattern B). The Python side owns the SQLite schema; the frontend only
  reads it / calls the API. Keep that seam clean — don't have two languages run migrations.
- SQLite via SQLAlchemy 2.0 (`mylibrary/db.py`). DB and API cache live under `data/`
  (gitignored).

### Pipeline modules

- `ingest.py` — Goodreads CSV -> `books`, idempotent on `Book Id`. Handles Excel-escaped
  `="..."` ISBNs, `My Rating == 0` = unrated, `Exclusive Shelf`.
- `catalog.py` — Open Library + Google Books clients. Disk-caches every raw response,
  throttles (configurable rate), retries with backoff, tracks per-host 429s.
- `enrich.py` — resolves each rated book, scores confidence, commits per book (resumable).
- `profile.py` — groups rated books by star tier, uses Claude tool-use to infer
  tier-distinguishing, evidence-cited taste traits. `extract_taste_profile` is the full
  cold-start build; `update_taste_profile` is the **incremental re-profile** — it ships
  Claude only the books changed since the last profile + the books the current traits cite
  (not the whole library) and asks it to revise the trait set, so the payload scales with
  the edit. Both stamp `ProfileMeta.last_profiled_at`. `books_changed_since` /
  `get_profile_meta` / `mark_profiled` back the dirty-state tracking.
- `library.py` — in-app library edits. `set_book_feedback` sets `app_rating` / `app_review`
  and bumps `feedback_updated_at`; `profile_status` reports whether the profile is stale
  (dirty) vs. those edits. Never auto-re-profiles — that's an explicit user action.
- `recommend.py` — two-stage recommender. Stage 1 retrieval = metadata expansion
  (`catalog.openlibrary_subject` / `googlebooks_subject` / `googlebooks_author`) +
  Claude-seeded queries (`catalog.googlebooks_query`), merged + deduped against the
  library. Stage 2 = Claude rerank/explain. Persists each run to `recommendations`
  (grouped by `run_id`). Anthropic key is checked at point of use, so the key only
  matters when a Claude stage actually runs. **Cost profile:** seed queries use
  `claude-haiku-4-5-20251001` (low-stakes text generation); rerank uses `settings.model`
  (Sonnet). Both calls share a cacheable prefix (traits + top 20 loved books, marked
  `ephemeral` with extended-TTL beta) so repeated runs within ~1 hour get a cache hit
  on the large data payload. `_LOVED_SAMPLE = 20` (top by rating/recency).
- `stats.py` — read-only dataset stats. Returns fields named `total`, `rated`,
  `unrated`, `mean_rating`, `by_star`, `shelves` — matching the TypeScript `Stats`
  interface. Do not rename these back to the old `books_total` / `rating_distribution`
  style; the frontend depends on the current names.

### Frontend (`frontend/`)

Next.js (App Router) + React + Tailwind + SWR (data fetching) + framer-motion (swipe).
It is a pure HTTP client of the FastAPI engine — no DB access, no migrations.

- `lib/api.ts` — the single typed fetch client. All calls go through it; `BASE` is
  `NEXT_PUBLIC_API_URL` (default `http://127.0.0.1:8000`). Types here mirror the Pydantic
  schemas. `PROFILE_STATUS_KEY` is the shared SWR key for `/profile/status` so a mutation
  anywhere can revalidate the re-profile banner.
- `app/` — routes: `/` (dashboard + run recommend), `/swipe` (rec swiping; `already_read`
  lands the book on the read shelf then prompts a review), `/to-read` (per-book: start
  reading / mark finished → review / remove), `/library` (rated books; click a row to
  re-rate/review; a "N books missing reviews" button steps through unrated read books),
  `/profile` (taste traits with inline editing, rating distribution, genre breakdown).
  `layout.tsx` mounts `NavBar` + `ReprofileBanner` above all pages.
- `components/` — `BookEditModal` (re-rate + review; diff-based save; optional
  `queuePosition`/`onFinishQueue` for the step-through review queue), `ReprofileBanner`
  (app-wide; shows only when `/profile/status` reports `dirty`, runs `/profile/update`),
  `SwipeCard`, `NavBar`.

Re-profiling is **never automatic** in the UI: editing a book marks the profile dirty
(`feedback_updated_at` > `last_profiled_at`), the banner appears, and the user chooses
when to spend the Claude call.

## Conventions / gotchas

- **Never run git state-mutating commands** (`git stash`, `git checkout`, `git reset`,
  `git commit`, etc.) as part of inspecting or verifying code — the user owns git. The
  sandbox mount is flaky and can interrupt these mid-operation, leaving a stale
  `.git/index.lock` that **blocks the user's own commits**, and the sandbox can't delete it
  (`rm` fails with "Operation not permitted"), so the user has to clean it up by hand. To
  read history use read-only commands only (`git log`, `git diff`, `git show`). To check
  whether an edit is valid, read the file back with the file tools rather than stashing.
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
- **Swipe decisions land books in the library** (`PATCH /recommendations/{id}/feedback`,
  shared `_ensure_library_book` helper): `accepted` → to-read shelf, `already_read` → read
  shelf (so neither is recommended again), `rejected` → no book but excluded from dedup.
  `already_read` returns the created/matched book so the UI can prompt a review; the create
  is idempotent on the same title+author.
- **`books` is never dropped.** It holds the only irreplaceable data (ratings, reviews).
  New columns are added in place via `ALTER TABLE ... ADD COLUMN` in `init_db` (that's how
  `app_review` / `feedback_updated_at` were added). Only the disposable tables
  (`taste_traits`, `recommendations`) get dropped+recreated.
- **Profile dirty-state**: `set_book_feedback` bumps `Book.feedback_updated_at`; the
  profile is "dirty" when any rated book changed after `ProfileMeta.last_profiled_at`.
  `profile_status()` / `GET /profile/status` expose this; the frontend banner keys off it.
- **Incremental vs. full re-profile**: prefer `update_taste_profile` (`reprofile` /
  `POST /profile/update`) after edits — it's cheap. `extract_taste_profile` (`profile` /
  `reprofile --full` / `POST /profile`) is the full rebuild. Update falls back to a full
  build when there's no prior profile.
- **Trait editing** (`PATCH /profile/traits/{id}`): updates `claim` text and sets
  `status = "edited"` so human-edited traits are distinguishable from Claude-proposed ones.
  The My Profile page exposes this inline; the `user_note` field is also patchable for
  freeform annotation without changing the claim.
- **`/profile/subjects`** (`GET`): aggregates enrichment subjects for all rated books,
  grouped by star tier. Used by the My Profile genre breakdown. Subject counts normalise
  capitalisation and cap per-book contribution at 8 subjects to avoid one over-tagged
  book dominating the chart.
- **First-run redirect / SWR cache**: the dashboard (`app/(main)/page.tsx`) redirects to
  `/setup` when `stats.total === 0`, and it gates render behind a spinner until `stats` is
  known so the dashboard never flashes before the redirect. The setup wizard (ingest +
  enrich) is a required two-step flow — there's **no "skip enrichment"** option. Gotcha:
  after the wizard runs, refresh the shared `"stats"` SWR key by passing fresh data —
  `await mutate("stats", api.stats(), { revalidate: false })` — **not** a bare
  `mutate("stats")`. A bare call only *revalidates*, and SWR won't refetch a key that no
  mounted component subscribes to (the dashboard is unmounted while on `/setup`), so the
  cache keeps the stale `total: 0` and bounces the user back to `/setup` in a loop. Same
  pattern applies any time a non-subscribed page needs to update another page's SWR key.
- Currently developed on **Python 3.14** — first suspect for any odd runtime behavior.

## Commands

```bash
pip install -r requirements.txt
python -m mylibrary.cli ingest          # data/goodreads_library_export.csv
python -m mylibrary.cli enrich          # --rps N, --limit N, --force, --retry-unresolved
python -m mylibrary.cli profile         # full taste profile build; needs ANTHROPIC_API_KEY
python -m mylibrary.cli traits          # print the saved taste profile + evidence
python -m mylibrary.cli rate ID 1-5     # re-rate a book in-app (0 clears the override)
python -m mylibrary.cli review ID "..."  # write/clear (--clear) an in-app review
python -m mylibrary.cli profile-status  # is the profile stale vs. recent edits?
python -m mylibrary.cli reprofile       # incremental re-profile (--full to rebuild)
python -m mylibrary.cli recommend       # --n N; two-stage recs, needs ANTHROPIC_API_KEY
python -m mylibrary.cli recs            # reprint the latest recommend run
python -m mylibrary.cli stats
python -m mylibrary.cli serve           # FastAPI at http://127.0.0.1:8000/docs
python -m pytest                        # ingest + matching + catalog + recommender + fee