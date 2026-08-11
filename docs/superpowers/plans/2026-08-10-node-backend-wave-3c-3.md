# Node Backend Wave 3c-3 — `POST /discover` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `recommend.discover()` — ephemeral natural-language discovery ("find me a book like X") — and its FastAPI route `POST /discover` (including the 30/minute rate limit) to a Next.js route handler, proven byte-identical against prompts and catalog traffic recorded from the real Python implementation. This closes wave 3c.

**Architecture:** Waves 3c-1 and 3c-2 already shipped everything reusable: `buildSignal` (the full library signal — discovery uses it unchanged), `assemble`, `fillOlDescriptions`, `capPool`, `subjectHits`, and `catalog.ts`'s `googleBooksQuery` / `openlibraryQuery`. **This plan adds only what is specific to discovery**: a constraint cleaner, a pool-level constraint filter, a two-source query pool, two new Claude prompts, an orchestrator, and the route.

Discovery is the odd one out in three ways worth holding in your head: it passes an **empty metadata pool** to `assemble` (the interpreted queries *are* the whole pool, so every candidate is tagged `claude_seed`), it filters the **raw pool before assembly** rather than the assembled candidates, and a stated language constraint **overrides** the reader's library languages for that run.

Claude output is nondeterministic, so "parity" here means the **request** is byte-identical. The rerank prompt embeds a candidate list built from live catalog responses, so the Node test replays the recorded HTTP and rebuilds the same prompt — which also re-proves `cleanConstraints`, the pool filter, and assembly along this path.

**Tech Stack:** Next.js 15 route handlers, drizzle-orm over postgres-js, vitest + PGlite, `@anthropic-ai/sdk`, zod for body validation.

---

## Global Constraints

These apply to **every** task. Read them before starting any task.

1. **Python is the specification.** When Python does something that looks wrong, reproduce it. Do not "fix" it in Node. Deviations are allowed only where this plan explicitly names one, and each must carry a comment explaining why.
2. **No Claude call inside a transaction.** `lib/server/db.ts` opens the pool with `max: 1`; touching the outer `db` while a `tx` is open deadlocks. This flow persists **nothing**, so it must not open a transaction at all.
3. **Ordered mappings bound for a prompt must be a `Map`** when any key is integer-like. Nothing in this wave has integer-like keys; the `indexed` candidate objects and the constraints object are plain objects, matching the existing builders.
4. **Python floats render differently.** `json.dumps(1.0)` → `1.0`; `JSON.stringify(1.0)` → `1`. Both discovery prompts embed the traits JSON, whose `confidence` and `user_weight` are floats — they are already `PyFloat`-wrapped by `buildSignal`, and both prompts get them via the shared `tasteAndLoved` helper. Do not hand-roll a second traits serializer.
5. **`{}` is truthy in JS, falsy in Python.** Every Python `if not some_dict:` becomes `if (Object.keys(d).length === 0)`, never `if (!d)`. This matters twice in this wave: `_apply_discovery_constraints`' early return and `constraints.get("languages")`.
6. **Alembic remains the sole migration authority.** This wave adds no columns and no migrations.
7. **Never read or print values from `.env` / `.env.local`.** Variable *names* only. Task 1 needs `GOOGLE_BOOKS_API_KEY` to be **present**; verify with an existence check, never by printing it.
8. **Do not run `git commit` unless the plan step says to commit.** Never add a `Co-Authored-By: Claude` trailer.
9. **Do not run destructive writes against the real dev Postgres.** All verification is against PGlite (tests) or the generator's throwaway SQLite.
10. Run `npx prettier --write <files you touched>` before each commit, from `frontend/`. Do **not** run a repo-wide `npm run format`. `lib/server/__tests__/fixtures/claude/` is in `.prettierignore`; leave it alone.

---

## Verified Facts

Every claim below was **executed and confirmed** against this repo on 2026-08-10, not inferred from reading. Trust them; do not re-derive them, and do not "correct" code that follows them.

| # | Fact | Evidence |
|---|---|---|
| V1 | `discover()` makes exactly **two** Claude calls: `discover_interpret` (`claude-haiku-4-5-20251001`, `max_tokens=1500`, tool `interpret_request`) then `discover_rerank` (`settings.model` = `claude-sonnet-5`, `max_tokens=4000`, tool `rank_discovery`). Both send one user message with a **2-block** content array; block 0 carries `cache_control: {"type": "ephemeral"}`. | Ran `discover("something like The Fifth Season but gentler", n=10)` with a monkeypatched `tracked_create` |
| V2 | The two block-0 prefixes **differ by one substring** and are NOT interchangeable: interpret uses `READER TASTE PROFILE (secondary context; the request rules):` and rerank uses `READER TASTE PROFILE (secondary - the request rules):`. Everything after that prefix is identical to `recPrompts.tasteAndLoved(signal)` — the same `TASTE TRAITS (JSON):` / `LOVED BOOKS (JSON):` pair, sliced to `LOVED_SAMPLE`. | Captured both block 0 texts and diffed them |
| V3 | `discover()` has **no** profile-missing/stale gate and **no** cold-start gating, and it reads the FULL `_build_signal` (so rejected recommendations *are* excluded, unlike the similar path). | Ran against the un-bumped SEED; read `recommend.py:1789-1795` |
| V4 | `discover()` passes an **empty metadata pool**: `_assemble([], pool, signal, cap=_MAX_CANDIDATES)`. Every candidate therefore comes out tagged `retrieval_pool: "claude_seed"`. | Probe output — all returned recs carried `claude_seed` |
| V5 | `_discovery_pool` runs **both** sources per query (Google Books then Open Library free-text), unlike `_seed_pool` which is Google-only. Two canned queries produced exactly **4 catalog URLs**: 2 googleapis + 2 openlibrary `search.json`. | Probe URL list |
| V6 | `_clean_constraints` normalization, exactly: `languages` → strip, lowercase, **truncate to 2 chars** (`"ENG"` → `"en"`, `" fr "` → `"fr"`), blanks dropped; `min_year`/`max_year` accept an `int` or an all-digit `str` (`"1990"` → `1990`) but **reject `bool` and `float`**; `exclude_subjects` → strip + lowercase, blanks dropped; every unsupported key (`page_count_max`, `standalone`, …) is **dropped**. Empty in → empty out. | Called `_clean_constraints` directly on eight inputs |
| V7 | `_apply_discovery_constraints` filters the **raw pool** (`list[tuple[cand, reason]]`) *before* `_assemble`, so the cap can never keep a constraint-violating book over a valid one. It has **no `exclude_authors`** branch (unlike `_apply_directive_constraints`), and unknown/missing fields always PASS. | Read `recommend.py:964-999`; confirmed the filtered candidate list in the captured prompt |
| V8 | A stated `languages` constraint **replaces** `signal["library_languages"]` for the run (`signal = {**signal, "library_languages": set(...)}`), which is how it reaches `_allowed_languages` inside `_assemble`. | Read `recommend.py:1812-1815`; observed the widened allow-set in the probe |
| V9 | `discover()` does **not** call `_apply_directive_constraints`, and neither prompt includes `_user_steering_block`. The standing custom-instructions directive does not steer discovery at all. | Read `recommend.py:1775-1860` + both captured prompts |
| V10 | The key check is **early**: `_client()` raises inside `_interpret_query`, which runs before any catalog call (discovery has no metadata pool). A keyless user makes **zero** catalog requests. Message is byte-identical to `RECOMMEND_NO_KEY_MESSAGE`. | Read the call order; `_client` at `recommend.py:206-223` |
| V11 | Two distinct early returns: when stage A yields no queries the result carries `queries: []`; when the candidate pool is empty it carries `queries: queries`. Both carry the interpretation and `count: 0`. | Probe with a canned empty-queries response |
| V12 | An empty/whitespace query raises `RuntimeError("Enter something to search for.")` → 400. Pydantic's `min_length=1` catches `""` at 422 first, but `"   "` (3 chars) passes validation and reaches the 400. | Probe + `TestClient` |
| V13 | HTTP contract, via `TestClient`: missing body → **422**; `{}` → **422** (`query` is required, no default); `{"query": ""}` → **422**; 501 chars → **422**; 500 chars → **200**; `{"n": 0}` / `{"n": 21}` / `{"n": "x"}` → **422**. `DiscoverRequest` is `query: str (min_length=1, max_length=500)`, `n: int = 10 (ge=1, le=20)`. | `TestClient` probe |
| V14 | `_rerank_discovery` drops hallucinated and duplicate `candidate_index` values, `.strip()`s the rationale, sorts by score descending, reorders description-having candidates first, then slices to `n` — identical to `_rerank_similar`. `round(0.875, 2)` → `0.88`. | Probe with canned ranked payloads |
| V15 | `frontend/lib/api.ts` (`api.discover`) is the sole caller, already typed as `DiscoverResult`. No frontend change is needed by the flip. `/discover` has no sibling sub-paths, so an `exact: true` backend rule is correct. | Repo-wide grep + `grep '@app.post("/discover' mylibrary/api.py` |

### Python quirks to reproduce, not fix

- **V7** — no `exclude_authors` on this path. Do not reuse `applyDirectiveConstraints` here; it would silently add that branch.
- **V9** — the directive does not steer discovery. Do not add `userSteeringBlock` to either prompt.
- **V2** — the two profile-context prefixes differ. Do not "unify" them.
- The `query` string is interpolated raw inside double quotes in both task prompts (`The reader asked: "{query}"`). A query containing a `"` produces unbalanced quotes in Python too. Reproduce; do not escape.

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `frontend/lib/server/recDiscoverPrompts.ts` | Verbatim `_DISCOVER_SYSTEM`, `_DISCOVER_TOOL`, `_DISCOVER_RANK_SYSTEM`, `_DISCOVER_RANK_TOOL` + both prompt builders |
| `frontend/lib/server/recDiscoverRun.ts` | `runDiscover` — the `discover()` orchestrator (no persistence) |
| `frontend/app/api/discover/route.ts` | `POST /api/discover` handler |
| `frontend/lib/server/__tests__/rec-discover-filters.test.ts` | |
| `frontend/lib/server/__tests__/parity-discover-prompts.test.ts` | The payoff: byte-identical prompt assertions |
| `frontend/lib/server/__tests__/discover-run.test.ts` | |
| `frontend/lib/server/__tests__/discover-route.test.ts` | |

