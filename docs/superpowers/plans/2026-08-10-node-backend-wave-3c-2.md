# Node Backend Wave 3c-2 — `POST /books/{id}/similar` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `recommend.recommend_similar()` — the ephemeral "more books like this" flow — and its FastAPI route `POST /books/{book_id}/similar` (including the 15/minute rate limit) to a Next.js route handler, proven byte-identical against prompts and catalog traffic recorded from the real Python implementation.

**Architecture:** Wave 3c-1 already shipped everything this flow shares with `/recommend`: `similarity.ts`, `recFilters.ts`, `recAssemble.ts` (`metadataPool`, `seedPool`, `assemble`, `capPool`, `fillOlDescriptions`) and `catalog.ts`'s discovery endpoints. **This plan adds only what is specific to the per-book path**: a book-anchored signal builder, two new Claude prompts, a small orchestrator, and the route. Nothing in `recommendRun.ts` changes.

Claude output is nondeterministic, so "parity" here means the **request** is byte-identical: `scripts/gen_claude_fixtures.py` records the real Python `create()` kwargs, and a Node test rebuilds the same prompt from the same replayed catalog HTTP. Because the rerank prompt embeds a candidate list assembled from live catalog responses, that single assertion also re-proves the shared retrieval core along the *similar* path, where it runs with a different (much smaller) pool.

**Tech Stack:** Next.js 15 route handlers, drizzle-orm over postgres-js, vitest + PGlite, `@anthropic-ai/sdk`, zod for body validation.

---

## Global Constraints

These apply to **every** task. Read them before starting any task.

1. **Python is the specification.** When Python does something that looks wrong, reproduce it. Do not "fix" it in Node. Deviations are allowed only where this plan explicitly names one, and each must carry a comment explaining why.
2. **No Claude call inside a transaction.** `lib/server/db.ts` opens the pool with `max: 1`; touching the outer `db` while a `tx` is open deadlocks. This flow persists **nothing** (results are ephemeral), so it must not open a transaction at all.
3. **Ordered mappings bound for a prompt must be a `Map`** when any key is integer-like. V8 enumerates `'5'`, `'4'`, `'3'` in ascending numeric order. The anchor JSON in this wave uses only alphabetic keys, so a plain object literal is safe and matches the existing `buildRerankPrompt` style — but do not swap in a `Record` built from a loop.
4. **Python floats render differently.** `json.dumps(1.0)` → `1.0`; `JSON.stringify(1.0)` → `1`. Any float that reaches a prompt must be wrapped with `pyFloat()`. No float reaches these two prompts (`year` is an int), so none is needed here — but check before adding a field.
5. **`{}` is truthy in JS, falsy in Python.** Every Python `if not some_dict:` becomes `if (Object.keys(d).length === 0)`, never `if (!d)`.
6. **Alembic remains the sole migration authority.** This wave adds no columns and no migrations.
7. **Never read or print values from `.env` / `.env.local`.** Variable *names* only. Task 1 needs `GOOGLE_BOOKS_API_KEY` to be **present**; verify with an existence check, never by printing it.
8. **Do not run `git commit` unless the plan step says to commit.** Never add a `Co-Authored-By: Claude` trailer.
9. **Do not run destructive writes against the real dev Postgres.** All verification is against PGlite (tests) or the generator's throwaway SQLite.
10. Run `npx prettier --write <files you touched>` before each commit, from `frontend/`. Do **not** run a repo-wide `npm run format` — it rewrites ~65 unrelated pre-existing files. `lib/server/__tests__/fixtures/claude/` is in `.prettierignore`; leave it alone.

---

## Verified Facts

Every claim below was **executed and confirmed** against this repo on 2026-08-10, not inferred from reading. Trust them; do not re-derive them, and do not "correct" code that follows them.

| # | Fact | Evidence |
|---|---|---|
| V1 | `recommend_similar()` makes exactly **two** Claude calls: `similar_seed` (`claude-haiku-4-5-20251001`, `max_tokens=1500`, tool `propose_search_queries` — it **reuses `_SEED_TOOL`**) then `similar_rerank` (`settings.model` = `claude-sonnet-5`, `max_tokens=4000`, tool `rank_similar_books`). Both send one user message with a **2-block** content array; block 0 carries `cache_control: {"type": "ephemeral"}` and is the identical `SEED BOOK (JSON):` string in both calls. | Ran `recommend_similar(1, n=8)` with a monkeypatched `tracked_create` |
| V2 | `recommend_similar()` has **no profile-missing / profile-stale gate and no cold-start gating** — it ran cleanly against the un-bumped SEED, unlike `recommend()`. The generator does **not** need `_prepare_recommend()` for these scenarios. | Same probe, ran without touching `profile_meta` |
| V3 | Against SEED book 1 (Dune) the flow issues **32 catalog URLs**: 3 OL subject + 3 GB subject + 1 GB author + 2 GB seed-query + **23 OL work-description fills**. | Same probe |
| V4 | Those 23 work-description fills are **new coverage**: the committed `recommend-http.json` has 24 URLs (8 OL subject + 16 GB) and **zero** OL work-description URLs, because `/recommend`'s 138-candidate pool trims description-less OL candidates away in `capPool`. The similar path's pool is far under the cap of 60, so `capPool` hits its `length <= cap` early return and `fillOlDescriptions` genuinely runs. | Counted both recordings |
| V5 | `_build_book_signal` returns **no** `library_series` and **no** `library_titles` key. `_assemble` reads them as `signal.get("library_series") or {}` / `signal.get("library_titles") or []`, so on this path the series filter and the fuzzy-duplicate filter are **inert**. Node must pass an empty `Map`/array, not the full library's. | Read `recommend.py:483-533` + `:1045-1057`; confirmed no `KeyError` at runtime |
| V6 | `_build_book_signal` does **not** fold rejected recommendations into `library_keys`/`library_isbns` (`_build_signal` does). A previously-rejected book can therefore resurface as a "similar" result. | Same read + probe |
| V7 | `recommend_similar` does **not** call `_apply_directive_constraints`. Custom instructions do not steer this path at all. | Read `recommend.py:1692-1775` |
| V8 | The key check is **late**: `_metadata_pool` runs before `_similar_seed_pool`, and `_client()` only raises inside `_book_facet_queries`. A keyless user pays for the full metadata catalog sweep and *then* gets the 400. The message is byte-identical to `RECOMMEND_NO_KEY_MESSAGE` ("...before running recommend."). | Read `recommend.py:206-223`, `:1724-1727` |
| V9 | HTTP contract, via `TestClient`: missing body → **422**; `{}` → **200** (`n` defaults to 8); `{"n": 0}` → **422**; `{"n": 21}` → **422**; `{"n": "x"}` → **422**; a book that isn't the caller's → **404** with detail `Book 999 not found` (**no trailing period** — distinct from `recommend_similar`'s own `RuntimeError: Book 999 not found.`, which the route's own 404 check makes unreachable). | `TestClient` probe |
| V10 | `_rerank_similar` drops hallucinated and duplicate `candidate_index` values, `.strip()`s the rationale, sorts by score descending, then reorders description-having candidates first, then slices to `n`. `round(0.875, 2)` came back as `0.88` in the response — the banker's-rounding tie that `round2` already handles. | Probe with canned ranked payloads incl. `candidate_index: 999` and a duplicate |
| V11 | The response body is `{anchor_book_id, anchor_title, count, model, seed_queries, recommendations[]}`, where `count` is the number of **ranked** results, not the candidate-pool size. | Same probe |
| V12 | The only Python routes under `/books` using POST are `POST /books` and `POST /books/{book_id}/similar`. Dropping `exact` from the existing `{ prefix: '/books', methods: ['POST'], exact: true }` rule therefore flips exactly this one route and nothing else. | `grep '@app.post("/books' mylibrary/api.py` |
| V13 | `frontend/lib/api.ts:443-444` (`api.similarBooks`) is the sole caller, already typed as `SimilarBooksResult`. No frontend change is needed by the flip. | Repo-wide grep for `/similar` |

### Python quirks to reproduce, not fix

- **V5** — the series and fuzzy-title filters are dead on this path. Pass `new Map()` and `[]`; do **not** "improve" it by reusing the full library's sets.
- **V6** — rejected recommendations are not excluded. Do not add them.
- **V7** — the user's custom instructions are ignored here. Do not call `applyDirectiveConstraints`.
- **V8** — do not hoist the API-key check above `metadataPool`. A keyless user must still make the metadata catalog calls first.
- The `_fuzzy_duplicate` subtitle-collision quirk and the `exclude_authors` surname/full-name mismatch quirk from wave 3c-1 are unchanged and unreachable here (V5, V7).

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `frontend/lib/server/recSimilarPrompts.ts` | Verbatim `_BOOK_FACET_SYSTEM`, `_SIMILAR_RANK_TOOL`, `_SIMILAR_RANK_SYSTEM` + the two prompt builders and the shared `SEED BOOK (JSON):` block |
| `frontend/lib/server/recSimilarRun.ts` | `runSimilar` — the `recommend_similar()` orchestrator (no persistence) |
| `frontend/app/api/books/[id]/similar/route.ts` | `POST /api/books/{id}/similar` handler |
| `frontend/lib/server/__tests__/rec-book-signal.test.ts` | |
| `frontend/lib/server/__tests__/parity-similar-prompts.test.ts` | The payoff: byte-identical prompt assertions |
| `frontend/lib/server/__tests__/similar-run.test.ts` | |
| `frontend/lib/server/__tests__/similar-route.test.ts` | |

