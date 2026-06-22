# MyLibrary — analysis engine

A personal, AI-powered book-analysis engine built on a Goodreads export. The pipeline
ingests your library, enriches it with real catalog metadata, infers an evidence-backed
**taste profile**, and recommends what to read next with a **two-stage recommender**
(retrieve real catalog candidates → Claude reranks/explains). No web UI yet — NL
discovery, the feedback loop, and evals come in later phases.

> Working name: *MyLibrary* (the project was "BetterReads", but that name is taken).

## Architecture

Python engine, built as a **FastAPI service** so the eventual TypeScript/Next.js
frontend can call it over HTTP (key stays server-side). The same core functions run as
an offline CLI for batch work.

```
Goodreads CSV ──▶ ingest ──▶ books ──▶ enrich ──▶ enrichment (+ confidence)
                                                        │
                                                        ▼
                                                   taste profile  ◀── Claude (tool use)
                                                        │
                                                        ▼
                  Open Library / Google Books ──▶ recommend ──▶ recommendations
                  (retrieve real candidates)          ▲
                                                       └── Claude reranks + explains
```

SQLite is the store and the future cross-language seam: this Python side owns the
schema; the frontend reads it (or calls the API).

## Pipeline stages

1. **Ingest** (`ingest.py`) — Goodreads CSV → `books`, idempotent on `Book Id`. Handles
   the Excel-escaped `="..."` ISBNs, treats `My Rating == 0` as *unrated*, and never
   overwrites in-app `app_rating` on re-import.
2. **Enrich** (`enrich.py`) — resolve each rated book via Open Library (ISBN, then
   title+author) with a Google Books fallback. Emits a `resolution_confidence`
   (HIGH/MEDIUM/LOW); ambiguous common-title matches are deliberately scored LOW so a
   later feedback phase can surface them. Raw responses are cached to `data/cache/`, so
   re-runs hit disk, not the network.
3. **Taste profile** (`profile.py`) — groups rated books by star tier and asks Claude
   (via tool use / structured output) what *distinguishes* the tiers — what separates
   5★ from 4★, and what the rare low-rated books share. Every trait cites the book ids
   that support it. Needs `ANTHROPIC_API_KEY`.
4. **Recommend** (`recommend.py`) — two-stage, and the LLM is *not* the recommender.
   **Stage 1 (retrieval)** is hybrid: deterministic metadata expansion (more books in
   your loved subjects/authors) plus Claude-seeded *search queries* — every query is run
   against the live catalog, so only real books survive. Both pools are merged, deduped,
   and filtered against your library. **Stage 2 (rerank)** has Claude score the real
   candidates against your taste profile and explain each pick, citing the trait ids and
   library book ids it leaned on. The served set is persisted (one `run_id` per call) for
   the future feedback loop. Needs `ANTHROPIC_API_KEY`.

## Setup

```bash
cd mylibrary
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env        # then add your ANTHROPIC_API_KEY
```

Export your library from Goodreads (My Books → Import and export → Export Library) and
save it as `data/goodreads_library_export.csv`.

## Run it (CLI)

```bash
python -m mylibrary.cli ingest                 # uses data/goodreads_library_export.csv
python -m mylibrary.cli enrich                 # add --limit 10 to test cheaply first
python -m mylibrary.cli profile                # needs ANTHROPIC_API_KEY
python -m mylibrary.cli recommend --n 10       # two-stage recs; needs ANTHROPIC_API_KEY
python -m mylibrary.cli recs                   # reprint the latest recommend run
python -m mylibrary.cli stats                  # rating dist, enrichment coverage, etc.
```

## Run it (API)

```bash
python -m mylibrary.cli serve                  # or: uvicorn mylibrary.api:app --reload
```

Then open http://127.0.0.1:8000/docs for interactive endpoints:
`GET /health`, `GET /stats`, `POST /ingest`, `POST /enrich`, `POST /profile`,
`GET /books`, `GET /profile`, `POST /recommend`, `GET /recommendations`.

## Tests

```bash
pytest          # ingest idempotency + CSV quirks + enrichment matching (no network)
```

## What's intentionally NOT here yet

NL discovery ("something cozy like X"), the feedback surface that turns rejected recs
into labeled negatives and lets you refine the taste profile iteratively, the web UI, and
the eval harness. Those are the next phases.