**Modified files**

| File | Change |
|---|---|
| `scripts/gen_claude_fixtures.py` | Two new scenarios (`discover_interpret`, `discover_rerank`) + their canned interpretation |
| `frontend/lib/server/__tests__/fixtures/claude/prompts.json` | Regenerated; gains 2 keys |
| `frontend/lib/server/__tests__/fixtures/claude/recommend-http.json` | Regenerated; gains discovery's 4 URLs |
| `frontend/lib/server/recFilters.ts` | `cleanConstraints`, `applyDiscoveryConstraints` |
| `frontend/lib/server/recAssemble.ts` | `discoveryPool` |
| `frontend/lib/server/recPrompts.ts` | `tasteAndLoved` becomes exported |
| `frontend/lib/server/claudeErrors.ts` | `DISCOVER_EMPTY_QUERY_MESSAGE` |
| `frontend/lib/server/ratelimit.ts` | `RATE_LIMITS.discover` |
| `frontend/lib/server/__tests__/ratelimit.test.ts` | Assert the new bucket |
| `frontend/lib/server/__tests__/ratelimit-routes.test.ts` | Drive the new route past 30/minute |
| `frontend/lib/backend.ts` | `POST /discover` flips to Node |
| `frontend/lib/__tests__/backend.test.ts` | One assertion flips from Python to Node |
| `CLAUDE.md` | Wave 3c-3 status; wave 3c complete |

**Dependency order:** Task 1 (fixtures) → Task 2 (constraints + pool) → Task 3 (prompts + parity) → Task 4 (orchestrator) → Task 5 (route + rate limit + flip).

---

## Task 1: Record the discovery Claude prompts and catalog traffic

**Files:**
- Modify: `scripts/gen_claude_fixtures.py`
- Regenerate + commit: `frontend/lib/server/__tests__/fixtures/claude/prompts.json` (gains 2 keys)
- Regenerate + commit: `frontend/lib/server/__tests__/fixtures/claude/recommend-http.json` (gains 4 URLs)

**Interfaces:**
- Produces: `prompts.json` keys `discover_interpret` and `discover_rerank`, each `{operation, user_id, kwargs}`.
- Produces: the same flat `recommend-http.json` map, now also covering discovery's two Google Books and two Open Library `search.json` URLs.

- [ ] **Step 1: Confirm a Google Books key is available (existence only)**

```bash
cd /home/chase/Documents/Code/my-library
grep -q '^GOOGLE_BOOKS_API_KEY=.\+' .env && echo "GOOGLE_BOOKS_API_KEY: present" || echo "GOOGLE_BOOKS_API_KEY: MISSING — stop and ask Chase"
```

If it is missing, **stop**. The generator refuses to write a fixture where a whole host returned nothing.

- [ ] **Step 2: Add the discovery scenario helpers**

In `scripts/gen_claude_fixtures.py`, insert directly **above** the `# name -> (flow, canned responses ...)` comment that precedes `SCENARIOS`:

```python
# The reader's request and Claude's canned interpretation of it. These strings
# determine which catalog URLs land in recommend-http.json, so changing them
# requires a regeneration run AND the same edit in parity-discover-prompts.test.ts.
#
# The constraints block is deliberately messy: it exercises every branch of
# _clean_constraints in one shot -- case/whitespace normalization, the 2-char
# language truncation, an integer-as-string year, and two unsupported keys that
# must be dropped -- and the surviving constraints then really filter the pool
# before assembly.
DISCOVER_QUERY = "something like The Fifth Season but gentler"

_DISCOVER_INTERP_CANNED = _CannedMessage(
    "interpret_request",
    {
        "interpretation": "Epic fantasy with a broken world, but warmer in tone.",
        "queries": [
            {"query": "literary fantasy found family", "rationale": "fixture"},
            {"query": "gentle epic fantasy hopeful tone", "rationale": "fixture"},
            {"query": "   ", "rationale": "blank -- must be dropped before retrieval"},
        ],
        "constraints": {
            "languages": ["ENG", " fr ", ""],
            "min_year": "1990",
            "max_year": 2020,
            "exclude_subjects": [" War ", "grief", ""],
            "page_count_max": 400,
            "standalone": True,
        },
    },
)


def _run_discover():
    # No _prepare_recommend() call: discover() has no profile-missing or
    # profile-stale gate and no cold-start gating (verified by probe).
    return recommend_mod.discover(DISCOVER_QUERY, n=10)  # n=10 is DiscoverRequest's default
```

- [ ] **Step 3: Register the two scenarios**

Append inside `SCENARIOS`, after the two `similar_*` entries (the `# --- append below this line only ---` rule still applies):

```python
    "discover_interpret": (_run_discover, [], 0),
    "discover_rerank": (_run_discover, [_DISCOVER_INTERP_CANNED], 1),
```

No change to `main()`.

- [ ] **Step 4: Regenerate the fixtures**

```bash
cd /home/chase/Documents/Code/my-library
.venv/bin/python scripts/gen_claude_fixtures.py
```

Expected tail (URL count will vary a little):

```
wrote frontend/lib/server/__tests__/fixtures/claude/prompts.json scenarios: [..., 'similar_seed', 'similar_rerank', 'discover_interpret', 'discover_rerank']
wrote frontend/lib/server/__tests__/fixtures/claude/recommend-http.json urls: 53
```

