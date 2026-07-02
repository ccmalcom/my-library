# Architecture — MyLibrary

## Stack

- Python engine, exposed as a **FastAPI service** (`mylibrary/api.py`) with a matching
  **Typer CLI** (`mylibrary/cli.py`). Same core functions back both.
- The frontend is a separate **TypeScript / Next.js** app in `frontend/` that calls this
  engine over HTTP (Pattern B). The Python side owns the SQLite schema; the frontend only
  reads it / calls the API. Keep that seam clean — don't have two languages run migrations.
- SQLite via SQLAlchemy 2.0 (`mylibrary/db.py`). DB and API cache live under `data/`
  (gitignored).

## Pipeline modules

- `ingest.py` — Goodreads CSV -> `books`, idempotent on `Book Id`. Handles Excel-escaped
  `="..."` ISBNs, `My Rating == 0` = unrated, `Exclusive Shelf`.

- `catalog.py` — Open Library + Google Books clients. Disk-caches every raw response,
  throttles (configurable rate), retries with backoff, tracks per-host 429s. `search_books`
  (manual picker): fetches broad + title-targeted queries from both Google Books and Open Library,
  deduplicates via `_search_dedup_key` (full-title key preserves series volumes; ISBN-13 collapse
  merges cross-source dupes), ranks by `_match_score` (exact/startswith/token/substring/author bands),
  and groups series volumes contiguously via `_apply_series_grouping`. The dedup key uses `_norm_full`
  (subtitle-preserving) not `_dedup_key` (which truncates at `:`).
  **Language key coverage:** candidates from Google Books functions and OL catalog-search functions
  carry a normalized `language` key (via `_norm_lang`). OL-subject browse candidates
  (`openlibrary_subject`) do not — they enter assembly with `language=None` and always pass the
  language filter.
  **OL description gap:** OL Edition records (`/api/books?jscmd=data`, `/books/OL...M.json`)
  rarely carry descriptions; the description lives on the Work record (`/works/OL...W.json`).
  `openlibrary_by_isbn` now follows Edition→Work when the edition has no description (via
  `_ol_edition_work_key`); `openlibrary_work_description(work_key)` fetches a Work directly
  (used by `enrich._apply` and `recommend._fill_ol_descriptions`).

- `enrich.py` — resolves each rated book, scores confidence, commits per book (resumable).
  Progress callback uses the **full candidate count** as the denominator (already-enriched books
  count as "done" from the start), so the UI shows `10/50` not `10/44` on re-runs.
  `Enrichment.language` — nullable ISO-ish language code populated during `_apply`.

- `profile.py` — groups rated books by star tier, uses Claude tool-use to infer
  tier-distinguishing, evidence-cited taste traits. `extract_taste_profile` is the full
  cold-start build; `update_taste_profile` is the **incremental re-profile** — it ships
  Claude only the books changed since the last profile + the books the current traits cite
  (not the whole library) and asks it to revise the trait set, so the payload scales with
  the edit. Both stamp `ProfileMeta.last_profiled_at`. `books_changed_since` /
  `get_profile_meta` / `mark_profiled` back the dirty-state tracking.
  **Structured feedback (Task 2.1):** the profiler now reads user verdicts and steering
  signals. `_feedback_context(session, user_id)` is a new helper that collects, per user,
  confirmed/rejected `TasteTrait` claims, downweighted traits (`user_weight < 1.0`), and
  more/less-like book labels from `TasteSignal` (book-kind, joined to `Book`). Both
  `extract_taste_profile` and `update_taste_profile` inject this as a `## User Feedback`
  prompt section (via `_build_prompt` / `_build_update_prompt`) so a rebuild preserves
  confirmed traits, softens downweighted ones, and treats more/less-like books as
  positive/negative signal. After Claude returns, `_remove_rejected_claims` filters any
  trait that matches a user-rejected claim (case-insensitive substring or high token
  overlap) so a killed trait can't return as a paraphrase. `build_tiers` accepts an
  optional `less_like_books` param to surface those titles in aversion reasoning.
  **Spend tracking:** both Claude calls (`extract_taste_profile` → `profile_full`,
  `update_taste_profile` → `profile_update`) go through `usage.tracked_create` instead of
  calling `client.messages.create` directly, so every call records tokens + computed cost.

- `library.py` — in-app library edits. `set_book_feedback` sets `app_rating` / `app_review`
  and bumps `feedback_updated_at`; `profile_status` reports whether the profile is stale
  (dirty) vs. those edits. Never auto-re-profiles — that's an explicit user action.
  **Invariant: a review requires a rating.** Both `set_book_feedback` and `add_book` reject
  a review on an unrated book (`ValueError` → 422), so a reviewed book is always rated and
  `books_changed_since`'s `effective_rating is not None` filter never drops a reviewed book.
  A rating may be supplied in the same call as the review.
  `add_book` is the **manual add** write path: it creates a `source="manual"` book (dedup by
  normalized title + author surname → `BookExistsError`) with an optional shelf, 1-5 rating,
  and free-text review, and stores the picked catalog result's cover/subjects/isbn as a
  `confidence_label="MANUAL"` stub Enrichment (mirrors `api._ensure_library_book`), so covers
  render immediately and the recommender treats the book as already enriched. A rated _or_
  reviewed add bumps `feedback_updated_at`, dirtying the profile just like an in-app
  re-rate/review (a written review is an especially strong signal). No network call happens in
  `add_book` — the search already resolved the book — so adding is fast and offline.
  `remove_book` permanently deletes a single book (+ its enrichment, cascaded) — the granular
  end of the removal surface.