**Modified files**

| File | Change |
|---|---|
| `scripts/gen_claude_fixtures.py` | Two new scenarios (`similar_seed`, `similar_rerank`) + their canned seed response |
| `frontend/lib/server/__tests__/fixtures/claude/prompts.json` | Regenerated; gains 2 keys |
| `frontend/lib/server/__tests__/fixtures/claude/recommend-http.json` | Regenerated; gains the similar path's URLs |
| `frontend/lib/server/recSignal.ts` | `buildBookSignal`, `BookAnchor`, `BookSignal` |
| `frontend/lib/server/claudeErrors.ts` | `SIMILAR_NOT_ENOUGH_METADATA_MESSAGE` |
| `frontend/lib/server/ratelimit.ts` | `RATE_LIMITS.booksSimilar` |
| `frontend/lib/server/__tests__/ratelimit.test.ts` | Assert the new bucket |
| `frontend/lib/server/__tests__/ratelimit-routes.test.ts` | Drive the new route past 15/minute |
| `frontend/lib/backend.ts` | `POST /books/{id}/similar` flips to Node |
| `frontend/lib/__tests__/backend.test.ts` | Two assertions flip from Python to Node |
| `CLAUDE.md` | Wave 3c-2 status |

**Dependency order:** Task 1 (fixtures) → Task 2 (book signal) → Task 3 (prompts + parity) → Task 4 (orchestrator) → Task 5 (route + rate limit + flip).

---

## Task 1: Record the similar-path Claude prompts and catalog traffic

`gen_claude_fixtures.py` already supports multi-call capture with a canned-response queue (wave 3c-1). This task adds two scenarios that drive `recommend_similar()` and lets the existing catalog recorder pick up the new URLs.

**Files:**
- Modify: `scripts/gen_claude_fixtures.py`
- Regenerate + commit: `frontend/lib/server/__tests__/fixtures/claude/prompts.json` (gains 2 keys)
- Regenerate + commit: `frontend/lib/server/__tests__/fixtures/claude/recommend-http.json` (gains ~30 URLs)

**Interfaces:**
- Produces: `prompts.json` keys `similar_seed` and `similar_rerank`, each `{operation, user_id, kwargs}` where `kwargs` has `model`, `max_tokens`, `system`, `tools`, `tool_choice`, `messages`.
- Produces: the same `recommend-http.json` map, now also covering the similar path's URLs. It is a flat `{url: {status, body?}}` map, so both parity tests read one file and shared URLs are recorded once.

- [ ] **Step 1: Confirm a Google Books key is available (existence only)**

A keyless recording gets 429s off Google's shared anonymous quota and the generator will refuse to write (`_assert_catalog_recording_is_usable`). Check presence without printing the value:

```bash
cd /home/chase/Documents/Code/my-library
grep -q '^GOOGLE_BOOKS_API_KEY=.\+' .env && echo "GOOGLE_BOOKS_API_KEY: present" || echo "GOOGLE_BOOKS_API_KEY: MISSING — stop and ask Chase"
```

If it is missing, **stop**. Do not proceed with a degraded recording.

- [ ] **Step 2: Add the similar scenario helpers**

In `scripts/gen_claude_fixtures.py`, insert directly **above** the `# name -> (flow, canned responses ...)` comment that precedes `SCENARIOS`:

```python
# A fixed stand-in for what Claude would propose in the per-book stage 1b. Like
# _SEED_QUERIES_CANNED, these strings determine which Google Books URLs land in
# recommend-http.json, so changing them requires a regeneration run AND the same
# edit in parity-similar-prompts.test.ts.
_SIMILAR_QUERIES_CANNED = _CannedMessage(
    "propose_search_queries",
    {
        "queries": [
            {"query": "desert planet political intrigue science fiction", "reason": "fixture"},
            {"query": "ecological science fiction messianic prophecy", "reason": "fixture"},
        ]
    },
)

# Book 1 (Dune) is the anchor: the only SEED book whose enrichment carries BOTH
# subjects and a description, so the anchor JSON exercises every populated field.
# `series` stays null -- no SEED book is both enriched with a series and richly
# described -- and that null is itself asserted in the Node parity test.
SIMILAR_BOOK_ID = 1


def _run_similar():
    # No _prepare_recommend() call: recommend_similar() has no profile-missing or
    # profile-stale gate and no cold-start gating (verified by probe), so it runs
    # against the SEED as-is. Keeping it out also means these scenarios cannot
    # perturb the earlier profile_* fixtures.
    return recommend_mod.recommend_similar(SIMILAR_BOOK_ID, n=8)  # n=8 is SimilarRequest's default
```

- [ ] **Step 3: Register the two scenarios**

Append inside `SCENARIOS`, after the two `recommend_*` entries (the `# --- append below this line only ---` rule still applies):

```python
    "similar_seed": (_run_similar, [], 0),
    "similar_rerank": (_run_similar, [_SIMILAR_QUERIES_CANNED], 1),
```

No change to `main()` — it already iterates `(fn, canned, take)` and writes the shared `catalog_http` map.

- [ ] **Step 4: Regenerate the fixtures**

This run hits the real Open Library and Google Books APIs and makes **zero** Claude calls (offline mode feeds canned responses). Expect roughly a minute.

```bash
cd /home/chase/Documents/Code/my-library
.venv/bin/python scripts/gen_claude_fixtures.py
```

Expected tail (URL count will vary — the similar and recommend paths share some subject URLs):

```
catalog traffic recorded:
  openlibrary.org N/N returned data
  www.googleapis.com N/N returned data
wrote frontend/lib/server/__tests__/fixtures/claude/prompts.json scenarios: ['directive_distill', 'archetype', 'reveal_lines', 'profile_full', 'profile_update', 'recommend_seed', 'recommend_rerank', 'similar_seed', 'similar_rerank']
wrote frontend/lib/server/__tests__/fixtures/claude/recommend-http.json urls: 50
```

**`urls:` must be well above the previous 24** (roughly 50-56). If it is still 24, `_run_similar` never ran — check the `SCENARIOS` entries. If either host reports `0/N`, the generator aborts and writes nothing; fix the key or retry later.

- [ ] **Step 5: Verify the recording**

```bash
cd /home/chase/Documents/Code/my-library
grep -c 'key=' frontend/lib/server/__tests__/fixtures/claude/recommend-http.json || echo "no api key leaked: OK"
.venv/bin/python -c "
import json
d = json.load(open('frontend/lib/server/__tests__/fixtures/claude/prompts.json'))
print('scenarios:', list(d))
for k in ('similar_seed', 'similar_rerank'):
    kw = d[k]['kwargs']
    print(k, kw['model'], kw['max_tokens'], [t['name'] for t in kw['tools']], kw['tool_choice'])
h = json.load(open('frontend/lib/server/__tests__/fixtures/claude/recommend-http.json'))
print('urls:', len(h), '| OL work fills:', sum(1 for u in h if '/works/' in u))
"
```

Expected:
```
no api key leaked: OK
scenarios: [... 'similar_seed', 'similar_rerank']
similar_seed claude-haiku-4-5-20251001 1500 ['propose_search_queries'] {'type': 'tool', 'name': 'propose_search_queries'}
similar_rerank claude-sonnet-5 4000 ['rank_similar_books'] {'type': 'tool', 'name': 'rank_similar_books'}
urls: 50 | OL work fills: 23
```

`OL work fills` must be **> 0** — that is V4's new coverage of `fillOlDescriptions`, which the recommend-only recording did not have.

