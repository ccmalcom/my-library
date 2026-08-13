# Node Backend Wave 4c-1 — Synchronous Enrichment Core Implementation Plan

> **For agentic workers:** REQUIRED EXECUTION PATH: follow the `CLAUDE.md:137-191` Claude / Codex split. Claude owns planning and judgement; send each implementation task verbatim to `/codex:rescue --background <task text>`, review the resulting diff, and let Chase commit and merge by hand. Enable the review gate at the start of execution. Never commit, cherry-pick, merge, push, or deploy from an agent session.

**Goal:** Port exactly the synchronous `enrich_library()` domain core and expose it through authenticated `POST /enrich`, preserving Python's selection, ISBN-first resolution, confidence, persistence, progress, skip/force, summary, catalog-cache, throttle, retry, and HTTP-stat behavior where observable.

**Architecture:** Extend the existing Node catalog module with enrichment-specific Open Library and Google wrappers plus per-run request statistics; add a server-only enrichment resolver and an orchestration module that performs one user-scoped load and commits each completed book independently; then add one authenticated synchronous route. Extend the existing catalog recorder before parity work. Reuse `getJson`, `googleBooksQuery`, `openlibraryWorkDescription`, `setRate`, and the Postgres cache; add no second fetch stack and no Claude path.

**Tech Stack:** Next.js route handlers, TypeScript, Drizzle over postgres-js, existing Postgres `catalog_cache`, Vitest + PGlite, Jest backend-switcher tests, Python catalog recorder, FastAPI/SQLAlchemy golden generation.

---

## Global Constraints

These apply to **every** task. Read them before starting any task.

1. **Wave 4c-1 is synchronous enrichment only:** port book selection, per-book resolution, confidence scoring, match methods, Enrichment upsert, force/skip behavior, progress callback, HTTP statistics, and the final summary; expose only the existing blocking `POST /enrich`. Do not add `POST /enrich/start`, `GET /enrich/status/{job_id}`, `enrich_jobs` changes, leases, a tick endpoint, `waitUntil`, self-chaining, poll repair, a janitor cron, job rate limits, or any other background/job machinery. Those belong to designed-but-deliberately-unplanned wave 4c-2.
2. **Wave 5 remains separate:** do not change admin routes, delete Python enrichment, cut over the Python service, change deployment, or port Redis/arq. The synchronous Python core and CLI remain live until wave 5.
3. **Confidence is a downstream data contract.** Locked decision #5 is “enrichment is the foundation”: metadata drives later recommendations, while ambiguous matches are deliberately LOW so feedback surfaces them. Tests must cover every HIGH/MEDIUM/LOW/NONE rule, all five persisted `match_method` strings, and both sides of every adjacent boundary. A wrong rule silently corrupts recommendations and is nearly invisible in a diff.
4. **Python is the specification.** `mylibrary/enrich.py`, every catalog function it calls, the synchronous wrapper at `mylibrary/api.py:577-590`, and their tests are authoritative. Reproduce observable quirks; do not improve matching during the port.
5. **ISBN means unconditional HIGH.** Any nonempty Open Library ISBN result immediately wins as `HIGH` / `isbn:openlibrary`; otherwise any nonempty Google ISBN result immediately wins as `HIGH` / `isbn:googlebooks`. Do not verify title similarity, author, or returned ISBN because Python does not.
6. **Search scoring is exact.** Empty candidates produce internal `NONE`. Otherwise sort by Python-compatible `SequenceMatcher.ratio()` of normalized titles. A unique best score `>= 0.85`, with author compatibility, is MEDIUM. `author_ok` means missing book author, missing candidate author, equal normalized surnames, or the book surname appearing anywhere in the candidate's normalized author. A best score below `0.85`, an author failure, or two top candidates both `>= 0.85` is LOW. The `0.60` weak threshold is observably inert: both its branch and fallthrough return the best candidate as LOW.
7. **Resolution order is exact.** Try Open Library ISBN, Google ISBN, Open Library search, then Google search. Return an Open Library MEDIUM immediately; otherwise still run Google. Return a Google MEDIUM immediately. When neither is MEDIUM, prefer the Open Library LOW candidate even if Google's LOW score is numerically better; then Google LOW; then unresolved. Match methods are exactly `isbn:openlibrary`, `isbn:googlebooks`, `search:openlibrary`, `search:googlebooks`, and `unresolved`.
8. **`NONE` is never persisted.** An unresolved book stores `confidence_label = "LOW"`, `resolution_confidence = 0.0`, `match_method = "unresolved"`, and a fresh `resolved_at`; its progress label is `unresolved`. Test the complete stored object, not only the label.
9. **Reuse the Node catalog layer.** All HTTP must flow through `frontend/lib/server/catalog.ts`'s `getJson()` and thereby `catalogCache.ts`'s `cacheGet()`/`cachePut()`, request throttle (`setRate`, `MYLIBRARY_REQ_PER_SEC`, private `throttle()`), retry, timeout, and negative caching. Reuse `googleBooksQuery()`, `normLang()`, and `openlibraryWorkDescription()`. Add missing `openlibraryByIsbn`, edition-to-work traversal, exact `openlibraryEnrichmentSearch`, `googleBooksByIsbn`, `googleBooksEnrichmentSearch`, and stats APIs in `catalog.ts`; never duplicate a fetcher in enrichment code.
10. **Enrichment never calls Claude.** `mylibrary/enrich.py` imports only catalog/config/database collaborators and `_resolve_one()` calls only catalog functions. Do not import or wire `anthropic.ts`, `claude.ts`, per-user key resolution, Anthropic clients, usage tracking, or `usage_events` into the core or route.
11. **Numeric formatting and rounding live in `serialize.ts`.** Use the existing Python-compatible helpers for stored/returned numeric values. Never write `Math.round(x * 10 ** d) / 10 ** d`; exact ties disagree with CPython and that defect has already reached real API responses. Confidence constants must pass through an exported helper in `frontend/lib/server/serialize.ts`, even though the current constants look exactly representable.
12. **Per-book durability is required.** Python commits after every book so interruption preserves completed work. Do not wrap the run in one transaction. Implement each upsert as its own `db.transaction(...)`, then invoke progress only after that transaction succeeds. A later lookup failure must not roll back earlier rows.
13. **Selection semantics are literal.** Load all books for the authenticated user with no `ORDER BY`; eligible means `includeUnrated || effectiveRating !== null`, where effective rating is `appRating` when non-null else `goodreadsRating` when non-null. Existing enrichment is skipped unless `force`; internal `retryUnresolved` retries rows whose `resolvedSource` is null. Apply `limit` only after skip calculation. Preserve the denominator `skipped + limitedWork.length`, including Python's negative-limit slice behavior if exposed to the core; the HTTP request accepts `limit: integer | null` without a positivity constraint.
14. **Progress and summary are exact.** Call progress once before work as `(skipped, fullTotal, '', 'starting')`, then once after each committed book as `(skipped + i, fullTotal, title, label)`. Summary key order/shape is `total`, `processed`, `HIGH`, `MEDIUM`, `LOW`, `unresolved`, `skipped_existing`, `http`; `http` is the post-run stats snapshot. Whole-object assertions must reject supersets.
15. **Complete runnable tests only.** Every test added by this plan has real setup, invocation, and whole-object assertions against real schema columns and fixture data. Do not replace bodies with comments, TODOs, partial-field assertions, `any`, or invented types. Expected-RED gates name failing tests, never a count.
16. **The fixture recorder is a prerequisite.** The current recorder invokes only `catalog.search_books()` and cannot capture an enrichment run. Extend it to seed isolated books, invoke real Python `enrich_library()`, capture every emitted URL, and write expected summary plus persisted enrichment rows before adding Node parity tests. Never fabricate a golden value in TypeScript.
17. **Executor command boundary is hard.** Codex cannot run `npm install`, any pytest command because `tests/conftest.py` imports FastAPI `TestClient`, `scripts/gen_catalog_fixtures.py`, `scripts/gen_parity_fixtures.py`, or another fixture recorder. A recorder/pytest/install step is explicitly Chase's or Claude's and includes its exact command. No executor step may pretend it ran one.
18. **Every task owns all gates.** Its verification step lists the relevant `npx vitest run <files>`, `npm run type-check`, `npx eslint <touched files>`, and `npx prettier --write <touched files>`. Route-switcher tasks also list their Jest file. An unlisted gate is out of scope to the executor, not implicitly remembered.
19. **Tasks are approximately ten executor minutes.** Stop at the task's verification step with the diff ready for review. If exploration shows the task cannot fit, split it before implementing. If a named edit target or symbol cannot be found, locate it with `rg`; if genuinely absent, report that plainly—never invent the edit or silently skip it.
20. **Chase owns repository operations.** No task runs commit, cherry-pick, merge, push, deploy, or destructive git commands. Use `git --no-pager` or `GIT_PAGER=cat` for every git inspection because a pager hangs the shell. Prettier only explicit touched files, never the repository.
21. **Proofs follow symbols.** When proving a change landed, use `grep -n '<exact code>' <file>`, never `sed -n 'N,Mp'`; author-time line numbers drift. Every implementation must be checked against the current file before editing.
22. **The switcher flip is last.** `POST /enrich` stays pinned to Python until the core, route, fixture parity, and all focused gates pass. Changing its backend-switcher test and production rule is its own final implementation task.
23. **SEARCH BEFORE YOU PORT — added by plan review, after this plan's own Task 3 was caught telling you to reimplement two already-ported modules.** Earlier waves already ported a surprising amount of `enrich.py`. Confirmed present and parity-tested today: `frontend/lib/server/similarity.ts` (wave 3c-1) exports `ratio()` — the full `difflib.SequenceMatcher(None, a, b).ratio()` port — plus `STRONG_SIM = 0.85` and `titleSim()`, which is `enrich._title_sim` itself; and `frontend/lib/server/dedup.ts` exports `normalizeTitle`, `surname`, and `normalizeFullTitle`, exact ports of the `enrich.py` originals. Wave 3a shipped `catalog.ts` and `catalogCache.ts`. **Before implementing ANY helper in this wave, `rg` for it under `frontend/lib/server/` first.** A second port of a Python function is worse than no port: the two are free to drift, and the project's whole discipline is byte-parity. If an existing port looks wrong, stop and report it — do not write a competing one.

