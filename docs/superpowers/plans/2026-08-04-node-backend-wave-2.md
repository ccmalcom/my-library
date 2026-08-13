# Node Backend Migration — Wave 2 (Simple Writes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port every non-Claude, non-job write route from FastAPI to Next.js route handlers with recorded-fixture parity, then flip those writes to Node in `auto` mode.

**Architecture:** Same strangler pattern as wave 1: each Python handler becomes a `withApi`-wrapped route handler backed by Drizzle, proven equal to real recorded FastAPI responses via a fixture-replay harness against PGlite. Wave 2 extends the harness from single GET requests to multi-step **write scenarios** (each runs against a freshly re-seeded DB, records every step's response, and uses already-ported wave-1 GETs as side-effect probes). The method-aware backend switcher then flips the wave-2 writes to Node.

**Tech Stack:** Next.js 15 App Router route handlers, Drizzle ORM (postgres-js / PGlite in tests), zod v4, vitest, Python fixture generator via FastAPI TestClient.

## Global Constraints

- **Parity is the acceptance bar.** Same status codes, same `{"detail": "..."}` error strings (byte-for-byte where Python is deterministic), same JSON bodies. Reproduce Python quirks; do not "fix" them.
- **Documented deviations only** (all invisible to the frontend, same policy as wave 1):
  1. Schema-level 422s (missing/mistyped body fields that Pydantic rejects before the handler) return a plain **string** `detail`, not FastAPI's structured list.
  2. Timestamps Node writes have **millisecond** precision; Python writes microseconds. Both serialize as ISO strings; masked in parity tests.
  3. The rec-feedback "status must be one of ..." 422 detail interpolates a Python **set repr whose order is hash-seed-dependent** — Python itself is nondeterministic here. Node emits the fixed string `status must be one of {'accepted', 'rejected', 'already_read'}`; the parity step masks this one detail.
- **Never read, print, or store values from `.env` / `.env.local`** — key *names* only; verify presence with existence checks.
- **Never run `git commit` unless Chase has explicitly authorized commits for this session.** Commit steps below mean: stage, print the message, STOP and ask. No `Co-Authored-By` trailer ever.
- **Never claim a change works from tests alone** — Task 14 requires a real browser pass.
- Empty-string env vars count as **unset** for optional config (wave-1 convention, commit `44592fa`) — apply to `FEEDBACK_PROMPTS_ENABLED` / `FEEDBACK_SNOOZE_HOURS`. Exception (existing wave-1 quirk, keep): `ANTHROPIC_API_KEY` set-but-empty still counts as *configured* for api-key status.
- Python reference files: `mylibrary/api.py`, `library.py`, `user_settings.py`, `directive.py`, `feedback.py`, `feedback_vocab.py`, `enrich.py`. When this plan and the Python source disagree, **the Python source wins** — it is the parity target.
- Alembic remains the only migration authority. Wave 2 adds **no** schema changes — every table already exists.

## Prerequisite (do this FIRST, before any task)

The dedup bugfix branch `fix/add-dedup-subtitle-collision` (PR #39/#40 — `_same_work`: edition variants match, sibling subtitles don't) must be **merged to `main` and merged into `feat/node-backend`** before running the fixture generator, because this plan ports the fixed `_same_work` semantics and the generator records live Python behavior. Check first:

```bash
grep -n "_same_work" mylibrary/enrich.py && echo "MERGED — proceed" || echo "NOT MERGED — stop and ask Chase"
```

If not merged: STOP and ask Chase to merge the PR, then `git merge main` into `feat/node-backend`. The `add-book-sibling-subtitle` scenario in Task 4 is the tripwire: with the old dedup, Python 409s the second POST and the recorded fixture will disagree with the Node port, failing loudly instead of silently porting stale semantics.

## Scope

**In (all handlers in `mylibrary/api.py`):** `POST /books`, `PATCH /books/{id}/feedback`, `PATCH /books/{id}/shelf`, `PATCH /books/{id}/enrichment`, `DELETE /books/{id}`, `PATCH /recommendations/{id}/feedback`, `PUT|DELETE /settings/api-key`, `PUT /settings/profile`, `PUT|DELETE /directive`, `PATCH /profile/traits/{id}`, `POST /feedback`, `GET /feedback/prompt`, `POST /feedback/dismiss`, `POST /taste-signal`.

The last five aren't named in the spec's wave-2 row but are simple non-Claude writes (plus one trivial read) with no other natural wave — folding them in here empties the "simple writes" bucket completely. `GET /feedback/prompt` rides along because it shares the eligibility logic with dismiss/submit.

**Out, with reasons:**
- `GET /catalog/search` stays on **Python until wave 3** (decision): it needs the live catalog clients + the Postgres `catalog_cache`, which the spec assigns to wave 3. The add-book flow works mixed-backend: the picker searches via Python, `POST /books` lands on Node — same DB, no coupling (`add_book` makes no network calls).
- `POST /directive/draft` (Haiku distill), `POST /profile/*` builds, `/books/{id}/similar`, `/discover`, `/recommend` → wave 3 (Claude flows).
- `DELETE /library`, `DELETE /profile`, `DELETE /account` (purge.py), ingest/import/export, enrich jobs → wave 4.
- `/admin/*` → wave 5.

## File Structure

```
frontend/lib/server/
  http.ts                     MODIFY — withApi passes Next route-context params through
  serialize.ts                MODIFY — add utcnowTs(), todayIsoDate(), pyList()
  books.ts                    MODIFY — add bookSummary()
  dedup.ts                    CREATE — normalizeTitle, surname, normalizeFullTitle, sameWork
  profileMeta.ts              CREATE — ensureProfileMeta()
  traits.ts                   CREATE — traitOut() (extracted from app/api/profile/route.ts)
  directive.ts                CREATE — cleanDirectiveConstraints()
  settings.ts                 CREATE — keyConfigured() (extracted from api-key/status route)
  feedbackPrompts.ts          CREATE — eligibility + state upsert logic
frontend/app/api/
  books/route.ts              MODIFY — add POST
  books/[id]/route.ts         CREATE — DELETE
  books/[id]/feedback/route.ts    CREATE — PATCH
  books/[id]/shelf/route.ts       CREATE — PATCH
  books/[id]/enrichment/route.ts  CREATE — PATCH
  recommendations/[id]/feedback/route.ts  CREATE — PATCH
  settings/api-key/route.ts   CREATE — PUT, DELETE
  settings/api-key/status/route.ts  MODIFY — use extracted keyConfigured()
  settings/profile/route.ts   MODIFY — add PUT
  directive/route.ts          MODIFY — add PUT, DELETE
  profile/route.ts            MODIFY — use extracted traitOut()
  profile/traits/[id]/route.ts    CREATE — PATCH
  feedback/route.ts           CREATE — POST
  feedback/prompt/route.ts    CREATE — GET
  feedback/dismiss/route.ts   CREATE — POST
  taste-signal/route.ts       CREATE — POST
frontend/lib/server/__tests__/
  helpers/pglite.ts           MODIFY — 3 new tables, sequence sync, Seed fields
  helpers/write-parity.ts     CREATE — scenario runner + handler registry
  parity-writes-books.test.ts         CREATE
  parity-writes-recs.test.ts          CREATE
  parity-writes-settings.test.ts      CREATE
  parity-writes-directive.test.ts     CREATE
  parity-writes-traits.test.ts        CREATE
  parity-writes-feedback.test.ts      CREATE
  fixtures/parity/write-scenarios.json  GENERATED (checked in)
frontend/lib/backend.ts       MODIFY — `exact` rule flag + wave-2 flip
frontend/lib/backend.test.ts  MODIFY — wave-2 routing cases (jest)
scripts/gen_parity_fixtures.py  MODIFY — write-scenario recording
```

---

### Task 1: `withApi` route params + serialize helpers

Wave 1 only had static routes. Wave 2 has `[id]` segments: Next.js App Router calls handlers as `(req, { params })` where `params` is a Promise. `withApi` must forward them.

**Files:**
- Modify: `frontend/lib/server/http.ts`
- Modify: `frontend/lib/server/serialize.ts`
- Test: `frontend/lib/server/__tests__/http-params.test.ts` (create), `frontend/lib/server/serialize.test.ts` (extend — it exists from wave 1; if named differently, extend the existing serialize test file)

**Interfaces:**
- Produces: `ApiCtx.params: Record<string, string>` (empty object for static routes); `withApi` returned fn signature `(req: Request, routeCtx?: { params?: Promise<Record<string, string>> | Record<string, string> }) => Promise<Response>`.
- Produces: `utcnowTs(): string` — `'YYYY-MM-DD HH:MM:SS.mmm'` UTC, the storage format matching drizzle's `mode: 'string'` reads; `todayIsoDate(): string` — `'YYYY-MM-DD'` UTC; `pyList(xs: string[]): string` — Python list-repr `['a', 'b']`.

- [ ] **Step 1: Write the failing tests**

`frontend/lib/server/__tests__/http-params.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { withApi } from '../http';

describe('withApi params', () => {
  it('passes awaited route params into ctx.params', async () => {
    const handler = withApi(
      '/api/books/[id]/feedback',
      async (_req, ctx) => Response.json({ id: ctx.params.id }),
      { requireAuth: false }
    );
    const res = await handler(new Request('http://test/api/books/7/feedback'), {
      params: Promise.resolve({ id: '7' }),
    });
    expect(await res.json()).toEqual({ id: '7' });
  });

  it('defaults ctx.params to {} for static routes', async () => {
    const handler = withApi(
      '/api/stats',
      async (_req, ctx) => Response.json({ keys: Object.keys(ctx.params) }),
      { requireAuth: false }
    );
    const res = await handler(new Request('http://test/api/stats'));
    expect(await res.json()).toEqual({ keys: [] });
  });
});
```

Serialize tests (add to the existing serialize test file):

```ts
import { utcnowTs, todayIsoDate, pyList } from '../serialize'; // adjust relative path to match the existing file

it('utcnowTs returns space-separated UTC timestamp', () => {
  expect(utcnowTs()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
});
it('todayIsoDate returns YYYY-MM-DD', () => {
  expect(todayIsoDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
it('pyList formats like Python list repr', () => {
  expect(pyList(['a', 'b'])).toBe("['a', 'b']");
  expect(pyList([])).toBe('[]');
});
```

- [ ] **Step 2: Run to verify failure** — `cd frontend && npx vitest run lib/server/__tests__/http-params.test.ts` → FAIL (params not on ctx / functions not exported).

- [ ] **Step 3: Implement**

In `http.ts`: add `params: Record<string, string>` to `ApiCtx`. Change the returned function to `async (req: Request, routeCtx?: { params?: Promise<Record<string, string>> | Record<string, string> })`. Before calling `handler`, resolve `const params = (await routeCtx?.params) ?? {};` and pass it in the ctx object. Everything else (auth, errors, logging) unchanged.

In `serialize.ts` append:

```ts
/** Naive-UTC storage format matching drizzle timestamp mode 'string' reads.
 *  Python stores microseconds; ms precision is a documented invisible deviation. */
export function utcnowTs(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

/** Python date.today() twin (server runs UTC). */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Python repr of a list of strings: ['a', 'b'] — for 422 detail parity. */
export function pyList(xs: string[]): string {
  return '[' + xs.map((x) => `'${x}'`).join(', ') + ']';
}
```

- [ ] **Step 4: Run to verify pass** — same command + `npx vitest run` (full) + `npx jest` (wave-0/1 suites unaffected).
- [ ] **Step 5: Commit gate** — stage; print `feat(node): withApi route params + write-path serialize helpers`; STOP unless commits authorized.

---

### Task 2: PGlite wave-2 tables + sequence sync

Writes INSERT new rows; seeded rows use explicit ids, so PGlite's serial sequences still sit at 1 and the first insert would collide. Python/SQLite auto-continues past max(id); Postgres needs `setval`. **The new-row ids are part of parity** (Python assigns 103 to the first book created after seed ids 1–14 + 101–102; setval to the global max reproduces exactly that).

**Files:**
- Modify: `frontend/lib/server/__tests__/helpers/pglite.ts`
- Test: `frontend/lib/server/__tests__/pglite-seed.test.ts` (create)

**Interfaces:**
- Produces: `makeTestDb()` now also creates `taste_signal`, `feedback`, `feedback_prompt_state`; `loadSeed()` accepts `taste_signals` / `feedback` / `feedback_prompt_state` seed keys and syncs every id sequence after loading.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { makeTestDb, loadSeed } from './helpers/pglite';

describe('wave-2 seed loading', () => {
  it('creates new tables and continues ids past the seeded max', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, {
        books: [
          { id: 1, user_id: 'local', title: 'A', goodreads_rating: 0, source: 'manual' },
          { id: 101, user_id: 'other', title: 'B', goodreads_rating: 0, source: 'manual' },
        ],
        feedback_prompt_state: [
          { id: 1, user_id: 'local', trigger: 'post-setup', run_id: '', status: 'submitted' },
        ],
      });
      const r = await (db as any).$client.query(
        `insert into books (user_id, title, goodreads_rating, source) values ('local','C',0,'manual') returning id`
      );
      expect(r.rows[0].id).toBe(102); // max(1, 101) + 1 — global max incl. other tenant
      const f = await (db as any).$client.query(`select count(*)::int as n from taste_signal`);
      expect(f.rows[0].n).toBe(0);
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run lib/server/__tests__/pglite-seed.test.ts` → FAIL (`feedback_prompt_state` doesn't exist / id collision).

- [ ] **Step 3: Implement.** In `makeTestDb()`'s DDL block append (mirrors `mylibrary/db.py`):

```sql
    create table taste_signal (
      id serial primary key,
      user_id text not null default 'local',
      direction text not null,
      target_kind text not null,
      target_book_id integer,
      snapshot json,
      created_at timestamp default current_timestamp
    );
    create table feedback (
      id serial primary key,
      user_id text not null default 'local',
      category text not null,
      body text not null,
      trigger text,
      run_id text,
      page text,
      app_version text,
      created_at timestamp not null default current_timestamp
    );
    create table feedback_prompt_state (
      id serial primary key,
      user_id text not null default 'local',
      trigger text not null,
      run_id text not null default '',
      status text not null,
      snooze_until timestamp,
      updated_at timestamp not null default current_timestamp,
      constraint uq_feedback_prompt_state unique (user_id, trigger, run_id)
    );
```

In `loadSeed()`: add `'snooze_until'` to `TS_COLS` (`'snapshot'` is already in `JSON_COLS`); extend `Seed` with `taste_signals?`, `feedback?`, `feedback_prompt_state?`; append `'taste_signals', 'feedback', 'feedback_prompt_state'` to `order` — but note the seed key `taste_signals` maps to table `taste_signal` (singular). Add a small map:

```ts
const TABLE_FOR_KEY: Record<string, string> = { taste_signals: 'taste_signal' };
// in the loop: const table = TABLE_FOR_KEY[key] ?? key;
```

After the insert loops, sync every serial sequence:

```ts
  const SEQ_TABLES = [
    'books', 'enrichment', 'taste_traits', 'recommendations', 'profile_meta',
    'user_settings', 'reader_archetypes', 'user_directive', 'usage_events',
    'taste_signal', 'feedback', 'feedback_prompt_state',
  ];
  for (const t of SEQ_TABLES) {
    await (db as any).$client.query(
      `select setval(pg_get_serial_sequence('${t}', 'id'), greatest((select coalesce(max(id), 0) from ${t}), 1))`
    );
  }
```

(`greatest(…, 1)` because `setval` rejects 0 on an empty table; an empty table then hands out id 2 first — acceptable, no scenario inserts into a wholly unseeded table where the id is asserted. If one ever does, seed one row.)

- [ ] **Step 4: Verify pass** — targeted test, then full `npm run test:server` (wave-1 parity suites must stay green).
- [ ] **Step 5: Commit gate** — `test(node): wave-2 tables + id-sequence sync in PGlite seed loader`.

---

### Task 3: dedup module (`_same_work` port)

**Files:**
- Create: `frontend/lib/server/dedup.ts`
- Test: `frontend/lib/server/dedup.test.ts`

**Interfaces:**
- Produces: `normalizeTitle(t: string | null): string`, `surname(author: string | null): string`, `normalizeFullTitle(t: string | null): string`, `sameWork(titleA: string | null, authorA: string | null, titleB: string | null, authorB: string | null): boolean`. Consumed by Tasks 5 and 8.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { normalizeTitle, surname, normalizeFullTitle, sameWork } from './dedup';

describe('dedup', () => {
  it('normalizeTitle drops subtitle, parentheticals, punctuation', () => {
    expect(normalizeTitle('Dune: Special Edition')).toBe('dune');
    expect(normalizeTitle('The Hobbit (Illustrated)')).toBe('the hobbit');
    expect(normalizeTitle("Ender's  Game!")).toBe('ender s game');
    expect(normalizeTitle(null)).toBe('');
  });
  it('surname takes last word of normalized author', () => {
    expect(surname('Ursula K. Le Guin')).toBe('guin');
    expect(surname(null)).toBe('');
    expect(surname('')).toBe('');
  });
  it('normalizeFullTitle keeps the subtitle', () => {
    expect(normalizeFullTitle('Exodus: The Helium Sea')).toBe('exodus the helium sea');
  });
  it('sameWork: edition variant matches, sibling subtitles do not', () => {
    expect(sameWork('Dune', 'Frank Herbert', 'Dune: Special Edition', 'Herbert')).toBe(true);
    expect(sameWork('Exodus: The Archimedes Engine', 'Peter F. Hamilton',
                    'Exodus: The Helium Sea', 'Peter F. Hamilton')).toBe(false);
    expect(sameWork('Dune', 'Frank Herbert', 'Dune', 'Arthur C. Clarke')).toBe(false);
  });
});
```

- [ ] **Step 2: Verify failure** (module missing).
- [ ] **Step 3: Implement** — direct port of `mylibrary/enrich.py` (`_normalize_title`, `_surname`, `_normalize_full_title`, `_same_work`):

```ts
/** Ports of mylibrary/enrich.py dedup helpers. Keep byte-identical semantics. */

export function normalizeTitle(t: string | null): string {
  if (!t) return '';
  let s = t.toLowerCase();
  s = s.split(':')[0]; // drop subtitle
  s = s.replace(/\(.*?\)/g, ''); // drop parentheticals (editions, etc.)
  s = s.replace(/[^a-z0-9 ]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

export function surname(author: string | null): string {
  if (!author) return '';
  const parts = normalizeTitle(author).split(' ');
  return parts[parts.length - 1];
}

/** Like normalizeTitle but keeps the subtitle, for same-work equality checks. */
export function normalizeFullTitle(t: string | null): string {
  if (!t) return '';
  let s = t.toLowerCase();
  s = s.replace(/\(.*?\)/g, '');
  s = s.replace(/[^a-z0-9 ]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Same work: equal full titles, or one is the other's bare pre-colon base
 *  (edition variant). Two different subtitles on a shared base are different works. */
export function sameWork(
  titleA: string | null, authorA: string | null,
  titleB: string | null, authorB: string | null
): boolean {
  if (surname(authorA) !== surname(authorB)) return false;
  const fullA = normalizeFullTitle(titleA);
  const fullB = normalizeFullTitle(titleB);
  if (fullA === fullB) return true;
  return fullA === normalizeTitle(titleB) || fullB === normalizeTitle(titleA);
}
```

- [ ] **Step 4: Verify pass**; run full vitest.
- [ ] **Step 5: Commit gate** — `feat(node): same-work dedup helpers (enrich.py port)`.

---

### Task 4: fixture generator — write scenarios

Extend `scripts/gen_parity_fixtures.py` (keep everything existing — the wave-1 GET fixtures are still consumed by wave-1 tests). Add scenario recording: each scenario runs against a **fresh re-seeded DB**; each step is a request whose `{status, body}` is recorded; the whole scenario spec (method, path, JSON body, mask flags) is written INTO the fixture file so the TS runner has a single source of truth.

**Files:**
- Modify: `scripts/gen_parity_fixtures.py`
- Generated: `frontend/lib/server/__tests__/fixtures/parity/write-scenarios.json` (checked in), plus regenerated `seed.json` / `python-responses.json` (should be byte-identical apart from the injected encrypted key + `$hoursAgo` timestamps — regeneration is expected and fine; wave-1 tests must stay green)

**Interfaces:**
- Produces (fixture shape consumed by Task 5's runner):

```json
{ "<scenario>": [ { "req": "PATCH /books/1/feedback", "json": {...}|null,
                    "status": 200, "body": {...}, "maskDetail": false } ] }
```

- [ ] **Step 1: Add scenario machinery** to the generator (after the existing `record`/`main` plumbing):

```python
from mylibrary.db import Feedback, FeedbackPromptState, TasteSignal  # add to imports

def reset_db() -> None:
    """Wipe every table and reload SEED — fresh state per write scenario."""
    with session_scope() as session:
        for model in (Enrichment, TasteTrait, Recommendation, ProfileMeta,
                      UserSettings, ReaderArchetype, UserDirective, UsageEvent,
                      TasteSignal, Feedback, FeedbackPromptState, Book):
            session.query(model).delete()
    load_seed()

def run_scenarios(client: TestClient) -> dict:
    out: dict = {}
    for name, steps in WRITE_SCENARIOS.items():
        reset_db()
        recorded = []
        for step in steps:
            method, path = step["req"].split(" ", 1)
            r = client.request(method, path, json=step.get("json"))
            body = r.json() if r.status_code != 204 and r.content else None
            recorded.append({
                "req": step["req"],
                "json": step.get("json"),
                "status": r.status_code,
                "body": body,
                "maskDetail": step.get("maskDetail", False),
            })
        out[name] = recorded
    return out
```

In `main()`, after the seeded-stage recording: `fixtures_writes = run_scenarios(client)` and write `(OUT_DIR / "write-scenarios.json").write_text(json.dumps(fixtures_writes, indent=1))`.

- [ ] **Step 2: Define `WRITE_SCENARIOS`** (module-level, after `SEED`). Every step below is deliberate — validation batteries, tenant-scoping 404s, idempotency, and side-effect probes via already-ported wave-1 GETs:

```python
WRITE_SCENARIOS: dict[str, list[dict]] = {
    "add-book-basic": [
        {"req": "POST /books", "json": {
            "title": "Ancillary Justice", "author": "Ann Leckie", "year": 2013,
            "isbn13": "9780316246620", "shelf": "to-read",
            "cover_url": "https://covers.example/aj.jpg",
            "subjects": ["science fiction", "space opera"],
            "catalog_source": "openlibrary", "catalog_id": "/works/OL16813953W"}},
        {"req": "GET /books?shelf=to-read"},
    ],
    "add-book-rated-review": [
        {"req": "POST /books", "json": {
            "title": "The Player of Games", "author": "Iain M. Banks",
            "shelf": "read", "rating": 5, "review": "The Culture at its best."}},
        {"req": "GET /profile/status"},
    ],
    "add-book-duplicate": [
        {"req": "POST /books", "json": {"title": "DUNE: Special Edition", "author": "Herbert"}},
    ],
    "add-book-sibling-subtitle": [
        {"req": "POST /books", "json": {"title": "Exodus: The Archimedes Engine", "author": "Peter F. Hamilton"}},
        {"req": "POST /books", "json": {"title": "Exodus: The Helium Sea", "author": "Peter F. Hamilton"}},
    ],
    "add-book-invalid": [
        {"req": "POST /books", "json": {"title": "X", "shelf": "nonsense"}},
        {"req": "POST /books", "json": {"title": "X", "rating": 9}},
        {"req": "POST /books", "json": {"title": "X", "review": "no rating"}},
        {"req": "POST /books", "json": {"title": "   "}},
    ],
    "book-feedback": [
        {"req": "PATCH /books/1/feedback", "json": {"rating": 4, "review": "Rereads well."}},
        {"req": "PATCH /books/3/feedback", "json": {"rating": 0}},
        {"req": "PATCH /books/1/feedback", "json": {"date_read": "2026-01-15", "is_favorite": True}},
        {"req": "PATCH /books/5/feedback", "json": {"exclude_from_profile": True}},
        {"req": "GET /books?rated_only=true"},
    ],
    "book-feedback-invalid": [
        {"req": "PATCH /books/8/feedback", "json": {"review": "unrated review"}},
        {"req": "PATCH /books/1/feedback", "json": {}},
        {"req": "PATCH /books/1/feedback", "json": {"rating": 7}},
        {"req": "PATCH /books/101/feedback", "json": {"rating": 3}},
        {"req": "PATCH /books/999/feedback", "json": {"rating": 3}},
    ],
    "book-shelf": [
        {"req": "PATCH /books/8/shelf", "json": {"shelf": "currently-reading"}},
        {"req": "PATCH /books/8/shelf", "json": {"shelf": "bogus"}},
        {"req": "PATCH /books/101/shelf", "json": {"shelf": "read"}},
    ],
    "enrichment-correction": [
        {"req": "PATCH /books/5/enrichment", "json": {
            "catalog_source": "openlibrary", "catalog_id": "/works/OL46125W-fixed",
            "cover_url": "https://covers.example/foundation-fixed.jpg",
            "subjects": ["science fiction", "psychohistory"],
            "description": "The right Foundation."}},
        {"req": "GET /profile/status"},
        {"req": "PATCH /books/14/enrichment", "json": {
            "catalog_source": "googlebooks", "catalog_id": "gb-smallgods"}},
        {"req": "PATCH /books/1/enrichment", "json": {"catalog_source": "", "catalog_id": ""}},
        {"req": "PATCH /books/101/enrichment", "json": {"catalog_source": "x", "catalog_id": "y"}},
    ],
    "delete-book": [
        {"req": "DELETE /books/8"},
        {"req": "GET /books?shelf=to-read"},
        {"req": "DELETE /books/8"},
        {"req": "DELETE /books/101"},
    ],
    "rec-feedback-accept": [
        {"req": "PATCH /recommendations/3/feedback", "json": {"status": "accepted"}},
        {"req": "PATCH /recommendations/3/feedback", "json": {"status": "accepted"}},
        {"req": "GET /books?shelf=to-read"},
    ],
    "rec-feedback-already-read": [
        {"req": "PATCH /recommendations/4/feedback", "json": {"status": "already_read"}},
    ],
    "rec-feedback-note-on-accepted": [
        {"req": "PATCH /recommendations/2/feedback", "json": {"user_note": "started it"}},
    ],
    "rec-feedback-reject-reasons": [
        {"req": "PATCH /recommendations/3/feedback",
         "json": {"status": "rejected", "reject_reasons": ["too_long", "not_now"]}},
        {"req": "GET /recommendations/rejected"},
    ],
    "rec-feedback-invalid": [
        {"req": "PATCH /recommendations/3/feedback", "json": {}},
        {"req": "PATCH /recommendations/3/feedback", "json": {"status": "meh"}, "maskDetail": True},
        {"req": "PATCH /recommendations/3/feedback",
         "json": {"status": "accepted", "reject_reasons": ["too_long"]}},
        {"req": "PATCH /recommendations/3/feedback",
         "json": {"status": "rejected", "reject_reasons": []}},
        {"req": "PATCH /recommendations/3/feedback",
         "json": {"status": "rejected", "reject_reasons": ["bogus_reason"]}},
        {"req": "PATCH /recommendations/101/feedback", "json": {"status": "accepted"}},
    ],
    "api-key": [
        {"req": "PUT /settings/api-key", "json": {"api_key": "sk-ant-test-wave2-key"}},
        {"req": "GET /settings/api-key/status"},
        {"req": "DELETE /settings/api-key"},
        {"req": "PUT /settings/api-key", "json": {"api_key": "   "}},
    ],
    "display-name": [
        {"req": "PUT /settings/profile", "json": {"display_name": "Wave Two"}},
        {"req": "PUT /settings/profile", "json": {"display_name": "  "}},
    ],
    "directive": [
        {"req": "PUT /directive", "json": {
            "nl_text": "  Standalone literary sci-fi.  ",
            "constraints": {"languages": ["EN", " fr "], "min_year": "1990",
                             "max_year": 2020, "page_max": 400,
                             "exclude_subjects": ["Grimdark "],
                             "exclude_authors": ["Ringo"]}}},
        {"req": "GET /directive"},
        {"req": "PUT /directive", "json": {"nl_text": "  ", "constraints": {}}},
        {"req": "DELETE /directive"},
        {"req": "GET /directive"},
    ],
    "trait-patch": [
        {"req": "PATCH /profile/traits/1", "json": {"status": "confirmed"}},
        {"req": "PATCH /profile/traits/1", "json": {"claim": "  Edited claim.  "}},
        {"req": "PATCH /profile/traits/3", "json": {"user_weight": 0.5, "user_note": "sort of"}},
        {"req": "GET /profile/status"},
        {"req": "PATCH /profile/traits/1", "json": {}},
        {"req": "PATCH /profile/traits/101", "json": {"status": "confirmed"}},
    ],
    "feedback-flow": [
        {"req": "GET /feedback/prompt?trigger=post-setup"},
        {"req": "POST /feedback", "json": {"category": "Bug", "body": "It broke.",
                                            "trigger": "post-setup", "page": "/setup"}},
        {"req": "GET /feedback/prompt?trigger=post-setup"},
        {"req": "POST /feedback/dismiss", "json": {"trigger": "post-first-profile", "mode": "dont_ask"}},
        {"req": "GET /feedback/prompt?trigger=post-first-profile"},
        {"req": "POST /feedback/dismiss", "json": {"trigger": "post-recs", "run_id": "runB", "mode": "ask_later"}},
        {"req": "GET /feedback/prompt?trigger=post-recs&run_id=runB"},
        {"req": "GET /feedback/prompt?trigger=post-recs&run_id=runC"},
    ],
    "feedback-invalid": [
        {"req": "POST /feedback", "json": {"category": "nonsense", "body": "x"}},
        {"req": "POST /feedback", "json": {"category": "bug", "body": "   "}},
        {"req": "POST /feedback", "json": {"category": "bug", "body": "x", "trigger": "post-recs"}},
        {"req": "GET /feedback/prompt?trigger=post-recs"},
        {"req": "POST /feedback/dismiss", "json": {"trigger": "post-setup", "mode": "whenever"}},
        {"req": "POST /feedback/dismiss", "json": {"trigger": "post-recs", "mode": "ask_later"}},
    ],
    "taste-signal": [
        {"req": "POST /taste-signal", "json": {"direction": "more", "target_kind": "book", "target_book_id": 1}},
        {"req": "POST /taste-signal", "json": {"direction": "less", "target_kind": "rec",
            "snapshot": {"title": "Blindsight", "author": "Peter Watts", "subjects": ["science fiction"]}}},
        {"req": "POST /taste-signal", "json": {"direction": "more", "target_kind": "book"}},
        {"req": "POST /taste-signal", "json": {"direction": "more", "target_kind": "book", "target_book_id": 101}},
        {"req": "POST /taste-signal", "json": {"direction": "more", "target_kind": "rec"}},
    ],
}
```

Notes for the implementer:
- `"page_max": 400` in the directive scenario is deliberate — `_clean_directive_constraints` must drop it.
- The rec-feedback `{"status": "meh"}` step carries `maskDetail: True` (Python set-repr nondeterminism — Global Constraints #3).
- Scenario bodies use Python booleans (`True`) — this is a Python file.
- `PATCH /books/999/feedback` (id beyond every seed row) proves not-found vs. tenant-scoping both yield the same 404.

- [ ] **Step 3: Run the generator** — `python scripts/gen_parity_fixtures.py` from the repo root. Inspect `write-scenarios.json`: every scenario present; statuses match expectations (409 for duplicate, 422s where planned, 404s for tenant rows, 201 for creates, 204 for dismiss). Spot-check `add-book-basic` step 1 body: `id` must be `103`. Spot-check `add-book-sibling-subtitle` step 2: **must be 201** (if 409 → the prerequisite merge didn't happen; STOP).
- [ ] **Step 4: Wave-1 suites still green** — `cd frontend && npm run test:server` (regenerated seed/python-responses must not break wave-1 parity tests).
- [ ] **Step 5: Commit gate** — `test(node): wave-2 write-scenario parity fixtures + generator support`.

---

### Task 5: write-parity runner + `POST /books`

**Files:**
- Create: `frontend/lib/server/__tests__/helpers/write-parity.ts`
- Modify: `frontend/app/api/books/route.ts` (add POST)
- Modify: `frontend/lib/server/books.ts` (add `bookSummary` — used from Task 6 on; define now with the module)
- Create: `frontend/lib/server/__tests__/parity-writes-books.test.ts` (first scenarios)

**Interfaces:**
- Produces: `runScenario(name: string): Promise<void>` — loads the scenario from `write-scenarios.json`, spins a fresh seeded PGlite, replays every step through the handler registry, asserts status + masked-body equality per step.
- Produces: `registerHandlers(...)` is NOT needed — the registry is a static table in `write-parity.ts`; later tasks **add rows to it** as they create routes.
- Produces: `bookSummary(b: BookRow)` — the `_book_summary` dict twin.

- [ ] **Step 1: Write the runner** (`helpers/write-parity.ts`):

```ts
import { expect } from 'vitest';
import scenariosJson from '../fixtures/parity/write-scenarios.json';
import seedJson from '../fixtures/parity/seed.json';
import { makeTestDb, loadSeed, type Seed } from './pglite';
import { _setDbForTests } from '../../db';

type Handler = (req: Request, routeCtx?: { params?: Record<string, string> }) => Promise<Response>;

/** Route registry: pattern → handler import. Later tasks append rows here as
 *  they create routes; a step whose path matches no row throws loudly. */
import * as booksRoute from '../../../../app/api/books/route';
// (Tasks 6–12 add imports here: booksIdRoute, booksFeedbackRoute, ... )

interface RegistryRow {
  method: string;
  pattern: RegExp; // named groups become params
  handler: () => Handler;
}

export const REGISTRY: RegistryRow[] = [
  { method: 'POST', pattern: /^\/books$/, handler: () => booksRoute.POST as Handler },
  { method: 'GET', pattern: /^\/books$/, handler: () => booksRoute.GET as Handler },
  // Wave-1 GET probes used by scenarios get rows too as needed:
  // /profile/status, /recommendations/rejected, /directive, /settings/api-key/status
  // — added in the task that first replays a scenario using them.
];

/** Mask volatile server-generated values; preserve the null/non-null distinction. */
const VOLATILE_KEYS = new Set([
  'feedback_updated_at', 'verdict_updated_at', 'updated_at', 'created_at',
  'date_added', 'snooze_until', 'resolved_at', 'derived_at',
]);
export function maskVolatile(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskVolatile);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => {
        if (VOLATILE_KEYS.has(k)) return [k, val === null ? null : '<set>'];
        // Cross-runtime row-order safety: /profile/status returns changed_book_ids
        // in query order, which SQLite and PGlite need not agree on (wave-1 precedent:
        // its parity test compares this field sorted).
        if (k === 'changed_book_ids' && Array.isArray(val)) {
          return [k, [...(val as number[])].sort((a, b) => a - b)];
        }
        return [k, maskVolatile(val)];
      })
    );
  }
  return v;
}

function resolve(method: string, path: string): { handler: Handler; params: Record<string, string> } {
  for (const row of REGISTRY) {
    if (row.method !== method) continue;
    const m = path.match(row.pattern);
    if (m) return { handler: row.handler(), params: { ...(m.groups ?? {}) } };
  }
  throw new Error(`no registered handler for ${method} ${path} — add it to REGISTRY`);
}

export async function runScenario(name: string): Promise<void> {
  const steps = (scenariosJson as any)[name];
  if (!steps) throw new Error(`no scenario named ${name}`);
  const { db, close } = await makeTestDb();
  try {
    await loadSeed(db, seedJson as unknown as Seed);
    _setDbForTests(db);
    for (const [i, step] of (steps as any[]).entries()) {
      const [method, pathAndQuery] = step.req.split(' ');
      const path = pathAndQuery.split('?')[0];
      const { handler, params } = resolve(method, path);
      const req = new Request(`http://test/api${pathAndQuery}`, {
        method,
        headers: step.json != null ? { 'content-type': 'application/json' } : {},
        body: step.json != null ? JSON.stringify(step.json) : undefined,
      });
      const res = await handler(req, { params });
      expect(res.status, `${name}[${i}] ${step.req} status`).toBe(step.status);
      if (step.status === 204) continue;
      let body: unknown = await res.json();
      let expected: unknown = step.body;
      if (step.maskDetail) {
        body = { ...(body as object), detail: '<masked>' };
        expected = { ...(expected as object), detail: '<masked>' };
      }
      expect(maskVolatile(body), `${name}[${i}] ${step.req} body`).toEqual(maskVolatile(expected));
    }
  } finally {
    _setDbForTests(null);
    await close();
  }
}
```

The runner reuses `setupParityEnv()` from `helpers/parity.ts` — call it in each test file's describe block, exactly like the wave-1 parity tests do. The registry's `params` come from named regex groups, e.g. `/^\/books\/(?<id>\d+)\/feedback$/`.

- [ ] **Step 2: First test file** (`parity-writes-books.test.ts`) — start with the scenarios POST /books alone can serve:

```ts
import { describe, it } from 'vitest';
import { setupParityEnv } from './helpers/parity';
import { runScenario } from './helpers/write-parity';

describe('write parity: books', () => {
  setupParityEnv();
  it('add-book-basic', () => runScenario('add-book-basic'));
  it('add-book-rated-review', () => runScenario('add-book-rated-review'));
  it('add-book-duplicate', () => runScenario('add-book-duplicate'));
  it('add-book-sibling-subtitle', () => runScenario('add-book-sibling-subtitle'));
  it('add-book-invalid', () => runScenario('add-book-invalid'));
});
```

`add-book-basic` also needs the wave-1 GET /books row (already in the registry above); `add-book-rated-review` needs GET /profile/status — add its registry row now: `{ method: 'GET', pattern: /^\/profile\/status$/, handler: () => profileStatusRoute.GET }` with the corresponding import from `app/api/profile/status/route`.

- [ ] **Step 3: Verify failure** — `npx vitest run lib/server/__tests__/parity-writes-books.test.ts` → FAIL (`booksRoute.POST` undefined).

- [ ] **Step 4: Implement POST in `app/api/books/route.ts`** (add to the existing file; `bookOut` and the zod import are already there):

```ts
import { isNotNull } from 'drizzle-orm'; // merge into existing drizzle-orm import
import { sameWork } from '@/lib/server/dedup';
import { VALID_SHELVES } from '@/lib/server/books'; // merge into existing books import
import { utcnowTs, todayIsoDate, pyList } from '@/lib/server/serialize'; // merge imports

const AddBook = z.object({
  title: z.string(),
  author: z.string().nullish(),
  year: z.number().int().nullish(),
  isbn13: z.string().nullish(),
  shelf: z.string().default('read'),
  rating: z.number().int().nullish(),
  review: z.string().nullish(),
  cover_url: z.string().nullish(),
  subjects: z.array(z.string()).nullish(),
  catalog_source: z.string().nullish(),
  catalog_id: z.string().nullish(),
});

export const POST = withApi('/api/books', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const parsed = AddBook.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(422, `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`);
  }
  const b = parsed.data;

  // Port of library.add_book — validation order matters for parity.
  const title = (b.title ?? '').trim();
  if (!title) throw new ApiError(422, 'title is required.');
  if (!VALID_SHELVES.includes(b.shelf)) {
    throw new ApiError(422, `shelf must be one of ${pyList(VALID_SHELVES)}.`);
  }
  if (b.rating != null && b.rating !== 0 && !(b.rating >= 1 && b.rating <= 5)) {
    throw new ApiError(422, 'rating must be between 1 and 5 (or omitted/0 for unrated).');
  }
  const author = (b.author ?? '').trim() || null;
  const isbn13 = (b.isbn13 ?? '').trim() || null;
  const review = (b.review ?? '').trim() || null;
  if (review && (b.rating == null || b.rating === 0)) {
    throw new ApiError(422, 'A review requires a rating (1-5). Rate the book, or omit the review.');
  }

  const db = getDb();
  // Dedup walk, scoped to this user (same-work identity — enrich.py::_same_work).
  const existing = await db
    .select({ title: schema.books.title, author: schema.books.author })
    .from(schema.books)
    .where(and(eq(schema.books.userId, ctx.user.userId), isNotNull(schema.books.title)));
  for (const row of existing) {
    if (sameWork(row.title, row.author, title, author)) {
      throw new ApiError(409, `"${title}" is already in your library.`);
    }
  }

  const rated = b.rating != null && b.rating !== 0;
  const [book] = await db
    .insert(schema.books)
    .values({
      userId: ctx.user.userId,
      title,
      author,
      isbn13,
      yearPublished: b.year ?? null,
      exclusiveShelf: b.shelf,
      source: 'manual',
      goodreadsRating: 0,
      dateAdded: todayIsoDate(),
      appRating: rated ? b.rating : null,
      appReview: review,
      feedbackUpdatedAt: rated || review ? utcnowTs() : null,
    })
    .returning();

  let enr = null;
  if (b.cover_url || b.subjects || b.catalog_source || b.catalog_id) {
    [enr] = await db
      .insert(schema.enrichment)
      .values({
        bookId: book.id,
        resolvedSource: b.catalog_source ?? null,
        resolvedId: b.catalog_id ?? null,
        subjects: b.subjects ?? [],
        coverUrl: b.cover_url ?? null,
        resolutionConfidence: 1.0,
        confidenceLabel: 'MANUAL',
        matchMethod: 'manual_add',
        resolvedAt: utcnowTs(),
      })
      .returning();
  }
  ctx.timer.mark('db');
  return Response.json(bookOut(book, enr), { status: 201 });
});
```

Check the drizzle enrichment schema for `resolvedAt` nullability — the introspected column is `not null default current_timestamp`; passing `utcnowTs()` explicitly keeps the value deterministic-ish and masked anyway.

Also add `bookSummary` to `frontend/lib/server/books.ts` now (Task 6 consumes it):

```ts
import { tsToIso } from './serialize'; // merge import