The count should rise from 49 to roughly 53 (discovery's 4 URLs).

**If the run fails with `discover_rerank captured 1 Claude call(s) but needs index 1`:** the constraint filter emptied the candidate pool, so `discover()` took its early return and never made the rerank call. The catalog's live results moved. Widen the canned constraints — raise `max_year` (2020 is the likeliest culprit; recent Google Books hits are dated 2025) — then delete nothing and re-run. Do **not** work around it by removing the constraints entirely; the whole point is that this fixture exercises the filter.

- [ ] **Step 5: Verify the recording**

```bash
cd /home/chase/Documents/Code/my-library
.venv/bin/python -c "
import json
d = json.load(open('frontend/lib/server/__tests__/fixtures/claude/prompts.json'))
print('scenarios:', list(d))
for k in ('discover_interpret', 'discover_rerank'):
    kw = d[k]['kwargs']
    print(k, kw['model'], kw['max_tokens'], [t['name'] for t in kw['tools']], kw['tool_choice'])
    print('  block0 prefix:', repr(kw['messages'][0]['content'][0]['text'][:60]))
h = json.load(open('frontend/lib/server/__tests__/fixtures/claude/recommend-http.json'))
print('urls:', len(h), '| OL search.json:', sum(1 for u in h if 'search.json' in u))
print('key leaked:', any('key=' in u for u in h))
"
```

Expected:
```
scenarios: [..., 'discover_interpret', 'discover_rerank']
discover_interpret claude-haiku-4-5-20251001 1500 ['interpret_request'] {'type': 'tool', 'name': 'interpret_request'}
  block0 prefix: 'READER TASTE PROFILE (secondary context; the request rules):\n'
discover_rerank claude-sonnet-5 4000 ['rank_discovery'] {'type': 'tool', 'name': 'rank_discovery'}
  block0 prefix: 'READER TASTE PROFILE (secondary - the request rules):\n'
urls: 53 | OL search.json: 2
key leaked: False
```

The two block-0 prefixes **must differ** (V2). If they are identical, the wrong scenario was captured.

- [ ] **Step 6: Confirm the existing parity tests still pass**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/parity-prompts.test.ts lib/server/__tests__/parity-recommend-prompts.test.ts lib/server/__tests__/parity-similar-prompts.test.ts
```

Expected: all PASS. `recommend_rerank` and `similar_rerank` may churn by a candidate or two (live catalog data); their tests rebuild from the same re-recorded HTTP, so they stay consistent. Nothing else may move.

```bash
cd /home/chase/Documents/Code/my-library
git diff --stat frontend/lib/server/__tests__/fixtures/claude/
```

- [ ] **Step 7: Commit**

```bash
cd /home/chase/Documents/Code/my-library
git add scripts/gen_claude_fixtures.py frontend/lib/server/__tests__/fixtures/claude/
git commit -m "test(node): record the discovery prompts + catalog traffic for wave 3c-3"
```

---

## Task 2: Constraint cleaning, the pool filter, and the two-source query pool

Three small, well-isolated pieces. No Claude, no route.

**Files:**
- Modify: `frontend/lib/server/recFilters.ts` (append)
- Modify: `frontend/lib/server/recAssemble.ts` (append after `seedPool`)
- Test: `frontend/lib/server/__tests__/rec-discover-filters.test.ts` (new)

**Interfaces:**
- Consumes: `subjectHits`, `ConstrainableCandidate` (`recFilters.ts`); `googleBooksQuery`, `openlibraryQuery` (`catalog.ts`); `PoolEntry` (`recAssemble.ts`).
- Produces:
  - `cleanConstraints(raw: Record<string, unknown>): Record<string, unknown>`
  - `applyDiscoveryConstraints<C extends ConstrainableCandidate>(pool: Array<[C, string]>, constraints: Record<string, unknown>): Array<[C, string]>`
  - `discoveryPool(db: Db, queries: string[], perQuery: number): Promise<PoolEntry[]>`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/lib/server/__tests__/rec-discover-filters.test.ts
import { describe, test, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { installHttpReplay } from './helpers/httpReplay';
import { cleanConstraints, applyDiscoveryConstraints } from '../recFilters';
import { discoveryPool } from '../recAssemble';

describe('cleanConstraints', () => {
  test('normalizes the supported keys and drops everything else', () => {
    expect(
      cleanConstraints({
        languages: ['ENG', ' fr ', ''],
        min_year: '1990',
        max_year: 2020,
        exclude_subjects: [' War ', 'grief', ''],
        page_count_max: 400,
        standalone: true,
      })
    ).toEqual({
      // Truncated to 2 chars AFTER strip + lowercase.
      languages: ['en', 'fr'],
      min_year: 1990,
      max_year: 2020,
      exclude_subjects: ['war', 'grief'],
    });
  });

  test('empty in, empty out — and empty lists never create a key', () => {
    expect(cleanConstraints({})).toEqual({});
    expect(cleanConstraints({ languages: [], exclude_subjects: [] })).toEqual({});
    expect(cleanConstraints({ languages: ['  '], exclude_subjects: [''] })).toEqual({});
  });

  test('years: int and all-digit string accepted; bool, float and non-digit rejected', () => {
    expect(cleanConstraints({ min_year: 1990 })).toEqual({ min_year: 1990 });
    expect(cleanConstraints({ min_year: ' 1990 ' })).toEqual({ min_year: 1990 });
    // Python: isinstance(True, int) is True, so bools are skipped EXPLICITLY first.
    expect(cleanConstraints({ min_year: true })).toEqual({});
    expect(cleanConstraints({ min_year: 1990.5 })).toEqual({});
    expect(cleanConstraints({ max_year: ' 20x0 ' })).toEqual({});
    expect(cleanConstraints({ max_year: '-1990' })).toEqual({}); // isdigit() is False for '-'
    expect(cleanConstraints({ max_year: null })).toEqual({});
  });
});

describe('applyDiscoveryConstraints', () => {
  const entry = (over: Record<string, unknown> = {}): [any, string] => [
    { title: 't', author: 'A', year: 2000, subjects: ['Fantasy'], ...over },
    'query:x',
  ];

  test('an empty constraints object is a no-op (Python: {} is falsy)', () => {
    const pool = [entry()];
    expect(applyDiscoveryConstraints(pool, {})).toBe(pool);
  });

  test('filters on year range, but only for integer years', () => {
    expect(applyDiscoveryConstraints([entry({ year: 1980 })], { min_year: 1990 })).toEqual([]);
    expect(applyDiscoveryConstraints([entry({ year: 2025 })], { max_year: 2020 })).toEqual([]);
    expect(applyDiscoveryConstraints([entry({ year: null })], { min_year: 1990 })).toHaveLength(1);
    // Python's isinstance(year, int) is False for a float -> the candidate passes.
    expect(applyDiscoveryConstraints([entry({ year: 1980.5 })], { min_year: 1990 })).toHaveLength(1);
  });

  test('drops candidates whose subjects hit an excluded term, whole-word only', () => {
    expect(
      applyDiscoveryConstraints([entry({ subjects: ['War Fiction'] })], {
        exclude_subjects: ['war'],
      })
    ).toEqual([]);
    expect(
      applyDiscoveryConstraints([entry({ subjects: ['Warmth'] })], { exclude_subjects: ['war'] })
    ).toHaveLength(1);
    expect(
      applyDiscoveryConstraints([entry({ subjects: null })], { exclude_subjects: ['war'] })
    ).toHaveLength(1);
  });

  test('has NO exclude_authors branch, unlike applyDirectiveConstraints', () => {
    // recommend._apply_discovery_constraints simply does not implement it. An
    // exclude_authors key is inert here. Reproduced deliberately.
    expect(
      applyDiscoveryConstraints([entry({ author: 'Herbert' })], { exclude_authors: ['herbert'] })
    ).toHaveLength(1);
  });

  test('preserves the (candidate, reason) pairing', () => {
    const out = applyDiscoveryConstraints([entry({ year: 2000 })], { min_year: 1990 });
    expect(out[0][1]).toBe('query:x');
  });
});

describe('discoveryPool', () => {
  test('runs BOTH sources per query, Google first, and tags each with its query', async () => {
    const { db, close } = await makeTestDb();
    const seen: string[] = [];
    const restore = installHttpReplay(
      {
        'https://www.googleapis.com/books/v1/volumes?q=cozy+fantasy&maxResults=2': {
          status: 200,
          body: { items: [{ id: 'g1', volumeInfo: { title: 'G' } }] },
        },
        'https://openlibrary.org/search.json?q=cozy+fantasy&limit=2&fields=key%2Ctitle%2Cauthor_name%2Cfirst_publish_year%2Ccover_i%2Cisbn%2Csubject%2Clanguage':
          { status: 200, body: { docs: [{ key: '/works/OL1W', title: 'O' }] } },
      },
      (u) => seen.push(u)
    );
    try {
      const pool = await discoveryPool(db, ['cozy fantasy'], 2);
      expect(pool.map(([c, r]) => [c.source, r])).toEqual([
        ['googlebooks', 'query:cozy fantasy'],
        ['openlibrary', 'query:cozy fantasy'],
      ]);
      // Order is load-bearing: it is what the recorded fixture replays.
      expect(seen[0]).toContain('googleapis.com');
      expect(seen[1]).toContain('openlibrary.org');
    } finally {
      restore();
      await close();
    }
  });

  test('an empty query list makes no requests', async () => {
    const { db, close } = await makeTestDb();
    const seen: string[] = [];
    const restore = installHttpReplay({}, (u) => seen.push(u));
    try {
      expect(await discoveryPool(db, [], 8)).toEqual([]);
      expect(seen).toEqual([]);
    } finally {
      restore();
      await close();
    }
  });
});
```

(`'googlebooks'` and `'openlibrary'` are the exact `source` values `catalog.ts` sets — verified, do not adjust them.)

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/rec-discover-filters.test.ts
```

Expected: FAIL — `cleanConstraints is not a function`.

- [ ] **Step 3: Implement the filters**

Append to `frontend/lib/server/recFilters.ts`:

```ts
/**
 * recommend._clean_constraints: keep only the supported, catalog-filterable
 * constraints and normalize their types.
 *
 * Supported: languages (2-letter lowercased), min_year/max_year (int),
 * exclude_subjects (lowercased). Page-count and standalone/series constraints are
 * intentionally unsupported -- catalog candidates don't reliably carry that data --
 * so they are dropped even when the model emits them.
 *
 * DEVIATIONS, both narrower than Python and both safe:
 *  - Python's `isinstance(val, int)` rejects a float, but JSON.parse erases the
 *    int/float distinction, so a wire value of `1990.0` reaches us as the integer
 *    1990 and is accepted here where Python would drop it. Same class of divergence
 *    as recommendRun's candidate_index check.
 *  - Python's `str.isdigit()` is Unicode-aware (it accepts superscripts and
 *    non-Latin digits, some of which then make `int()` raise); `/^\d+$/` is
 *    ASCII-only. The years Claude emits are ASCII.
 */
export function cleanConstraints(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const langs = ((raw.languages as unknown[] | null) ?? [])
    .filter((x) => String(x).trim() !== '')
    // Truncate to 2 AFTER trim + lowercase, exactly like Python's `.strip().lower()[:2]`.
    .map((x) => String(x).trim().toLowerCase().slice(0, 2));
  if (langs.length) out.languages = langs;

  for (const key of ['min_year', 'max_year'] as const) {
    const val = raw[key];
    // Python checks bool FIRST because bool subclasses int -- True would become 1.
    if (typeof val === 'boolean') continue;
    if (typeof val === 'number' && Number.isInteger(val)) out[key] = val;
    else if (typeof val === 'string' && /^\d+$/.test(val.trim())) out[key] = Number(val.trim());
  }

  const excl = ((raw.exclude_subjects as unknown[] | null) ?? [])
    .filter((x) => String(x).trim() !== '')
    .map((x) => String(x).trim().toLowerCase());
  if (excl.length) out.exclude_subjects = excl;

  return out;
}

/**
 * recommend._apply_discovery_constraints: filter the RAW candidate pool by the
 * reader's stated era + exclude_subjects constraints, BEFORE assembly -- so the
 * cap can never keep a constraint-violating book over a valid one.
 *
 * Deliberately NOT applyDirectiveConstraints: this one has no exclude_authors
 * branch, and it operates on (candidate, reason) pool entries rather than
 * assembled candidates. Language is handled separately, by overriding the signal's
 * allowed-language set in runDiscover. Unknown/missing fields always PASS.
 */
export function applyDiscoveryConstraints<C extends ConstrainableCandidate>(
  pool: Array<[C, string]>,
  constraints: Record<string, unknown>
): Array<[C, string]> {
  // Python's `if not constraints` -- an EMPTY object is falsy there but truthy in JS.
  if (!constraints || Object.keys(constraints).length === 0) return pool;

  const minYear = constraints.min_year as number | null | undefined;
  const maxYear = constraints.max_year as number | null | undefined;
  const exclude = ((constraints.exclude_subjects as string[] | null) ?? []).map((s) =>
    s.toLowerCase()
  );

  return pool.filter(([cand]) => {
    const year = cand.year;
    // Python's isinstance(year, int): a float year fails the check and passes the filter.
    if (typeof year === 'number' && Number.isInteger(year)) {
      if (minYear != null && year < minYear) return false;
      if (maxYear != null && year > maxYear) return false;
    }
    if (exclude.length) {
      const subjects = (cand.subjects ?? []).map((s) => String(s).toLowerCase());
      for (const term of exclude) {
        if (subjects.some((s) => subjectHits(term, s))) return false;
      }
    }
    return true;
  });
}
```

Then append to `frontend/lib/server/recAssemble.ts`, directly after `seedPool` (and add `openlibraryQuery` to the `./catalog` import list):

```ts
/**
 * recommend._discovery_pool: run the interpreted NL-discovery queries against the
 * live catalog. Unlike seedPool (Google-only), discovery has no library-metadata
 * backstop -- recall rests entirely on these queries -- so each runs against BOTH
 * sources. Google first, then Open Library: that order is what the recorded
 * fixture replays.
 */
export async function discoveryPool(
  db: Db,
  queries: string[],
  perQuery: number
): Promise<PoolEntry[]> {
  const pool: PoolEntry[] = [];
  for (const q of queries) {
    for (const c of await googleBooksQuery(db, q, perQuery)) pool.push([c, `query:${q}`]);
    for (const c of await openlibraryQuery(db, q, perQuery)) pool.push([c, `query:${q}`]);
  }
  return pool;
}
```

- [ ] **Step 4: Run the tests**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/rec-discover-filters.test.ts lib/server/__tests__/rec-filters.test.ts lib/server/__tests__/rec-assemble.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx prettier --write lib/server/recFilters.ts lib/server/recAssemble.ts lib/server/__tests__/rec-discover-filters.test.ts
cd /home/chase/Documents/Code/my-library
git add frontend/lib/server/recFilters.ts frontend/lib/server/recAssemble.ts frontend/lib/server/__tests__/rec-discover-filters.test.ts
git commit -m "feat(node): discovery constraint cleaning, pool filter and two-source pool"
```

---

## Task 3: The two discovery prompts, proven byte-identical

Every string here is copied **verbatim** from `mylibrary/recommend.py`. Do not reflow, re-punctuate, or "improve" any of them.

**Files:**
- Modify: `frontend/lib/server/recPrompts.ts` (export `tasteAndLoved`)
- Create: `frontend/lib/server/recDiscoverPrompts.ts`
- Test: `frontend/lib/server/__tests__/parity-discover-prompts.test.ts` (new)

**Interfaces:**
- Consumes: `PromptBlock`, `tasteAndLoved` (`recPrompts.ts`); `AssembledCandidate` (`recAssemble.ts`); `RecSignal` (`recSignal.ts`); `pyJsonDumps` (`serialize.ts`).
- Produces: `DISCOVER_SYSTEM`, `DISCOVER_TOOL`, `DISCOVER_RANK_SYSTEM`, `DISCOVER_RANK_TOOL`, `buildInterpretPrompt(query, signal): PromptBlock[]`, `buildDiscoverRerankPrompt(candidates, query, interpretation, signal, n): PromptBlock[]`.

- [ ] **Step 1: Export `tasteAndLoved`**

In `frontend/lib/server/recPrompts.ts`, change line 152 from

```ts
function tasteAndLoved(signal: RecSignal): string {
```

to

```ts
/**
 * The `TASTE TRAITS (JSON):` / `LOVED BOOKS (JSON):` pair shared by /recommend's two
 * prompts and /discover's two prompts. Exported for recDiscoverPrompts.ts, which
 * prefixes it with its own header line rather than duplicating the serialization.
 */
export function tasteAndLoved(signal: RecSignal): string {
```

- [ ] **Step 2: Write the failing test**

```ts
// frontend/lib/server/__tests__/parity-discover-prompts.test.ts
import { describe, it, expect } from 'vitest';
import prompts from './fixtures/claude/prompts.json';
import httpFixtures from './fixtures/claude/recommend-http.json';
import seedJson from './fixtures/parity/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupParityEnv } from './helpers/parity';
import { installHttpReplay } from './helpers/httpReplay';
import { buildSignal, type RecSignal } from '../recSignal';
import { assemble, discoveryPool, fillOlDescriptions, MAX_CANDIDATES, PER_QUERY } from '../recAssemble';
import { applyDiscoveryConstraints, cleanConstraints } from '../recFilters';
import { SEED_MODEL, SEED_MAX_TOKENS, RANK_MAX_TOKENS, rankModel } from '../recPrompts';
import {
  DISCOVER_SYSTEM,
  DISCOVER_TOOL,
  DISCOVER_RANK_SYSTEM,
  DISCOVER_RANK_TOOL,
  buildInterpretPrompt,
  buildDiscoverRerankPrompt,
} from '../recDiscoverPrompts';

// Must stay identical to DISCOVER_QUERY / _DISCOVER_INTERP_CANNED in
// scripts/gen_claude_fixtures.py -- together they determine which catalog URLs
// recommend-http.json contains for this path.
const DISCOVER_QUERY = 'something like The Fifth Season but gentler';
const CANNED_INTERPRETATION = 'Epic fantasy with a broken world, but warmer in tone.';
const CANNED_QUERIES = ['literary fantasy found family', 'gentle epic fantasy hopeful tone'];
const CANNED_RAW_CONSTRAINTS = {
  languages: ['ENG', ' fr ', ''],
  min_year: '1990',
  max_year: 2020,
  exclude_subjects: [' War ', 'grief', ''],
  page_count_max: 400,
  standalone: true,
};

describe('prompt parity: discover stage A (interpret)', () => {
  setupParityEnv();

  it('builds a byte-identical request to Python', async () => {
    const py = (prompts as any).discover_interpret.kwargs;
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const signal = await buildSignal(db, 'local');
      // Stage A is built from the query + profile alone -- no catalog.
      expect(buildInterpretPrompt(DISCOVER_QUERY, signal)).toEqual(py.messages[0].content);
      expect(DISCOVER_SYSTEM).toBe(py.system);
      expect(DISCOVER_TOOL).toEqual(py.tools[0]);
      expect(SEED_MODEL).toBe(py.model); // discovery reuses the Haiku seed model
      expect(SEED_MAX_TOKENS).toBe(py.max_tokens);
      expect(py.tool_choice).toEqual({ type: 'tool', name: 'interpret_request' });
      expect(py.messages[0].role).toBe('user');
    } finally {
      await close();
    }
  });
});

describe('prompt parity: discover stage B (rerank)', () => {
  setupParityEnv();

  it("rebuilds Python's candidate list and rerank prompt from replayed catalog traffic", async () => {
    const py = (prompts as any).discover_rerank.kwargs;
    const { db, close } = await makeTestDb();
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await loadSeed(db, seedJson as any);
      let signal = await buildSignal(db, 'local');

      const constraints = cleanConstraints(CANNED_RAW_CONSTRAINTS);
      expect(constraints).toEqual({
        languages: ['en', 'fr'],
        min_year: 1990,
        max_year: 2020,
        exclude_subjects: ['war', 'grief'],
      });

      // A stated language constraint REPLACES the library's languages for this run.
      signal = {
        ...signal,
        library_languages: new Set(constraints.languages as string[]),
      } as RecSignal;

      let pool = await discoveryPool(db, CANNED_QUERIES, PER_QUERY);
      pool = applyDiscoveryConstraints(pool, constraints);
      // Discovery passes an EMPTY metadata pool: the interpreted queries are the
      // whole pool, so every candidate comes out tagged 'claude_seed'.
      const candidates = assemble([], pool, signal, MAX_CANDIDATES);
      await fillOlDescriptions(db, candidates);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every((c) => c.retrieval_pool === 'claude_seed')).toBe(true);

      // This single assertion covers the deterministic discovery chain: the
      // two-source pool order, the pre-assembly constraint filter, the language
      // override, dedup, author caps and description ordering all feed the
      // CANDIDATES JSON inside this prompt.
      //
      // The fixture is a snapshot of live catalog data: re-recording churns a
      // candidate or two as Google Books re-ranks. That is expected -- this proves
      // Node reproduces whatever was recorded, not one specific candidate list.
      expect(
        buildDiscoverRerankPrompt(candidates, DISCOVER_QUERY, CANNED_INTERPRETATION, signal, 10)
      ).toEqual(py.messages[0].content);
      expect(DISCOVER_RANK_SYSTEM).toBe(py.system);
      expect(DISCOVER_RANK_TOOL).toEqual(py.tools[0]);
      expect(rankModel()).toBe(py.model);
      expect(RANK_MAX_TOKENS).toBe(py.max_tokens);
      expect(py.tool_choice).toEqual({ type: 'tool', name: 'rank_discovery' });
    } finally {
      restore();
      await close();
    }
  });

  it('uses a DIFFERENT profile-context header from stage A', async () => {
    // The two prefixes differ by one substring in Python. Unifying them would be a
    // silent parity break that no other assertion here would catch.
    const a = (prompts as any).discover_interpret.kwargs.messages[0].content[0].text;
    const b = (prompts as any).discover_rerank.kwargs.messages[0].content[0].text;
    expect(a.startsWith('READER TASTE PROFILE (secondary context; the request rules):\n')).toBe(
      true
    );
    expect(b.startsWith('READER TASTE PROFILE (secondary - the request rules):\n')).toBe(true);
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/parity-discover-prompts.test.ts
```

Expected: FAIL — `Cannot find module '../recDiscoverPrompts'`.

- [ ] **Step 4: Implement**

```ts
// frontend/lib/server/recDiscoverPrompts.ts
/**
 * Port of recommend.py's two /discover prompts (_DISCOVER_SYSTEM/_DISCOVER_TOOL and
 * _DISCOVER_RANK_SYSTEM/_DISCOVER_RANK_TOOL) plus their builders.
 *
 * Discovery grounds in the reader's REQUEST; the taste profile is secondary
 * tie-break context only, which is why neither prompt carries the user-steering
 * block that /recommend's reranker uses. Stage A reuses recPrompts' Haiku model and
 * token budget, exactly as Python does.
 *
 * Every string here is copied VERBATIM from Python and asserted byte-for-byte in
 * parity-discover-prompts.test.ts. Do not reflow or re-punctuate them.
 */
import type { AssembledCandidate } from './recAssemble';
import { tasteAndLoved, type PromptBlock } from './recPrompts';
import type { RecSignal } from './recSignal';
import { pyJsonDumps } from './serialize';

// --- stage A: interpret the request ----------------------------------------

export const DISCOVER_SYSTEM =
  "You translate a reader's natural-language book request into catalog search queries and " +
  'constraints. You never name specific titles; you produce search TERMS (themes, genres, ' +
  'styles, comparable-author names when the reader gives one) that a book catalog can ' +
  'resolve.\n\n' +
  'Rules:\n' +
  "- The reader's request is the primary signal. Their taste profile is provided as " +
  'secondary context: use it to break ties and set tone (e.g. their prose preferences), ' +
  'never to override what they asked for. If they ask for something their profile dislikes, ' +
  'honor the request; people read outside their pattern on purpose.\n' +
  '- If the request names a book or author ("like The Fifth Season"), decompose WHY someone ' +
  'asks for that book into 3-6 distinct facets (e.g. geological apocalypse setting; ' +
  'second-person narration; rage as the engine; found family under oppression) and emit one ' +
  'query per facet. Facets, not synonyms: six rewordings of the same idea retrieve the same ' +
  'shelf six times.\n' +
  '- If the request is a mood or situation ("something gentle for a bad week", "a beach book ' +
  "that isn't dumb\"), translate the mood into concrete catalog language: pacing, stakes, tone.\n" +
  '- Extract hard constraints ONLY when the reader states them: language, publication era ' +
  '(min_year / max_year), and subjects to avoid (exclude_subjects, e.g. "nothing violent" ' +
  '-> war, violence). These are filters, not queries. Do not invent constraints the reader ' +
  "didn't state, and do not constrain by length or series; those aren't filterable.\n" +
  '- When the request is ambiguous, emit queries covering the 2-3 most likely readings rather ' +
  'than guessing one.\n\n' +
  'Examples (request -> facets; constraints only when stated):\n' +
  '- "Find me a book like Project Hail Mary" -> facets: lone-problem-solver survival scifi; ' +
  'competence-porn engineering narration; first-contact friendship; humor inside hard sci-fi; ' +
  'race-against-extinction stakes. No constraints.\n' +
  '- "Something gentle for a bad week" -> facets: low-stakes literary comfort; kindness between ' +
  'strangers; cozy small-community fiction; quiet healing narratives. Constraints: ' +
  'exclude_subjects: [grief, war, abuse].\n' +
  '- "A thriller my book club won\'t hate" -> facets: literary crime; character-driven suspense; ' +
  'thrillers with prose ambition; discussable moral-dilemma plots. No hard constraints.\n' +
  '- "Nonfiction that reads like a novel" -> facets: narrative nonfiction; immersive reportage; ' +
  'true crime with literary structure; biography with scene-level storytelling. No hard ' +
  'constraints.';

export const DISCOVER_TOOL = {
  name: 'interpret_request',
  description:
    "Translate a reader's natural-language book request into catalog SEARCH queries " +
    '(search terms: themes, styles, comparable-author names, never specific titles), ' +
    'the hard constraints they stated, and a one-sentence interpretation of what they want.',
  input_schema: {
    type: 'object',
    properties: {
      interpretation: {
        type: 'string',
        description: 'One sentence restating what the reader wants, in their own terms.',
      },
      queries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'A catalog search query for one facet: search terms, not a title.',
            },
            rationale: {
              type: 'string',
              description: 'Which facet of the request this query chases.',
            },
          },
          required: ['query', 'rationale'],
        },
      },
      constraints: {
        type: 'object',
        description: 'Hard filters the reader stated. Omit any they did not state.',
        properties: {
          languages: {
            type: 'array',
            items: { type: 'string' },
            description:
              "ISO 639-1 codes, e.g. ['en','fr']. Only when the reader names a language.",
          },
          min_year: {
            type: 'integer',
            description: 'Earliest publication year, when the reader states an era.',
          },
          max_year: {
            type: 'integer',
            description: 'Latest publication year, when the reader states an era.',
          },
          exclude_subjects: {
            type: 'array',
            items: { type: 'string' },
            description:
              "Subjects/themes to avoid, e.g. ['war','grief'] for 'nothing heavy'.",
          },
        },
      },
    },
    required: ['interpretation', 'queries'],
  },
};

/** recommend._interpret_query's message content. */
export function buildInterpretPrompt(query: string, signal: RecSignal): PromptBlock[] {
  const profileContext =
    'READER TASTE PROFILE (secondary context; the request rules):\n' + tasteAndLoved(signal);

  // The query is interpolated raw inside double quotes, exactly as Python does.
  // A query containing a `"` produces unbalanced quotes there too.
  const taskPrompt =
    `The reader asked: "${query}"\n\n` +
    'Interpret this request. Emit search QUERIES (facets, not titles), any hard ' +
    'CONSTRAINTS they stated (language, era, subjects to avoid; omit if unstated), and ' +
    'a one-sentence INTERPRETATION of what they want.';

  return [
    { type: 'text', text: profileContext, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskPrompt },
  ];
}

