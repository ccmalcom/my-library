# CLAUDE.md — MyLibrary

Project context for AI assistants. Read this file first, then load sub-docs as needed.

## What this is

MyLibrary is a personal, AI-powered book-analysis engine built on a Goodreads CSV export.
Pipeline: `ingest -> enrich -> taste profile -> recommend`. Exposed as a FastAPI service + Next.js frontend.

Working name is "MyLibrary" (the original "BetterReads" is taken).

**Current state:** Phase 6 live — Vercel frontend → Railway web → Supabase Postgres/auth.
Invite-only / free launch. Admin console (invite/revoke users) shipped. Frontend redesign + mobile optimization deployed.
Next priority (see `todo.md`): cost guardrails + `/catalog/search` rate limiting (spend visibility + abuse control).

## Sub-documents (load when relevant)

- **`docs/architecture.md`** — stack, pipeline modules (`ingest`, `catalog`, `enrich`, `profile`, `library`, `purge`, `archetype`, `recommend`, `stats`, `worker`)
- **`docs/hosting.md`** — Supabase auth, multi-tenancy, per-user API keys, background jobs, env vars, Alembic migrations, Railway/Vercel deploy
- **`docs/frontend.md`** — Next.js routes, components, design system, auth boundaries, mobile/tablet, SWR patterns
- **`docs/conventions.md`** — gotchas: TSX parser quirks, git rules, Python/CLI, data invariants, recommender, profile, SWR cache

## Locked decisions (do not relitigate)

1. **Goodreads API is dead.** CSV export is the only ingest path. Never scrape Goodreads or call its API.
2. **Goodreads is import-once.** The CSV is a cold-start seed; MyLibrary owns ratings and feedback going forward. Import must never clobber in-app `app_rating` or `app_review`.
3. **The recommender is two-stage** (retrieval of real catalog candidates, then Claude reranks/explains). The LLM is NOT the recommender. Stage-1 is hybrid (deterministic metadata expansion + Claude-seeded search queries, all resolved against the live catalog so no invented titles survive).
4. **Taste profile is metadata-driven** — cold-start signal comes from ratings + enriched metadata grouped by tier. In-app `app_review` values ARE fed in as direct signal and weighted above metadata inference once written.
5. **Enrichment is the foundation.** Every book gets a `resolution_confidence` (HIGH/MEDIUM/LOW); ambiguous matches are scored LOW on purpose so a later feedback step surfaces them.
6. **Evals are the differentiator** (later phase).

## Commands

```bash
pip install -r requirements.txt
python -m mylibrary.cli ingest          # data/goodreads_library_export.csv
python -m mylibrary.cli enrich          # --rps N, --limit N, --force, --retry-unresolved
python -m mylibrary.cli profile         # full taste profile build; needs ANTHROPIC_API_KEY
python -m mylibrary.cli traits          # print the saved taste profile + evidence
python -m mylibrary.cli add "Title"     # manually add a book (--author, --rating, --review, --shelf)
python -m mylibrary.cli rate ID 1-5     # re-rate a book in-app (0 clears the override)
python -m mylibrary.cli review ID "..." # write/clear (--clear) an in-app review
python -m mylibrary.cli remove-book ID  # permanently delete a single book
python -m mylibrary.cli backfill-descriptions  # repair rec-accepted books missing a description (--all-users for deployed DB)
python -m mylibrary.cli clear-profile   # drop traits + recs; keep books (-y to skip confirm)
python -m mylibrary.cli clear-library   # drop books + enrichments + profile (clean reset)
python -m mylibrary.cli delete-account  # drop ALL data incl. stored API key
python -m mylibrary.cli profile-status  # is the profile stale vs. recent edits?
python -m mylibrary.cli reprofile       # incremental re-profile (--full to rebuild)
python -m mylibrary.cli recommend       # --n N; two-stage recs, needs ANTHROPIC_API_KEY
python -m mylibrary.cli recs            # reprint the latest recommend run
python -m mylibrary.cli stats
python -m mylibrary.cli serve           # FastAPI at http://127.0.0.1:8000/docs
python -m pytest                        # ingest + matching + catalog + recommender + feedback + admin
cd frontend && npm install && npm run dev  # Next.js dev server at http://localhost:3000
```

## Recommender behavior

`recommend()` now returns a `cold_start: bool` key (True on thin libraries < 8 loved / < 12 rated books).
Language filtering, same-author caps, and cold-start gating are behavior-shaping additions that refine Stage 1 retrieval without changing the two-stage locked decision — the LLM is still not the recommender.