/** Sorted — this exact order is what Python's sorted(VALID_SHELVES) interpolates into 422s. */
export const VALID_SHELVES = ['currently-reading', 'did-not-finish', 'read', 'to-read'];

/** Port of library.py::_book_summary — the PATCH feedback/shelf response dict. */
export function bookSummary(b: BookRow) {
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    exclusive_shelf: b.exclusiveShelf,
    app_rating: b.appRating,
    goodreads_rating: b.goodreadsRating,
    effective_rating: effectiveRating(b.appRating, b.goodreadsRating),
    app_review: b.appReview,
    date_read: b.dateRead,
    feedback_updated_at: tsToIso(b.feedbackUpdatedAt),
    exclude_from_profile: b.excludeFromProfile,
  };
}
```

- [ ] **Step 5: Verify pass** — the books write-parity file, then full `npm run test:server` + `npm run type-check`.
- [ ] **Step 6: Commit gate** — `feat(node): POST /api/books + write-scenario parity runner`.

---

### Task 6: `PATCH /books/[id]/feedback` + `PATCH /books/[id]/shelf`

**Files:**
- Create: `frontend/app/api/books/[id]/feedback/route.ts`, `frontend/app/api/books/[id]/shelf/route.ts`
- Modify: `helpers/write-parity.ts` (registry rows), Test: `parity-writes-books.test.ts` (add scenarios `book-feedback`, `book-feedback-invalid`, `book-shelf`)

**Interfaces:**
- Consumes: `bookSummary` + `VALID_SHELVES` from `lib/server/books.ts` (Task 5), `pyList` / `effectiveRating` / `utcnowTs` from `lib/server/serialize.ts`.

- [ ] **Step 1: Add scenario tests + registry rows** (`/^\/books\/(?<id>\d+)\/feedback$/`, `/^\/books\/(?<id>\d+)\/shelf$/`); run → FAIL.
- [ ] **Step 2: Implement feedback route** — port of `library.set_book_feedback` with `api.py`'s exception mapping:

```ts
import { and, eq } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { bookSummary } from '@/lib/server/books';
import { effectiveRating, utcnowTs } from '@/lib/server/serialize';
import { z } from 'zod';