// --- stage B: rank candidates by fit to the request -------------------------

export const DISCOVER_RANK_TOOL = {
  name: 'rank_discovery',
  description:
    "Rank the provided real catalog candidates by how well they answer the reader's " +
    'request, and explain each pick. Choose ONLY from the given candidates.',
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
              description: "0..1 fit with the reader's REQUEST.",
            },
            rationale: {
              type: 'string',
              description:
                '1-2 sentences answering the request in its own terms: what the ' +
                'book does and which facet of the request it delivers. Name the ' +
                'mechanism (pace, voice, structure, mood, subject), not just ' +
                'shared genre. Honest about stretch picks. Plain punctuation, ' +
                'no em dashes.',
            },
          },
          required: ['candidate_index', 'score', 'rationale'],
        },
      },
    },
    required: ['recommendations'],
  },
};

export const DISCOVER_RANK_SYSTEM =
  "You are a book recommender answering a reader's specific request. You rank a fixed list " +
  'of real catalog candidates by how well they answer THAT REQUEST, and you never invent ' +
  'books; you only rank the candidates given. Rank fit against the request first and the ' +
  "reader's taste profile second (use the profile only to break ties). You prefer specific " +
  'fit (voice, structure, pace, mood, subject) over popularity.\n\n' +
  'Write each rationale like a well-read friend pressing the book into their hands, in 1-2 ' +
  'sentences: lead with what the book does, then answer the request in its own terms: if ' +
  'they asked for "like The Fifth Season", say which facet of it this book delivers. Name ' +
  'the mechanism of the fit, never just shared genre. If a pick is a stretch, say so honestly ' +
  'and name what still connects. Use plain punctuation only: no em dashes. Never write ' +
  '"you\'ll love this", generic praise, or clinical trait language.';