---

## Verified Facts

Every row below was checked against the current repository, not accepted from the inventory or design sketches.

| # | Fact | Evidence |
| --- | --- | --- |
| V1 | `enrich_library` defaults are `force=False`, `limit=None`, `include_unrated=False`, `retry_unresolved=False`, `requests_per_second=None`, optional four-argument progress, and local user. | `mylibrary/enrich.py:180-189` |
| V2 | Each run optionally sets catalog rate, always resets stats, and initializes the seven pre-HTTP summary keys in their observable insertion order. | `mylibrary/enrich.py:203-215` |
| V3 | Selection is user-scoped with no `ORDER BY`; eligibility uses the effective rating unless `include_unrated`. | `mylibrary/enrich.py:217-221`; `mylibrary/db.py:109-118` |
| V4 | Force, retry-unresolved, skipped calculation, post-skip limit slicing, total denominator, and initial progress call have the literal semantics stated in Constraints 13-14. | `mylibrary/enrich.py:222-246` |
| V5 | Resolution order and all five method strings are Open Library ISBN, Google ISBN, Open Library search, Google search, unresolved. | `mylibrary/enrich.py:151-177` |
| V6 | Any ISBN candidate is returned HIGH immediately without title, author, or ISBN validation. | `mylibrary/enrich.py:153-159` |
| V7 | Candidate scoring uses normalized-title `SequenceMatcher`, a `0.85` strong threshold, the stated author rule, and ambiguity when both top scores are strong. | `mylibrary/enrich.py:29-32`; `mylibrary/enrich.py:35-48`; `mylibrary/enrich.py:78-79`; `mylibrary/enrich.py:93-120` |
| V8 | The `0.60` weak branch and the final fallthrough both return the best candidate LOW. | `mylibrary/enrich.py:121-123` |
| V9 | Apply copies source/id/subjects/series/position/language/description/cover/raw, assigns confidence/method, and stamps resolution time; missing Open Library Work descriptions receive one Work lookup. | `mylibrary/enrich.py:126-148` |
| V10 | Unresolved persistence converts internal NONE to stored LOW/0.0/unresolved; resolved counts increment their label; every book commits before progress. | `mylibrary/enrich.py:248-271` |
| V11 | Final summary appends the current HTTP stats snapshot under `http`. | `mylibrary/enrich.py:273-274`; `mylibrary/catalog.py:59-75` |
| V12 | HTTP stats count actual attempts, retries, caught network failures, retryable response classes, and host requests/429s; cache hits return before any counter. | `mylibrary/catalog.py:99-155` |
| V13 | Open Library ISBN may traverse edition → Work → description; the exact ISBN record normalization is specified by the returned literal. | `mylibrary/catalog.py:186-212`; `mylibrary/catalog.py:215-251` |
| V14 | Enrichment Open Library search sends `title`, `limit=5`, optional `author`, no `fields`, and maps at most five docs. | `mylibrary/catalog.py:301-330` |
| V15 | Google ISBN takes the first generic query candidate; title search builds `intitle:"..."` plus optional `inauthor:"..."`. | `mylibrary/catalog.py:336-363`; `mylibrary/catalog.py:384-392` |
| V16 | Node already exposes `setRate`, `getJson`, `googleBooksQuery`, candidate normalization, and Work-description lookup; `getJson` owns cache, throttle, retries, timeout, and negative caching. | `frontend/lib/server/catalog.ts:21-89`; `frontend/lib/server/catalog.ts:112-175`; `frontend/lib/server/catalog.ts:419-429` |
| V17 | `cacheGet` distinguishes missing from cached JSON null, while `cachePut` upserts payload/source/time in the existing `catalog_cache` table. | `frontend/lib/server/catalogCache.ts:15-48`; `frontend/lib/server/schema.ts:255-260` |
| V18 | Existing Open Library Node search helpers are not enrichment-equivalent: one uses `q`, and one lacks author, defaults to 20, and adds a `fields` list. | `frontend/lib/server/catalog.ts:178-229` |
| V19 | The Drizzle and PGlite schemas already contain every enrichment column, including language and unique `book_id`; no schema migration is needed. | `frontend/lib/server/schema.ts:128-151`; `frontend/lib/server/__tests__/helpers/pglite.ts:68-84` |
| V20 | `serialize.ts` owns half-even rounding and timestamps; its private `pyRound` must not be copied into enrichment. | `frontend/lib/server/serialize.ts:1-59`; `frontend/lib/server/serialize.ts:72-111` |
| V21 | The synchronous request body contains only `force`, nullable integer `limit`, and `include_unrated`, with defaults false/null/false. | `mylibrary/schemas.py:19-22` |
| V22 | `POST /enrich` is authenticated, blocking, not rate-limited, and passes only the three request fields plus resolved user ID to the core. | `mylibrary/api.py:577-590`; `mylibrary/api.py:219-238` |
| V23 | Python enrichment imports no Claude/Anthropic/usage collaborator and its resolver calls catalog only. | `mylibrary/enrich.py:21-27`; `mylibrary/enrich.py:151-177` |
| V24 | The existing catalog recorder captures only three `search_books` calls and writes HTTP plus normalized search outputs; it never invokes enrichment. | `scripts/gen_catalog_fixtures.py:33-60` |
| V25 | Node HTTP replay performs exact URL lookup and throws `HttpReplayMissError` on an unrecorded request. | `frontend/lib/server/__tests__/helpers/httpReplay.ts:17-46` |
| V26 | Existing Python enrichment tests cover basic normalization/scoring only; they do not cover resolution order, persistence, selection, progress, summaries, or HTTP stats. | `tests/test_enrich.py:5-67` |
| V27 | Auto mode currently contains no `/enrich` Node rule and explicitly keeps enrichment background paths on Python. | `frontend/lib/backend.ts:44-74`; `frontend/lib/__tests__/backend.test.ts:85-133` |
| V28 | `withApi` authenticates by default, converts auth/API failures, and accepts a raw `Response`; no wrapper change is required. | `frontend/lib/server/http.ts:35-94` |
| V29 | Codex is prohibited from pytest, fixture recorders, and `npm install`, and Chase commits by hand. | `CLAUDE.md:171-191` |
| V30 | Approved scope explicitly splits synchronous domain risk into 4c-1 and all job/platform machinery into 4c-2; admin/cutover are wave 5. | `docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:60-80`; `docs/superpowers/specs/2026-08-11-wave-4c-enrichment-design.md:223-228` |

### Python quirks to reproduce, not fix

- `_score_candidates` deliberately-looking-but-inert threshold: `if best_sim >= _WEAK_SIM: return best, "LOW"` is followed by `return best, "LOW"`. Every nonempty candidate list that is not MEDIUM is LOW, whether the best score is exactly `0.60`, just below it, or zero. Keep both conceptual branches in TypeScript and comment that Python's weak threshold is currently inert if duplication or lint pressure tempts deletion.
- `_resolve_one` trusts any ISBN lookup result absolutely. The first nonempty Open Library or Google candidate is HIGH without checking title similarity, author, or whether its payload confirms the requested ISBN. Do not add verification Python lacks.
- Internal `NONE` is never stored. No candidates becomes an Enrichment row with `confidence_label = "LOW"`, `resolution_confidence = 0.0`, `match_method = "unresolved"`, null resolution fields, and progress label `unresolved`.
- A LOW Open Library search candidate wins over a LOW Google candidate even when Google's numerical similarity is better; scores are not compared across catalogs.
- Ambiguity ignores author identity for the second candidate. If the two highest title scores are both `>= 0.85`, the result is LOW even when only the best candidate's author matches.
- `limit` is applied after existing-row skipping. Skipped rows remain in `total`, while eligible rows excluded by the limit do not. Python list slicing also accepts zero and negative limits.
- A forced upsert overwrites enrichment-owned fields with candidate nulls/empty arrays. It is replacement semantics, not “fill blanks only.” Unresolved retry updates only the four unresolved fields and timestamp; Python does not explicitly clear stale resolved metadata on that path.
- Book query order is intentionally unspecified because there is no `ORDER BY`. Tests may control insertion order for a fixture but must not add production ordering as an “improvement.”