const Body = z.object({
  rating: z.number().int().nullish(),
  review: z.string().nullish(),
  clear_review: z.boolean().default(false),
  date_read: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  exclude_from_profile: z.boolean().nullish(),
  is_favorite: z.boolean().nullish(),
});

export const PATCH = withApi('/api/books/[id]/feedback', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(422, `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`);
  }
  const b = parsed.data;
  const bookId = Number(ctx.params.id);

  // Port of library.set_book_feedback — validation order matters.
  if (b.rating != null && b.rating !== 0 && !(b.rating >= 1 && b.rating <= 5)) {
    throw new ApiError(422, 'rating must be between 1 and 5 (or 0 to clear).');
  }
  if (b.rating == null && b.review == null && !b.clear_review &&
      b.date_read == null && b.exclude_from_profile == null && b.is_favorite == null) {
    throw new ApiError(422, 'Nothing to update: pass a rating, review, date read, exclude flag, and/or favorite.');
  }

  const db = getDb();
  const rows = await db.select().from(schema.books)
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, ctx.user.userId)));
  const book = rows[0];
  if (!book) throw new ApiError(404, `Book ${bookId} not found.`);

  const next = { ...book };
  if (b.rating != null) next.appRating = b.rating === 0 ? null : b.rating;
  if (b.clear_review) next.appReview = null;
  else if (b.review != null) next.appReview = b.review.trim() || null;
  if (b.date_read != null) next.dateRead = b.date_read;
  if (b.exclude_from_profile != null) next.excludeFromProfile = b.exclude_from_profile;
  if (b.is_favorite != null) next.isFavorite = b.is_favorite;

  // Review-without-rating guard runs AFTER applying changes (DNF exempt) — Python order.
  if (next.appReview && effectiveRating(next.appRating, next.goodreadsRating) === null &&
      next.exclusiveShelf !== 'did-not-finish') {
    throw new ApiError(422,
      'A review requires a rating. Rate the book 1-5 (same update is fine) before saving a review.');
  }

  next.feedbackUpdatedAt = utcnowTs();
  await db.update(schema.books).set({
    appRating: next.appRating, appReview: next.appReview, dateRead: next.dateRead,
    excludeFromProfile: next.excludeFromProfile, isFavorite: next.isFavorite,
    feedbackUpdatedAt: next.feedbackUpdatedAt,
  }).where(eq(schema.books.id, bookId));
  ctx.timer.mark('db');
  return Response.json(bookSummary(next));
});
```

- [ ] **Step 3: Implement shelf route** — port of `library.set_book_shelf`:

```ts
export const PATCH = withApi('/api/books/[id]/shelf', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const shelf = typeof raw?.shelf === 'string' ? raw.shelf : null;
  if (shelf === null) throw new ApiError(422, 'validation error: shelf is required');
  if (!VALID_SHELVES.includes(shelf)) {
    throw new ApiError(422, `shelf must be one of ${pyList(VALID_SHELVES)}.`);
  }
  const bookId = Number(ctx.params.id);
  const db = getDb();
  const rows = await db.select().from(schema.books)
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, ctx.user.userId)));
  const book = rows[0];
  if (!book) throw new ApiError(404, `Book ${bookId} not found.`);
  if (shelf !== 'did-not-finish' && book.appReview &&
      effectiveRating(book.appRating, book.goodreadsRating) === null) {
    throw new ApiError(422,
      'A review requires a rating. Rate the book 1-5 before moving it off did-not-finish.');
  }
  await db.update(schema.books).set({ exclusiveShelf: shelf })
    .where(eq(schema.books.id, bookId));
  ctx.timer.mark('db');
  return Response.json(bookSummary({ ...book, exclusiveShelf: shelf }));
});
```

(Shelf moves do NOT bump `feedback_updated_at` — deliberate Python behavior, keep it.)

- [ ] **Step 4: Verify pass** — scenarios green, full suites green, type-check, lint.
- [ ] **Step 5: Commit gate** — `feat(node): book feedback + shelf writes`.

---

### Task 7: `PATCH /books/[id]/enrichment` + `DELETE /books/[id]` + `ensureProfileMeta`

**Files:**
- Create: `frontend/lib/server/profileMeta.ts`, `frontend/app/api/books/[id]/enrichment/route.ts`, `frontend/app/api/books/[id]/route.ts`
- Registry rows + scenarios `enrichment-correction`, `delete-book` in `parity-writes-books.test.ts`

**Interfaces:**
- Produces: `ensureProfileMeta(db: Db, userId: string): Promise<ProfileMetaRow>` — `profile.get_profile_meta` twin: select by userId, insert-if-missing, return the row. Consumed by Tasks 8 and 12.

- [ ] **Step 1: Scenario tests + registry rows** → FAIL.
- [ ] **Step 2: `profileMeta.ts`:**

```ts
import { eq } from 'drizzle-orm';
import { schema, type Db } from './db';