- `purge.py` — **bulk, user-scoped data removal** (the supported way to reset a user, e.g. to
  re-test onboarding without minting a new account). `clear_profile` drops traits + recs +
  profile_meta + `reader_archetypes` but keeps books; `clear_library` drops books + enrichments
  and **cascades** to clear the profile (→ a clean first-setup state, `stats.total == 0`, no
  orphaned taste data); `delete_account` drops everything incl. `user_settings` (the stored
  Anthropic key) — app-data only, it does **not** delete the Supabase auth user. Enrichments are
  deleted before books for FK safety; `recommendations` (no FK) are dropped by `user_id`. Backs
  `DELETE /library` / `/profile` / `/account` and the CLI `clear-library` / `clear-profile` /
  `delete-account`.

- `archetype.py` — **reader archetype system**. Scores the user's taste profile across 4 axes via
  Claude Haiku tool-use → produces a 4-letter code (e.g. `IPBH`) mapped to one of 16 named
  archetypes. Axes: `lens` (I=Immersive / R=Reflective), `engine` (P=Plot-first / C=Character-first),
  `range` (B=Broad / D=Deep), `resonance` (H=Heart / M=Mind). `ARCHETYPES` dict maps all 16 codes
  to `{name, tagline}`. `derive_archetype(*, user_id)` calls Haiku with the user's traits, upserts
  `ReaderArchetype` row (one per user), returns `ArchetypeResult`. `scores_to_code()` converts four
  floats to the letter code. The `_TOOL` schema requires all 8 fields (4 scores + 4 rationales) so
  Claude always populates them. Alembic migration: `0005_reader_archetypes` (idempotent, chains after
  `0004`). API endpoints: `POST /profile/archetype` (derive/re-derive), `GET /profile/archetype`
  (fetch stored; 404 if none). `_archetype_out()` in `api.py` maps the DB row to `ArchetypeOut` —
  it normalises empty-string rationales to `None` via `rationale or None` so the frontend's
  truthiness check is reliable. `is_stale` is `True` when `derived_at < last_profiled_at`.
  The Claude call goes through `usage.tracked_create` (`archetype` operation), recording tokens + cost.

