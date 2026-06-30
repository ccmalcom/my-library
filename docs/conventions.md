# Conventions & Gotchas — MyLibrary

## TypeScript / TSX

- **`Modal` component** (`components/ui/Modal.tsx`) takes `labelId` (ARIA string) + `onClose` + optional `className` — no `title` prop. Render the heading _inside_ as a child with `id={labelId}`. Missing `className` leaves the dialog unstyled.

- **No non-ASCII characters inside JS string literals in `.tsx` files.** Turbopack rejects them with "Expected '</', got 'ident'". Em dashes (`—`), curly quotes, ellipses, etc. are fine in JSX _text nodes_ (between tags) but must not appear inside `"..."` or `'...'` JS string values. Use plain ASCII equivalents (`-`, `...`) or unicode escapes (`—`) in string literals.

- **No IIFEs inside JSX in `.tsx` files.** Turbopack rejects `{(() => { ... })()}` with the same parse error. Compute derived values as plain variables at the top of the component function.

- **The edit tool injects curly/smart quotes into `.tsx` string literals.** When AI edit tools write double-quoted JS strings, they may emit U+201C/U+201D curly quotes instead of straight `"`. Fix with:

  ```bash
  python3 -c "
  path = 'frontend/app/.../page.tsx'
  with open(path, 'rb') as f: c = f.read()
  c = c.replace(b'\xe2\x80\x9c', b'\"').replace(b'\xe2\x80\x9d', b'\"')
  with open(path, 'wb') as f: f.write(c)
  "
  ```

  Prefer **single-quoted strings** (`'...'`) in `.tsx` className arrays to sidestep this.

## Git

- **Never run git state-mutating commands** (`git stash`, `git checkout`, `git reset`, `git commit`, etc.) as part of inspecting or verifying code — the user owns git. The sandbox mount is flaky and can interrupt these mid-operation, leaving a stale `.git/index.lock` that **blocks the user's own commits**, and the sandbox can't delete it. To read history use read-only commands only (`git log`, `git diff`, `git show`). To check whether an edit is valid, read the file back with the file tools.

## Python / CLI

- **Run via `python -m`** (`python -m mylibrary.cli ...`, `python -m pytest`). The console scripts (pytest.exe, uvicorn.exe) may not be on PATH. On Windows use `.venv/Scripts/python -m pytest` — bare `python` may lack packages (e.g. `slowapi`) installed only in the venv.
- **`session_scope()` is the DB context manager; `get_session()` is not.** `get_session()` returns a bare `Session` (no `__exit__`). All core functions use `with session_scope() as session:`. Don't write `with get_session() as session:` — it will fail.
- **Windows PowerShell**: no `&&`. Chain with `;` + `if ($?) { ... }`, or run commands separately.
- Currently developed on **Python 3.14** — first suspect for any odd runtime behavior.

## Enrichment