export type ProfileMetaRow = typeof schema.profileMeta.$inferSelect;

/** Port of profile.get_profile_meta: fetch-or-create the singleton row. */
export async function ensureProfileMeta(db: Db, userId: string): Promise<ProfileMetaRow> {
  const rows = await db.select().from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, userId));
  if (rows[0]) return rows[0];
  const [created] = await db.insert(schema.profileMeta)
    .values({ userId }).returning();
  return created;
}
```

- [ ] **Step 3: Enrichment route** — port of `library.correct_enrichment` + `api.py` response (BookOut, so re-read the enrichment after upsert):

```ts
export const PATCH = withApi('/api/books/[id]/enrichment', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const parsed = z.object({
    catalog_source: z.string(),
    catalog_id: z.string(),
    cover_url: z.string().nullish(),
    subjects: z.array(z.string()).nullish(),
    description: z.string().nullish(),
  }).safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(422, `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`);
  }
  const b = parsed.data;
  const catalogSource = (b.catalog_source ?? '').trim();
  const catalogId = (b.catalog_id ?? '').trim();
  if (!catalogSource || !catalogId) {
    throw new ApiError(422, 'catalog_source and catalog_id are required.');
  }
  const bookId = Number(ctx.params.id);
  const db = getDb();
  const rows = await db.select().from(schema.books)
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, ctx.user.userId)));
  const book = rows[0];
  if (!book) throw new ApiError(404, `Book ${bookId} not found.`);

  const fields = {
    resolvedSource: catalogSource, resolvedId: catalogId,
    subjects: b.subjects ?? [], coverUrl: b.cover_url ?? null,
    description: b.description ?? null, // always overwritten, even to null — Python behavior
    confidenceLabel: 'CORRECTED', resolutionConfidence: 1.0,
    matchMethod: 'user_correction', resolvedAt: utcnowTs(),
  };
  const existing = await db.select().from(schema.enrichment)
    .where(eq(schema.enrichment.bookId, bookId));
  if (existing[0]) {
    await db.update(schema.enrichment).set(fields)
      .where(eq(schema.enrichment.bookId, bookId));
  } else {
    await db.insert(schema.enrichment).values({ bookId, ...fields });
  }

  const meta = await ensureProfileMeta(db, ctx.user.userId);
  await db.update(schema.profileMeta).set({ enrichmentCorrectedAt: utcnowTs() })
    .where(eq(schema.profileMeta.id, meta.id));

  const enr = (await db.select().from(schema.enrichment)
    .where(eq(schema.enrichment.bookId, bookId)))[0] ?? null;
  ctx.timer.mark('db');
  return Response.json(bookOut(book, enr));
});
```

- [ ] **Step 4: Delete route** (`app/api/books/[id]/route.ts`) — port of `library.remove_book`. The DB FK has **no ON DELETE CASCADE** (Python's cascade is ORM-level), so delete the enrichment row first:

```ts
export const DELETE = withApi('/api/books/[id]', async (_req, ctx) => {
  const bookId = Number(ctx.params.id);
  const db = getDb();
  const rows = await db.select().from(schema.books)
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, ctx.user.userId)));
  const book = rows[0];
  if (!book) throw new ApiError(404, `Book ${bookId} not found.`);
  await db.delete(schema.enrichment).where(eq(schema.enrichment.bookId, bookId));
  await db.delete(schema.books).where(eq(schema.books.id, bookId));
  ctx.timer.mark('db');
  return Response.json({ id: bookId, title: book.title, removed: true });
});
```

- [ ] **Step 5: Verify pass** (scenarios incl. the `GET /profile/status` dirty-flag probe), full suites.
- [ ] **Step 6: Commit gate** — `feat(node): enrichment correction + book delete`.

---

### Task 8: `PATCH /recommendations/[id]/feedback`

The biggest port: validation battery + `_ensure_library_book`.

**Files:**
- Create: `frontend/app/api/recommendations/[id]/feedback/route.ts`
- Modify: `frontend/lib/server/recs.ts` (add `ensureLibraryBook`)
- Create: `frontend/lib/server/__tests__/parity-writes-recs.test.ts` (scenarios `rec-feedback-accept`, `rec-feedback-already-read`, `rec-feedback-note-on-accepted`, `rec-feedback-reject-reasons`, `rec-feedback-invalid`) + registry rows (incl. wave-1 `GET /recommendations/rejected` probe)

**Interfaces:**
- Consumes: `sameWork` (Task 3), `ensureProfileMeta` (Task 7), `bookOut` (wave 1).
- Produces: `ensureLibraryBook(db, rec, shelf, userId): Promise<{ book, enrichment }>` in `recs.ts`.

- [ ] **Step 1: Scenario tests + registry rows** → FAIL.
- [ ] **Step 2: `ensureLibraryBook`** in `recs.ts` — port of `api.py::_ensure_library_book` (post-PR version using `_same_work`):

```ts
import { and, eq, isNotNull } from 'drizzle-orm';
import { schema, type Db } from './db';
import { sameWork } from './dedup';