- [ ] **Step 6: Confirm the existing parity tests still pass**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/parity-prompts.test.ts lib/server/__tests__/parity-recommend-prompts.test.ts
```

Expected: all PASS.

**Expected churn:** `recommend_rerank`'s prompt may shift by a candidate or two — the fixture snapshots live catalog data and Google Books re-ranks between recordings (documented in `CLAUDE.md`). That is fine: `parity-recommend-prompts.test.ts` rebuilds the prompt from the same re-recorded HTTP, so it stays consistent.

**Not expected:** any change to `directive_distill`, `archetype`, `reveal_lines`, `profile_full`, `profile_update`, or `recommend_seed` — none of them touch the catalog. If one moved, an environment variable leaked into the recording. Stop and investigate rather than committing.

```bash
cd /home/chase/Documents/Code/my-library
git diff --stat frontend/lib/server/__tests__/fixtures/claude/
```

- [ ] **Step 7: Commit**

```bash
cd /home/chase/Documents/Code/my-library
git add scripts/gen_claude_fixtures.py frontend/lib/server/__tests__/fixtures/claude/
git commit -m "test(node): record the similar-books prompts + catalog traffic for wave 3c-2"
```

---

## Task 2: The book-anchored signal

`_build_book_signal` is `_build_signal`'s smaller sibling: discovery seeds come from ONE book, while the exclusion sets still cover the whole library. It omits `library_series` and `library_titles` entirely (V5) and skips rejected recommendations (V6).

**Files:**
- Modify: `frontend/lib/server/recSignal.ts` (append after `buildSignal`)
- Test: `frontend/lib/server/__tests__/rec-book-signal.test.ts` (new)

**Interfaces:**
- Consumes: `schema`, `Db` (`db.ts`); `surname` (`dedup.ts`); `dedupKey` (`recFilters.ts`); `AssembleSignal` (`recAssemble.ts`).
- Produces:
  - `interface BookAnchor { id: number; title: string; author: string | null; year: number | null; subjects: string[]; description: string | null; series: string | null }`
  - `interface BookSignal extends AssembleSignal { top_subjects: string[]; top_authors: string[]; anchor: BookAnchor }`
  - `buildBookSignal(db: Db, userId: string, bookId: number): Promise<BookSignal | null>` — `null` when the book is not the caller's.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/lib/server/__tests__/rec-book-signal.test.ts
import { describe, test, expect } from 'vitest';
import seedJson from './fixtures/parity/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { buildBookSignal } from '../recSignal';
import { dedupKey } from '../recFilters';

describe('buildBookSignal', () => {
  test('seeds discovery from ONE book but excludes the WHOLE library', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const signal = (await buildBookSignal(db, 'local', 1))!;
      expect(signal).not.toBeNull();

      // Discovery seeds come from book 1 (Dune) alone.
      expect(signal.top_subjects).toEqual(['science fiction', 'space opera', 'politics']);
      expect(signal.top_authors).toEqual(['Frank Herbert']);
      expect(signal.anchor).toEqual({
        id: 1,
        title: 'Dune',
        author: 'Frank Herbert',
        year: 1965,
        subjects: ['science fiction', 'space opera', 'politics'],
        description: 'Melange, sandworms, prophecy.',
        series: null,
      });

      // Exclusion sets still cover every book the reader owns.
      expect(signal.library_keys.has(dedupKey('Kindred', 'Octavia E. Butler'))).toBe(true);
      expect(signal.library_keys.has(dedupKey('Dune', 'Frank Herbert'))).toBe(true);
      expect(signal.library_isbns.has('9780441013593')).toBe(true);
      expect(signal.library_authors.has('butler')).toBe(true);
    } finally {
      await close();
    }
  });

  test('PYTHON QUIRK: library_series and library_titles are always empty here', async () => {
    // _build_book_signal returns neither key; _assemble reads them as
    // `signal.get(...) or {}` / `or []`, so the series filter and the
    // fuzzy-duplicate filter are INERT on the similar path. Reproduced
    // deliberately -- do NOT populate them from the library.
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const signal = (await buildBookSignal(db, 'local', 1))!;
      expect(signal.library_series.size).toBe(0);
      expect(signal.library_titles).toEqual([]);
    } finally {
      await close();
    }
  });

  test('PYTHON QUIRK: rejected recommendations are NOT excluded', async () => {
    // _build_signal folds rejected recs into library_keys so they never resurface.
    // _build_book_signal does not, so a rejected book can come back as "similar".
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const signal = (await buildBookSignal(db, 'local', 1))!;
      const rejected = (seedJson as any).recommendations.filter(
        (r: any) => r.status === 'rejected'
      );
      expect(rejected.length).toBeGreaterThan(0);
      for (const r of rejected) {
        expect(signal.library_keys.has(dedupKey(r.title, r.author))).toBe(false);
      }
    } finally {
      await close();
    }
  });

  test('an unenriched book still yields an anchor, with empty subjects', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      // Book 9 (Too Like the Lightning) has no enrichment row in the SEED.
      const signal = (await buildBookSignal(db, 'local', 9))!;
      expect(signal.top_subjects).toEqual([]);
      expect(signal.anchor.subjects).toEqual([]);
      expect(signal.anchor.description).toBeNull();
      expect(signal.anchor.series).toBeNull();
      expect(signal.anchor.author).toBe('Ada Palmer');
    } finally {
      await close();
    }
  });

  test('returns null for a missing book and for another tenant’s book', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      expect(await buildBookSignal(db, 'local', 999)).toBeNull();
      // Book 101 belongs to the other seeded tenant.
      expect(await buildBookSignal(db, 'local', 101)).toBeNull();
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/rec-book-signal.test.ts
```

Expected: FAIL — `buildBookSignal is not a function`.

- [ ] **Step 3: Implement**

Append to `frontend/lib/server/recSignal.ts` (and add `type AssembleSignal` to the imports — it lives in `./recAssemble`; the import is type-only, so there is no runtime cycle even though `recAssemble` imports `RecSignal` back):

```ts
/** recommend._build_book_signal's `anchor` dict. */
export interface BookAnchor {
  id: number;
  title: string;
  author: string | null;
  year: number | null;
  subjects: string[];
  description: string | null;
  series: string | null;
}

/**
 * The signal shape for the per-book "more like this" path. It satisfies both
 * assemble()'s AssembleSignal and metadataPool()'s {top_subjects, top_authors},
 * so the whole 3c-1 retrieval core is reused unchanged.
 */
export interface BookSignal extends AssembleSignal {
  top_subjects: string[];
  top_authors: string[];
  anchor: BookAnchor;
}

/**
 * Port of recommend._build_book_signal. Discovery seeds (top_subjects,
 * top_authors, anchor) come from ONE book; the exclusion/permission sets still
 * cover the whole library, so we never recommend a book the reader already owns
 * and we respect their reading languages.
 *
 * Returns null when the book is not this user's — Python raises
 * `RuntimeError("Book N not found.")` from recommend_similar() instead, but the
 * route 404s before that ever runs (see the route handler), so the caller
 * decides which error to raise.
 *
 * DEVIATION (deliberate, same as buildSignal): the ORDER BY is explicit. Python
 * relies on Postgres's arbitrary row order, which is not good enough for a
 * byte-identical prompt assertion.
 */
export async function buildBookSignal(
  db: Db,
  userId: string,
  bookId: number
): Promise<BookSignal | null> {
  const rows = await db
    .select({ b: schema.books, enr: schema.enrichment })
    .from(schema.books)
    // Safe against fan-out: enrichment.book_id carries a UNIQUE index, so this is 1:1.
    .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
    .where(eq(schema.books.userId, userId))
    .orderBy(asc(schema.books.id));

  const library_keys = new Set<string>();
  const library_isbns = new Set<string>();
  const library_languages = new Set<string>();
  const library_authors = new Set<string>();
  let anchorRow: (typeof rows)[number] | undefined;

  for (const row of rows) {
    const { b, enr } = row;
    library_keys.add(dedupKey(b.title, b.author));
    if (b.isbn13) library_isbns.add(b.isbn13);
    const enrLang = enr?.language ?? null;
    if (enrLang) library_languages.add(enrLang);
    if (b.author) library_authors.add(surname(b.author));
    if (b.id === bookId) anchorRow = row;
  }

  if (!anchorRow) return null;

  const { b, enr } = anchorRow;
  const subjects = ((enr?.subjects as string[] | null) ?? []) as string[];

  return {
    library_keys,
    library_isbns,
    library_authors,
    library_languages,
    // PYTHON QUIRK (do not "fix"): _build_book_signal returns neither key, and
    // _assemble defaults them to {} / []. The series filter and the
    // fuzzy-duplicate filter are therefore INERT on this path.
    library_series: new Map<string, Set<number>>(),
    library_titles: [],
    top_subjects: subjects.slice(0, TOP_SUBJECTS),
    top_authors: b.author ? [b.author] : [],
    anchor: {
      id: b.id,
      title: b.title,
      author: b.author,
      year: b.yearPublished,
      subjects: subjects.slice(0, 8),
      description: enr?.description ?? null,
      series: enr?.series ?? null,
    },
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/rec-book-signal.test.ts lib/server/__tests__/rec-signal.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx prettier --write lib/server/recSignal.ts lib/server/__tests__/rec-book-signal.test.ts
cd /home/chase/Documents/Code/my-library
git add frontend/lib/server/recSignal.ts frontend/lib/server/__tests__/rec-book-signal.test.ts
git commit -m "feat(node): port the recommender's book-anchored signal"
```

