# MyLibrary — Frontend + Feedback Loop Plan

> Written 2026-06-22. Pick up here when usage resets.
> Nothing has been built yet. This is the full plan to implement Phase 6: the swipe UI + feedback loop.

---

## What this phase adds

1. A **Next.js frontend** that lets you trigger a recommendation run and swipe through the results.
2. A **feedback endpoint** on the FastAPI backend that records swipe decisions.
3. Accepted recs land in the **to-read shelf** in the `books` table.
4. Rejected recs are persisted as labeled negatives for future profile refinement.
5. User reviews/ratings feed into profiling more heavily than inferred metadata.

---

## Decisions locked in this conversation

### `books.source` contract
The `source` column already exists on `books` (default `"goodreads_import"`). Formalize three values:

| Value | Meaning |
|---|---|
| `"goodreads_import"` | Came from the Goodreads CSV |
| `"user_added"` | Added manually via the UI |
| `"recommendation"` | Accepted from a swipe run |

No migration needed — the column is already there.

### Swipe right = add to to-read shelf in `books`
When the user accepts a recommendation:
- Write a new row to `books`: `exclusive_shelf = "to-read"`, `source = "recommendation"`, `goodreads_rating = 0`, `app_rating = None`.
- Mark `Recommendation.status = "accepted"`.
- The existing dedup logic in `recommend.py` queries `books` by normalized title + author surname, so the accepted book will never be re-recommended. This is intentional.

### Swipe left = rejected, persisted as labeled negative
- Mark `Recommendation.status = "rejected"`.
- Do NOT delete the row. It stays in `recommendations` so future profile refinement can use it.
- The recommender's served-set dedup should also exclude `status = "rejected"` rows in future runs (prevent re-surfacing explicit rejects).

### UI behavior
- **One card at a time** (Tinder-style stack).
- **Both swipe (touch/trackpad) and click** (left/right buttons) for desktop users.
- **"Run Recommendations" button** on the landing/home page triggers `POST /recommend`. Show a loading state while the run is in progress.
- After all 10 cards are swiped, **navigate to the to-read shelf**.
- For now: binary accept/reject only. No "maybe" / save gesture in this phase.

### Recommendation run triggering
- The UI fires `POST /recommend`. The run is synchronous and takes time.
- Simplest approach for a personal tool: show a spinner/loading state and await the response before navigating to the swipe view. No polling needed unless response times are too long.
- If we later want async: `POST /recommend` returns a `run_id`, frontend polls `GET /recommendations` until results appear for that `run_id`.

### User feedback weighting in profiling
This is a key product decision: **explicit user signals should outweigh inferred metadata**.

Signal hierarchy (highest to lowest weight):
1. **`app_rating`** — user set this in-app (most authoritative)
2. **`goodreads_rating`** — imported user rating
3. **Swipe feedback on recommendations** — accept/reject on served recs
4. **Enriched metadata** (subjects, genres, series) — inferred, no direct user voice

When `profile.py` next runs:
- Books with `app_rating` or `goodreads_rating` should anchor the tier groupings.
- Rejected recommendations (with their `grounded_trait_ids`) are negative evidence for those traits — if a user consistently rejects recs citing trait X, that trait should be downweighted or flagged for review.
- Accepted recs that haven't been read yet (to-read) are a soft positive — don't count them as strongly as a 5-star read, but they confirm the direction.

**Note:** The Goodreads import already brings in `to-read` shelf books (unrated, `exclusive_shelf = "to-read"`). These are currently ignored by `profile.py`. Plan to use them as a soft positive signal in a future profile pass — but don't change `profile.py` during the UI build.

---

## Backend changes

### 1. `PATCH /recommendations/{id}/feedback`

New endpoint. Request body:

```json
{ "status": "accepted" | "rejected", "user_note": "optional string" }
```