type RecRow = typeof schema.recommendations.$inferSelect;

/** Idempotently land a recommended book in the user's library on `shelf`.
 *  Port of api.py::_ensure_library_book (same-work dedup, stub enrichment). */
export async function ensureLibraryBook(db: Db, rec: RecRow, shelf: string, userId: string) {
  const existing = await db.select().from(schema.books)
    .where(and(eq(schema.books.userId, userId), isNotNull(schema.books.title)));
  for (const b of existing) {
    if (sameWork(b.title, b.author, rec.title, rec.author)) {
      const enr = (await db.select().from(schema.enrichment)
        .where(eq(schema.enrichment.bookId, b.id)))[0] ?? null;
      return { book: b, enrichment: enr };
    }
  }
  const [book] = await db.insert(schema.books).values({
    userId, title: rec.title, author: rec.author, isbn13: rec.isbn13,
    yearPublished: rec.year, exclusiveShelf: shelf,
    source: 'recommendation', goodreadsRating: 0,
  }).returning();
  const [enr] = await db.insert(schema.enrichment).values({
    bookId: book.id, resolvedSource: rec.catalogSource, resolvedId: rec.catalogId,
    subjects: rec.subjects, description: rec.description, coverUrl: rec.coverUrl,
    resolutionConfidence: 1.0, confidenceLabel: 'RECOMMENDATION',
    matchMethod: 'recommendation_' + shelf,
  }).returning();
  return { book, enrichment: enr };
}
```

- [ ] **Step 3: The route** — mirror `api.py` line-for-line; note "provided" means **key present in the raw JSON**, matching Pydantic's `model_fields_set`:

```ts
import { REJECT_REASONS } from '@/lib/server/recs'; // export the tuple from recs.ts too