---

## Task 3: The two similar-path prompts, proven byte-identical

Every string here is copied **verbatim** from `mylibrary/recommend.py`. Do not reflow, re-punctuate, or "improve" any of them — the parity test compares them character for character.

**Files:**
- Create: `frontend/lib/server/recSimilarPrompts.ts`
- Test: `frontend/lib/server/__tests__/parity-similar-prompts.test.ts` (new)

**Interfaces:**
- Consumes: `PromptBlock`, `rankModel`, `RANK_MAX_TOKENS`, `SEED_MODEL`, `SEED_MAX_TOKENS`, `SEED_TOOL` (`recPrompts.ts`); `AssembledCandidate` (`recAssemble.ts`); `BookAnchor` (`recSignal.ts`); `pyJsonDumps` (`serialize.ts`).
- Produces: `BOOK_FACET_SYSTEM`, `SIMILAR_RANK_TOOL`, `SIMILAR_RANK_SYSTEM`, `seedBookContext(anchor): string`, `buildBookFacetPrompt(anchor, nQueries): PromptBlock[]`, `buildSimilarRerankPrompt(candidates, anchor, n): PromptBlock[]`.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/lib/server/__tests__/parity-similar-prompts.test.ts
import { describe, it, expect } from 'vitest';
import prompts from './fixtures/claude/prompts.json';
import httpFixtures from './fixtures/claude/recommend-http.json';
import seedJson from './fixtures/parity/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupParityEnv } from './helpers/parity';
import { installHttpReplay } from './helpers/httpReplay';
import { buildBookSignal } from '../recSignal';
import {
  assemble,
  fillOlDescriptions,
  metadataPool,
  seedPool,
  MAX_CANDIDATES,
  PER_QUERY,
  SEED_QUERIES,
} from '../recAssemble';
import { SEED_MODEL, SEED_MAX_TOKENS, SEED_TOOL, RANK_MAX_TOKENS, rankModel } from '../recPrompts';
import {
  BOOK_FACET_SYSTEM,
  SIMILAR_RANK_SYSTEM,
  SIMILAR_RANK_TOOL,
  buildBookFacetPrompt,
  buildSimilarRerankPrompt,
} from '../recSimilarPrompts';

// Must stay identical to SIMILAR_BOOK_ID / _SIMILAR_QUERIES_CANNED in
// scripts/gen_claude_fixtures.py -- together they determine which catalog URLs
// recommend-http.json contains for this path.
const SIMILAR_BOOK_ID = 1;
const CANNED_SIMILAR_QUERIES = [
  'desert planet political intrigue science fiction',
  'ecological science fiction messianic prophecy',
];

describe('prompt parity: similar stage 1b (book facet queries)', () => {
  setupParityEnv();

  it('builds a byte-identical request to Python', async () => {
    const py = (prompts as any).similar_seed.kwargs;
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const signal = (await buildBookSignal(db, 'local', SIMILAR_BOOK_ID))!;
      // The facet prompt is built from the anchor alone -- no catalog, no profile.
      expect(buildBookFacetPrompt(signal.anchor, SEED_QUERIES)).toEqual(py.messages[0].content);
      expect(BOOK_FACET_SYSTEM).toBe(py.system);
      // Python reuses _SEED_TOOL verbatim for this call.
      expect(SEED_TOOL).toEqual(py.tools[0]);
      expect(SEED_MODEL).toBe(py.model);
      expect(SEED_MAX_TOKENS).toBe(py.max_tokens);
      expect(py.tool_choice).toEqual({ type: 'tool', name: 'propose_search_queries' });
      expect(py.messages[0].role).toBe('user');
      // The anchor's `series` is null in the SEED; assert it renders as JSON null
      // rather than being dropped from the object.
      expect(py.messages[0].content[0].text).toContain('"series": null');
    } finally {
      await close();
    }
  });
});