/** recommend._rerank_discovery's message content. */
export function buildDiscoverRerankPrompt(
  candidates: AssembledCandidate[],
  query: string,
  interpretation: string,
  signal: RecSignal,
  n: number
): PromptBlock[] {
  const indexed = candidates.map((c, i) => ({
    idx: i,
    title: c.title,
    author: c.author,
    year: c.year,
    subjects: c.subjects ?? [],
  }));

  // NOTE the header differs from stage A's by one substring. Not a typo.
  const profileContext =
    'READER TASTE PROFILE (secondary - the request rules):\n' + tasteAndLoved(signal);

  const taskPrompt =
    `The reader asked: "${query}"\n` +
    `Interpreted as: ${interpretation}\n\n` +
    `Rank the best ${n} candidates against THIS REQUEST and explain each. Choose ONLY from ` +
    'the CANDIDATES list (cite each by its `idx`). Score 0..1 for fit to the request. In ' +
    'each rationale, answer the request in its own terms.\n\n' +
    'CANDIDATES (JSON):\n' +
    pyJsonDumps(indexed);

  return [
    { type: 'text', text: profileContext, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: taskPrompt },
  ];
}
```

- [ ] **Step 5: Run the tests**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/parity-discover-prompts.test.ts lib/server/__tests__/parity-recommend-prompts.test.ts
```

Expected: all PASS. (The recommend test is included because Step 1 touched `recPrompts.ts`.)

**If a system/tool string fails**, diff the vitest output against `mylibrary/recommend.py` — the long `DISCOVER_SYSTEM` is the likeliest place for a dropped space at a string-concatenation boundary. **If the rerank assertion fails on the candidate list**, the discovery chain diverged; check `discoveryPool`'s Google-then-OL order, then the constraint filter, then the language override. Do **not** edit the fixture to make the test pass.

- [ ] **Step 6: Commit**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx prettier --write lib/server/recDiscoverPrompts.ts lib/server/recPrompts.ts lib/server/__tests__/parity-discover-prompts.test.ts
cd /home/chase/Documents/Code/my-library
git add frontend/lib/server/recDiscoverPrompts.ts frontend/lib/server/recPrompts.ts frontend/lib/server/__tests__/parity-discover-prompts.test.ts
git commit -m "feat(node): discovery prompts, proven byte-identical to Python"
```

---

## Task 4: The `discover()` orchestrator

**Files:**
- Modify: `frontend/lib/server/claudeErrors.ts` (append)
- Create: `frontend/lib/server/recDiscoverRun.ts`
- Test: `frontend/lib/server/__tests__/discover-run.test.ts` (new)

**Interfaces:**
- Consumes: `trackedCreate` (`anthropic.ts`); `toolInput`, `ClaudeClient` (`claude.ts`); `RECOMMEND_NO_KEY_MESSAGE`, `DISCOVER_EMPTY_QUERY_MESSAGE` (`claudeErrors.ts`); `ApiError` (`errors.ts`); `buildSignal`, `RecSignal` (`recSignal.ts`); `assemble`, `discoveryPool`, `fillOlDescriptions`, `MAX_CANDIDATES`, `PER_QUERY`, `AssembledCandidate` (`recAssemble.ts`); `applyDiscoveryConstraints`, `cleanConstraints` (`recFilters.ts`); `SEED_MODEL`, `SEED_MAX_TOKENS`, `RANK_MAX_TOKENS`, `rankModel` (`recPrompts.ts`); the Task 3 exports; `round2` (`serialize.ts`).
- Produces: `runDiscover(db: Db, client: ClaudeClient | null, userId: string, query: string, n: number): Promise<Record<string, unknown>>`.

- [ ] **Step 1: Add the error message**

Append to `frontend/lib/server/claudeErrors.ts`:

```ts
/** discover()'s empty-query guard, surfaced by api.py as a 400. */
export const DISCOVER_EMPTY_QUERY_MESSAGE = 'Enter something to search for.';
```

- [ ] **Step 2: Write the failing test**

```ts
// frontend/lib/server/__tests__/discover-run.test.ts
import { describe, test, expect } from 'vitest';
import seedJson from './fixtures/parity/seed.json';
import httpFixtures from './fixtures/claude/recommend-http.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupParityEnv } from './helpers/parity';
import { installHttpReplay } from './helpers/httpReplay';
import { schema } from '../db';
import { runDiscover } from '../recDiscoverRun';
import type { ClaudeClient } from '../claude';