// in recs.ts:
export const REJECT_REASONS = [
  'wrong_genre', 'too_dark', 'tried_author', 'too_long',
  'not_now', 'overhyped', 'wrong_vibe',
] as const;
```

```ts
export const PATCH = withApi('/api/recommendations/[id]/feedback', async (req, ctx) => {
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (raw === null || typeof raw !== 'object') {
    throw new ApiError(422, 'validation error: invalid body');
  }
  const statusProvided = 'status' in raw;
  const userNoteProvided = 'user_note' in raw;
  const status = raw.status as string | null;
  const userNote = raw.user_note as string | null;
  const rejectReasons = (raw.reject_reasons ?? null) as string[] | null;
  const rejectReasonsProvided = rejectReasons !== null;

  const VALID = ['accepted', 'rejected', 'already_read'];
  if (statusProvided && !VALID.includes(status as string)) {
    // Python interpolates a set repr here — order is hash-seed-dependent, so this
    // exact string is a documented deviation; the fixture step is maskDetail'd.
    throw new ApiError(422, "status must be one of {'accepted', 'rejected', 'already_read'}");
  }
  if (!statusProvided && !userNoteProvided && !rejectReasonsProvided) {
    throw new ApiError(422, 'Provide status and/or user_note');
  }
  if (rejectReasonsProvided && (statusProvided ? status : null) !== 'rejected') {
    throw new ApiError(422, "reject_reasons may only be provided when status is 'rejected'");
  }
  if (rejectReasonsProvided) {
    const valid = rejectReasons.length > 0 && rejectReasons.every((r) => (REJECT_REASONS as readonly string[]).includes(r));
    if (!valid) {
      if (rejectReasons.length === 0) {
        throw new ApiError(422, `reject_reasons must be a non-empty list. Valid codes: ${pyList([...REJECT_REASONS])}`);
      }
      const unknown = rejectReasons.filter((r) => !(REJECT_REASONS as readonly string[]).includes(r));
      throw new ApiError(422, `Unknown reject_reasons: ${pyList(unknown)}. Valid codes: ${pyList([...REJECT_REASONS])}`);
    }
  }

  const recId = Number(ctx.params.id);
  const db = getDb();
  const recs = await db.select().from(schema.recommendations)
    .where(eq(schema.recommendations.id, recId));
  const rec = recs[0];
  if (!rec || rec.userId !== ctx.user.userId) {
    throw new ApiError(404, `Recommendation ${recId} not found`);
  }

  const updates: Partial<typeof rec> = {};
  if (statusProvided) updates.status = status as string;
  if (userNoteProvided) updates.userNote = userNote;
  if (rejectReasonsProvided) {
    updates.rejectReasons = rejectReasons;
    const meta = await ensureProfileMeta(db, ctx.user.userId);
    await db.update(schema.profileMeta).set({ recFeedbackUpdatedAt: utcnowTs() })
      .where(eq(schema.profileMeta.id, meta.id));
  }
  if (Object.keys(updates).length) {
    await db.update(schema.recommendations).set(updates)
      .where(eq(schema.recommendations.id, recId));
  }
  const updated = { ...rec, ...updates };

  // Python: `req.status or rec.status` — falls back when status wasn't provided.
  const effective = (statusProvided && status) || updated.status;
  let book: unknown = null;
  if (effective === 'accepted') {
    const r = await ensureLibraryBook(db, updated, 'to-read', ctx.user.userId);
    book = bookOut(r.book, r.enrichment);
  } else if (effective === 'already_read') {
    const r = await ensureLibraryBook(db, updated, 'read', ctx.user.userId);
    book = bookOut(r.book, r.enrichment);
  }
  ctx.timer.mark('db');
  return Response.json({ status: updated.status, user_note: updated.userNote, book });
});
```

- [ ] **Step 4: Verify pass** — the idempotency scenario (`accept` twice → same book id both times, `GET /books?shelf=to-read` shows exactly one new row) is the critical one. Full suites.
- [ ] **Step 5: Commit gate** — `feat(node): recommendation swipe feedback + ensureLibraryBook`.

---

### Task 9: settings writes (`PUT`/`DELETE /settings/api-key`, `PUT /settings/profile`)

**Files:**
- Create: `frontend/lib/server/settings.ts`, `frontend/app/api/settings/api-key/route.ts`
- Modify: `frontend/app/api/settings/api-key/status/route.ts` (use the extracted helper — read the wave-1 file FIRST and move its logic verbatim), `frontend/app/api/settings/profile/route.ts` (add PUT)
- Create: `frontend/lib/server/__tests__/parity-writes-settings.test.ts` (scenarios `api-key`, `display-name`) + registry rows (incl. wave-1 `GET /settings/api-key/status`)
- Test (unit): crypto round-trip on the stored value

**Interfaces:**
- Produces: `keyConfigured(db: Db, userId: string): Promise<boolean>` — extraction of the wave-1 status route's exact logic (stored-key-decrypts OR `process.env.ANTHROPIC_API_KEY !== undefined`); `upsertUserSettings(db, userId, patch): Promise<void>`.

- [ ] **Step 1: Scenario tests + registry rows** → FAIL.
- [ ] **Step 2: `settings.ts`** — extract, don't reinvent: open `app/api/settings/api-key/status/route.ts`, move its configured-check into `keyConfigured`, and refactor the status route to call it (its parity tests from wave 1 must stay green — that's the proof the extraction is faithful). Add:

```ts
import { eq } from 'drizzle-orm';
import { schema, type Db } from './db';
import { utcnowTs } from './serialize';

export async function upsertUserSettings(
  db: Db, userId: string,
  patch: Partial<{ anthropicApiKeyEncrypted: string | null; displayName: string }>
): Promise<void> {
  const rows = await db.select().from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId));
  if (rows[0]) {
    await db.update(schema.userSettings).set({ ...patch, updatedAt: utcnowTs() })
      .where(eq(schema.userSettings.id, rows[0].id));
  } else {
    await db.insert(schema.userSettings).values({ userId, ...patch });
  }
}
```

(Python nuance preserved: the insert branch does NOT set `updated_at` — only updates stamp it.)

- [ ] **Step 3: Routes:**

`api-key/route.ts`:

```ts
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { encrypt } from '@/lib/server/crypto';
import { keyConfigured, upsertUserSettings } from '@/lib/server/settings';

export const PUT = withApi('/api/settings/api-key', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const key = typeof raw?.api_key === 'string' ? raw.api_key.trim() : '';
  if (!key) throw new ApiError(422, 'API key must not be empty.');
  const db = getDb();
  await upsertUserSettings(db, ctx.user.userId, { anthropicApiKeyEncrypted: encrypt(key) });
  ctx.timer.mark('db');
  return Response.json({ configured: true });
});

export const DELETE = withApi('/api/settings/api-key', async (_req, ctx) => {
  const db = getDb();
  await upsertUserSettings(db, ctx.user.userId, { anthropicApiKeyEncrypted: null });
  const configured = await keyConfigured(db, ctx.user.userId);
  ctx.timer.mark('db');
  return Response.json({ configured });
});
```

Python nuance: `clear_anthropic_key` only touches an **existing** row (no insert). `upsertUserSettings` inserts one with a null key if missing — same visible behavior, invisible row difference; acceptable. If you'd rather be exact: skip the write when no row exists.

`settings/profile/route.ts`, add:

```ts
export const PUT = withApi('/api/settings/profile', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const name = typeof raw?.display_name === 'string' ? raw.display_name.trim() : '';
  if (!name) throw new ApiError(422, 'Display name must not be empty.');
  const db = getDb();
  await upsertUserSettings(db, ctx.user.userId, { displayName: name });
  const rows = await db.select().from(schema.userSettings)
    .where(eq(schema.userSettings.userId, ctx.user.userId));
  ctx.timer.mark('db');
  return Response.json({ display_name: rows[0]?.displayName ?? null });
});
```

- [ ] **Step 4: Crypto round-trip unit test** (in the settings parity test file or a sibling): after running the `api-key` scenario manually — simpler as a direct unit test: seed a DB, call the PUT handler with `{"api_key": "sk-ant-roundtrip"}` via the runner's registry-resolve or directly, then read the stored `anthropic_api_key_encrypted` and assert `decrypt(stored) === 'sk-ant-roundtrip'`. This is the one write whose stored value the parity fixture can't check (fresh nonce per encryption).
- [ ] **Step 5: Verify pass** — incl. wave-1 settings parity tests (the status-route refactor must not move a single byte of behavior). Full suites.
- [ ] **Step 6: Commit gate** — `feat(node): settings writes (api key encrypt/clear, display name)`.

---

### Task 10: `PUT /directive` + `DELETE /directive`

**Files:**
- Create: `frontend/lib/server/directive.ts`
- Modify: `frontend/app/api/directive/route.ts` (add PUT, DELETE)
- Create: `frontend/lib/server/__tests__/parity-writes-directive.test.ts` (scenario `directive`) + registry rows (incl. wave-1 `GET /directive`)

**Interfaces:**
- Produces: `cleanDirectiveConstraints(raw: unknown): Record<string, unknown>` — port of `directive._clean_directive_constraints`.

- [ ] **Step 1: Failing unit tests for the cleaner** (plus the scenario test):

```ts
import { cleanDirectiveConstraints } from './directive';

it('normalizes languages to 2-letter lowercase', () => {
  expect(cleanDirectiveConstraints({ languages: ['EN', ' fr ', ''] }))
    .toEqual({ languages: ['en', 'fr'] });
});
it('coerces digit strings, keeps ints, skips bools, drops unknown keys', () => {
  expect(cleanDirectiveConstraints({ min_year: '1990', max_year: 2020, page_max: 400, series: true }))
    .toEqual({ min_year: 1990, max_year: 2020 });
});
it('empty input → {}', () => {
  expect(cleanDirectiveConstraints(null)).toEqual({});
});
```

- [ ] **Step 2: Implement `directive.ts`:**

```ts
/** Port of directive._clean_directive_constraints — keep only supported,
 *  catalog-filterable constraints; normalize types. */
export function cleanDirectiveConstraints(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;

  const langs = (Array.isArray(r.languages) ? r.languages : [])
    .filter((x) => String(x).trim())
    .map((x) => String(x).trim().toLowerCase().slice(0, 2));
  if (langs.length) out.languages = langs;

  for (const key of ['min_year', 'max_year'] as const) {
    const val = r[key];
    if (typeof val === 'boolean') continue;
    if (typeof val === 'number' && Number.isInteger(val)) out[key] = val;
    else if (typeof val === 'string' && /^\d+$/.test(val.trim())) out[key] = parseInt(val.trim(), 10);
  }

  const excl = (Array.isArray(r.exclude_subjects) ? r.exclude_subjects : [])
    .filter((x) => String(x).trim())
    .map((x) => String(x).trim().toLowerCase());
  if (excl.length) out.exclude_subjects = excl;

  const authors = (Array.isArray(r.exclude_authors) ? r.exclude_authors : [])
    .filter((x) => String(x).trim())
    .map((x) => String(x).trim().toLowerCase());
  if (authors.length) out.exclude_authors = authors;

  return out;
}
```

- [ ] **Step 3: Routes** (add to `directive/route.ts`; `EMPTY` already defined there):

```ts
export const PUT = withApi('/api/directive', async (req, ctx) => {
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const text = (typeof raw?.nl_text === 'string' ? raw.nl_text : '').trim();
  const cleaned = cleanDirectiveConstraints(raw?.constraints);
  if (!text && !Object.keys(cleaned).length) {
    throw new ApiError(422, 'Custom instructions must not be empty.');
  }
  const db = getDb();
  const rows = await db.select().from(schema.userDirective)
    .where(eq(schema.userDirective.userId, ctx.user.userId));
  if (rows[0]) {
    await db.update(schema.userDirective).set({
      nlText: text || null,
      constraints: Object.keys(cleaned).length ? cleaned : null,
      updatedAt: utcnowTs(), // ORM onupdate twin — only the update branch stamps it
    }).where(eq(schema.userDirective.id, rows[0].id));
  } else {
    await db.insert(schema.userDirective).values({
      userId: ctx.user.userId,
      nlText: text || null,
      constraints: Object.keys(cleaned).length ? cleaned : null,
    });
  }
  // Python re-reads via get_directive and returns the same shape as GET.
  const after = (await db.select().from(schema.userDirective)
    .where(eq(schema.userDirective.userId, ctx.user.userId)))[0];
  const constraints = (after?.constraints ?? {}) as Record<string, unknown>;
  const meaningful = after && (after.nlText || Object.keys(constraints).length > 0);
  ctx.timer.mark('db');
  if (!meaningful) return Response.json(EMPTY);
  return Response.json({
    nl_text: after.nlText, constraints, updated_at: tsToIso(after.updatedAt),
  });
});

export const DELETE = withApi('/api/directive', async (_req, ctx) => {
  const db = getDb();
  await db.delete(schema.userDirective)
    .where(eq(schema.userDirective.userId, ctx.user.userId));
  ctx.timer.mark('db');
  return Response.json(EMPTY);
});
```

- [ ] **Step 4: Verify pass** (the recorded scenario proves the cleaner end-to-end: `page_max` dropped, `"1990"` → 1990, `EN`→`en`), full suites.
- [ ] **Step 5: Commit gate** — `feat(node): directive set/clear`.

---

### Task 11: `PATCH /profile/traits/[id]`

**Files:**
- Create: `frontend/lib/server/traits.ts` (extract the trait→JSON mapper from `app/api/profile/route.ts` as `traitOut(t)`; refactor that route to use it — its wave-1 parity tests prove the extraction)
- Create: `frontend/app/api/profile/traits/[id]/route.ts`
- Create: `frontend/lib/server/__tests__/parity-writes-traits.test.ts` (scenario `trait-patch`) + registry rows (incl. wave-1 `GET /profile/status`)

- [ ] **Step 1: Scenario test + registry** → FAIL.
- [ ] **Step 2: Extract `traitOut`** into `traits.ts` (verbatim field mapping from the profile route, incl. `tsToIso` on both timestamps).
- [ ] **Step 3: Route** — port of `api.py::update_trait` + `library.set_trait_verdict`:

```ts
const Body = z.object({
  claim: z.string().nullish(),
  user_note: z.string().nullish(),
  status: z.enum(['confirmed', 'rejected']).nullish(),
  user_weight: z.number().min(0).max(1).nullish(),
});