---

## File Structure

**New files**

| File | Responsibility |
| --- | --- |
| `frontend/lib/server/enrichment.ts` | Python-compatible normalization, SequenceMatcher ratio, scoring, resolution order, candidate application, selection/orchestration, per-book transaction, progress, and summary. |
| `frontend/lib/server/__tests__/enrichment-score.test.ts` | Complete confidence boundaries, ambiguity, author compatibility, ISBN trust, resolution order, and every match method. |
| `frontend/lib/server/__tests__/enrichment-run.test.ts` | Real-schema selection, force/retry/limit, upsert replacement, unresolved persistence, progress, durability, summary, and tenant isolation. |
| `frontend/lib/server/__tests__/fixtures/catalog/enrichment-expected.json` | Human-recorded Python summary and persisted rows for the isolated enrichment scenario. |
| `frontend/lib/server/__tests__/enrichment-parity.test.ts` | Replays recorded enrichment HTTP and compares whole summary/rows to Python. |
| `frontend/app/api/enrich/route.ts` | Authenticated, synchronous compatibility handler for `POST /enrich`. |
| `frontend/app/api/enrich/route.test.ts` | Complete defaults/options/validation/auth-scope route tests. |

**Modified files**

| File | Change |
| --- | --- |
| `frontend/lib/server/catalog.ts` | Add enrichment-specific wrappers and run-local HTTP statistics while preserving the single fetch/cache/throttle layer. |
| `frontend/lib/server/serialize.ts` | Add one exported confidence helper backed by existing Python-compatible rounding. |
| `frontend/lib/server/__tests__/catalog-fetch.test.ts` | Lock stats including cache hits, retry classes, hosts, reset/snapshot, and network failures. |
| `frontend/lib/server/__tests__/catalog-search.test.ts` | Lock exact enrichment URLs and normalized catalog helper results. |
| `scripts/gen_catalog_fixtures.py` | Add an isolated real Python enrichment recording scenario; keep secret stripping and search fixtures. |
| `frontend/lib/server/__tests__/fixtures/catalog/http.json` | Human-regenerated HTTP fixture containing enrichment URLs. |
| `frontend/lib/backend.ts` | Final task only: exact method-specific `POST /enrich` Node rule. |
| `frontend/lib/__tests__/backend.test.ts` | Final task only: RED-first route and exact-array assertions. |
| `CLAUDE.md` | Final task only: record 4c-1 completion while keeping 4c-2 and wave-5 boundaries explicit. |

No package, lockfile, schema, migration, Python runtime, job, admin, Claude, usage, worker, or deployment file changes.

---

## Task 1: Add catalog statistics without changing the fetch stack

**Files:** `frontend/lib/server/catalog.ts`, `frontend/lib/server/__tests__/catalog-fetch.test.ts`

- [ ] **Step 1: Add complete RED tests for reset, cache, retry, and host accounting**

Append runnable tests using `makeTestDb`, `installHttpReplay`, and the existing fetch stubbing style. Assert whole snapshots:

```ts
it('resetCatalogStats returns the empty Python-shaped snapshot', () => {
  resetCatalogStats();
  expect(getCatalogStats()).toEqual({
    requests: 0,
    rate_limited: 0,
    server_errors: 0,
    network_errors: 0,
    retries: 0,
    by_host: {},
  });
});

it('counts attempts, retry classes, and hosts but not cache hits', async () => {
  const { db, close } = await makeTestDb();
  setRate(1_000_000);
  resetCatalogStats();
  let googleCalls = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('google.test')) {
      googleCalls += 1;
      return googleCalls === 1
        ? new Response('{}', { status: 429, headers: { 'Retry-After': '0' } })
        : Response.json({ ok: 'google' });
    }
    return new Response('{}', { status: 503 });
  };
  try {
    expect(await getJson(db, 'https://google.test/a', 'googlebooks')).toEqual({ ok: 'google' });
    expect(await getJson(db, 'https://google.test/a', 'googlebooks')).toEqual({ ok: 'google' });
    expect(await getJson(db, 'https://openlibrary.test/b', 'openlibrary')).toBeNull();
    expect(getCatalogStats()).toEqual({
      requests: 4,
      rate_limited: 1,
      server_errors: 2,
      network_errors: 0,
      retries: 2,
      by_host: {
        'google.test': { requests: 2, rate_limited: 1 },
        'openlibrary.test': { requests: 2, rate_limited: 0 },
      },
    });
  } finally {
    globalThis.fetch = oldFetch;
    await close();
  }
});

it('counts each caught network failure and its retry', async () => {
  const { db, close } = await makeTestDb();
  setRate(1_000_000);
  resetCatalogStats();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('offline');
  };
  try {
    expect(await getJson(db, 'https://network.test/a', 'test')).toBeNull();
    expect(getCatalogStats()).toEqual({
      requests: 2,
      rate_limited: 0,
      server_errors: 0,
      network_errors: 2,
      retries: 1,
      by_host: { 'network.test': { requests: 2, rate_limited: 0 } },
    });
  } finally {
    globalThis.fetch = oldFetch;
    await close();
  }
});
```

- [ ] **Step 2: Run the named RED tests**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/catalog-fetch.test.ts
```

Expected RED by name: `resetCatalogStats returns the empty Python-shaped snapshot`, `counts attempts, retry classes, and hosts but not cache hits`, and `counts each caught network failure and its retry` fail because the stats exports do not exist.

- [ ] **Step 3: Instrument only `getJson`**

Add `resetCatalogStats()` and `getCatalogStats()` with a plain-object snapshot. Increment request and host request immediately before each real `fetch`, increment `retries` when `attempt > 1`, increment `network_errors` in the catch, `rate_limited` plus host rate limit for every 429, and `server_errors` for every 500/502/503/504. Do not count cache hits. Preserve `HttpReplayMissError` rethrow and all existing retry/cache behavior.

- [ ] **Step 4: Run all task gates and prove the API landed**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/catalog-fetch.test.ts
npm run type-check
npx eslint lib/server/catalog.ts lib/server/__tests__/catalog-fetch.test.ts
npx prettier --write lib/server/catalog.ts lib/server/__tests__/catalog-fetch.test.ts
grep -n 'export function resetCatalogStats' lib/server/catalog.ts
grep -n 'export function getCatalogStats' lib/server/catalog.ts
```

Expected: PASS. Diff ready for review.

---

## Task 2: Add exact enrichment catalog operations

**Files:** `frontend/lib/server/catalog.ts`, `frontend/lib/server/__tests__/catalog-search.test.ts`

- [ ] **Step 1: Write complete URL and normalization tests first**

Use a fresh PGlite database and `installHttpReplay` with literal response maps. Assert call arrays and whole candidates for: Open Library ISBN with inline description; ISBN edition → Work description; exact Open Library title/author URL with no `fields`; missing-author URL; Google ISBN first candidate; and quoted Google title/author search. The central test body is:

```ts
it('uses the exact enrichment lookup URLs and returns whole normalized candidates', async () => {
  const { db, close } = await makeTestDb();
  setRate(1_000_000);
  const calls: string[] = [];
  const fixtures = {
    'https://openlibrary.org/api/books?bibkeys=ISBN%3A111&jscmd=data&format=json': {
      status: 200,
      body: {
        'ISBN:111': {
          key: '/books/OL1M',
          title: 'Wrong title is still trusted',
          subjects: [{ name: 'Space' }],
          cover: { medium: 'https://cover/1' },
          description: { value: 'Edition description' },
        },
      },
    },
    'https://openlibrary.org/search.json?title=Dune&limit=5&author=Frank+Herbert': {
      status: 200,
      body: { docs: [{ key: '/works/OL1W', title: 'Dune', author_name: ['Frank Herbert'], subject: ['SF'], cover_i: 7, first_publish_year: 1965, language: ['eng'] }] },
    },
    'https://www.googleapis.com/books/v1/volumes?q=isbn%3A222&maxResults=5': {
      status: 200,
      body: { items: [{ id: 'g1', volumeInfo: { title: 'Google ISBN', authors: ['A Writer'], categories: ['Fiction'], language: 'en' } }] },
    },
    'https://www.googleapis.com/books/v1/volumes?q=intitle%3A%22Dune%22+inauthor%3A%22Frank+Herbert%22&maxResults=5': {
      status: 200,
      body: { items: [{ id: 'g2', volumeInfo: { title: 'Dune', authors: ['Frank Herbert'], publishedDate: '1965', language: 'eng' } }] },
    },
  };
  const uninstall = installHttpReplay(fixtures, (url) => calls.push(url));
  try {
    expect(await openlibraryByIsbn(db, '111')).toEqual({
      source: 'openlibrary', resolved_id: '/books/OL1M', title: 'Wrong title is still trusted',
      author: null, subjects: ['Space'], description: 'Edition description', cover_url: 'https://cover/1',
      year: null, language: null, raw: { isbn: '111', record: fixtures['https://openlibrary.org/api/books?bibkeys=ISBN%3A111&jscmd=data&format=json'].body['ISBN:111'] },
    });
    expect(await openlibraryEnrichmentSearch(db, 'Dune', 'Frank Herbert')).toEqual([{
      source: 'openlibrary', resolved_id: '/works/OL1W', title: 'Dune', author: 'Frank Herbert',
      subjects: ['SF'], cover_url: 'https://covers.openlibrary.org/b/id/7-M.jpg', year: 1965,
      language: 'en', raw: fixtures['https://openlibrary.org/search.json?title=Dune&limit=5&author=Frank+Herbert'].body.docs[0],
    }]);
    expect(await googleBooksByIsbn(db, '222')).toEqual({
      source: 'googlebooks', resolved_id: 'g1', title: 'Google ISBN', author: 'A Writer', subjects: ['Fiction'],
      description: null, cover_url: null, year: null, language: 'en', raw: fixtures['https://www.googleapis.com/books/v1/volumes?q=isbn%3A222&maxResults=5'].body.items[0],
    });
    expect(await googleBooksEnrichmentSearch(db, 'Dune', 'Frank Herbert')).toEqual([{
      source: 'googlebooks', resolved_id: 'g2', title: 'Dune', author: 'Frank Herbert', subjects: [],
      description: null, cover_url: null, year: 1965, language: 'en', raw: fixtures['https://www.googleapis.com/books/v1/volumes?q=intitle%3A%22Dune%22+inauthor%3A%22Frank+Herbert%22&maxResults=5'].body.items[0],
    }]);
    expect(calls).toEqual(Object.keys(fixtures));
  } finally {
    uninstall();
    await close();
  }
});
```