- **Commits per book** so Ctrl+C is safe and re-runs resume (already-enriched books are skipped; unresolved/LOW are committed and won't auto-retry without `--force`).
- **Request rate** is tunable via `--rps` or `MYLIBRARY_REQ_PER_SEC` (default 8/s). The enrich summary's `http` block reports 429s per host — lower the rate if they appear.
- **Failed resolutions are committed as unresolved rows** (so they don't auto-retry). Re-attempt just those with `enrich --retry-unresolved` instead of `--force` (which redoes the whole library). Open Library is flaky; transient timeouts are common.

## Search & Recommender

- **Two normalizers, different purposes:** `_norm_full` (search path, `catalog.py`) keeps subtitles — do NOT use it in enrichment matching. `enrich._normalize_title` (enrichment path) splits on `:` — do NOT use it in search. Conflating them will break series dedup or enrichment matching respectively.
- **Language policy:** captured at enrich time from the catalog candidate; filtered at recommend time. Unknown-language candidates (`language=None`) are always allowed through — never silently dropped. When the library has no language data, the recommender defaults to English-only candidates.
- **Cold-start thresholds and author-cap constants are tunable knobs** in `recommend.py` (`_COLD_START_LOVED`, `_COLD_START_RATED`, `_MAX_PER_AUTHOR`, `_MAX_LIBRARY_AUTHOR_SHARE`) — adjust there, not in tests or callers.

## Data invariants

- **`books` is never dropped.** It holds the only irreplaceable data (ratings, reviews). New columns are added in place via `ALTER TABLE ... ADD COLUMN` in `init_db`. Only the disposable tables (`taste_traits`, `recommendations`) get dropped+recreated.
- **Purge cascade contract** (`purge.py`): `clear_profile` drops derived taste data (traits + recs + profile_meta + archetype), keeps books. `clear_library` = that **plus** books/enrichments. `delete_account` = everything the user owns, in *every* table — the invariant is "the `user_id` owns no rows anywhere." `TasteSignal` and `EnrichJob` are **durable**: they survive `clear_library`/`clear_profile` and are dropped *only* by `delete_account`. When you add a new user-scoped table, wire it into `delete_account` or you silently break this invariant.
- **Review requires a rating.** Both `set_book_feedback` and `add_book` reject a review on an unrated book (`ValueError` → 422). Both `BookEditModal` and `AddBookModal` enforce this client-side.
- **Profile dirty-state**: `set_book_feedback` bumps `Book.feedback_updated_at`; the profile is "dirty" when any rated/DNF book — or any **favorited** book, including unrated ones — changed after `ProfileMeta.last_profiled_at` (`books_changed_since` includes favorites because they're sent to Claude as positive signal). `profile_status()` / `GET /profile/status` expose this; the frontend banner keys off it.
- **`exclude_from_profile`** (`Book` column, bool, default False): tracks a book without including it in taste profiling or archetype derivation. Toggling goes through `set_book_feedback` (dirtying the profile). `build_tiers` and `books_changed_since` both filter `exclude_from_profile == False`. Alembic migration: `0006_add_exclude_from_profile` (idempotent). Frontend: toggle in `BookEditModal`; "excluded" badge on library rows.

## Recommender

- **`recommend` requires a clean, up-to-date profile** — raises `RuntimeError` (→ HTTP 400) if `last_profiled_at` is `None` or any rated/reviewed book has changed since the last build. Build/update the profile first.
- **`recommend` never re-recommends a library book** (dedup by normalized title + author surname, reusing `enrich._normalize_title` / `_surname`). Individual recommendations and their feedback are durable; rejection reasons and swipe decisions feed back into future profiles.
- **Swipe decisions land books in the library** (`PATCH /recommendations/{id}/feedback`, shared `_ensure_library_book` helper): `accepted` → to-read shelf, `already_read` → read shelf, `rejected` → no book but excluded from dedup + stores optional `reject_reasons` (validated against `feedback_vocab.REJECT_REASONS`). `already_read` returns the created/matched book so the UI can prompt a review; the create is idempotent on the same title+author. Swipe decisions dirty the profile.
- **The stub enrichment must carry `rec.description`.** `_ensure_library_book` creates a stub `Enrichment` (`confidence_label="RECOMMENDATION"`) from the `Recommendation` row — it must copy `description`, `cover_url`, and `subjects` across. Because the book now *has* an enrichment row, a later `enrich` run skips it (`enrich.py`: `if force or b.enrichment is None`), so any field omitted here is permanently null in the UI until an `enrich --force`. Dropping `description` is what made every recommendation-accepted to-read book show "No description available."
- **User feedback on recommendations** (`PATCH /recommendations/{id}/feedback`): accepts `status` (accepted/already_read/rejected), optional `reject_reasons` (list of reason slugs), and optional `notes`. Reject reasons are validated against the canonical vocabulary and aggregated for use in reranking.

## Profile

- **Incremental vs. full re-profile**: prefer `update_taste_profile` (`reprofile` / `POST /profile/update`) after edits — it's cheap. `extract_taste_profile` (`profile` / `reprofile --full` / `POST /profile`) is the full rebuild. Update falls back to a full build when there's no prior profile.
- **Trait verdict feedback** (`PATCH /profile/traits/{id}`): set `status` (confirmed/rejected) and/or `user_weight` (float, default 1.0). Confirmed traits are preserved across re-profiles; rejected traits are filtered from Claude's output. Downweighted traits (`user_weight < 1.0`) are softened in prompt context. All verdicts stamp `verdict_updated_at` and dirty the profile.
- **Taste signals** (`POST /taste-signal`): record "more like this" or "less like this" for a specific book or recommendation. Book-kind signals are durable and feed into profile builds as positive/negative signal. Rec-kind signals capture snapshot data so recommendations can be removed without losing steering. All signals dirty the profile.
- **`/profile/subjects`** (`GET`): aggregates enrichment subjects for all rated books, grouped by star tier. Subject counts normalise capitalisation and cap per-book contribution at 8 subjects.

## SWR cache / frontend state

- **After each setup wizard step**, refresh the shared `"stats"` SWR key by passing fresh data — `await mutate("stats", api.stats(), { revalidate: false })` — **not** a bare `mutate("stats")`. A bare call only revalidates, and SWR won't refetch a key no mounted component subscribes to, so the cache keeps the stale `total: 0`.
- **`LibraryGate` latches** its setup-vs-ready decision on first stats load. The wizard calls `onComplete` at its final step to advance deliberately — don't make the gate reactive to `stats.total` changing.

## Manual add

- **Search-and-pick only** — the book stored is always a real catalog hit, never free-typed. Consistent with the "no invented titles" rule.
- Dedup is by normalized title + author surname; a duplicate returns **409** (`BookExistsError`), which `AddBookModal` shows as "already in your library".

## Alembic (see also `docs/hosting.md`)

- Any future migration that adds a column/table already present in the models' `create_all` baseline must be idempotent (inspect the bind and skip if already exists).