- `recommend.py` — two-stage recommender. Stage 1 retrieval = metadata expansion
  (`catalog.openlibrary_subject` / `googlebooks_subject` / `googlebooks_author`) +
  Claude-seeded queries (`catalog.googlebooks_query`), merged + deduped against the
  library. Stage 2 = Claude rerank/explain. Persists each run to `recommendations`
  (grouped by `run_id`). Anthropic key is checked at point of use, so the key only
  matters when a Claude stage actually runs. **`_assemble` field rename:** the raw candidate
  dict's `source` key becomes `catalog_source` and `resolved_id` becomes `catalog_id` in the
  assembled pool — add new fields to both the initial `by_key[key] = {...}` block AND the
  dedup merge `else` branch, or they'll be silently dropped. `_fill_ol_descriptions` runs
  after `_assemble` to batch-fetch Work descriptions for OL candidates that didn't get one
  from the subjects endpoint (disk-cached, free on repeat runs). **Cost profile:** seed queries use
  `claude-haiku-4-5-20251001` (low-stakes text generation); rerank uses `settings.model`
  (Sonnet). Both calls share a cacheable prefix (traits + top 20 loved books, marked
  `ephemeral` with extended-TTL beta) so repeated runs within ~1 hour get a cache hit
  on the large data payload. `_LOVED_SAMPLE = 20` (top by rating/recency).
  **Default model is `claude-sonnet-5`** (`config.DEFAULT_MODEL`, overridable via
  `MYLIBRARY_MODEL`) — the haiku call sites (`archetype.py`'s trait scoring, and this
  module's seed-query generation above) are unchanged by that swap; it only affects
  taste-profile extraction/update (`profile.py`) and this module's Stage-2 rerank.
  **Structured feedback (Task 2.2):** `_build_signal` now carries user feedback into both
  stages. Each trait dict gains `user_weight` (float, default 1.0) and `status` (default
  `proposed`); traits with `status == "rejected"` are excluded from `signal["traits"]`
  entirely. New signal keys: `more_like` / `less_like` (book labels `"{title} by {author}"`
  from `TasteSignal`, book-kind only, via `_feedback_book_signals`) and
  `reject_reason_counts` (aggregated `reject_reasons` across the user's rejected
  `Recommendation` rows, via `_reject_reason_counts`). `_claude_rerank` appends a
  `## User Steering` section (built by `_user_steering_block`) to the cached profile
  prefix instructing Claude to favor more-like books, penalize less-like books + frequent
  reject reasons, and weight trait influence by `user_weight`. `_claude_seed_queries`
  biases stage-1 seed queries toward more_like / away from less_like qualities.
  **Language filter:** candidates outside the library's language set are dropped at assembly
  (`_language_ok` passes None-language candidates through). **Same-author cap:**
  `_apply_author_caps` limits any single author to `_MAX_PER_AUTHOR=2` picks and library-author
  share to `_MAX_LIBRARY_AUTHOR_SHARE=0.4`. **Cold-start gate:** `_is_cold_start` returns True
  when loved < 8 or rated < 12; in cold-start mode, `_metadata_pool` skips author expansion and
  `recommend()` returns `cold_start: true`.
  **Spend tracking:** both Claude calls (`_claude_seed_queries` → `recommend_seed`,
  `_claude_rerank` → `recommend_rerank`) go through `usage.tracked_create`, recording tokens + cost.

- **`TasteSignal` / `taste_signal` table** — durable, append-only steering signals that express
  "more like this" or "less like this" for a specific book or recommendation. Columns:
  `direction` (`more` | `less`), `target_kind` (`book` | `rec`), `target_book_id` (FK to user's
  `Book` row for book-kind signals), `snapshot` (JSON title/author/subjects snapshot for rec-kind
  signals, since the `Recommendation` row may be pruned later). **Never dropped by `clear_library`
  or `clear_profile`** — these are irreplaceable user preferences that survive full library resets.
  Alembic migration: `0010_taste_signal`.

- `feedback_vocab.py` — shared vocabulary for structured recommendation feedback. Defines
  `REJECT_REASONS` (the canonical tuple of rejection reason slugs: `wrong_genre`, `too_dark`,
  `tried_author`, `too_long`, `not_now`, `overhyped`, `wrong_vibe`) and `is_valid_reasons()`
  validator. Imported by the API and future feedback-processing modules; keeps the slug list
  in one place so new reasons only need adding here.

- `eval.py` — minimal offline eval baseline: recall/precision@k on held-out loved books
  + deterministic trait groundedness (optional Claude judge). CLI: `python -m mylibrary.cli eval`;
  snapshots to `data/eval/`.

- `stats.py` — read-only dataset stats. Returns fields named `total`, `rated`,
  `unrated`, `mean_rating`, `by_star`, `shelves` — matching the TypeScript `Stats`
  interface. Do not rename these back to the old `books_total` / `rating_distribution`
  style; the frontend depends on the current names.

- `usage.py` — per-user Anthropic spend tracking (soft-warn only). `tracked_create` wraps
  `client.messages.create`, recording token usage + computed cost (`cost_usd`, via
  `MODEL_PRICING`) to the `usage_events` table after every Claude call. `cap_status(user_id)`
  reports month-to-date spend + a soft-warn flag. Recording is best-effort — a failure here
  never breaks the calling profile/recommend/archetype call. See `docs/hosting.md` for the
  full breakdown.

- `worker.py` — Phase 4 background job engine. Contains `enrich_books` (arq async task),
  `run_enrich_job` (blocking core shared by arq and BackgroundTask fallback), `create_enrich_job`
  (creates an `EnrichJob` row, returns `job_id`), and `WorkerSettings` (arq entry point).
  Start with `python -m arq mylibrary.worker.WorkerSettings`. When `REDIS_URL` is unset the
  API falls back to FastAPI BackgroundTasks so local dev works without Redis.

## Feedback & Steering API Endpoints

The feedback surface (Phase 3) exposes three endpoints that record user preferences and steer the profile and recommender:

- **`PATCH /profile/traits/{trait_id}`** — Confirm or reject a taste trait, optionally adjust its weight. Accepts `status` (confirmed/rejected), optional `user_weight` (float, default 1.0), and optional `user_note` (freeform annotation). Confirmed traits survive re-profiles; rejected traits are filtered; downweighted traits are softened in prompt context. Stamps `verdict_updated_at` and dirties the profile. Backed by `library.set_trait_verdict()`.

- **`PATCH /recommendations/{rec_id}/feedback`** — Record a swipe decision (accepted/already_read/rejected) on a recommendation. Accepts optional `reject_reasons` (list of slugs from `feedback_vocab.REJECT_REASONS`) and optional `notes`. Rejection reasons are validated against the canonical vocabulary and persisted; counts are aggregated for reranking signal. Swipe decisions create/match library books and dirty the profile. Backed by `recommend._ensure_library_book()` and `library.set_book_feedback()`.

- **`POST /taste-signal`** — Record a "more like this" or "less like this" signal for a specific book or recommendation. Accepts `direction` (more/less), `target_kind` (book/rec), `target_book_id` (for book-kind), and optional `snapshot` JSON (for rec-kind). Book-kind signals feed into profile builds as positive/negative guidance; rec-kind signals snapshot the recommendation so steering survives recommendation pruning. Signals are durable (never dropped by `clear_library` or `clear_profile`) and dirty the profile. Backed by `library.record_taste_signal()`.

All three endpoints stamp `ProfileMeta.rec_feedback_updated_at` or equivalent, triggering dirty-state tracking so `profile_status()` / `GET /profile/status` flags the profile for rebuild.