describe('prompt parity: similar stage 2 (rerank)', () => {
  setupParityEnv();

  it("rebuilds Python's candidate list and rerank prompt from replayed catalog traffic", async () => {
    const py = (prompts as any).similar_rerank.kwargs;
    const { db, close } = await makeTestDb();
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await loadSeed(db, seedJson as any);
      const signal = (await buildBookSignal(db, 'local', SIMILAR_BOOK_ID))!;

      // cold_start is always false on this path: library thinness is irrelevant
      // to a single seed book, so author expansion always runs.
      const meta = await metadataPool(db, signal, PER_QUERY, false);
      const seed = await seedPool(db, CANNED_SIMILAR_QUERIES, PER_QUERY);
      const candidates = assemble(meta, seed, signal, MAX_CANDIDATES);
      // NOT applyDirectiveConstraints: recommend_similar never calls it (V7).
      await fillOlDescriptions(db, candidates);
      expect(candidates.length).toBeGreaterThan(0);

      // This single assertion covers the deterministic retrieval core AS IT RUNS
      // ON THIS PATH: pool order, dedup, language + learner filters, author caps
      // and description ordering all feed the CANDIDATES JSON inside this prompt.
      //
      // COVERAGE this path adds over parity-recommend-prompts.test.ts:
      //  - fillOlDescriptions genuinely runs (the recommend fixture records zero
      //    /works/ URLs, because its 138-candidate pool trims description-less OL
      //    candidates in capPool). Here the pool is far under the cap of 60.
      //  - capPool's `length <= cap` early return is the branch taken.
      //  - the series and fuzzy-duplicate filters are inert (empty library_series
      //    and library_titles), which is exactly what Python does here.
      //
      // The fixture is a snapshot of live catalog data: re-recording churns a
      // candidate or two as Google Books re-ranks. That is expected -- this proves
      // Node reproduces whatever was recorded, not one specific candidate list.
      expect(buildSimilarRerankPrompt(candidates, signal.anchor, 8)).toEqual(
        py.messages[0].content
      );
      expect(SIMILAR_RANK_SYSTEM).toBe(py.system);
      expect(SIMILAR_RANK_TOOL).toEqual(py.tools[0]);
      expect(rankModel()).toBe(py.model);
      expect(RANK_MAX_TOKENS).toBe(py.max_tokens);
      expect(py.tool_choice).toEqual({ type: 'tool', name: 'rank_similar_books' });
    } finally {
      restore();
      await close();
    }
  });

  it('sends the identical SEED BOOK block in both stages', async () => {
    // Python builds the same book_context string in _book_facet_queries and
    // _rerank_similar, so the ephemeral cache prefix is shared across the two calls.
    const seedBlock = (prompts as any).similar_seed.kwargs.messages[0].content[0];
    const rerankBlock = (prompts as any).similar_rerank.kwargs.messages[0].content[0];
    expect(seedBlock).toEqual(rerankBlock);
    expect(seedBlock.cache_control).toEqual({ type: 'ephemeral' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/parity-similar-prompts.test.ts
```

Expected: FAIL — `Cannot find module '../recSimilarPrompts'`.

- [ ] **Step 3: Implement**

```ts
// frontend/lib/server/recSimilarPrompts.ts
/**
 * Port of recommend.py's two per-book prompts (_BOOK_FACET_SYSTEM and
 * _SIMILAR_RANK_TOOL/_SIMILAR_RANK_SYSTEM) plus their builders.
 *
 * These live apart from recPrompts.ts because they ground in ONE anchor book
 * rather than the taste profile -- no traits, no loved books, no user steering.
 * Stage 1b reuses recPrompts' SEED_TOOL/SEED_MODEL/SEED_MAX_TOKENS verbatim,
 * exactly as Python reuses _SEED_TOOL.
 *
 * Every string here is copied VERBATIM from Python and asserted byte-for-byte in
 * parity-similar-prompts.test.ts. Do not reflow or re-punctuate them.
 */
import type { AssembledCandidate } from './recAssemble';
import type { PromptBlock } from './recPrompts';
import type { BookAnchor } from './recSignal';
import { pyJsonDumps } from './serialize';

// --- stage 1b: decompose one book into search queries -----------------------

export const BOOK_FACET_SYSTEM =
  'You decompose ONE book into catalog search queries that would surface OTHER books ' +
  'like it. You propose search TERMS, never specific titles. Chase what makes this ' +
  'particular book distinctive (its voice, structure, pace, mood, and specific subject ' +
  "matter), not generic bestsellers in its genre. Do not aim queries at the book's own " +
  'author (same-author books are handled separately); reach for comparable books by ' +
  'other authors.';

/**
 * The `SEED BOOK (JSON):` block, byte-identical in both stages (Python builds the
 * same `book_context` string twice), so the two calls share an ephemeral cache prefix.
 *
 * A plain object literal is correct here: every key is alphabetic, so V8 preserves
 * insertion order. (The Map rule in serialize.ts exists for integer-like keys.) The
 * key ORDER below is load-bearing -- it is Python's dict literal order.
 */
export function seedBookContext(anchor: BookAnchor): string {
  return (
    'SEED BOOK (JSON):\n' +
    pyJsonDumps({
      title: anchor.title,
      author: anchor.author,
      year: anchor.year,
      subjects: anchor.subjects ?? [],
      series: anchor.series,
      description: anchor.description,
    })
  );
}

/** recommend._book_facet_queries' message content. */
export function buildBookFacetPrompt(anchor: BookAnchor, nQueries: number): PromptBlock[] {
  const taskPrompt =
    `The seed book is above. Propose up to ${nQueries} CATALOG SEARCH QUERIES ` +
    '(search terms, not book titles) that would surface books a reader who loved this ' +
    'one is likely to enjoy. Chase its distinguishing qualities (voice, structure, ' +
    'mood, and specific subject matter) and avoid generic bestseller terms and the ' +
    "book's own author.";

  return [
    { type: 'text', text: seedBookContext(anchor), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskPrompt },
  ];
}

// --- stage 2: rank candidates by resemblance to the seed book ---------------

export const SIMILAR_RANK_TOOL = {
  name: 'rank_similar_books',
  description:
    'Rank the provided real catalog candidates by how similar they are to the seed ' +
    'book, and explain each pick. Choose ONLY from the given candidates.',
  input_schema: {
    type: 'object',
    properties: {
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            candidate_index: {
              type: 'integer',
              description: 'The `idx` of a provided candidate. Must exist.',
            },
            score: {
              type: 'number',
              description: '0..1 similarity to the seed book.',
            },
            rationale: {
              type: 'string',
              description:
                '1-2 sentences in the voice of a well-read friend: what the ' +
                'book does and how it echoes the seed book, naming the ' +
                'mechanism of the resemblance (pace, voice, structure, mood, ' +
                'subject), never just shared genre. Honest about stretch ' +
                'picks. Plain punctuation, no em dashes.',
            },
          },
          required: ['candidate_index', 'score', 'rationale'],
        },
      },
    },
    required: ['recommendations'],
  },
};

export const SIMILAR_RANK_SYSTEM =
  'You recommend books similar to ONE specific book the reader already knows. You rank a ' +
  'fixed list of real catalog candidates by how much they resemble that seed book, and you ' +
  'never invent books; you only rank the candidates given. You prefer specific resemblance ' +
  '(voice, structure, pace, mood, subject) over shared genre or popularity.\n\n' +
  'Write each rationale like a well-read friend pressing the book into their hands, in 1-2 ' +
  'sentences: lead with what the book does, then name exactly how it echoes the seed book. ' +
  'If a pick is a stretch, say so honestly and name what still connects. Use plain ' +
  'punctuation only: no em dashes. Never write "you\'ll love this", generic praise, or ' +
  'clinical genre-speak.';

/** recommend._rerank_similar's message content. */
export function buildSimilarRerankPrompt(
  candidates: AssembledCandidate[],
  anchor: BookAnchor,
  n: number
): PromptBlock[] {
  const indexed = candidates.map((c, i) => ({
    idx: i,
    title: c.title,
    author: c.author,
    year: c.year,
    subjects: c.subjects ?? [],
  }));

  const taskPrompt =
    `Rank the best ${n} candidates by similarity to the SEED BOOK and explain each. ` +
    'Choose ONLY from the CANDIDATES list (cite each by its `idx`). Score 0..1 for ' +
    'resemblance to the seed book. Name the mechanism of the resemblance in each ' +
    'rationale.\n\nCANDIDATES (JSON):\n' +
    pyJsonDumps(indexed);

  return [
    { type: 'text', text: seedBookContext(anchor), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskPrompt },
  ];
}
```

- [ ] **Step 4: Run the tests**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/parity-similar-prompts.test.ts
```

Expected: PASS (3 tests).

**If the rerank assertion fails on the candidate list** (not on a system/tool string), the retrieval chain diverged. Diff the two `CANDIDATES (JSON):` blocks — vitest prints both. Check in this order: `top_subjects` order (Task 2), `metadataPool`'s OL-then-GB-then-author call order, and whether `applyDirectiveConstraints` was mistakenly called. **Do not** edit the fixture to make the test pass.

- [ ] **Step 5: Commit**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx prettier --write lib/server/recSimilarPrompts.ts lib/server/__tests__/parity-similar-prompts.test.ts
cd /home/chase/Documents/Code/my-library
git add frontend/lib/server/recSimilarPrompts.ts frontend/lib/server/__tests__/parity-similar-prompts.test.ts
git commit -m "feat(node): similar-books prompts, proven byte-identical to Python"
```

---

## Task 4: The `recommend_similar()` orchestrator

Mirrors `recommendRun.ts` in shape but is simpler: no profile gate, no cold-start, no directive constraints, no persistence and therefore **no transaction**.

**Files:**
- Modify: `frontend/lib/server/claudeErrors.ts` (append)
- Create: `frontend/lib/server/recSimilarRun.ts`
- Test: `frontend/lib/server/__tests__/similar-run.test.ts` (new)

**Interfaces:**
- Consumes: `trackedCreate` (`anthropic.ts`); `toolInput`, `ClaudeClient` (`claude.ts`); `RECOMMEND_NO_KEY_MESSAGE`, `SIMILAR_NOT_ENOUGH_METADATA_MESSAGE` (`claudeErrors.ts`); `ApiError` (`errors.ts`); `buildBookSignal`, `BookAnchor`, `BookSignal` (`recSignal.ts`); `metadataPool`, `seedPool`, `assemble`, `fillOlDescriptions`, `MAX_CANDIDATES`, `PER_QUERY`, `SEED_QUERIES`, `AssembledCandidate` (`recAssemble.ts`); `SEED_MODEL`, `SEED_MAX_TOKENS`, `SEED_TOOL`, `RANK_MAX_TOKENS`, `rankModel` (`recPrompts.ts`); the Task 3 exports; `round2` (`serialize.ts`).
- Produces: `runSimilar(db: Db, client: ClaudeClient | null, userId: string, bookId: number, n: number): Promise<Record<string, unknown>>`.

- [ ] **Step 1: Add the error message**

Append to `frontend/lib/server/claudeErrors.ts`:

```ts
/** recommend_similar's metadata gate, surfaced by api.py as a 400. */
export const SIMILAR_NOT_ENOUGH_METADATA_MESSAGE =
  'Not enough metadata on this book to find similar reads. Enrich it first.';
```

- [ ] **Step 2: Write the failing test**

```ts
// frontend/lib/server/__tests__/similar-run.test.ts
import { describe, test, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import seedJson from './fixtures/parity/seed.json';
import httpFixtures from './fixtures/claude/recommend-http.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupParityEnv } from './helpers/parity';
import { installHttpReplay } from './helpers/httpReplay';
import { schema } from '../db';
import { runSimilar } from '../recSimilarRun';
import { ApiError } from '../errors';
import type { ClaudeClient } from '../claude';

const CANNED_SIMILAR_QUERIES = [
  'desert planet political intrigue science fiction',
  'ecological science fiction messianic prophecy',
];

/** A ClaudeClient that answers the facet call then the rerank call, in order. */
function fakeClient(rankedPayload: unknown[]): ClaudeClient & { calls: any[] } {
  const calls: any[] = [];
  let n = 0;
  return {
    calls,
    messages: {
      create: async (kwargs: any) => {
        calls.push(kwargs);
        n++;
        if (n === 1) {
          return {
            content: [
              {
                type: 'tool_use',
                name: 'propose_search_queries',
                input: {
                  queries: [
                    ...CANNED_SIMILAR_QUERIES.map((q) => ({ query: q, reason: 'f' })),
                    { query: '   ', reason: 'blank is dropped' },
                  ],
                },
              },
            ],
            usage: null,
          };
        }
        return {
          content: [
            {
              type: 'tool_use',
              name: 'rank_similar_books',
              input: { recommendations: rankedPayload },
            },
          ],
          usage: null,
        };
      },
    },
  } as any;
}

describe('runSimilar', () => {
  setupParityEnv();

  test('runs both stages, drops bad indices, rounds scores and does not persist', async () => {
    const { db, close } = await makeTestDb();
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClient([
        { candidate_index: 0, score: 0.875, rationale: '  padded  ' },
        { candidate_index: 1, score: 0.5, rationale: 'second' },
        { candidate_index: 9999, score: 0.99, rationale: 'hallucinated' },
        { candidate_index: 0, score: 0.99, rationale: 'duplicate' },
        { candidate_index: -1, score: 0.99, rationale: 'negative' },
      ]);
      const out: any = await runSimilar(db, client, 'local', 1, 8);

      expect(out.anchor_book_id).toBe(1);
      expect(out.anchor_title).toBe('Dune');
      expect(out.model).toBe('claude-sonnet-5');
      expect(out.seed_queries).toEqual(CANNED_SIMILAR_QUERIES); // blank query dropped
      expect(out.count).toBe(2);
      expect(out.recommendations).toHaveLength(2);
      expect(out.recommendations[0].rank).toBe(1);
      expect(out.recommendations[1].rank).toBe(2);
      // round(0.875, 2) is a banker's-rounding tie: 87 is odd, so it goes to 0.88.
      expect(out.recommendations[0].score).toBe(0.88);
      expect(out.recommendations[0].rationale).toBe('padded');
      expect(Object.keys(out.recommendations[0]).sort()).toEqual(
        [
          'author',
          'catalog_id',
          'catalog_source',
          'cover_url',
          'description',
          'isbn13',
          'rank',
          'rationale',
          'retrieval_pool',
          'score',
          'seed_reason',
          'subjects',
          'title',
          'year',
        ].sort()
      );

      // Ephemeral: nothing may reach the recommendations table.
      const rows = await db.select().from(schema.recommendations);
      expect(rows).toHaveLength((seedJson as any).recommendations.length);

      // Stage order and models.
      expect(client.calls[0].model).toBe('claude-haiku-4-5-20251001');
      expect(client.calls[1].model).toBe('claude-sonnet-5');
    } finally {
      restore();
      await close();
    }
  });

  test('400s with the no-key message, but only AFTER the metadata sweep', async () => {
    // PYTHON QUIRK (V8): _client() is called inside _book_facet_queries, which runs
    // after _metadata_pool. The key check must not be hoisted.
    const { db, close } = await makeTestDb();
    const seen: string[] = [];
    const restore = installHttpReplay(httpFixtures as any, (u) => seen.push(u));
    try {
      await loadSeed(db, seedJson as any);
      await expect(runSimilar(db, null, 'local', 1, 8)).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('No Anthropic API key configured'),
      });
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      restore();
      await close();
    }
  });

  test('400s when the book has no subjects, description or author', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      // Book 9 has no enrichment row; strip its author to trip the gate.
      await db.update(schema.books).set({ author: null }).where(eq(schema.books.id, 9));
      await expect(runSimilar(db, null, 'local', 9, 8)).rejects.toMatchObject({
        status: 400,
        detail: 'Not enough metadata on this book to find similar reads. Enrich it first.',
      });
    } finally {
      await close();
    }
  });

  test('400s with Python’s RuntimeError text for a book that is not the caller’s', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      await expect(runSimilar(db, null, 'local', 101, 8)).rejects.toBeInstanceOf(ApiError);
      await expect(runSimilar(db, null, 'local', 101, 8)).rejects.toMatchObject({
        status: 400,
        detail: 'Book 101 not found.',
      });
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/similar-run.test.ts
```

Expected: FAIL — `Cannot find module '../recSimilarRun'`.

- [ ] **Step 4: Implement**

```ts
// frontend/lib/server/recSimilarRun.ts
/**
 * Port of recommend.recommend_similar() — ephemeral "more books like this" for
 * one owned library book.
 *
 * Book-anchored: retrieval seeds from the single book's facets rather than the
 * taste profile, and it skips the profile-missing/stale gate, cold-start gating
 * and the directive constraints that /recommend applies. Results are NOT
 * persisted -- no `recommendations` rows -- so this opens no transaction at all.
 * Same-author caps and language filtering still apply, reused unchanged from the
 * shared 3c-1 retrieval core.
 */
import { trackedCreate } from './anthropic';
import { toolInput, type ClaudeClient } from './claude';
import { RECOMMEND_NO_KEY_MESSAGE, SIMILAR_NOT_ENOUGH_METADATA_MESSAGE } from './claudeErrors';
import type { Db } from './db';
import { ApiError } from './errors';
import {
  assemble,
  fillOlDescriptions,
  metadataPool,
  seedPool,
  MAX_CANDIDATES,
  PER_QUERY,
  SEED_QUERIES,
  type AssembledCandidate,
} from './recAssemble';
import { rankModel, RANK_MAX_TOKENS, SEED_MAX_TOKENS, SEED_MODEL, SEED_TOOL } from './recPrompts';
import { buildBookSignal, type BookAnchor } from './recSignal';
import {
  BOOK_FACET_SYSTEM,
  SIMILAR_RANK_SYSTEM,
  SIMILAR_RANK_TOOL,
  buildBookFacetPrompt,
  buildSimilarRerankPrompt,
} from './recSimilarPrompts';
import { round2 } from './serialize';

interface RankedSimilar extends AssembledCandidate {
  score: number;
  rationale: string;
}

export async function runSimilar(
  db: Db,
  client: ClaudeClient | null,
  userId: string,
  bookId: number,
  n: number
): Promise<Record<string, unknown>> {
  // Python's _client() checks the key at point of USE, inside _book_facet_queries.
  // That call happens AFTER the metadata catalog sweep, so a keyless user still
  // makes every metadata request before seeing the 400. Do not hoist this.
  const requireClient = (): ClaudeClient => {
    if (!client) throw new ApiError(400, RECOMMEND_NO_KEY_MESSAGE);
    return client;
  };

  const signal = await buildBookSignal(db, userId, bookId);
  // Python raises RuntimeError("Book N not found."), which api.py maps to a 400.
  // Unreachable through the route (it 404s on ownership first), kept for fidelity.
  if (signal === null) throw new ApiError(400, `Book ${bookId} not found.`);

  const anchor = signal.anchor;
  if (!signal.top_subjects.length && !anchor.description && !anchor.author) {
    throw new ApiError(400, SIMILAR_NOT_ENOUGH_METADATA_MESSAGE);
  }

  // cold_start is always false here: library thinness is irrelevant to a single seed.
  const metaPool = await metadataPool(db, signal, PER_QUERY, false);
  const seedQueries = await bookFacetQueries(db, requireClient(), anchor, userId, SEED_QUERIES);
  const seedEntries = await seedPool(db, seedQueries, PER_QUERY);

  const candidates = assemble(metaPool, seedEntries, signal, MAX_CANDIDATES);
  await fillOlDescriptions(db, candidates);
  const model = rankModel();

  if (candidates.length === 0) {
    return {
      anchor_book_id: anchor.id,
      anchor_title: anchor.title,
      count: 0,
      model,
      seed_queries: seedQueries,
      recommendations: [],
    };
  }

  const ranked = await rerankSimilar(db, requireClient(), candidates, anchor, userId, n);

  const recsOut = ranked.map((c, i) => ({
    rank: i + 1,
    title: c.title,
    author: c.author,
    year: c.year,
    isbn13: c.isbn13,
    cover_url: c.cover_url,
    subjects: c.subjects ?? [],
    description: c.description,
    catalog_source: c.catalog_source,
    catalog_id: c.catalog_id,
    retrieval_pool: c.retrieval_pool,
    seed_reason: c.seed_reason,
    score: round2(c.score),
    rationale: c.rationale,
  }));

  return {
    anchor_book_id: anchor.id,
    anchor_title: anchor.title,
    count: recsOut.length,
    model,
    seed_queries: seedQueries,
    recommendations: recsOut,
  };
}

/** recommend._book_facet_queries: stage 1b. Reuses SEED_TOOL, like Python. */
async function bookFacetQueries(
  db: Db,
  client: ClaudeClient,
  anchor: BookAnchor,
  userId: string,
  nQueries: number
): Promise<string[]> {
  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'similar_seed' },
    {
      model: SEED_MODEL,
      max_tokens: SEED_MAX_TOKENS,
      system: BOOK_FACET_SYSTEM,
      tools: [SEED_TOOL],
      tool_choice: { type: 'tool', name: 'propose_search_queries' },
      messages: [{ role: 'user', content: buildBookFacetPrompt(anchor, nQueries) }],
    }
  );
  // Python matches the FIRST tool_use block without checking its name.
  const input = toolInput(message as any, '');
  if (!input) return [];
  const items = (input.queries as Array<{ query?: string }> | undefined) ?? [];
  return items.filter((q) => (q?.query ?? '').trim() !== '').map((q) => String(q.query).trim());
}