const DISCOVER_QUERY = 'something like The Fifth Season but gentler';
const CANNED_INTERPRETATION = 'Epic fantasy with a broken world, but warmer in tone.';

const INTERP_INPUT = {
  interpretation: CANNED_INTERPRETATION,
  queries: [
    { query: 'literary fantasy found family', rationale: 'f' },
    { query: 'gentle epic fantasy hopeful tone', rationale: 'f' },
    { query: '   ', rationale: 'blank is dropped' },
  ],
  constraints: {
    languages: ['ENG', ' fr ', ''],
    min_year: '1990',
    max_year: 2020,
    exclude_subjects: [' War ', 'grief', ''],
    page_count_max: 400,
    standalone: true,
  },
};

/** A ClaudeClient that answers stage A then stage B, in order. */
function fakeClient(interpInput: unknown, rankedPayload?: unknown[]): ClaudeClient & { calls: any[] } {
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
            content: [{ type: 'tool_use', name: 'interpret_request', input: interpInput }],
            usage: null,
          };
        }
        return {
          content: [
            { type: 'tool_use', name: 'rank_discovery', input: { recommendations: rankedPayload ?? [] } },
          ],
          usage: null,
        };
      },
    },
  } as any;
}

describe('runDiscover', () => {
  setupParityEnv();

  test('runs both stages, drops bad indices, rounds scores and does not persist', async () => {
    const { db, close } = await makeTestDb();
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClient(INTERP_INPUT, [
        { candidate_index: 0, score: 0.875, rationale: '  padded  ' },
        { candidate_index: 1, score: 0.5, rationale: 'second' },
        { candidate_index: 4242, score: 0.99, rationale: 'hallucinated' },
        { candidate_index: 0, score: 0.99, rationale: 'duplicate' },
        { candidate_index: -1, score: 0.99, rationale: 'negative' },
      ]);
      const out: any = await runDiscover(db, client, 'local', DISCOVER_QUERY, 10);

      expect(out.query).toBe(DISCOVER_QUERY);
      expect(out.interpretation).toBe(CANNED_INTERPRETATION);
      expect(out.model).toBe('claude-sonnet-5');
      // The blank query is dropped before retrieval.
      expect(out.queries).toEqual([
        'literary fantasy found family',
        'gentle epic fantasy hopeful tone',
      ]);
      expect(out.count).toBe(2);
      expect(out.recommendations).toHaveLength(2);
      expect(out.recommendations[0].rank).toBe(1);
      // round(0.875, 2) is a banker's-rounding tie: 87 is odd, so it goes to 0.88.
      expect(out.recommendations[0].score).toBe(0.88);
      expect(out.recommendations[0].rationale).toBe('padded');
      // Discovery passes an empty metadata pool, so everything is claude_seed.
      expect(out.recommendations.every((r: any) => r.retrieval_pool === 'claude_seed')).toBe(true);

      // Ephemeral: nothing may reach the recommendations table.
      const rows = await db.select().from(schema.recommendations);
      expect(rows).toHaveLength((seedJson as any).recommendations.length);

      expect(client.calls[0].model).toBe('claude-haiku-4-5-20251001');
      expect(client.calls[1].model).toBe('claude-sonnet-5');
    } finally {
      restore();
      await close();
    }
  });

  test('400s on an empty or whitespace-only query, before any Claude call', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClient(INTERP_INPUT);
      for (const q of ['', '   ']) {
        await expect(runDiscover(db, client, 'local', q, 10)).rejects.toMatchObject({
          status: 400,
          detail: 'Enter something to search for.',
        });
      }
      expect(client.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  test('400s with the no-key message BEFORE any catalog request', async () => {
    // Discovery has no metadata pool, so _client() raises inside stage A before a
    // single catalog fetch. An empty replay map proves it: any request would throw
    // HttpReplayMissError instead of the 400 asserted here.
    const { db, close } = await makeTestDb();
    const seen: string[] = [];
    const restore = installHttpReplay({}, (u) => seen.push(u));
    try {
      await loadSeed(db, seedJson as any);
      await expect(runDiscover(db, null, 'local', DISCOVER_QUERY, 10)).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('No Anthropic API key configured'),
      });
      expect(seen).toEqual([]);
    } finally {
      restore();
      await close();
    }
  });

  test('returns early with queries: [] when stage A proposes nothing', async () => {
    const { db, close } = await makeTestDb();
    const seen: string[] = [];
    const restore = installHttpReplay({}, (u) => seen.push(u));
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClient({ interpretation: 'nothing', queries: [] });
      const out: any = await runDiscover(db, client, 'local', 'gibberish', 10);
      expect(out).toEqual({
        query: 'gibberish',
        interpretation: 'nothing',
        count: 0,
        model: 'claude-sonnet-5',
        queries: [],
        recommendations: [],
      });
      // No retrieval, and no second Claude call.
      expect(seen).toEqual([]);
      expect(client.calls).toHaveLength(1);
    } finally {
      restore();
      await close();
    }
  });

  test('returns early WITH the queries when retrieval surfaces no candidates', async () => {
    const { db, close } = await makeTestDb();
    // Both sources answer 404 -> empty pool -> empty candidate list. They must be
    // PRESENT in the fixture map as 404s: a URL that is simply absent throws
    // HttpReplayMissError, which catalog.ts propagates rather than swallowing.
    const restore = installHttpReplay({
      'https://www.googleapis.com/books/v1/volumes?q=zzzz+nothing&maxResults=8': { status: 404 },
      'https://openlibrary.org/search.json?q=zzzz+nothing&limit=8&fields=key%2Ctitle%2Cauthor_name%2Cfirst_publish_year%2Ccover_i%2Cisbn%2Csubject%2Clanguage':
        { status: 404 },
    });
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClient({
        interpretation: 'nothing findable',
        queries: [{ query: 'zzzz nothing', rationale: 'f' }],
      });
      const out: any = await runDiscover(db, client, 'local', 'zzzz', 10);
      expect(out.count).toBe(0);
      // Unlike the no-queries early return above, this one carries the queries.
      expect(out.queries).toEqual(['zzzz nothing']);
      expect(out.recommendations).toEqual([]);
      expect(client.calls).toHaveLength(1); // no rerank call
    } finally {
      restore();
      await close();
    }
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/discover-run.test.ts
```

Expected: FAIL — `Cannot find module '../recDiscoverRun'`.

- [ ] **Step 4: Implement**

```ts
// frontend/lib/server/recDiscoverRun.ts
/**
 * Port of recommend.discover() — ephemeral natural-language discovery.
 *
 * Two-stage and REQUEST-anchored: stage A (Haiku) interprets the free-text request
 * into catalog queries + hard constraints, retrieval resolves them against the live
 * catalog, and stage B (the rerank model) ranks the real candidates by fit to the
 * request. The taste profile is secondary tie-break context only, the standing
 * directive does not steer this path at all, and there is no profile-missing/stale
 * gate. Results are NOT persisted, so this opens no transaction.
 */
import { trackedCreate } from './anthropic';
import { toolInput, type ClaudeClient } from './claude';
import { DISCOVER_EMPTY_QUERY_MESSAGE, RECOMMEND_NO_KEY_MESSAGE } from './claudeErrors';
import type { Db } from './db';
import { ApiError } from './errors';
import {
  assemble,
  discoveryPool,
  fillOlDescriptions,
  MAX_CANDIDATES,
  PER_QUERY,
  type AssembledCandidate,
} from './recAssemble';
import { applyDiscoveryConstraints, cleanConstraints } from './recFilters';
import {
  DISCOVER_RANK_SYSTEM,
  DISCOVER_RANK_TOOL,
  DISCOVER_SYSTEM,
  DISCOVER_TOOL,
  buildDiscoverRerankPrompt,
  buildInterpretPrompt,
} from './recDiscoverPrompts';
import { rankModel, RANK_MAX_TOKENS, SEED_MAX_TOKENS, SEED_MODEL } from './recPrompts';
import { buildSignal, type RecSignal } from './recSignal';
import { round2 } from './serialize';

interface Interpretation {
  interpretation: string;
  queries: string[];
  constraints: Record<string, unknown>;
}

interface RankedDiscovery extends AssembledCandidate {
  score: number;
  rationale: string;
}

export async function runDiscover(
  db: Db,
  client: ClaudeClient | null,
  userId: string,
  query: string,
  n: number
): Promise<Record<string, unknown>> {
  const q = (query ?? '').trim();
  if (!q) throw new ApiError(400, DISCOVER_EMPTY_QUERY_MESSAGE);

  // Python's _client() checks the key at point of USE, inside _interpret_query.
  // Discovery has no metadata pool, so that is before any catalog request.
  const requireClient = (): ClaudeClient => {
    if (!client) throw new ApiError(400, RECOMMEND_NO_KEY_MESSAGE);
    return client;
  };

  // The FULL signal: library exclusion sets (including rejected recommendations)
  // plus traits/loved as secondary context. buildSignal never raises on a thin or
  // profile-less library, which is why discovery works before a profile exists.
  let signal = await buildSignal(db, userId);

  const interp = await interpretQuery(db, requireClient(), q, signal, userId);
  const model = rankModel();

  if (interp.queries.length === 0) {
    return {
      query: q,
      interpretation: interp.interpretation,
      count: 0,
      model,
      queries: [],
      recommendations: [],
    };
  }

  // A stated language constraint OVERRIDES the reader's library languages for this
  // run (people ask for other-language books on purpose). assemble() reads
  // library_languages via allowedLanguages, so overriding it here is enough.
  const statedLanguages = interp.constraints.languages as string[] | undefined;
  if (statedLanguages && statedLanguages.length) {
    signal = { ...signal, library_languages: new Set(statedLanguages) } as RecSignal;
  }

  let pool = await discoveryPool(db, interp.queries, PER_QUERY);
  // Filter the RAW pool, before the cap, so a constraint-violating book can never
  // displace a valid one.
  pool = applyDiscoveryConstraints(pool, interp.constraints);
  // Discovery is purely query-driven: no metadata pool. The interpreted queries ARE
  // the seed pool, so every candidate comes out tagged 'claude_seed'.
  const candidates = assemble([], pool, signal, MAX_CANDIDATES);
  await fillOlDescriptions(db, candidates);

  if (candidates.length === 0) {
    // NOTE: unlike the no-queries return above, this one carries the queries.
    return {
      query: q,
      interpretation: interp.interpretation,
      count: 0,
      model,
      queries: interp.queries,
      recommendations: [],
    };
  }

  const ranked = await rerankDiscovery(
    db,
    requireClient(),
    candidates,
    q,
    interp.interpretation,
    signal,
    userId,
    n
  );

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
    query: q,
    interpretation: interp.interpretation,
    count: recsOut.length,
    model,
    queries: interp.queries,
    recommendations: recsOut,
  };
}