export const PATCH = withApi('/api/profile/traits/[id]', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(422, `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`);
  }
  const b = parsed.data;
  if (b.claim == null && b.user_note == null && b.status == null && b.user_weight == null) {
    throw new ApiError(422, 'at least one field (claim, user_note, status, user_weight) must be provided');
  }
  const traitId = Number(ctx.params.id);
  const db = getDb();
  const rows = await db.select().from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.id, traitId));
  const trait = rows[0];
  if (!trait || trait.userId !== ctx.user.userId) {
    throw new ApiError(404, `Trait ${traitId} not found`);
  }
  const updates: Partial<typeof trait> = {};
  if (b.claim != null) { updates.claim = b.claim.trim(); updates.status = 'edited'; }
  if (b.user_note != null) updates.userNote = b.user_note;
  if (b.status != null || b.user_weight != null) {
    if (b.status != null) updates.status = b.status; // verdict overrides 'edited'
    if (b.user_weight != null) updates.userWeight = b.user_weight;
    updates.verdictUpdatedAt = utcnowTs();
  }
  await db.update(schema.tasteTraits).set(updates)
    .where(eq(schema.tasteTraits.id, traitId));
  ctx.timer.mark('db');
  return Response.json(traitOut({ ...trait, ...updates }));
});
```

(Python's two-branch fetch collapses to one — same 404 string either way; a claim-only edit does NOT stamp `verdict_updated_at`, a status/weight edit does. That's the behavior the scenario asserts.)

- [ ] **Step 4: Verify pass** — incl. the `GET /profile/status` probe (trait verdict marks the profile dirty) and wave-1 profile parity tests (mapper extraction). Full suites.
- [ ] **Step 5: Commit gate** — `feat(node): taste-trait editing`.

---

### Task 12: feedback trio + taste-signal

**Files:**
- Create: `frontend/lib/server/feedbackPrompts.ts`, `frontend/app/api/feedback/route.ts`, `frontend/app/api/feedback/prompt/route.ts`, `frontend/app/api/feedback/dismiss/route.ts`, `frontend/app/api/taste-signal/route.ts`
- Create: `frontend/lib/server/__tests__/parity-writes-feedback.test.ts` (scenarios `feedback-flow`, `feedback-invalid`, `taste-signal`) + registry rows
- Modify: `helpers/parity.ts` — add `'FEEDBACK_PROMPTS_ENABLED', 'FEEDBACK_SNOOZE_HOURS'` to `ENV_KEYS` and delete both in `beforeEach` (Python generator runs with defaults: enabled, 72h)

**Interfaces:**
- Produces (`feedbackPrompts.ts`): `ONE_TIME_TRIGGERS`, `VALID_CATEGORIES`, `checkPromptEligibility(db, userId, trigger, runId): Promise<boolean>`, `dismissPrompt(db, userId, trigger, runId, mode): Promise<void>`, `upsertPromptState(db, {userId, trigger, runId, status, snoozeUntil}): Promise<void>` — ports of `mylibrary/feedback.py`.
- Config: prompts enabled = `FEEDBACK_PROMPTS_ENABLED` env (unset/empty → `true`; `'false'/'0'/'no'/'off'` → false, mirroring Python `_env_bool`); snooze hours = `FEEDBACK_SNOOZE_HOURS` (unset/empty → `72`).

- [ ] **Step 1: Scenario tests + registry** → FAIL.
- [ ] **Step 2: `feedbackPrompts.ts`** — direct port of `feedback.py`. Timestamp comparisons are lexicographic on the same-format `'YYYY-MM-DD HH:MM:SS…'` strings (wave-1 precedent) with `now = utcnowTs()`:

```ts
import { and, eq, gt } from 'drizzle-orm';
import { schema, type Db } from './db';
import { utcnowTs } from './serialize';

export const ONE_TIME_TRIGGERS = ['post-setup', 'post-first-profile'];
export const REPEATABLE_TRIGGER = 'post-recs';
// Python emits sorted(VALID_CATEGORIES) in the 422 — this array IS that sorted order.
export const VALID_CATEGORIES = ['bug', 'confusing', 'idea', 'praise', 'targeted'];

/** Empty-string env counts as unset (wave-1 convention). */
function promptsEnabled(): boolean {
  const v = process.env.FEEDBACK_PROMPTS_ENABLED;
  if (v === undefined || v === '') return true;
  return !['false', '0', 'no', 'off'].includes(v.toLowerCase());
}
function snoozeHours(): number {
  const v = process.env.FEEDBACK_SNOOZE_HOURS;
  if (v === undefined || v === '') return 72;
  return parseInt(v, 10);
}

export async function upsertPromptState(
  db: Db,
  args: { userId: string; trigger: string; runId: string; status: string; snoozeUntil?: string | null }
): Promise<void> {
  const rows = await db.select().from(schema.feedbackPromptState).where(and(
    eq(schema.feedbackPromptState.userId, args.userId),
    eq(schema.feedbackPromptState.trigger, args.trigger),
    eq(schema.feedbackPromptState.runId, args.runId),
  ));
  if (rows[0]) {
    await db.update(schema.feedbackPromptState)
      .set({ status: args.status, snoozeUntil: args.snoozeUntil ?? null, updatedAt: utcnowTs() })
      .where(eq(schema.feedbackPromptState.id, rows[0].id));
  } else {
    await db.insert(schema.feedbackPromptState).values({
      userId: args.userId, trigger: args.trigger, runId: args.runId,
      status: args.status, snoozeUntil: args.snoozeUntil ?? null,
    });
  }
}

export async function checkPromptEligibility(
  db: Db, userId: string, trigger: string, runId: string | null
): Promise<boolean> {
  if (!promptsEnabled()) return false;
  const now = utcnowTs();

  if (ONE_TIME_TRIGGERS.includes(trigger)) {
    const rows = await db.select().from(schema.feedbackPromptState).where(and(
      eq(schema.feedbackPromptState.userId, userId),
      eq(schema.feedbackPromptState.trigger, trigger),
      eq(schema.feedbackPromptState.runId, ''),
    ));
    const row = rows[0];
    if (!row) return true;
    if (row.status === 'ask_later') {
      return row.snoozeUntil !== null && row.snoozeUntil <= now; // lexicographic, same format
    }
    return false; // submitted or dont_ask
  }

  if (trigger === REPEATABLE_TRIGGER) {
    const rid = runId ?? '';
    const globalDontAsk = await db.select().from(schema.feedbackPromptState).where(and(
      eq(schema.feedbackPromptState.userId, userId),
      eq(schema.feedbackPromptState.trigger, REPEATABLE_TRIGGER),
      eq(schema.feedbackPromptState.runId, ''),
      eq(schema.feedbackPromptState.status, 'dont_ask'),
    ));
    if (globalDontAsk[0]) return false;
    const fbRows = await db.select().from(schema.feedback).where(and(
      eq(schema.feedback.userId, userId),
      eq(schema.feedback.trigger, REPEATABLE_TRIGGER),
      eq(schema.feedback.runId, rid),
    ));
    if (fbRows[0]) return false;
    const snooze = await db.select().from(schema.feedbackPromptState).where(and(
      eq(schema.feedbackPromptState.userId, userId),
      eq(schema.feedbackPromptState.trigger, REPEATABLE_TRIGGER),
      eq(schema.feedbackPromptState.runId, rid),
      eq(schema.feedbackPromptState.status, 'ask_later'),
      gt(schema.feedbackPromptState.snoozeUntil, now),
    ));
    return !snooze[0];
  }

  return false; // unknown trigger — don't show
}

export async function dismissPrompt(
  db: Db, userId: string, trigger: string, runId: string | null, mode: string
): Promise<void> {
  let stateRunId: string;
  let snoozeUntil: string | null;
  if (mode === 'dont_ask') {
    stateRunId = '';
    snoozeUntil = null;
  } else { // 'ask_later' — mode already validated by the route
    stateRunId = ONE_TIME_TRIGGERS.includes(trigger) ? '' : (runId ?? '');
    snoozeUntil = new Date(Date.now() + snoozeHours() * 3_600_000)
      .toISOString().replace('T', ' ').replace('Z', '');
  }
  await upsertPromptState(db, { userId, trigger, runId: stateRunId, status: mode, snoozeUntil });
}
```

- [ ] **Step 3: Routes.**

`app/api/feedback/route.ts`:

```ts
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { pyList } from '@/lib/server/serialize';
import { ONE_TIME_TRIGGERS, VALID_CATEGORIES, upsertPromptState } from '@/lib/server/feedbackPrompts';

export const POST = withApi('/api/feedback', async (req, ctx) => {
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new ApiError(422, 'validation error: invalid body');
  const category = String(raw.category ?? '').toLowerCase().trim();
  if (!VALID_CATEGORIES.includes(category)) {
    throw new ApiError(422, `category must be one of ${pyList(VALID_CATEGORIES)}`);
  }
  const body = typeof raw.body === 'string' ? raw.body : '';
  if (!body || !body.trim()) throw new ApiError(422, 'body must be a non-empty string');
  const trigger = typeof raw.trigger === 'string' && raw.trigger ? raw.trigger.toLowerCase().trim() : null;
  const runId = typeof raw.run_id === 'string' && raw.run_id.trim() ? raw.run_id.trim() : null;
  if (trigger === 'post-recs' && !runId) {
    throw new ApiError(422, "run_id is required when trigger='post-recs'");
  }
  const db = getDb();
  await db.insert(schema.feedback).values({
    userId: ctx.user.userId, category, body, trigger, runId,
    page: typeof raw.page === 'string' ? raw.page : null,
    appVersion: typeof raw.app_version === 'string' ? raw.app_version : null,
  });
  if (trigger && ONE_TIME_TRIGGERS.includes(trigger)) {
    await upsertPromptState(db, { userId: ctx.user.userId, trigger, runId: '', status: 'submitted' });
  }
  ctx.timer.mark('db');
  return Response.json({}, { status: 201 });
});
```

`app/api/feedback/prompt/route.ts`:

```ts
export const GET = withApi('/api/feedback/prompt', async (req, ctx) => {
  const sp = new URL(req.url).searchParams;
  const trigger = sp.get('trigger');
  if (trigger === null) throw new ApiError(422, 'validation error: trigger is required');
  const triggerNorm = trigger.toLowerCase().trim();
  const runIdRaw = sp.get('run_id');
  const runIdNorm = runIdRaw && runIdRaw.trim() ? runIdRaw.trim() : null;
  if (triggerNorm === 'post-recs' && !runIdNorm) {
    throw new ApiError(422, "run_id is required when trigger='post-recs'");
  }
  const show = await checkPromptEligibility(getDb(), ctx.user.userId, triggerNorm, runIdNorm);
  ctx.timer.mark('db');
  return Response.json({ show });
});
```

`app/api/feedback/dismiss/route.ts`:

```ts
export const POST = withApi('/api/feedback/dismiss', async (req, ctx) => {
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const mode = typeof raw?.mode === 'string' ? raw.mode : '';
  if (mode !== 'ask_later' && mode !== 'dont_ask') {
    throw new ApiError(422, "mode must be 'ask_later' or 'dont_ask'");
  }
  const trigger = String(raw?.trigger ?? '').toLowerCase().trim();
  const runIdRaw = raw?.run_id;
  const runIdNorm = typeof runIdRaw === 'string' && runIdRaw.trim() ? runIdRaw.trim() : null;
  if (trigger === 'post-recs' && mode === 'ask_later' && !runIdNorm) {
    throw new ApiError(422, "run_id is required when trigger='post-recs' and mode='ask_later'");
  }
  await dismissPrompt(getDb(), ctx.user.userId, trigger, runIdNorm, mode);
  ctx.timer.mark('db');
  return new Response(null, { status: 204 });
});
```

`app/api/taste-signal/route.ts`:

```ts
const Body = z.object({
  direction: z.enum(['more', 'less']),   // Pydantic Literal → schema-level 422 (string-detail deviation)
  target_kind: z.enum(['book', 'rec']),
  target_book_id: z.number().int().nullish(),
  snapshot: z.record(z.string(), z.unknown()).nullish(),
});