/** recommend._rerank_similar: stage 2. */
async function rerankSimilar(
  db: Db,
  client: ClaudeClient,
  candidates: AssembledCandidate[],
  anchor: BookAnchor,
  userId: string,
  n: number
): Promise<RankedSimilar[]> {
  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'similar_rerank' },
    {
      model: rankModel(),
      max_tokens: RANK_MAX_TOKENS,
      system: SIMILAR_RANK_SYSTEM,
      tools: [SIMILAR_RANK_TOOL],
      tool_choice: { type: 'tool', name: 'rank_similar_books' },
      messages: [{ role: 'user', content: buildSimilarRerankPrompt(candidates, anchor, n) }],
    }
  );

  const input = toolInput(message as any, '');
  const rankedRaw = (input?.recommendations as Array<Record<string, unknown>> | undefined) ?? [];

  const out: RankedSimilar[] = [];
  const seenIdx = new Set<number>();
  for (const r of rankedRaw) {
    const idx = r.candidate_index;
    // Drop hallucinated / duplicate indices. Same intentional divergence from
    // Python's `isinstance(idx, int)` as recommendRun.claudeRerank -- JSON.parse
    // erases the int/float distinction, and this is the safer reading either way.
    if (
      typeof idx !== 'number' ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= candidates.length ||
      seenIdx.has(idx)
    ) {
      continue;
    }
    seenIdx.add(idx);
    out.push({
      ...candidates[idx],
      score: Number(r.score ?? 0),
      rationale: String(r.rationale ?? '').trim(),
    });
  }

  out.sort((a, b) => b.score - a.score);
  // Prefer candidates with descriptions (better UX), but never drop below n if
  // description-having candidates are scarce.
  const withDesc = out.filter((c) => c.description);
  const withoutDesc = out.filter((c) => !c.description);
  return [...withDesc, ...withoutDesc].slice(0, n);
}
```

- [ ] **Step 5: Run the tests**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/similar-run.test.ts lib/server/__tests__/parity-similar-prompts.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx prettier --write lib/server/recSimilarRun.ts lib/server/claudeErrors.ts lib/server/__tests__/similar-run.test.ts
cd /home/chase/Documents/Code/my-library
git add frontend/lib/server/recSimilarRun.ts frontend/lib/server/claudeErrors.ts frontend/lib/server/__tests__/similar-run.test.ts
git commit -m "feat(node): port the recommend_similar orchestrator"
```