/** recommend._interpret_query: stage A. */
async function interpretQuery(
  db: Db,
  client: ClaudeClient,
  query: string,
  signal: RecSignal,
  userId: string
): Promise<Interpretation> {
  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'discover_interpret' },
    {
      model: SEED_MODEL,
      max_tokens: SEED_MAX_TOKENS,
      system: DISCOVER_SYSTEM,
      tools: [DISCOVER_TOOL],
      tool_choice: { type: 'tool', name: 'interpret_request' },
      messages: [{ role: 'user', content: buildInterpretPrompt(query, signal) }],
    }
  );

  // Python matches the FIRST tool_use block without checking its name, and falls
  // back to a fully-empty interpretation when there is none.
  const input = toolInput(message as any, '');
  if (!input) return { interpretation: '', queries: [], constraints: {} };

  const items = (input.queries as Array<{ query?: string }> | undefined) ?? [];
  return {
    interpretation: String(input.interpretation ?? '').trim(),
    queries: items
      .filter((x) => (x?.query ?? '').trim() !== '')
      .map((x) => String(x.query).trim()),
    constraints: cleanConstraints((input.constraints as Record<string, unknown>) ?? {}),
  };
}

/** recommend._rerank_discovery: stage B. */
async function rerankDiscovery(
  db: Db,
  client: ClaudeClient,
  candidates: AssembledCandidate[],
  query: string,
  interpretation: string,
  signal: RecSignal,
  userId: string,
  n: number
): Promise<RankedDiscovery[]> {
  const message = await trackedCreate(
    client,
    db,
    { userId, operation: 'discover_rerank' },
    {
      model: rankModel(),
      max_tokens: RANK_MAX_TOKENS,
      system: DISCOVER_RANK_SYSTEM,
      tools: [DISCOVER_RANK_TOOL],
      tool_choice: { type: 'tool', name: 'rank_discovery' },
      messages: [
        {
          role: 'user',
          content: buildDiscoverRerankPrompt(candidates, query, interpretation, signal, n),
        },
      ],
    }
  );

  const input = toolInput(message as any, '');
  const rankedRaw = (input?.recommendations as Array<Record<string, unknown>> | undefined) ?? [];

  const out: RankedDiscovery[] = [];
  const seenIdx = new Set<number>();
  for (const r of rankedRaw) {
    const idx = r.candidate_index;
    // Drop hallucinated / duplicate indices. Same intentional divergence from
    // Python's `isinstance(idx, int)` as recommendRun and recSimilarRun.
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
npx vitest run lib/server/__tests__/discover-run.test.ts lib/server/__tests__/parity-discover-prompts.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx prettier --write lib/server/recDiscoverRun.ts lib/server/claudeErrors.ts lib/server/__tests__/discover-run.test.ts
cd /home/chase/Documents/Code/my-library
git add frontend/lib/server/recDiscoverRun.ts frontend/lib/server/claudeErrors.ts frontend/lib/server/__tests__/discover-run.test.ts
git commit -m "feat(node): port the discover() orchestrator"
```

---

## Task 5: The route, its 30/minute limit, and the backend flip

**Files:**
- Modify: `frontend/lib/server/ratelimit.ts`
- Create: `frontend/app/api/discover/route.ts`
- Test: `frontend/lib/server/__tests__/discover-route.test.ts` (new)
- Modify: `frontend/lib/server/__tests__/ratelimit.test.ts`
- Modify: `frontend/lib/server/__tests__/ratelimit-routes.test.ts`
- Modify: `frontend/lib/backend.ts`
- Modify: `frontend/lib/__tests__/backend.test.ts:112`
- Modify: `CLAUDE.md`

**Interfaces:**
- Produces: `RATE_LIMITS.discover = { limit: 30, windowSeconds: 60 }`; `POST` from `app/api/discover/route.ts`.

- [ ] **Step 1: Add the rate-limit bucket**

In `frontend/lib/server/ratelimit.ts`, extend `RATE_LIMITS` and its doc comment:

```ts
/** Parity with mylibrary/api.py decorators: 30/minute catalog search, 5/minute enrich
 *  start, 30/minute directive draft, 15/minute similar books, 30/minute discover. Each
 *  route uses its own bucket key — these limits are independent, not shared. */
export const RATE_LIMITS = {
  catalogSearch: { limit: 30, windowSeconds: 60 },
  enrichStart: { limit: 5, windowSeconds: 60 },
  directiveDraft: { limit: 30, windowSeconds: 60 },
  booksSimilar: { limit: 15, windowSeconds: 60 },
  discover: { limit: 30, windowSeconds: 60 },
} as const;
```

In `frontend/lib/server/__tests__/ratelimit.test.ts`, add to the existing limits assertion block:

```ts
    expect(RATE_LIMITS.discover).toEqual({ limit: 30, windowSeconds: 60 });
```

- [ ] **Step 2: Write the failing route test**

```ts
// frontend/lib/server/__tests__/discover-route.test.ts
import { describe, test, expect } from 'vitest';
import seedJson from './fixtures/parity/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupParityEnv } from './helpers/parity';
import { installHttpReplay } from './helpers/httpReplay';
import { _setDbForTests, schema } from '../db';
import { POST } from '@/app/api/discover/route';

const req = (body?: unknown) =>
  new Request('http://test/api/discover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('POST /api/discover', () => {
  setupParityEnv();

  test('mirrors FastAPI’s validation on query and n', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      _setDbForTests(db);
      expect((await POST(req())).status).toBe(422); // missing body
      expect((await POST(req({}))).status).toBe(422); // query is required
      expect((await POST(req({ query: '' }))).status).toBe(422); // min_length 1
      expect((await POST(req({ query: 'x'.repeat(501) }))).status).toBe(422); // max_length 500
      expect((await POST(req({ query: 'q', n: 0 }))).status).toBe(422); // ge 1
      expect((await POST(req({ query: 'q', n: 21 }))).status).toBe(422); // le 20
      expect((await POST(req({ query: 'q', n: 'x' }))).status).toBe(422);
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('400s (not 422) on a whitespace-only query, like Python', async () => {
    // Pydantic's min_length=1 is satisfied by "   "; discover() then strips it and
    // raises RuntimeError, which api.py maps to a 400.
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      await db.update(schema.userSettings).set({ anthropicApiKeyEncrypted: null });
      _setDbForTests(db);
      const res = await POST(req({ query: '   ' }));
      expect(res.status).toBe(400);
      expect((await res.json()).detail).toBe('Enter something to search for.');
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('400s with the no-key message, without touching the catalog', async () => {
    const { db, close } = await makeTestDb();
    const seen: string[] = [];
    const restore = installHttpReplay({}, (u) => seen.push(u));
    try {
      await loadSeed(db, seedJson as any);
      // setupParityEnv clears the env key, but the SEED stores an encrypted per-user
      // key for 'local'. Without clearing it too, a real Anthropic client is built
      // and the run 500s on a live network call.
      await db.update(schema.userSettings).set({ anthropicApiKeyEncrypted: null });
      _setDbForTests(db);
      const res = await POST(req({ query: 'gentle fantasy', n: 5 }));
      expect(res.status).toBe(400);
      expect((await res.json()).detail).toContain('No Anthropic API key configured');
      expect(seen).toEqual([]);
    } finally {
      restore();
      _setDbForTests(null);
      await close();
    }
  });
});
```

Then extend `frontend/lib/server/__tests__/ratelimit-routes.test.ts`. Add one import beside the existing route imports:

```ts
import { POST as discoverRoute } from '../../../app/api/discover/route';
```

and add this `it` block inside the existing `describe`, after the `books/[id]/similar` one. This one **can** reuse `assertCorrected429`, since the limit is 30/minute like the first two:

```ts
  it('POST /api/discover returns the corrected body once the 30/minute limit is exceeded', async () => {
    silenceLogs();
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      expect(RATE_LIMITS.discover).toEqual({ limit: 30, windowSeconds: 60 });

      // setupParityEnv deletes ANTHROPIC_API_KEY and this test seeds no user_settings
      // row, so every "allowed" request 400s on the no-key branch (checked AFTER the
      // rate limit in the route). Discovery has no metadata pool, so none of these
      // reaches the catalog either — no mocking needed.
      const body = JSON.stringify({ query: 'gentle fantasy' });
      let last: Response | undefined;
      for (let i = 0; i < RATE_LIMITS.discover.limit + 1; i++) {
        last = await discoverRoute(
          new Request('http://test/api/discover', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          })
        );
      }
      await assertCorrected429(last!);
    } finally {
      _setDbForTests(null);
      await close();
    }
  });
```

- [ ] **Step 3: Run them and watch them fail**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/discover-route.test.ts lib/server/__tests__/ratelimit-routes.test.ts lib/server/__tests__/ratelimit.test.ts
```

Expected: FAIL — `Cannot find module '@/app/api/discover/route'`.

- [ ] **Step 4: Implement the route**

```ts
// frontend/app/api/discover/route.ts
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { checkRateLimit, RATE_LIMITS, rateLimitExceededResponse } from '@/lib/server/ratelimit';
import { runDiscover } from '@/lib/server/recDiscoverRun';

// Two Claude calls (a Haiku interpretation pass and a Sonnet rerank) plus two
// catalog fetches per interpreted query. 300s is Vercel Hobby's maximum and the
// default on every tier.
export const maxDuration = 300;

/** Twin of schemas.DiscoverRequest: query (1..500 chars, required), n: int = 10 (1..20). */
const Body = z.object({
  query: z.string().min(1).max(500),
  n: z.number().int().min(1).max(20).default(10),
});

/**
 * Port of api.py::discover_books (963-978). Ephemeral natural-language discovery;
 * nothing is persisted.
 *
 * Order of checks matches FastAPI: the body is validated during dependency
 * resolution (422), THEN slowapi's decorator runs (429), THEN the handler body.
 * Note that a whitespace-only query passes Pydantic's min_length=1 and is rejected
 * later, by runDiscover, as a 400 — not a 422.
 */
export const POST = withApi('/api/discover', async (req, ctx) => {
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
    key: `discover:${ctx.user.userId}`,
    ...RATE_LIMITS.discover,
  });
  if (!rl.allowed) {
    // Corrected 429 shape (not the usual {"detail": ...}) -- see
    // rateLimitExceededResponse's doc comment in ratelimit.ts.
    return rateLimitExceededResponse(
      RATE_LIMITS.discover.limit,
      RATE_LIMITS.discover.windowSeconds
    );
  }

  // Resolve the key once and hand it down. NOT raised here: Python checks the key at
  // point of use, inside the interpretation stage.
  const apiKey = await resolveAnthropicKey(db, ctx.user.userId);
  const client = apiKey ? makeAnthropicClient(apiKey) : null;

  const out = await runDiscover(db, client, ctx.user.userId, parsed.data.query, parsed.data.n);
  ctx.timer.mark('claude');
  return Response.json(out);
});
```

- [ ] **Step 5: Run the route tests**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/discover-route.test.ts lib/server/__tests__/ratelimit-routes.test.ts lib/server/__tests__/ratelimit.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Flip the route to Node in auto mode**

In `frontend/lib/backend.ts`, add this entry to `NODE_DEFAULT_ROUTES`, directly after the `/recommend` rule:

```ts
  // Wave 3c-3: natural-language discovery. `exact` because /discover has no
  // sub-paths today and a future one should be an explicit decision.
  { prefix: '/discover', methods: ['POST'], exact: true },
```

and add to the file's header comment, after the wave 3c-1 line:

```
 * Wave 3c-3: `POST /discover` (natural-language discovery) flips to Node, completing wave 3c.
```

- [ ] **Step 7: Update the backend switcher test**

In `frontend/lib/__tests__/backend.test.ts`, line 112 currently reads:

```ts
    expect(baseFor('/discover', 'POST')).toBe(PY); // 3c
```

Replace it with:

```ts
    expect(baseFor('/discover', 'POST')).toBe('/api'); // wave 3c-3
```

Also update the comment two lines above it — `// still Python — 3c-3/4/5` becomes `// still Python — waves 4/5`.

- [ ] **Step 8: Run the whole suite**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run
npx tsc --noEmit
```

Expected: all tests PASS and no type errors.

- [ ] **Step 9: Verify in the real app**

Tests alone are not sufficient (global rule). Bring up the app against a throwaway local database and exercise the flow in the browser.

```bash
# Terminal 1 — see the isolated-local-env skill for the SQLite/local-mode setup.
cd /home/chase/Documents/Code/my-library && python -m mylibrary.cli serve
# Terminal 2
cd /home/chase/Documents/Code/my-library/frontend && npm run dev
```

Then, in the browser at http://localhost:3000:
1. Find the discovery entry point (`api.discover`) and submit a natural-language request.
2. Confirm results render with their interpretation line, and that the DevTools Network tab shows the request going to **`/api/discover`** (same-origin Node), not to `127.0.0.1:8000`.
3. Submit a request with a stated constraint ("something French", "nothing about war") and confirm it still returns results.
4. Confirm nothing new appears in the recommendations feed / swipe deck — these results are ephemeral.
5. Report what you saw. If a real Anthropic key is not available locally, say so explicitly rather than claiming the flow was verified.

- [ ] **Step 10: Update CLAUDE.md**

Replace the closing sentence of the migration paragraph — `Wave 3c-3 (\`/discover\`) is next, then wave 4 (jobs + imports) and wave 5 (admin + cutover).` — with:

> Wave 3c-3 shipped `POST /discover` and completes wave 3c: `cleanConstraints` +
> `applyDiscoveryConstraints` (a pool-level filter applied BEFORE assembly, with no
> `exclude_authors` branch — deliberately not `applyDirectiveConstraints`),
> `discoveryPool` (both catalog sources per query, Google then Open Library),
> `recDiscoverPrompts.ts` and `recDiscoverRun.ts`, with Python's 30/minute SlowAPI
> limit reproduced via `RATE_LIMITS.discover`. Discovery is the odd one out in the
> recommender family: it hands `assemble` an EMPTY metadata pool (so every candidate
> is tagged `claude_seed`), a stated language constraint replaces the reader's
> library languages for the run, and the standing custom-instructions directive does
> not steer it at all. Its two prompts share `recPrompts.tasteAndLoved` but prefix it
> with two headers that differ by one substring — an asserted parity detail, not a
> typo. Wave 4 (jobs + imports) is next, then wave 5 (admin + cutover).

- [ ] **Step 11: Commit**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx prettier --write lib/server/ratelimit.ts lib/backend.ts app/api/discover/route.ts \
  lib/server/__tests__/discover-route.test.ts \
  lib/server/__tests__/ratelimit.test.ts \
  lib/server/__tests__/ratelimit-routes.test.ts \
  lib/__tests__/backend.test.ts
cd /home/chase/Documents/Code/my-library
git add frontend/app/api/discover frontend/lib/server/ratelimit.ts frontend/lib/backend.ts \
  frontend/lib/server/__tests__/discover-route.test.ts \
  frontend/lib/server/__tests__/ratelimit.test.ts \
  frontend/lib/server/__tests__/ratelimit-routes.test.ts \
  frontend/lib/__tests__/backend.test.ts CLAUDE.md
git commit -m "feat(node): POST /discover and flip it to Node in auto mode"
```

---

## Done when

- `npx vitest run` passes in `frontend/`, including the two new parity assertions.
- `npx tsc --noEmit` is clean.
- `prompts.json` contains `discover_interpret` and `discover_rerank`, and their two block-0 prefixes differ.
- The browser flow in Task 5 Step 9 was actually exercised and reported.
- `POST /discover` reaches `/api` in auto mode. Wave 3c is complete: `/recommend`, `/books/{id}/similar` and `/discover` are all Node.

---

## Verification record — executed 2026-08-10

Every "done when" item above was met. Evidence, in the order it was produced.

### Fixture regeneration (Task 1)

```
catalog traffic recorded:
  openlibrary.org: 33/33 returned data
  www.googleapis.com: 20/20 returned data
prompts.json scenarios: [..., 'similar_seed', 'similar_rerank', 'discover_interpret', 'discover_rerank']
recommend-http.json urls: 53   (was 49; discovery added 4)
```

`discover_interpret` recorded as `claude-haiku-4-5-20251001` / 1500 / `interpret_request`,
`discover_rerank` as `claude-sonnet-5` / 4000 / `rank_discovery`; both 2-block with
`cache_control` on block 0. The two block-0 prefixes differ as V2 requires
(`(secondary context; the request rules)` vs `(secondary - the request rules)`).
`key leaked: False`. The three pre-existing parity suites stayed green on the new fixture.

### Automated suite

- `npx vitest run` → **56 files, 334 tests, all passing.**
- `npx tsc --noEmit` → clean (exit 0).
- The Task 3 rerank parity assertion passed on its FIRST run, so the two-source pool
  order, pre-assembly constraint filter, language override, dedup, author caps and
  description ordering all reproduce Python without adjustment.

### Live run (Task 5 Step 9)

Throwaway Docker Postgres (never dev Supabase) + Python on :8010 + `next dev` on :3000,
real Anthropic key injected without being read. See the `node-route-live-verification`
memory for the setup recipe.

Browser, at `http://localhost:3000/discover`:

1. "something gentle for a bad week, nothing about war" → results rendered with the
   interpretation line and a per-pick rationale on each card.
2. DevTools Network: **`POST http://localhost:3000/api/discover` → 200**. Only other
   requests were Google Books cover images. **Zero** requests to `127.0.0.1:8000`/`:8010`,
   and the Python access log recorded **0** `/discover` hits. Backend badge read `N`.
3. Stated-constraint request ("a quiet novel published after 2000, nothing about grief")
   returned results honoring both the era filter and the subject exclusion.
4. Ephemeral confirmed: `recommendations` stayed at **0 rows**; Home still showed
   "Ready for new picks?" with 0 to-read. `usage_events` ended at 5 `discover_interpret` /
   3 `discover_rerank` — matching exactly the flows run, two of which early-returned
   before a rerank. Rate-limit bucket `discover:local` was created.

Cross-check on a divergent-looking result: a French-language request returned `count: 0`
from Node — and the **identical query against the Python backend on the same database also
returned 0**. That is the language-override path behaving, not a port defect.

### Shipped as

```
4abe5bc feat(node): POST /discover and flip it to Node in auto mode
6c6f124 feat(node): port the discover() orchestrator
32c8505 feat(node): discovery prompts, proven byte-identical to Python
8e0346a feat(node): discovery constraint cleaning, pool filter and two-source pool
71f0694 test(node): record the discovery prompts + catalog traffic for wave 3c-3
```