export const POST = withApi('/api/taste-signal', async (req, ctx) => {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError(422, `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`);
  }
  const b = parsed.data;
  const db = getDb();

  if (b.target_kind === 'book') {
    if (b.target_book_id == null) {
      throw new ApiError(422, 'target_book_id is required for book-kind signals');
    }
    const rows = await db.select().from(schema.books)
      .where(and(eq(schema.books.id, b.target_book_id), eq(schema.books.userId, ctx.user.userId)));
    // NOTE: no trailing period — this 404 comes from record_taste_signal, unlike library.py's.
    if (!rows[0]) throw new ApiError(404, `Book ${b.target_book_id} not found`);
  } else if (b.target_kind === 'rec') {
    // Python `if not snapshot` — empty object is falsy too.
    if (!b.snapshot || Object.keys(b.snapshot).length === 0) {
      throw new ApiError(422, 'snapshot is required for rec-kind signals');
    }
  }

  const [signal] = await db.insert(schema.tasteSignal).values({
    userId: ctx.user.userId, direction: b.direction, targetKind: b.target_kind,
    targetBookId: b.target_book_id ?? null, snapshot: b.snapshot ?? null,
    createdAt: utcnowTs(),
  }).returning();

  const meta = await ensureProfileMeta(db, ctx.user.userId);
  await db.update(schema.profileMeta).set({ recFeedbackUpdatedAt: utcnowTs() })
    .where(eq(schema.profileMeta.id, meta.id));

  ctx.timer.mark('db');
  return Response.json({
    id: signal.id, direction: signal.direction, target_kind: signal.targetKind,
    target_book_id: signal.targetBookId, snapshot: signal.snapshot,
    created_at: tsToIso(signal.createdAt),
  }, { status: 201 });
});
```
- [ ] **Step 4: Verify pass** — the `feedback-flow` scenario is a genuine state machine (show → submit → hidden; dont_ask → hidden; per-run snooze → hidden for runB, still shown for runC). Full suites.
- [ ] **Step 5: Commit gate** — `feat(node): feedback prompts + taste signals`.

---

### Task 13: backend switcher flip

**Files:**
- Modify: `frontend/lib/backend.ts`, `frontend/lib/backend.test.ts` (jest)

**Interfaces:**
- Produces: `BackendRule` gains `exact?: boolean` (match `path === prefix` instead of `startsWith`). Needed because `POST /books` (wave 2, Node) and `POST /books/{id}/similar` (wave 3, still Python) share a prefix.

- [ ] **Step 1: Failing jest tests** (add to the existing `backend.test.ts` suites, same style):

```ts
// wave-2: writes flip to Node
expect(baseFor('/books', 'POST')).toBe('/api');
expect(baseFor('/books/12/feedback', 'PATCH')).toBe('/api');
expect(baseFor('/books/12/shelf', 'PATCH')).toBe('/api');
expect(baseFor('/books/12/enrichment', 'PATCH')).toBe('/api');
expect(baseFor('/books/12', 'DELETE')).toBe('/api');
expect(baseFor('/recommendations/3/feedback', 'PATCH')).toBe('/api');
expect(baseFor('/settings/api-key', 'PUT')).toBe('/api');
expect(baseFor('/settings/api-key', 'DELETE')).toBe('/api');
expect(baseFor('/settings/profile', 'PUT')).toBe('/api');
expect(baseFor('/directive', 'PUT')).toBe('/api');
expect(baseFor('/directive', 'DELETE')).toBe('/api');
expect(baseFor('/profile/traits/5', 'PATCH')).toBe('/api');
expect(baseFor('/feedback', 'POST')).toBe('/api');
expect(baseFor('/feedback/prompt', 'GET')).toBe('/api');
expect(baseFor('/feedback/dismiss', 'POST')).toBe('/api');
expect(baseFor('/taste-signal', 'POST')).toBe('/api');
// still Python:
expect(baseFor('/books/12/similar', 'POST')).toBe(PY);   // wave-3 Claude flow
expect(baseFor('/catalog/search?q=x', 'GET')).toBe(PY);  // wave-3 catalog cache
expect(baseFor('/directive/draft', 'POST')).toBe(PY);    // wave-3 distill
expect(baseFor('/profile', 'POST')).toBe(PY);            // profile build
expect(baseFor('/library', 'DELETE')).toBe(PY);          // wave-4 purge
expect(baseFor('/account', 'DELETE')).toBe(PY);
```

(`PY` = whatever the existing tests call the python base constant.)

- [ ] **Step 2: Implement** — in `backend.ts`:

```ts
export interface BackendRule {
  prefix: string;
  /** When set, only these methods route to Node; otherwise all methods do. */
  methods?: string[];
  /** When true, the path must equal prefix exactly (no sub-paths). */
  exact?: boolean;
}

export const NODE_DEFAULT_ROUTES: BackendRule[] = [
  { prefix: '/stats' },
  { prefix: '/books', methods: ['GET', 'PATCH', 'DELETE'] },
  { prefix: '/books', methods: ['POST'], exact: true }, // POST /books/{id}/similar stays Python (wave 3)
  { prefix: '/profile', methods: ['GET', 'PATCH'] },
  { prefix: '/recommendations', methods: ['GET', 'PATCH'] },
  { prefix: '/settings', methods: ['GET', 'PUT', 'DELETE'] },
  { prefix: '/directive', methods: ['GET', 'PUT', 'DELETE'], exact: true }, // POST /directive/draft stays Python
  { prefix: '/feedback' },
  { prefix: '/taste-signal' },
];
```

and in `baseFor`, the rule match becomes:

```ts
      NODE_DEFAULT_ROUTES.some((r) => {
        const pathOnly = path.split('?')[0];
        const matches = r.exact ? pathOnly === r.prefix : path.startsWith(r.prefix);
        return matches && (!r.methods || r.methods.includes(m));
      })
```

Wait — `/directive` with `exact: true` and methods GET/PUT/DELETE: `GET /directive` matched before via prefix; keep GET working (it's exact anyway). `POST /directive/draft` has method POST — excluded by the methods list even without `exact`; the `exact` flag is belt-and-braces. For `/feedback`: `POST /feedback`, `GET /feedback/prompt`, `POST /feedback/dismiss` all live under it and all are Node — plain prefix rule is right.

Careful with `path.split('?')` — `baseFor` receives paths that may carry query strings (`/catalog/search?q=x`); apply the split for BOTH exact and prefix matching consistently (`pathOnly.startsWith(...)`).

- [ ] **Step 3: Run jest** → PASS; also `npx tsc --noEmit`, lint.
- [ ] **Step 4: Frontend call-site sanity** — every `lib/api.ts` helper already passes its method into `baseFor` (wave 1). Verify no OTHER call site bypasses it: `grep -rn "NEXT_PUBLIC_API_URL\|pythonBase()" frontend/app frontend/components frontend/lib --include='*.ts*' | grep -v backend.ts` — investigate any hit that builds a URL without `baseFor`.
- [ ] **Step 5: Commit gate** — `feat(node): flip wave-2 writes to Node in auto mode`.

---

### Task 14: full verification

Follow the same sequence as wave 1 (`docs/superpowers/plans/wave-1-verification.md` is the template). Record everything in `docs/superpowers/plans/wave-2-verification.md`.

- [ ] **Step 1: All suites**

```bash
cd frontend && npx jest && npm run test:server && npm run type-check && npm run lint
cd .. && python -m pytest   # must stay at the wave-1 count — Python code untouched except scripts/
```

- [ ] **Step 2: Local isolated side-by-side.** Use `.claude/skills/isolated-local-env/SKILL.md` exactly (empty-string exports incl. `REDIS_URL=`; verify with the `get_settings()` one-liner BEFORE anything else). Python on `:8010` with a throwaway SQLite seed; Node dev server on `:3000` in local-admin mode (same env shape as wave 1 — `DATABASE_URL`/`ENCRYPTION_KEY` come from `.env.local`, never read them). Exercise each wave-2 write on both backends with curl and compare status + shape: add a book (and a duplicate → 409), rate/review it, move shelf, correct an enrichment, delete it, swipe a rec (accept + reject with reasons), set/clear api key, set display name, set/clear directive, confirm a trait, submit feedback, dismiss a prompt, post a taste signal. Zero 500s; identical error strings on the deterministic 422/404/409s.
- [ ] **Step 3: Browser walk (mandatory — tests alone don't count).** On `/admin` → System tab force `node`, then walk the real flows in the UI: add a book via the picker (search still hits Python — expected; the create must hit `/api/books`, verify in the network tab), rate + review a book, favorite it, move its shelf, delete it, swipe recommendations (accept/reject incl. reject reasons), edit custom instructions on `/profile`, confirm/reject a trait, change display name + API key in `/settings`, submit feedback from the modal. Then force `python` and spot-check the same flows still work; then `auto` and confirm the network tab shows wave-2 writes on `/api/*` and wave-3+ calls (recommend, profile build, catalog search) still on Railway. Zero console errors.
- [ ] **Step 4: Push + preview.** Push `feat/node-backend` (push is authorized as part of this plan; commits still gated per session rules). Confirm the Vercel build is READY.
- [ ] **Step 5 (CHASE-gated): live preview checks + benchmark.** Same SSO constraint as waves 0–1 unless shelfsprite.app is attached by then (see the spec's rebrand section — a custom domain bypasses Vercel SSO). Benchmark: writes are excluded from the benchmark harness by design (they mutate state); benchmark only the wave-1 read set again post-flip to confirm no regression, per `scripts/benchmark.mjs` usage in `docs/benchmarks.md`.
- [ ] **Step 6: Write `wave-2-verification.md`** — same structure as wave 1's record: what ran, what was found, what's left for Chase.

---

## Self-review (spec coverage)

- Spec wave-2 row: rate/review (`/books/{id}/feedback` — Task 6), shelf (Task 6), favorite/exclude (fields of Task 6), add book (Task 5), rec feedback (Task 8), enrichment correction (Task 7), directive set/clear (Task 10), remove book (Task 7), settings writes incl. key encryption (Task 9). ✔
- Spec-gap additions folded in: trait verdicts (Task 11), beta-feedback trio (Task 12), taste signals (Task 12) — simple writes with no other home. ✔
- `/catalog/search` decision documented (stays Python until wave 3). ✔
- Wave-1 conventions carried: string-422 deviation, empty-env-is-unset, lexicographic same-format timestamp compares, tenant-scoping guard rows in every scenario, no schema changes, Alembic authority untouched. ✔
- Known deliberate simplifications (document in verification record if a reviewer asks): DELETE api-key may create a row where Python doesn't (Task 9 note); rec-feedback set-repr 422 masked (Global Constraints #3); timestamps ms vs µs.

## Deferrals

- Catalog cache + `/catalog/search` port, all Claude flows (profile build/update, archetype POST, reveal-lines, directive draft, recommend/similar/discover) → **wave 3**.
- Enrichment jobs, ingest/import/export, purge routes (`/library`, `/profile` DELETE, `/account`) → **wave 4**.
- Admin routes; cutover (incl. ShelfSprite rename per the spec's rebrand section) → **wave 5**.