Logic:
- Look up `Recommendation` by `id`. 404 if not found.
- Set `status` and `user_note`.
- If `status == "accepted"`:
  - Check if a `books` row already exists with matching normalized title + author (use the same `_normalize_title` / `_surname` helpers from `enrich.py`). If it exists, skip insert (idempotent).
  - Otherwise, insert a new `Book` row: `title`, `author`, `year_published` (from rec's `year`), `isbn13`, `cover_url` (store in enrichment?), `exclusive_shelf = "to-read"`, `source = "recommendation"`, `goodreads_rating = 0`.
- Commit and return the updated recommendation.

### 2. Dedup in `recommend.py` — also exclude rejected recs

Currently dedup queries the `books` table. Add a second exclusion: also skip any title+author pair that appears in `recommendations` with `status = "rejected"`. This prevents the recommender from re-surfacing explicit rejects in future runs.

Small change to the dedup step in `recommend.py` — one additional query.

### 3. Schema note: `cover_url` on accepted books

When we write an accepted rec to `books`, the cover URL lives on the `Recommendation` row. The `books` table doesn't have `cover_url` — it's on `Enrichment`. Options:
- Also create an `Enrichment` row for the accepted book, copying `cover_url`, `subjects`, `catalog_source`, `catalog_id` from the `Recommendation`.
- Or add `cover_url` to `books`. (Less clean — keep enrichment data in enrichment.)

**Recommended:** Create a stub `Enrichment` row for accepted recs, copying the fields we have. Mark `confidence_label = "RECOMMENDATION"` (a new label, distinct from HIGH/MEDIUM/LOW) so it's identifiable.

### 4. No new migrations needed
`init_db()` already handles drop+recreate for `recommendations` and `taste_traits`. `books` and `enrichment` are never touched by `init_db`. The `source` field already exists.

---

## Frontend structure

Next.js app, lives as a subfolder of the repo (or sibling repo — **decide before building**). Calls the FastAPI service over HTTP.

**Decision:** `frontend/` subfolder inside the existing repo. Keeps context unified and is trivially splittable into a separate repo later via `git subtree split` if distribution requires it.

### Routes

```
/                    → Home: stats snapshot + "Run Recommendations" button
/swipe               → Card-by-card swipe interface (redirects home if no active run)
/to-read             → To-read shelf, sorted by date added
/library             → Full rated library (read-only for now)
```

### Swipe card contents

Each card shows:
- **Cover image** (`cover_url` from the recommendation)
- **Title + Author + Year**
- **Claude's rationale** (`rationale` field) — "why this for you" — this is the key differentiator
- Optionally: matched taste traits (from `grounded_trait_ids`) — consider showing as small pills, could be noisy

### Swipe interaction

- **Drag left/right** (framer-motion drag) for touch/trackpad
- **← → arrow buttons** below the card for desktop click
- Visual feedback: card tilts and turns red (reject) or green (accept) as it's dragged
- On release past threshold: card flies off, next card comes up, `PATCH` fires in background

### Tech choices

- **framer-motion** for drag + animation (friendlier API than react-spring, good drag primitives)
- **Tailwind CSS** for styling
- **SWR or React Query** for data fetching / cache invalidation
- **No auth** — personal tool, local only

### Loading state (recommend run)

When "Run Recommendations" is clicked:
1. Button becomes a spinner.
2. `POST /recommend` fires (may take 30–60s).
3. On success, navigate to `/swipe` with the fresh results.
4. If it errors, show the error and let the user retry.

---

## Build order (when you pick this up)

1. **Backend first** — add `PATCH /recommendations/{id}/feedback`, handle the `books` insert for accepted recs, update dedup to exclude rejected. Run `pytest` after.
2. **Scaffold Next.js** — `npx create-next-app@latest frontend --typescript --tailwind --app`. Install framer-motion.
3. **Home page** — health check display + "Run Recommendations" button wired to `POST /recommend`.
4. **Swipe page** — fetch `GET /recommendations`, render card stack, wire swipe + click to `PATCH`.
5. **To-read shelf** — fetch `GET /books?shelf=to-read`, render sorted list.
6. **Polish** — transitions, error states, loading skeletons.

---

## Things NOT in this phase (do later)

- Feeding rejected recs back into `profile.py` as labeled negatives (Phase 7 / eval harness)
- Using Goodreads to-read shelf as soft-positive signal in profiling
- NL discovery ("find me something cozy like X")
- Auth / multi-user
- Deploying anywhere — stays local for now
- **Token cost audit** — review where the Claude API spend actually goes (`profile.py` tool-use run, `recommend.py` stage-1 seed queries + stage-2 rerank/explain) and evaluate whether prompt caching (stable system prompts / taste profile) or batch processing (Anthropic Batch API for non-interactive steps like enrichment explanations) would meaningfully reduce costs. Worth doing before any public distribution.