Add separate complete tests for the edition-to-work traversal and omitted author; do not replace either with comments.

- [ ] **Step 2: Run the named RED test**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/catalog-search.test.ts
```

Expected RED by name: `uses the exact enrichment lookup URLs and returns whole normalized candidates`, `fills an ISBN description through edition-to-work traversal`, and `omits author from an authorless Open Library enrichment search` fail because the exports do not exist.

- [ ] **Step 3: Implement wrappers through `getJson`**

Add typed functions `openlibraryByIsbn`, private `openlibraryEditionWorkKey`, `openlibraryEnrichmentSearch`, `googleBooksByIsbn`, and `googleBooksEnrichmentSearch`. Reuse `googleBooksQuery`, `normLang`, `openlibraryWorkDescription`, and one candidate converter where field shapes truly match. Keep enrichment Open Library search separate from `openlibraryTitle` because its URL/payload contract differs. Use `URLSearchParams`; prove its actual encoded URL with the RED fixtures rather than hand-adjusting fixture keys.

- [ ] **Step 4: Run all task gates and prove no fetcher was duplicated**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/catalog-search.test.ts lib/server/__tests__/catalog-fetch.test.ts
npm run type-check
npx eslint lib/server/catalog.ts lib/server/__tests__/catalog-search.test.ts
npx prettier --write lib/server/catalog.ts lib/server/__tests__/catalog-search.test.ts
grep -n 'export async function openlibraryByIsbn' lib/server/catalog.ts
grep -n 'export async function openlibraryEnrichmentSearch' lib/server/catalog.ts
grep -n 'export async function googleBooksByIsbn' lib/server/catalog.ts
grep -n 'export async function googleBooksEnrichmentSearch' lib/server/catalog.ts
grep -n 'await getJson' lib/server/catalog.ts
```

Expected: PASS; all network operations still converge on `getJson`. Diff ready for review.

---

## Task 3: Port Python title similarity and the complete confidence matrix

**Files:** `frontend/lib/server/enrichment.ts`, `frontend/lib/server/serialize.ts`, `frontend/lib/server/__tests__/enrichment-score.test.ts`

> **CORRECTED BY REVIEW — read this before writing any code in this task.** The original draft of
> this task told you to implement the `difflib.SequenceMatcher` algorithm and to create
> `normalizeEnrichmentTitle` / `enrichmentSurname` / `normalizeEnrichmentFullTitle`. **All of that
> already exists and is already parity-tested**, and duplicating it would put two ports of the same
> Python function in a codebase whose entire discipline is byte-parity. Verified against the repo:
>
> - `frontend/lib/server/similarity.ts` — shipped in wave 3c-1. Exports `ratio(a, b)` (the full
>   `SequenceMatcher(None, a, b).ratio()` port, including the "both empty returns 1.0" quirk),
>   `STRONG_SIM = 0.85`, and `titleSim(a, b)`, whose docstring is literally
>   *"enrich.\_title\_sim: ratio over the SUBTITLE-STRIPPED normalized titles."* `titleSim` **is**
>   the function `_score_candidates` needs — use it directly.
> - `frontend/lib/server/dedup.ts` — header: *"Ports of mylibrary/enrich.py dedup helpers. Keep
>   byte-identical semantics."* Exports `normalizeTitle`, `surname`, `normalizeFullTitle`, all three
>   already exact ports of the `enrich.py` originals.
>
> **Import these. Do not reimplement, re-export under a new name, or copy their bodies.** If you
> believe one of them diverges from Python, stop and report it rather than writing a second version.
>
> The only genuinely-new helper in this task is `searchTitle` (Python `_search_title`) — confirmed
> absent from `frontend/lib/server/`. Note it is NOT `normalizeTitle`: it only strips parentheticals
> and collapses whitespace, and it **preserves case**.

- [ ] **Step 1: Write the parity tests for the reused helpers plus the one new one**

These tests pin the behavior this task depends on. Three of the four functions are imported, not
written — the test still asserts them, so that a future change to `dedup.ts` or `similarity.ts` that
breaks enrichment fails here loudly.

```ts
import { ratio, titleSim, STRONG_SIM } from '../similarity';
import { normalizeTitle, surname, normalizeFullTitle } from '../dedup';
import { searchTitle } from '../enrichment';

it('normalizes titles, surnames, and search titles exactly like Python', () => {
  expect({
    normalized: normalizeTitle('The Name: A Novel (Deluxe)!'),
    full: normalizeFullTitle('Dune: Special Edition (Hardcover)'),
    surname: surname('Ursula K. Le Guin'),
    search: searchTitle('Evenfall (In the Company of Shadows)'),
  }).toEqual({ normalized: 'the name', full: 'dune special edition', surname: 'guin', search: 'Evenfall' });
});

it('matches Python SequenceMatcher ratios at both strong-boundary neighbors', () => {
  expect({
    exactStrong: ratio('abcdefghijklmnopqrst', 'abcdefghijklmnopqxyz'),
    belowStrong: ratio('abcdefghijklmnopqrst', 'abcdefghijklmnopwxyz'),
    strongConst: STRONG_SIM,
  }).toEqual({ exactStrong: 0.85, belowStrong: 0.8, strongConst: 0.85 });
});
```

Both ratio values were verified against real CPython `difflib` while reviewing this plan; they are
correct as written. `searchTitle` is the only implementation Step 1 requires:

```ts
/** Python enrich._search_title: strip parentheticals, collapse whitespace, KEEP case. */
export function searchTitle(title: string | null): string {
  return (title ?? '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 2: Write the entire scoring rule table as explicit tests**

`scoreCandidates` must call the imported `titleSim` for every comparison and the imported
`STRONG_SIM` for the strong threshold. Declare only `WEAK_SIM = 0.6` locally, since that constant is
specific to `_score_candidates` and (per the quirks section) currently inert.

Use real typed book/candidate fixtures and whole results. The named cases must include:

```ts
it.each([
  ['empty candidates is internal NONE', [], null, 'NONE'],
  ['unique score exactly 0.85 with compatible author is MEDIUM', [candidate('abcdefghijklmnopqxyz', 'Jane Doe')], 'abcdefghijklmnopqxyz', 'MEDIUM'],
  ['score immediately below 0.85 is LOW', [candidate('abcdefghijklmnopwxyz', 'Jane Doe')], 'abcdefghijklmnopwxyz', 'LOW'],
  ['missing book author is compatible and MEDIUM', [candidate('abcdefghijklmnopqxyz', 'Someone')], 'abcdefghijklmnopqxyz', 'MEDIUM'],
  ['missing candidate author is compatible and MEDIUM', [candidate('abcdefghijklmnopqxyz', null)], 'abcdefghijklmnopqxyz', 'MEDIUM'],
  ['equal surname is compatible and MEDIUM', [candidate('abcdefghijklmnopqxyz', 'Janet Doe')], 'abcdefghijklmnopqxyz', 'MEDIUM'],
  ['surname contained in normalized candidate author is MEDIUM', [candidate('abcdefghijklmnopqxyz', 'The Doe Writing Group')], 'abcdefghijklmnopqxyz', 'MEDIUM'],
  ['incompatible author makes a strong unique title LOW', [candidate('abcdefghijklmnopqxyz', 'Jane Roe')], 'abcdefghijklmnopqxyz', 'LOW'],
])('%s', (_name, candidates, selectedTitle, label) => {
  expect(scoreCandidates(book('abcdefghijklmnopqrst', 'John Doe'), candidates)).toEqual({
    candidate: selectedTitle === null ? null : candidates[0],
    label,
  });
});
```

Add separate whole-result tests named `second score exactly 0.85 makes the result ambiguous LOW`, `second score immediately below 0.85 leaves the best MEDIUM`, `score exactly 0.60 returns LOW through Python's inert weak branch`, `score immediately below 0.60 also returns LOW through Python's fallthrough`, and `stable sorting keeps the first equal-scoring candidate`.

- [ ] **Step 3: Add confidence serialization through `serialize.ts`**

Export `serializeResolutionConfidence(label: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE')` returning the Python constants through existing `pyRound` internally. Test the whole table:

```ts
expect(['HIGH', 'MEDIUM', 'LOW', 'NONE'].map((label) => [label, serializeResolutionConfidence(label as ConfidenceLabel)])).toEqual([
  ['HIGH', 0.95], ['MEDIUM', 0.7], ['LOW', 0.3], ['NONE', 0.0],
]);
```

Do not export or copy private `pyRound`, and do not use `Math.round`.

- [ ] **Step 4: Run all task gates and prove both thresholds remain visible**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/enrichment-score.test.ts lib/server/__tests__/serialize.test.ts
npm run type-check
npx eslint lib/server/enrichment.ts lib/server/serialize.ts lib/server/__tests__/enrichment-score.test.ts
npx prettier --write lib/server/enrichment.ts lib/server/serialize.ts lib/server/__tests__/enrichment-score.test.ts
grep -n "from '../similarity'" lib/server/__tests__/enrichment-score.test.ts
grep -n 'const WEAK_SIM = 0.6' lib/server/enrichment.ts
grep -n 'weak threshold is inert in Python' lib/server/enrichment.ts
grep -n 'export function serializeResolutionConfidence' lib/server/serialize.ts
```

Expected: PASS. Diff ready for review.

---

## Task 4: Lock resolution order, ISBN trust, and every match method

**Files:** `frontend/lib/server/enrichment.ts`, `frontend/lib/server/__tests__/enrichment-score.test.ts`

- [ ] **Step 1: Add complete injected-catalog resolution tests**

Define a typed `EnrichmentCatalog` collaborator in production and a fixture factory in the test. Each fake records calls and returns typed candidates. Add these complete named cases with whole `{ result, calls }` assertions:

```ts
it('trusts the first Open Library ISBN candidate as HIGH without verification', async () => {
  const { catalog, calls } = fakeCatalog({ olIsbn: candidate('A Completely Wrong Title', 'Wrong Author') });
  const result = await resolveOne(dbStub, book('Expected Title', 'Expected Author', '111'), catalog);
  expect({ result, calls }).toEqual({
    result: { candidate: candidate('A Completely Wrong Title', 'Wrong Author'), label: 'HIGH', method: 'isbn:openlibrary' },
    calls: ['ol-isbn:111'],
  });
});

it('falls from Open Library ISBN to an unverified Google ISBN HIGH', async () => {
  const google = candidate('Still Wrong', 'Still Wrong');
  const { catalog, calls } = fakeCatalog({ olIsbn: null, googleIsbn: google });
  const result = await resolveOne(dbStub, book('Expected', 'Author', '222'), catalog);
  expect({ result, calls }).toEqual({
    result: { candidate: google, label: 'HIGH', method: 'isbn:googlebooks' },
    calls: ['ol-isbn:222', 'google-isbn:222'],
  });
});
```

Also add full tests named `Open Library MEDIUM stops before Google search`, `Open Library LOW still runs Google and Google MEDIUM wins`, `Open Library LOW wins over a numerically better Google LOW`, `Google LOW is used when Open Library is empty`, `no candidates returns internal NONE and unresolved`, and `search strips the series parenthetical before both catalog calls`. Together they assert all five method values and the exact call sequence.

- [ ] **Step 2: Run the named RED tests**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/enrichment-score.test.ts
```

Expected RED by name: every Task 4 case fails because `resolveOne` and its typed collaborator do not exist.

- [ ] **Step 3: Implement literal short-circuiting**

Implement `resolveOne` in the exact source order. The production collaborator delegates only to Task 2's catalog exports. Keep numeric search scores internal to each catalog; do not compare Open Library and Google LOW values. Do not import Claude or usage modules.

- [ ] **Step 4: Run all task gates and prove every method literal**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/enrichment-score.test.ts lib/server/__tests__/catalog-search.test.ts
npm run type-check
npx eslint lib/server/enrichment.ts lib/server/__tests__/enrichment-score.test.ts
npx prettier --write lib/server/enrichment.ts lib/server/__tests__/enrichment-score.test.ts
grep -n "'isbn:openlibrary'" lib/server/enrichment.ts
grep -n "'isbn:googlebooks'" lib/server/enrichment.ts
grep -n "'search:openlibrary'" lib/server/enrichment.ts
grep -n "'search:googlebooks'" lib/server/enrichment.ts
grep -n "'unresolved'" lib/server/enrichment.ts
rg -n 'anthropic|claude|usage' lib/server/enrichment.ts
```

Expected: tests PASS and the final search prints nothing. Diff ready for review.

---

## Task 5: Implement one-book enrichment persistence

**Files:** `frontend/lib/server/enrichment.ts`, `frontend/lib/server/__tests__/enrichment-run.test.ts`

- [ ] **Step 1: Write the complete resolved insert/upsert test**

Seed a real `books` row with all required columns, call the one-book persistence helper with a full candidate, query every enrichment column except generated `id`, and compare the whole object after masking only `resolvedAt` with `expect.any(String)`:

```ts
expect(rows).toEqual([{
  bookId: 1,
  resolvedSource: 'openlibrary',
  resolvedId: '/works/OL1W',
  subjects: ['Science Fiction', 'Desert'],
  series: null,
  seriesPosition: null,
  description: 'A description',
  coverUrl: 'https://cover/1',
  resolutionConfidence: 0.7,
  confidenceLabel: 'MEDIUM',
  matchMethod: 'search:openlibrary',
  rawResponse: { key: '/works/OL1W' },
  resolvedAt: expect.any(String),
  language: 'en',
}]);
```

Then call it again with a Google candidate containing nulls and empty subjects and assert the entire same row is replaced, proving forced upsert does not preserve stale enrichment-owned values.

- [ ] **Step 2: Write the complete unresolved persistence test**

Seed an existing resolved row, execute the unresolved path, and assert every schema field. Preserve Python's stale-data quirk explicitly: source/id/subjects/etc. remain, while confidence label becomes LOW, confidence becomes `0.0`, method becomes unresolved, and timestamp changes.

```ts
expect(after).toEqual([{
  bookId: 1,
  resolvedSource: 'openlibrary',
  resolvedId: '/works/OLD',
  subjects: ['old'],
  series: 'Old Series',
  seriesPosition: '2',
  description: 'old description',
  coverUrl: 'old cover',
  resolutionConfidence: 0.0,
  confidenceLabel: 'LOW',
  matchMethod: 'unresolved',
  rawResponse: { old: true },
  resolvedAt: expect.any(String),
  language: 'en',
}]);
```

- [ ] **Step 3: Implement transaction-owned upsert and Work-description fallback**

Use `db.transaction(async (tx) => ...)` per book and Drizzle `onConflictDoUpdate` on `enrichment.bookId`. For a missing Open Library description whose `resolvedId` starts `/works/`, call the existing `openlibraryWorkDescription(db, resolvedId)` before the transaction, matching `_apply`. Generate timestamps with `utcnowTs()` and confidence with `serializeResolutionConfidence()`.

- [ ] **Step 4: Run all task gates and prove the conflict target**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/enrichment-run.test.ts lib/server/__tests__/enrichment-score.test.ts
npm run type-check
npx eslint lib/server/enrichment.ts lib/server/__tests__/enrichment-run.test.ts
npx prettier --write lib/server/enrichment.ts lib/server/__tests__/enrichment-run.test.ts
grep -n 'onConflictDoUpdate' lib/server/enrichment.ts
grep -n 'target: enrichment.bookId' lib/server/enrichment.ts
grep -n 'serializeResolutionConfidence' lib/server/enrichment.ts
grep -n 'utcnowTs' lib/server/enrichment.ts
```

Expected: PASS. Diff ready for review.

---

## Task 6: Port selection, progress, durability, and summary orchestration

**Files:** `frontend/lib/server/enrichment.ts`, `frontend/lib/server/__tests__/enrichment-run.test.ts`

- [ ] **Step 1: Add a complete selection/skip/limit/progress test**

Seed, in controlled insertion order: rated unenriched, app-rated with Goodreads zero, unrated, resolved existing, unresolved existing, and another user's rated book. Inject deterministic resolution results. Invoke with `limit: 1`, then compare the whole summary, call list, progress list, and all tenant enrichment rows. The expected summary includes an all-zero HTTP block and `total = skipped_existing + limited work`, not all eligible rows.

```ts
expect({ summary, resolvedBookIds, progress }).toEqual({
  summary: {
    total: 2, processed: 1, HIGH: 1, MEDIUM: 0, LOW: 0,
    unresolved: 0, skipped_existing: 1,
    http: { requests: 0, rate_limited: 0, server_errors: 0, network_errors: 0, retries: 0, by_host: {} },
  },
  resolvedBookIds: [1],
  progress: [
    [1, 2, '', 'starting'],
    [2, 2, 'Rated new', 'HIGH'],
  ],
});
```

Query the rows afterward and assert the complete ordered array so the other user and limit-excluded row cannot be silently enriched.

- [ ] **Step 2: Add complete force, retry, include-unrated, zero, and negative-limit tests**

Each test seeds real rows and compares the whole summary plus resulting whole enrichment rows:

- `force reprocesses resolved and unresolved rows but not ineligible unrated rows`
- `retryUnresolved reprocesses only existing rows with null resolvedSource`
- `includeUnrated admits a book whose appRating and goodreadsRating are both null-equivalent`
- `limit zero processes nothing but retains skipped_existing in total and starting progress`
- `negative limit reproduces Python slicing by dropping that many rows from the tail`

Because schema `goodreads_rating` is non-null, represent the Python effective-unrated case with `goodreadsRating: 0` and no app rating only if current `Book.effective_rating` confirms zero is treated as absent; otherwise report the deviation before writing the fixture and use the real Python rule. Do not invent a nullable schema value.

- [ ] **Step 3: Add the unresolved summary/progress whole-object test**

Resolve one book to no candidates and assert exactly: processed 1, confidence counters all zero, unresolved 1, stored LOW/0.0/unresolved row, and final progress label `unresolved`.

- [ ] **Step 4: Add the per-book durability test**

Make the resolver succeed for book 1 and throw `catalog exploded` for book 2. Assert the promise rejects, book 1's complete enrichment row exists, book 2 has none, and progress contains only starting plus book 1. This proves no run-wide transaction and no progress-before-commit.

- [ ] **Step 5: Implement `enrichLibrary` literally**

Accept a typed options object with public route options plus internal `retryUnresolved`, `requestsPerSecond`, `progress`, and injected resolver for tests. Reset catalog stats at invocation start; call `setRate` only when the override is non-null. Load tenant books and enrichment with a left join and no ordering clause. Compute effective rating, work, skipped, limit slicing, and progress exactly. Persist each book independently. Append `getCatalogStats()` last.

- [ ] **Step 6: Run all task gates and prove there is no run-wide transaction**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/enrichment-run.test.ts lib/server/__tests__/enrichment-score.test.ts
npm run type-check
npx eslint lib/server/enrichment.ts lib/server/__tests__/enrichment-run.test.ts
npx prettier --write lib/server/enrichment.ts lib/server/__tests__/enrichment-run.test.ts
grep -n 'export async function enrichLibrary' lib/server/enrichment.ts
grep -n "progress(skipped, fullTotal, '', 'starting')" lib/server/enrichment.ts
grep -n 'getCatalogStats' lib/server/enrichment.ts
grep -n 'db.transaction' lib/server/enrichment.ts
```

Expected: PASS. Review the `db.transaction` hit: it belongs inside the one-book persistence helper, never around the loop. Diff ready for review.

---

## Task 7: Extend the Python catalog recorder for enrichment

**Files:** `scripts/gen_catalog_fixtures.py`, `frontend/lib/server/__tests__/fixtures/catalog/http.json`, `frontend/lib/server/__tests__/fixtures/catalog/enrichment-expected.json`

- [ ] **Step 1: Extend the recorder without running it (Codex)**

Keep the existing three search scenarios. Add an isolated temporary database seed that deliberately exercises: Open Library ISBN success with edition/Work description; Open Library ISBN miss then Google ISBN success; Open Library search MEDIUM; Open Library LOW then Google MEDIUM; all-search miss/unresolved; and a pre-enriched skip. Invoke real `enrich_library(user_id='fixture-user')`. Serialize expected summary and every persisted enrichment column except generated ID; replace each `resolved_at` with the literal `<TIMESTAMP>` only after validating it is a datetime. Record emitted URLs through the existing `_spy`, strip Google keys, and write deterministic JSON.

Do not hand-author upstream payloads or expected confidence values. If live catalogs no longer yield deterministic branches for the chosen books, stop and report the exact missing branch; Chase/Claude must choose stable seed inputs or introduce a recorder-local response capture pass. Never fabricate a golden.

- [ ] **Step 2: Prove the recorder contains the scenario but do not execute it (Codex)**

```bash
cd /home/chase/Documents/Code/my-library
grep -n 'enrich_library' scripts/gen_catalog_fixtures.py
grep -n 'enrichment-expected.json' scripts/gen_catalog_fixtures.py
grep -n "user_id='fixture-user'" scripts/gen_catalog_fixtures.py
cd frontend
npm run type-check
npx eslint lib/server/catalog.ts
npx prettier --write lib/server/catalog.ts
```

Expected: symbol proofs print. Codex stops; diff ready for Claude/Chase review. Python formatting is not delegated to Prettier.

- [ ] **Step 3: Record the real fixtures (Chase or Claude only)**

```bash
cd /home/chase/Documents/Code/my-library
.venv/bin/python scripts/gen_catalog_fixtures.py
```

This step is **not executable by Codex**. Confirm no API key appears:

```bash
rg -n 'key=' frontend/lib/server/__tests__/fixtures/catalog/http.json
grep -n '"match_method"' frontend/lib/server/__tests__/fixtures/catalog/enrichment-expected.json
grep -n '"http"' frontend/lib/server/__tests__/fixtures/catalog/enrichment-expected.json
```

Expected: key search prints nothing; both expected-data proofs print real recorded fields.

- [ ] **Step 4: Run Python validation (Chase or Claude only)**

```bash
cd /home/chase/Documents/Code/my-library
.venv/bin/pytest tests/test_catalog.py tests/test_enrich.py tests/test_enrich_language.py
```

This step is **not executable by Codex** because the suite imports `tests/conftest.py` and FastAPI `TestClient`. Report exact results; do not ask Codex to substitute a golden.

---

## Task 8: Add recorded end-to-end enrichment parity

**Files:** `frontend/lib/server/__tests__/enrichment-parity.test.ts`, `frontend/lib/server/__tests__/fixtures/catalog/http.json`, `frontend/lib/server/__tests__/fixtures/catalog/enrichment-expected.json`

- [ ] **Step 1: Write the complete replay test**

Load the human-recorded expected seed/summary/rows, seed PGlite through the existing helper, delete `GOOGLE_BOOKS_API_KEY`, call `setRate(1_000_000)`, install exact HTTP replay, invoke `enrichLibrary`, mask only `resolvedAt` after first asserting it matches the repository timestamp shape, and compare:

```ts
expect({ summary, enrichment: normalizedRows }).toEqual({
  summary: expected.summary,
  enrichment: expected.enrichment,
});
```

Do not strip `rawResponse`, subjects, language, confidence, match method, or any summary/HTTP key. Whole-object equality must fail on supersets. Assert the replay call list equals `expected.urls` if the recorder writes that list; otherwise extend the recorder first rather than deriving it from Node.

- [ ] **Step 2: Run the named parity test**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/enrichment-parity.test.ts
```

Expected: `matches Python's recorded synchronous enrichment summary and rows` passes. Any `HttpReplayMissError` means the recorder is incomplete; do not weaken exact URL matching.

- [ ] **Step 3: Run all task gates and prove whole-object assertions remain**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run lib/server/__tests__/enrichment-parity.test.ts lib/server/__tests__/enrichment-run.test.ts lib/server/__tests__/enrichment-score.test.ts lib/server/__tests__/catalog-search.test.ts lib/server/__tests__/catalog-fetch.test.ts
npm run type-check
npx eslint lib/server/__tests__/enrichment-parity.test.ts
npx prettier --write lib/server/__tests__/enrichment-parity.test.ts lib/server/__tests__/fixtures/catalog/enrichment-expected.json lib/server/__tests__/fixtures/catalog/http.json
grep -n 'toEqual({' lib/server/__tests__/enrichment-parity.test.ts
grep -n 'HttpReplayMissError' lib/server/__tests__/helpers/httpReplay.ts
```

Expected: PASS. Diff ready for review.

---

## Task 9: Add authenticated synchronous `POST /enrich`

**Files:** `frontend/app/api/enrich/route.ts`, `frontend/app/api/enrich/route.test.ts`

- [ ] **Step 1: Write complete route tests before the handler**

Follow existing route-test database/auth mocking. Mock only `enrichLibrary`, not authentication. Add complete tests:

```ts
it('passes defaults and the authenticated user to synchronous enrichment', async () => {
  enrichLibraryMock.mockResolvedValue(summaryFixture);
  const response = await POST(new Request('http://test/api/enrich', {
    method: 'POST', headers: authHeaders('user-a'), body: JSON.stringify({}),
  }));
  expect({ status: response.status, body: await response.json(), calls: enrichLibraryMock.mock.calls }).toEqual({
    status: 200,
    body: summaryFixture,
    calls: [[expect.anything(), { force: false, limit: null, includeUnrated: false, userId: 'user-a' }]],
  });
});

it('passes force, nullable integer limit, and include_unrated with exact name mapping', async () => {
  enrichLibraryMock.mockResolvedValue(summaryFixture);
  const response = await POST(new Request('http://test/api/enrich', {
    method: 'POST', headers: authHeaders('user-b'),
    body: JSON.stringify({ force: true, limit: -1, include_unrated: true }),
  }));
  expect({ status: response.status, body: await response.json(), calls: enrichLibraryMock.mock.calls }).toEqual({
    status: 200,
    body: summaryFixture,
    calls: [[expect.anything(), { force: true, limit: -1, includeUnrated: true, userId: 'user-b' }]],
  });
});
```

Add whole-response cases named `rejects a missing JSON body with 422`, `rejects a fractional limit with 422`, `rejects unknown request keys with 422`, and `rejects an unauthenticated request with 401 without calling enrichment`. If current Pydantic demonstrably ignores unknown keys, remove `.strict()` and change that test to assert ignored-key parity; verify against the actual model configuration before implementing.

- [ ] **Step 2: Run the expected-RED tests by name**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run app/api/enrich/route.test.ts
```

Expected RED by name: `passes defaults and the authenticated user to synchronous enrichment` and every other Task 9 case fail because the route does not exist.

- [ ] **Step 3: Implement the blocking route**

Use `z.object` with defaults matching `EnrichRequest`, `withApi('/api/enrich', ...)`, `getDb()`, and one awaited `enrichLibrary` call. Do not add `maxDuration`, rate limiting, background work, Claude key resolution, or usage tracking. Return `Response.json(summary)`.

- [ ] **Step 4: Run all task gates and prove forbidden wiring is absent**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx vitest run app/api/enrich/route.test.ts lib/server/__tests__/enrichment-parity.test.ts lib/server/__tests__/enrichment-run.test.ts
npm run type-check
npx eslint app/api/enrich/route.ts app/api/enrich/route.test.ts
npx prettier --write app/api/enrich/route.ts app/api/enrich/route.test.ts
grep -n "withApi('/api/enrich'" app/api/enrich/route.ts
grep -n 'await enrichLibrary' app/api/enrich/route.ts
rg -n 'anthropic|claude|usage|rateLimit|waitUntil|enrichJobs' app/api/enrich/route.ts lib/server/enrichment.ts
```

Expected: tests PASS and forbidden-wiring search prints nothing. The route exists but auto mode still sends `/enrich` to Python. Diff ready for review.

---

## Task 10: Flip only synchronous `POST /enrich` and record project state

**Files:** `frontend/lib/backend.ts`, `frontend/lib/__tests__/backend.test.ts`, `CLAUDE.md`

- [ ] **Step 1: Change every switcher assertion first**

Add complete behavior tests while preserving explicit Python assertions for 4c-2:

```ts
test('auto: wave-4c-1 synchronous enrich goes to Node; background enrichment stays Python', () => {
  expect(baseFor('/enrich', 'POST')).toBe('/api');
  expect(baseFor('/enrich', 'GET')).toBe(PY);
  expect(baseFor('/enrich/child', 'POST')).toBe(PY);
  expect(baseFor('/enrich/start', 'POST')).toBe(PY);
  expect(baseFor('/enrich/status/job-1', 'GET')).toBe(PY);
});
```

Add `{ prefix: '/enrich', methods: ['POST'], exact: true }` to the complete `NODE_DEFAULT_ROUTES` expected array after wave 4b. Update its test name to include 4c-1. Do not change production yet.

- [ ] **Step 2: Prove Jest is RED before the production list changes**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npm test -- --runInBand lib/__tests__/backend.test.ts
```

Expected RED by name: `auto: wave-4c-1 synchronous enrich goes to Node; background enrichment stays Python` and `NODE_DEFAULT_ROUTES is complete and ordered` fail on the missing exact rule. No failure count is prescribed.

- [ ] **Step 3: Add exactly one production rule**

```ts
// Wave 4c-1: synchronous compatibility enrichment only. Background job routes stay Python.
{ prefix: '/enrich', methods: ['POST'], exact: true },
```

Place it after wave 4b. Exact matching is mandatory so `/enrich/start` does not move in 4c-1.

- [ ] **Step 4: Update `CLAUDE.md` without broadening the wave**

Record that synchronous `POST /enrich` and the domain core are on Node, catalog HTTP/cache/stats are shared, and confidence parity is locked. State explicitly that every background/job item is still wave 4c-2 and admin/Python cutover is wave 5. Do not claim live verification until it occurs.

- [ ] **Step 5: Run every task gate, prove the exact rule, and inspect only**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npm test -- --runInBand lib/__tests__/backend.test.ts
npx vitest run app/api/enrich/route.test.ts lib/server/__tests__/enrichment-parity.test.ts lib/server/__tests__/enrichment-run.test.ts lib/server/__tests__/enrichment-score.test.ts lib/server/__tests__/catalog-search.test.ts lib/server/__tests__/catalog-fetch.test.ts
npm run type-check
npx eslint lib/backend.ts lib/__tests__/backend.test.ts app/api/enrich/route.ts app/api/enrich/route.test.ts lib/server/enrichment.ts lib/server/catalog.ts lib/server/serialize.ts
npx prettier --write lib/backend.ts lib/__tests__/backend.test.ts app/api/enrich/route.ts app/api/enrich/route.test.ts lib/server/enrichment.ts lib/server/catalog.ts lib/server/serialize.ts
grep -n "prefix: '/enrich'.*methods: \['POST'\].*exact: true" lib/backend.ts lib/__tests__/backend.test.ts
cd ..
git --no-pager diff --stat
```

Expected: PASS; the grep prints exactly production and snapshot rows. No `/enrich/start` rule changed. Diff ready for Chase's review.

---

## Task 11: Full verification and handoff

Jest and Vitest cover disjoint paths: Jest owns the backend switcher; Vitest owns `lib/server/**` and `app/api/**`. Python and fixture commands remain human-only.

- [ ] **Step 1: Run all four frontend commands separately (Codex may run)**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npm test -- --runInBand
npm run test:server
npm run type-check
npm run lint
```

- [ ] **Step 2: Run targeted formatting on the explicit touched set (Codex may run)**

```bash
cd /home/chase/Documents/Code/my-library/frontend
npx prettier --write lib/server/catalog.ts lib/server/serialize.ts lib/server/enrichment.ts lib/server/__tests__/catalog-fetch.test.ts lib/server/__tests__/catalog-search.test.ts lib/server/__tests__/enrichment-score.test.ts lib/server/__tests__/enrichment-run.test.ts lib/server/__tests__/enrichment-parity.test.ts lib/server/__tests__/fixtures/catalog/http.json lib/server/__tests__/fixtures/catalog/enrichment-expected.json app/api/enrich/route.ts app/api/enrich/route.test.ts lib/backend.ts lib/__tests__/backend.test.ts
```

- [ ] **Step 3: Run the complete Python suite (Chase or Claude only)**

```bash
cd /home/chase/Documents/Code/my-library
.venv/bin/pytest
```

Codex cannot run this command because `tests/conftest.py` imports FastAPI `TestClient`. Record the human-run result exactly.

- [ ] **Step 4: Re-run critical symbol proofs**

```bash
cd /home/chase/Documents/Code/my-library
grep -n 'export async function enrichLibrary' frontend/lib/server/enrichment.ts
grep -n 'STRONG_SIM' frontend/lib/server/enrichment.ts   # must be IMPORTED from similarity.ts, not redeclared
grep -n 'const WEAK_SIM = 0.6' frontend/lib/server/enrichment.ts
grep -n 'weak threshold is inert in Python' frontend/lib/server/enrichment.ts
grep -n "'isbn:openlibrary'" frontend/lib/server/enrichment.ts
grep -n "'isbn:googlebooks'" frontend/lib/server/enrichment.ts
grep -n "'search:openlibrary'" frontend/lib/server/enrichment.ts
grep -n "'search:googlebooks'" frontend/lib/server/enrichment.ts
grep -n "'unresolved'" frontend/lib/server/enrichment.ts
grep -n 'serializeResolutionConfidence' frontend/lib/server/serialize.ts
grep -n "withApi('/api/enrich'" frontend/app/api/enrich/route.ts
grep -n "prefix: '/enrich'.*methods: \['POST'\].*exact: true" frontend/lib/backend.ts frontend/lib/__tests__/backend.test.ts
rg -n 'anthropic|claude|usage|waitUntil|enrichJobs|lease|janitor' frontend/lib/server/enrichment.ts frontend/app/api/enrich/route.ts
```

Expected: all positive proofs print; forbidden-wiring search prints nothing.

- [ ] **Step 5: Inspect the exact migration boundary**

```bash
cd /home/chase/Documents/Code/my-library
git --no-pager diff --stat
git --no-pager diff -- frontend/lib/server/catalog.ts frontend/lib/server/serialize.ts frontend/lib/server/enrichment.ts frontend/lib/server/__tests__/catalog-fetch.test.ts frontend/lib/server/__tests__/catalog-search.test.ts frontend/lib/server/__tests__/enrichment-score.test.ts frontend/lib/server/__tests__/enrichment-run.test.ts frontend/lib/server/__tests__/enrichment-parity.test.ts frontend/app/api/enrich/route.ts frontend/app/api/enrich/route.test.ts frontend/lib/backend.ts frontend/lib/__tests__/backend.test.ts scripts/gen_catalog_fixtures.py CLAUDE.md
```

Confirm no package/lockfile, schema/migration, `enrich_jobs`, background endpoint, admin route, Python cutover, Claude, usage, worker, or deployment change exists.

- [ ] **Step 6: Report for handoff**

Report exact diffs, who regenerated fixtures, all frontend commands, human pytest result, proof searches, and deviations from Python. The diff is ready for Chase's review. Chase chooses commits, commits, merges, pushes, and deploys by hand.

---

## Done when

- Exactly synchronous authenticated `POST /enrich` reaches same-origin `/api` in auto mode with an exact POST guard; `/enrich/start`, `/enrich/status/{job_id}`, and every job path remain Python/unmodified.
- Every catalog request goes through existing `getJson` → Postgres cache/throttle/retry; no duplicate fetcher exists.
- Open Library ISBN edition/Work traversal, exact title/author search, Google ISBN, and quoted Google title/author search match recorded Python URLs and whole candidates.
- HIGH pure-ISBN trust, MEDIUM's exact `0.85` boundary, adjacent LOW boundaries, author compatibility, ambiguity, inert `0.60` behavior, and internal NONE are covered by named complete tests.
- All five persisted match methods are explicitly tested, including Open Library LOW precedence over a better Google LOW.
- Resolved upsert and unresolved LOW/0.0 persistence compare every real enrichment column; replacement and stale-field quirks match Python.
- User scope, effective-rating eligibility, force, retry-unresolved, post-skip limit, zero/negative limits, skipped totals, initial/final progress, and per-book durability have whole-object tests.
- Summary key set/order and HTTP statistics match Python, including cache-hit exclusion, retries, response classes, network failures, and by-host counts.
- The human-generated enrichment fixture comes from real Python `enrich_library()` plus captured catalog HTTP; no Node-authored golden or unrecorded network access exists.
- Enrichment imports no Claude/Anthropic/key/usage code and writes no usage event.
- `npm test -- --runInBand`, `npm run test:server`, `npm run type-check`, and `npm run lint` pass; targeted Prettier passes; Chase or Claude records the complete pytest result.
- No 4c-2 background/job machinery, wave-5 admin/cutover work, schema/migration, package dependency, or deployment change exists.
- No agent ran install, fixture recording, pytest, commit, cherry-pick, merge, push, or deploy. The diff is ready for Chase's review.

---

## Verification record

Executed 2026-08-11. All 11 tasks complete. Codex ran Tasks 1-6 and 8-10 plus Task 7 steps 1-2;
Claude ran every fixture recording, every pytest invocation, the CLAUDE.md record, and independent
re-verification of every task's gates.

### Final gate results

| Gate | Result |
| --- | --- |
| `npm test -- --runInBand` (Jest) | 5 suites, 39 tests passed |
| `npm run test:server` (Vitest) | 66 files, 457 tests passed |
| `npm run type-check` | passed |
| `npm run lint` | passed |
| `.venv/bin/pytest` (Claude-run) | 360 passed, 83 warnings |
| `.venv/bin/pytest tests/test_catalog.py tests/test_enrich.py tests/test_enrich_language.py` | 11 passed |

Symbol proofs all printed; `rg -n 'anthropic|claude|usage|waitUntil|enrichJobs|lease|janitor'` over
`enrichment.ts` and `route.ts` printed nothing. `STRONG_SIM` is imported from `similarity.ts:17`,
not redeclared. `rg -n 'key=' http.json` printed nothing. No package, lockfile, schema, migration,
admin, worker, or deployment file was touched.

### Defects found during execution and fixed

1. **Open Library ISBN URL encoding (Task 2, would have failed Task 8).** Codex built the URL with
   `URLSearchParams`, emitting `bibkeys=ISBN%3A111`. Python builds it with an f-string, so the colon
   stays raw. Found by differential-testing all four enrichment URLs against real `httpx.QueryParams`
   — the other three matched byte-for-byte. Left unfixed it would have thrown `HttpReplayMissError`
   against the recorded fixture and split the `catalog_cache` key. Fixed in `catalog.ts` with a
   comment explaining why `URLSearchParams` is wrong there.
2. **Recorder missing `init_db()` (Task 7).** The seed ran before any table existed. Fixed.
3. **Two resolution branches never fired (Task 7).** The intended seeds produced
   `isbn:openlibrary`/`search:openlibrary` instead of `isbn:googlebooks`/`search:googlebooks`.
   Root causes, established by probing live catalogs: popular titles resolve on Open Library first,
   and Google's near-duplicate editions trip the ambiguity rule. Replaced two seeds with probe-chosen
   ones (`9780593655036`, and `The Wager` whose runner-up scores 0.5 against a 0.85 threshold — the
   other candidate's runner-up was 0.837, too fragile). All five match methods now recorded.
4. **Pre-run enrichment state not recoverable (Task 8).** The fixture emitted only post-run rows, so
   the Node test would have had to infer book 6's skip state from its own result. Added
   `seed_enrichment` to the recorder.
5. **Ordered URL assertion contradicted the plan's own quirks section (Task 8).** Step 1 asked for
   `expect(calls).toEqual(expected.urls)`, but the plan also states book order is intentionally
   unspecified (no `ORDER BY`). PGlite yielded 2,7,1,3,4,5 where the recorder's SQLite yielded
   1,2,3,4,5,7 — same 14 URLs, different sequence. Changed to a sorted-multiset comparison with a
   comment; within-book order is still asserted by `enrichment-score.test.ts`.
6. **Flaky timestamp assertion (Task 8, found by Task 9's run).** `\.\d{3}` fails whenever Postgres
   strips trailing zeros (`.510` reads back as `.51`). Widened to `(\.\d{1,6})?`.
7. **Unknown-key handling (Task 9).** Probing `EnrichRequest` showed `model_config` is `{}`, so
   Pydantic *ignores* unknown keys. The plan's `rejects unknown request keys with 422` case was
   inverted to assert ignored-key parity, exactly as the plan anticipated it might need to be.
8. **Fixture reviewability (Task 11).** The recorder had added `sort_keys=True` to the two
   pre-existing fixtures, producing ~21k lines of pure reordering. Reverted for those two files;
   only the new `enrichment-expected.json` is sorted.

### Accepted divergences from Python

- **Zod rejects Pydantic's lax coercions.** `{"limit": "3"}` and `{"force": "yes"}` are 422 on Node;
  Python coerces them to `3` and `true`. Documented by a named route test rather than hidden.
- **Cross-book enrichment order** is unspecified in both runtimes and is not asserted.

### Live browser verification (2026-08-11)

Performed against the throwaway `mylib-w3b-verify` Postgres container — **dev Supabase was never
touched**. Next ran in local-auth mode (`userId: 'local'`); `GET /api/books` returning the
container's own rows confirmed the route was bound to the container before any write.

`POST /enrich` has **no UI caller** — `api.ts`'s `runEnrich` is unreferenced, because the hosted UI
uses the background `enrichStart` (still Python). So it was driven from the real page origin at
`http://localhost:3000/library`, going through the actual Next.js route handler, local auth,
drizzle, real Postgres and live catalogs. `read_network_requests` recorded
`POST http://localhost:3000/api/enrich -> 200`.

Run 1 — 4 enriched + 2 unresolvable books:
`{total: 6, processed: 2, HIGH: 0, MEDIUM: 0, LOW: 0, unresolved: 2, skipped_existing: 4}`.
Persisted rows were `LOW` / `0.0` / `unresolved` / NULL subjects — the internal-`NONE`-is-never-stored
contract, live. The `http` block reported 6 requests with 4 `rate_limited` on `www.googleapis.com`
(Node has no `GOOGLE_BOOKS_API_KEY`, so it hit the anonymous quota) and 2 retries — the Task 1
instrumentation, including per-host 429 accounting, working against real traffic.

Run 2 — after adding a resolvable book (Dune, ISBN 9780441172719):
`{total: 7, processed: 1, HIGH: 1, ..., skipped_existing: 6}` with exactly 3 `openlibrary.org`
requests and **zero** Google calls, demonstrating the ISBN short-circuit and the edition→Work
description traversal.

**Differential test against Python on the same live database** (the strongest proof available):
for both runs the rows Node wrote were deleted, Python's `enrich_library(user_id='local')` was run
against that same container, and the results diffed.

| Comparison | Result |
| --- | --- |
| Run 1 summary (sans `http`) | identical |
| Run 1 persisted rows | identical |
| Run 2 summary (sans `http`) | identical |
| Run 2 resolved row (all 13 columns) | identical |

The resolved row matched on `resolved_source`, `resolved_id` (`/books/OL59726263M`),
`match_method` (`isbn:openlibrary`), `HIGH`/`0.95`, the full subjects array, the Work-traversal
description, `cover_url`, `raw_response` shape, and `language: None` — the documented quirk that an
ISBN candidate carries no language key.

`http` blocks were excluded from the diff by design: Python's disk cache and Node's Postgres
`catalog_cache` were in different states (Python needed 2 requests where Node needed 3, having one
URL already cached), so request counts are cache-state artifacts, not logic differences. The
persisted results were identical either way.

### NOT verified

- **No UI flow exercises `POST /enrich`**, because none exists — the route is CLI/tooling
  compatibility only. "A user clicks something and enrichment runs on Node" remains untrue by
  design; the hosted enrichment button still goes to Python's background job (wave 4c-2).
- Nothing was run against dev Supabase or production.

The diff is ready for Chase's review; no agent committed, merged, pushed, or deployed.