---

## Task 5: The route, its 15/minute limit, and the backend flip

**Files:**
- Modify: `frontend/lib/server/ratelimit.ts`
- Create: `frontend/app/api/books/[id]/similar/route.ts`
- Test: `frontend/lib/server/__tests__/similar-route.test.ts` (new)
- Modify: `frontend/lib/server/__tests__/ratelimit.test.ts:44-47`
- Modify: `frontend/lib/server/__tests__/ratelimit-routes.test.ts`
- Modify: `frontend/lib/backend.ts:32`
- Modify: `frontend/lib/__tests__/backend.test.ts:47`, `:105-106`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `withApi`, `ApiError` (`http.ts`); `getDb`, `schema` (`db.ts`); `parseIdParam` (`serialize.ts`); `resolveAnthropicKey`, `makeAnthropicClient` (`claude.ts`); `runSimilar` (`recSimilarRun.ts`); `checkRateLimit`, `RATE_LIMITS`, `rateLimitExceededResponse` (`ratelimit.ts`).
- Produces: `RATE_LIMITS.booksSimilar = { limit: 15, windowSeconds: 60 }`; `POST` from `app/api/books/[id]/similar/route.ts`.

- [ ] **Step 1: Add the rate-limit bucket**

In `frontend/lib/server/ratelimit.ts`, extend `RATE_LIMITS` and its doc comment:

```ts
/** Parity with mylibrary/api.py decorators: 30/minute catalog search, 5/minute enrich
 *  start, 30/minute directive draft, 15/minute similar books. Each route uses its own
 *  bucket key — these limits are independent, not shared. */
export const RATE_LIMITS = {
  catalogSearch: { limit: 30, windowSeconds: 60 },
  enrichStart: { limit: 5, windowSeconds: 60 },
  directiveDraft: { limit: 30, windowSeconds: 60 },
  booksSimilar: { limit: 15, windowSeconds: 60 },
} as const;
```

In `frontend/lib/server/__tests__/ratelimit.test.ts`, add to the existing limits assertion block (alongside `catalogSearch` / `enrichStart`):

```ts
    expect(RATE_LIMITS.booksSimilar).toEqual({ limit: 15, windowSeconds: 60 });
```

- [ ] **Step 2: Write the failing route test**

```ts
// frontend/lib/server/__tests__/similar-route.test.ts
import { describe, test, expect } from 'vitest';
import seedJson from './fixtures/parity/seed.json';
import httpFixtures from './fixtures/claude/recommend-http.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupParityEnv } from './helpers/parity';
import { installHttpReplay } from './helpers/httpReplay';
import { _setDbForTests, schema } from '../db';
import { POST } from '@/app/api/books/[id]/similar/route';

const req = (id: string, body?: unknown) =>
  new Request(`http://test/api/books/${id}/similar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const call = (id: string, body?: unknown) =>
  POST(req(id, body), { params: Promise.resolve({ id }) });

describe('POST /api/books/[id]/similar', () => {
  setupParityEnv();

  test('mirrors FastAPI’s validation: 422 on a missing body and on n out of range', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      _setDbForTests(db);
      expect((await call('1')).status).toBe(422); // missing body
      expect((await call('1', { n: 0 })).status).toBe(422); // ge=1
      expect((await call('1', { n: 21 })).status).toBe(422); // le=20
      expect((await call('1', { n: 'x' })).status).toBe(422);
      expect((await call('abc', { n: 8 })).status).toBe(422); // non-integer path id
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('404s for a missing book and for another tenant’s book', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      _setDbForTests(db);
      const missing = await call('999', {});
      expect(missing.status).toBe(404);
      // No trailing period -- this is api.py's HTTPException detail, not
      // recommend_similar's RuntimeError text.
      expect((await missing.json()).detail).toBe('Book 999 not found');
      expect((await call('101', {})).status).toBe(404);
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('400s with the no-key message, after the metadata sweep', async () => {
    const { db, close } = await makeTestDb();
    // Book 1's metadata sweep issues 7 catalog requests before the key check (V8),
    // so the recorded fixture must be replayed or the test would hit the network.
    // seedPool never runs — requireClient() throws first.
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await loadSeed(db, seedJson as any);
      // setupParityEnv clears the env key, but the SEED stores an encrypted per-user
      // key for 'local'. Without clearing it too, a real Anthropic client is built
      // and the run 500s on a live network call.
      await db.update(schema.userSettings).set({ anthropicApiKeyEncrypted: null });
      _setDbForTests(db);
      const res = await call('1', { n: 3 });
      expect(res.status).toBe(400);
      expect((await res.json()).detail).toContain('No Anthropic API key configured');
    } finally {
      restore();
      _setDbForTests(null);
      await close();
    }
  });
});
```

Then extend `frontend/lib/server/__tests__/ratelimit-routes.test.ts`. That file uses `it` (not `test`), relative route imports, and a local `silenceLogs()` helper. Add one import beside the two existing route imports at the top:

```ts
import { POST as booksSimilar } from '../../../app/api/books/[id]/similar/route';
```

and add this `it` block inside the existing `describe('429 rate-limit response shape, driven through the real routes', ...)`, after the `directive/draft` one. It does **not** reuse `assertCorrected429` — that helper hardcodes `30 per 1 minute`:

```ts
  it('POST /api/books/[id]/similar returns the corrected body once the 15/minute limit is exceeded', async () => {
    silenceLogs();
    const { db, close } = await makeTestDb();
    try {
      expect(RATE_LIMITS.booksSimilar).toEqual({ limit: 15, windowSeconds: 60 });
      _setDbForTests(db);
      let last: Response | undefined;
      for (let i = 0; i < RATE_LIMITS.booksSimilar.limit + 1; i++) {
        // A book id that does not exist, against an unseeded database: the rate
        // limit is checked BEFORE the ownership 404 (FastAPI validates the body,
        // then slowapi's decorator runs, then the handler body), so each of these
        // consumes a slot and none of them reaches the catalog or Claude.
        last = await booksSimilar(
          new Request('http://test/api/books/999/similar', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ n: 8 }),
          }),
          { params: Promise.resolve({ id: '999' }) }
        );
      }
      expect(last!.status).toBe(429);
      expect(await last!.json()).toEqual({ error: 'Rate limit exceeded: 15 per 1 minute' });
      expect(last!.headers.get('content-type')).toBe('application/json');
      expect(last!.headers.get('retry-after')).toBeNull();
    } finally {
      _setDbForTests(null);
      await close();
    }
  });
```

The first 15 calls return 404; only the 16th is the 429 being asserted.

- [ ] **Step 3: Run them and watch them fail**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/similar-route.test.ts lib/server/__tests__/ratelimit-routes.test.ts lib/server/__tests__/ratelimit.test.ts
```

Expected: FAIL — `Cannot find module '@/app/api/books/[id]/similar/route'`, plus the new `RATE_LIMITS.booksSimilar` assertion if Step 1 was skipped.

- [ ] **Step 4: Implement the route**

```ts
// frontend/app/api/books/[id]/similar/route.ts
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { parseIdParam } from '@/lib/server/serialize';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { checkRateLimit, RATE_LIMITS, rateLimitExceededResponse } from '@/lib/server/ratelimit';
import { runSimilar } from '@/lib/server/recSimilarRun';

// Two Claude calls (a Haiku facet pass and a Sonnet rerank) plus up to ~35 catalog
// fetches. 300s is Vercel Hobby's maximum and the default on every tier.
export const maxDuration = 300;

/** Twin of schemas.SimilarRequest: n: int = 8, ge=1, le=20. */
const Body = z.object({
  n: z.number().int().min(1).max(20).default(8),
});

/**
 * Port of api.py::similar_books (940-961). Ephemeral "more books like this" for one
 * owned library book; nothing is persisted.
 *
 * Order of checks matches FastAPI: the body is validated during dependency
 * resolution (422), THEN slowapi's decorator runs (429), THEN the handler body's
 * ownership query (404). Verified against the real app with TestClient.
 */
export const POST = withApi('/api/books/[id]/similar', async (req, ctx) => {
  const bookId = parseIdParam(ctx.params.id);

  // FastAPI 422s on a MISSING body for a Pydantic-model parameter even when every
  // field is defaulted, but accepts `{}` and fills the defaults in. A failed parse
  // is the missing-body case.
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(422, 'validation error: body is required');
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    // DEVIATION: FastAPI returns a structured detail ARRAY; every Node route in this
    // migration returns a string detail instead. Established in wave 2, kept here.
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }

  const db = getDb();
  const rl = await checkRateLimit(db, {
    key: `books_similar:${ctx.user.userId}`,
    ...RATE_LIMITS.booksSimilar,
  });
  if (!rl.allowed) {
    // Corrected 429 shape (not the usual {"detail": ...}) -- see
    // rateLimitExceededResponse's doc comment in ratelimit.ts.
    return rateLimitExceededResponse(
      RATE_LIMITS.booksSimilar.limit,
      RATE_LIMITS.booksSimilar.windowSeconds
    );
  }

  const owned = await db
    .select({ id: schema.books.id })
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, ctx.user.userId)));
  // api.py's HTTPException detail has NO trailing period, unlike
  // recommend_similar's own RuntimeError text. Keep them distinct.
  if (owned.length === 0) throw new ApiError(404, `Book ${bookId} not found`);

  // Resolve the key once and hand it down. NOT raised here: Python checks the key
  // at point of use, inside the facet-query stage, which runs after the metadata
  // catalog sweep.
  const apiKey = await resolveAnthropicKey(db, ctx.user.userId);
  const client = apiKey ? makeAnthropicClient(apiKey) : null;

  const out = await runSimilar(db, client, ctx.user.userId, bookId, parsed.data.n);
  ctx.timer.mark('claude');
  return Response.json(out);
});
```

- [ ] **Step 5: Run the route tests**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/similar-route.test.ts lib/server/__tests__/ratelimit-routes.test.ts lib/server/__tests__/ratelimit.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Flip the route to Node in auto mode**

In `frontend/lib/backend.ts`, replace line 32:

```ts
  { prefix: '/books', methods: ['POST'], exact: true }, // Load-bearing: without exact, POST /books/{id}/similar (wave-3 Claude flow) would incorrectly match this rule via prefix+method and flip to Node
```

with:

```ts
  // Wave 3c-2: `exact` dropped so POST /books/{id}/similar follows POST /books to
  // Node. Safe because those are the ONLY two POST routes Python serves under
  // /books (verified against mylibrary/api.py). A future Python POST /books/*
  // route would be captured by this rule -- re-add `exact` and give it its own
  // entry if that ever happens.
  { prefix: '/books', methods: ['POST'] },
```

Also update the file's header comment: the line reading

```
 * prefix (`POST /books/{id}/similar`, `POST /directive/draft`).
```

becomes

```
 * prefix (`POST /directive/draft`).
 * Wave 3c-2: `POST /books/{id}/similar` (ephemeral "more like this") flips to Node.
```

- [ ] **Step 7: Update the backend switcher tests**

In `frontend/lib/__tests__/backend.test.ts`, the "wave-3/wave-4 paths ... stay on Python" test currently opens with the similar assertion. Replace that line:

```ts
    expect(baseFor('/books/12/similar', 'POST')).toBe(PY); // wave-3 Claude flow (wave-3c)
```

with:

```ts
    expect(baseFor('/books/12/similar', 'POST')).toBe('/api'); // wave 3c-2
```

and in the "wave-3a: catalog search and POST routes flip to Node" test, replace:

```ts
    // still Python — 3c-2/3c-3/4/5
    expect(baseFor('/books/12/similar', 'POST')).toBe(PY); // 3c-2
```

with:

```ts
    expect(baseFor('/books/12/similar', 'POST')).toBe('/api'); // wave 3c-2
    // The POST /books rule is no longer `exact`; both it and its /similar child
    // are Node, and GET/PATCH/DELETE children are unaffected.
    expect(baseFor('/books', 'POST')).toBe('/api');
    expect(baseFor('/books/12', 'DELETE')).toBe('/api');
    // still Python — 3c-3/4/5
```

- [ ] **Step 8: Run the whole suite**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run
npx tsc --noEmit
```

Expected: all tests PASS and no type errors. If `tsc` reports an unused import in `recSignal.ts` (`AssembleSignal` is type-only), confirm it is imported with `import type`.

- [ ] **Step 9: Verify in the real app**

Tests alone are not sufficient (global rule). Bring up the app against a throwaway local database and exercise the flow in the browser.

```bash
# Terminal 1 — see the isolated-local-env skill for the SQLite/local-mode setup.
cd /home/chase/Documents/Code/my-library && python -m mylibrary.cli serve
# Terminal 2
cd /home/chase/Documents/Code/my-library/frontend && npm run dev
```

Then, in the browser at http://localhost:3000:
1. Open a book detail view and trigger "more books like this" (`api.similarBooks`).
2. Confirm results render, and that the DevTools Network tab shows the request going to **`/api/books/<id>/similar`** (same-origin Node), not to `127.0.0.1:8000`.
3. Confirm nothing new appears in the recommendations feed / swipe deck — these results are ephemeral.
4. Report what you saw. If a real Anthropic key is not available locally, say so explicitly rather than claiming the flow was verified.

- [ ] **Step 10: Update CLAUDE.md**

In the "Node backend migration underway" paragraph, replace the sentence

> Wave 3c-2 (`/books/{id}/similar`, which must also reproduce Python's 15/minute rate
> limit) and 3c-3 (`/discover`) are next — both consume 3c-1's retrieval core unchanged.

with:

> Wave 3c-2 shipped `POST /books/{id}/similar`: a book-anchored signal
> (`recSignal.buildBookSignal`), two new prompts (`recSimilarPrompts.ts`), the
> `recommend_similar` orchestrator (`recSimilarRun.ts`) and the route, with Python's
> 15/minute SlowAPI limit reproduced via `RATE_LIMITS.booksSimilar`. Its parity test
> replays the same `recommend-http.json`, which the generator now also records along
> the similar path — that recording is where `fillOlDescriptions` and `capPool`'s
> `length <= cap` early return are finally fixture-proven, since `/recommend`'s
> 138-candidate pool trims description-less Open Library candidates before they get
> there. Three Python quirks are reproduced deliberately on this path: the series and
> fuzzy-duplicate filters are inert (`_build_book_signal` returns no `library_series`
> or `library_titles`), rejected recommendations are not excluded, and custom
> instructions do not steer it. Wave 3c-3 (`/discover`) is next, then wave 4
> (jobs + imports) and wave 5 (admin + cutover).

- [ ] **Step 11: Commit**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx prettier --write lib/server/ratelimit.ts lib/backend.ts \
  'app/api/books/[id]/similar/route.ts' \
  lib/server/__tests__/similar-route.test.ts \
  lib/server/__tests__/ratelimit.test.ts \
  lib/server/__tests__/ratelimit-routes.test.ts \
  lib/__tests__/backend.test.ts
cd /home/chase/Documents/Code/my-library
git add frontend/app/api/books frontend/lib/server/ratelimit.ts frontend/lib/backend.ts \
  frontend/lib/server/__tests__/similar-route.test.ts \
  frontend/lib/server/__tests__/ratelimit.test.ts \
  frontend/lib/server/__tests__/ratelimit-routes.test.ts \
  frontend/lib/__tests__/backend.test.ts CLAUDE.md
git commit -m "feat(node): POST /books/{id}/similar and flip it to Node in auto mode"
```

---

## Done when

- `npx vitest run` passes in `frontend/`, including the two new parity assertions.
- `npx tsc --noEmit` is clean.
- `prompts.json` contains `similar_seed` and `similar_rerank`; `recommend-http.json` contains at least one `/works/` URL.
- The browser flow in Task 5 Step 9 was actually exercised and reported.
- `POST /books/{id}/similar` reaches `/api` in auto mode; `POST /discover` still reaches Python.
