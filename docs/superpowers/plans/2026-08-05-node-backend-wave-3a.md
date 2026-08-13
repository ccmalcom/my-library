# Node Backend Migration — Wave 3a (Catalog + Claude Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the catalog HTTP client with its Postgres cache, ship `GET /catalog/search`, and port the three single-call Claude flows (directive distill, archetype, reveal lines) — establishing the Claude-call testing architecture that waves 3b and 3c reuse.

**Architecture:** Wave 3 is split into three plans (see "Why wave 3 is split" below); this is 3a. Two new foundations land here. First, `lib/server/catalog.ts` — a port of `mylibrary/catalog.py`'s fetch layer whose disk cache becomes the `catalog_cache` Postgres table (created back in wave 0). Second, `lib/server/claude.ts` — key resolution plus a client factory, paired with a **prompt-parity** test harness: because Claude's output is nondeterministic, parity is proven by asserting the Node-built prompt, system string, tool schema, model, and max_tokens are byte-identical to Python's for the same DB state, then replaying a recorded tool_use response through both sides to prove identical persistence and HTTP output.

**Tech Stack:** Next.js 15 route handlers, Drizzle ORM, `@anthropic-ai/sdk`, zod v4, vitest + PGlite, `undici`/global `fetch` with a recorded-response replay layer.

## Global Constraints

- **Parity is the acceptance bar** for everything deterministic: status codes, `{"detail": "..."}` error strings, JSON body shapes, persisted rows. Reproduce Python quirks; do not "fix" them.
- **Claude output is NOT deterministic** and is explicitly out of parity scope. What IS in scope and must match byte-for-byte: the prompt string, the `system` string, the tool JSON schema, `tool_choice`, `model`, `max_tokens`, the message-block structure (including `cache_control` placement), and everything the handler does with a given response.
- **No live Anthropic spend in tests, ever.** Every Claude call in tests goes through an injected fake client. A test that would issue a real API call is a plan violation.
- **No live catalog HTTP in tests.** All Open Library / Google Books responses are replayed from checked-in fixtures.
- Carried from waves 1–2: schema-level 422s return a **string** `detail` (documented deviation); timestamps are ms precision; empty-string env vars count as unset **except** `ANTHROPIC_API_KEY` for the api-key *status* route (see Task 4's note — status and resolve deliberately disagree, and both behaviors are Python's).
- **Never read, print, or store values from `.env` / `.env.local`** — key names only.
- **Never run `git commit` unless Chase has explicitly authorized commits for this session.** Commit steps mean: stage, print the message, STOP and ask. No `Co-Authored-By` trailer ever.
- **Never claim a change works from tests alone** — Task 10 requires exercising the real app.
- Alembic remains the only migration authority. **Wave 3a adds no schema changes** — `catalog_cache` already exists from wave 0's migration `0018_node_wave0_tables`.
- Python reference files: `mylibrary/catalog.py`, `directive.py`, `archetype.py`, `reveal.py`, `user_settings.py`, `usage.py`, `api.py`. **When this plan and the Python source disagree, the Python source wins.**

## Why wave 3 is split (read this before starting)

The spec's wave 3 row bundles "profile build/update, archetype + reveal, directive distill, two-stage recommender, discover/similar; catalog cache goes live." That is far larger than waves 1 and 2 combined: `recommend.py` alone is 1,887 lines with a 14-step retrieval pipeline, six distinct Claude call sites, and ~30 pure helper functions that each need their own parity tests. A single plan covering it would be unreviewable and would drift during execution.

The split, in dependency order:

| Plan | Contents | Depends on |
|---|---|---|
| **3a (this plan)** | Catalog client + Postgres cache, `GET /catalog/search`, Claude key resolution + client factory + prompt-parity harness, `POST /directive/draft`, `POST /profile/archetype`, `POST /profile/reveal-lines` | wave 2 |
| **3b** | `POST /profile`, `POST /profile/update` — tier building, feedback context, rejected-claim overlap filtering, full-vs-incremental branching | 3a's Claude foundation |
| **3c** | `POST /recommend`, `POST /books/{id}/similar`, `POST /discover` — Stage-1 retrieval, assembly/capping/filtering, Stage-2 rerank | 3a's catalog + Claude foundation |

Each produces working, shippable software on its own. The spec's wave numbering is unchanged otherwise: waves 4 (jobs + imports) and 5 (admin + cutover) follow 3c. Update the spec's wave table when this plan is accepted.

## Scope

**In:** `GET /catalog/search`, `POST /directive/draft`, `POST /profile/archetype`, `POST /profile/reveal-lines`, plus the `lib/server/catalog.ts` and `lib/server/claude.ts` foundations.

**Out:** `POST /profile`, `POST /profile/update` → 3b. `POST /recommend`, `POST /books/{id}/similar`, `POST /discover` → 3c. Enrichment jobs, imports/exports, purge → wave 4. Admin → wave 5.

**Note on `/catalog/search`:** wave 2 deliberately left this on Python so the add-book flow worked mixed-backend. It flips to Node here, completing that flow end-to-end on Node.

## File Structure

```
frontend/lib/server/
  catalog.ts              CREATE — fetch layer, Postgres cache, normalizers, search_books port
  catalogCache.ts         CREATE — get/put against catalog_cache (negative caching included)
  claude.ts               CREATE — resolveAnthropicKey, makeAnthropicClient, ClaudeClient type
  claudeErrors.ts         CREATE — NO_KEY_MESSAGE constants (exact Python strings)
  directiveDistill.ts     CREATE — prompt builder + tool schema + response mapping
  archetypeDerive.ts      CREATE — prompt builder + tool schema + scoring/upsert
  revealLines.ts          CREATE — prompt builder + few-shots + tool schema + persistence
  archetype.ts            MODIFY — export AXES ordering for the derive path (wave 1 has the read side)
frontend/app/api/
  catalog/search/route.ts       CREATE — GET, rate-limited 30/min
  directive/draft/route.ts      CREATE — POST
  profile/archetype/route.ts    MODIFY — add POST (wave 1 has GET)
  profile/reveal-lines/route.ts CREATE — POST
frontend/lib/server/__tests__/
  helpers/httpReplay.ts         CREATE — fetch stub driven by recorded fixtures
  helpers/fakeClaude.ts         CREATE — injectable client returning recorded responses
  fixtures/catalog/*.json       GENERATED (checked in) — recorded OL/GB responses
  fixtures/claude/prompts.json  GENERATED (checked in) — Python-built prompts per scenario
  fixtures/claude/responses.json GENERATED (checked in) — recorded Claude tool_use payloads
  catalog-cache.test.ts         CREATE
  catalog-search.test.ts        CREATE
  parity-prompts.test.ts        CREATE — the byte-identical prompt assertions
  parity-claude-flows.test.ts   CREATE — stubbed-response behavior parity
scripts/
  gen_catalog_fixtures.py       CREATE — records real OL/GB HTTP responses
  gen_claude_fixtures.py        CREATE — records Python prompts + real Claude responses
frontend/lib/backend.ts         MODIFY — flip the four wave-3a routes
frontend/lib/backend.test.ts    MODIFY — routing cases
```

---

### Task 1: catalog cache on Postgres

Python caches every catalog GET to `{data_dir}/cache/{sha1(url)}.json`, including a literal `"null"` file on a 404 (negative caching). The Node twin uses the `catalog_cache` table. **Keeping `sha1(url)` as the key** makes entries cross-checkable against Python's disk cache during migration.

**Files:**
- Create: `frontend/lib/server/catalogCache.ts`
- Test: `frontend/lib/server/__tests__/catalog-cache.test.ts`
- Modify: `frontend/lib/server/__tests__/helpers/pglite.ts` (add `catalog_cache` to `loadSeed`'s known tables — the table DDL already exists in `makeTestDb` from wave 0)

**Interfaces:**
- Produces: `cacheKeyFor(url: string): string` (sha1 hex); `cacheGet(db, url): Promise<{ hit: boolean; payload: unknown }>`; `cachePut(db, url, source, payload): Promise<void>`.
- The `hit`/`payload` split is load-bearing: a cached 404 is `{hit: true, payload: null}`, an uncached URL is `{hit: false, payload: null}`. Collapsing them would refetch every 404 forever.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { cacheKeyFor, cacheGet, cachePut } from '../catalogCache';

describe('catalog cache', () => {
  it('derives the same sha1 key Python uses', () => {
    // echo -n 'https://openlibrary.org/works/OL1W.json' | sha1sum
    expect(cacheKeyFor('https://openlibrary.org/works/OL1W.json')).toMatch(/^[0-9a-f]{40}$/);
    expect(cacheKeyFor('a')).toBe('86f7e437faa5a7fce15d1ddcb9eaeaea377667b8');
  });

  it('round-trips a payload', async () => {
    const { db, close } = await makeTestDb();
    try {
      expect(await cacheGet(db, 'https://x/1')).toEqual({ hit: false, payload: null });
      await cachePut(db, 'https://x/1', 'openlibrary', { docs: [1, 2] });
      expect(await cacheGet(db, 'https://x/1')).toEqual({ hit: true, payload: { docs: [1, 2] } });
    } finally { await close(); }
  });

  it('distinguishes a cached null (404) from a miss', async () => {
    const { db, close } = await makeTestDb();
    try {
      await cachePut(db, 'https://x/404', 'openlibrary', null);
      expect(await cacheGet(db, 'https://x/404')).toEqual({ hit: true, payload: null });
    } finally { await close(); }
  });

  it('re-putting the same url overwrites rather than erroring', async () => {
    const { db, close } = await makeTestDb();
    try {
      await cachePut(db, 'https://x/2', 'googlebooks', { a: 1 });
      await cachePut(db, 'https://x/2', 'googlebooks', { a: 2 });
      expect(await cacheGet(db, 'https://x/2')).toEqual({ hit: true, payload: { a: 2 } });
    } finally { await close(); }
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd frontend && npx vitest run lib/server/__tests__/catalog-cache.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `catalogCache.ts`**

```ts
/**
 * Catalog HTTP response cache on Postgres (catalog_cache, from wave 0's migration).
 * Replaces mylibrary/catalog.py's {data_dir}/cache/{sha1(url)}.json disk cache.
 * Key stays sha1(url) so entries are cross-checkable with the Python cache
 * during migration. Entries never expire — book metadata is stable (per spec).
 */
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from './db';

export function cacheKeyFor(url: string): string {
  return createHash('sha1').update(url, 'utf8').digest('hex');
}

export interface CacheLookup {
  /** True when a row exists — including a negatively-cached 404 (payload null). */
  hit: boolean;
  payload: unknown;
}

export async function cacheGet(db: Db, url: string): Promise<CacheLookup> {
  const rows = await db
    .select({ payload: schema.catalogCache.payload })
    .from(schema.catalogCache)
    .where(eq(schema.catalogCache.cacheKey, cacheKeyFor(url)));
  if (!rows.length) return { hit: false, payload: null };
  return { hit: true, payload: rows[0].payload ?? null };
}

export async function cachePut(
  db: Db, url: string, source: string, payload: unknown
): Promise<void> {
  const key = cacheKeyFor(url);
  // jsonb cannot store a bare SQL NULL and still mean "JSON null" — store the
  // JSON null literal so a 404 round-trips as {hit:true, payload:null}.
  await db.execute(sql`
    insert into catalog_cache (cache_key, source, payload, fetched_at)
    values (${key}, ${source}, ${JSON.stringify(payload ?? null)}::jsonb, now())
    on conflict (cache_key) do update
      set payload = excluded.payload, source = excluded.source, fetched_at = now()
  `);
}
```

If `schema.catalogCache.payload` is typed non-nullable by the introspected schema, the `?? null` still yields `null` at runtime for a JSON-null payload — verify by running the third test, which exists precisely to catch this.

- [ ] **Step 4: Run to verify pass**; then full `npm run test:server`.
- [ ] **Step 5: Commit gate** — stage; print `feat(node): catalog response cache on Postgres`; STOP unless commits authorized.

---

### Task 2: catalog fetch layer + normalizers

**Files:**
- Create: `frontend/lib/server/catalog.ts`
- Create: `frontend/lib/server/__tests__/helpers/httpReplay.ts`
- Test: `frontend/lib/server/__tests__/catalog-fetch.test.ts`

**Interfaces:**
- Produces: `getJson(db, url, source): Promise<unknown | null>`; `normLang(code: string | string[] | null): string | null`; `yearFromGoogle(published: string | null): number | null`; `isbn13FromGoogleItem(item): string | null`; `setRate(rps: number): void`.
- Produces (test helper): `installHttpReplay(fixtures: Record<string, {status: number, body?: unknown}>)` returning an uninstall fn; any URL not in the map throws loudly rather than hitting the network.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { installHttpReplay } from './helpers/httpReplay';
import { getJson, normLang, yearFromGoogle, isbn13FromGoogleItem } from '../catalog';

let uninstall: (() => void) | undefined;
afterEach(() => { uninstall?.(); uninstall = undefined; });

describe('catalog normalizers', () => {
  it('normLang maps MARC codes and arrays', () => {
    expect(normLang(['eng'])).toBe('en');
    expect(normLang('fre')).toBe('fr');
    expect(normLang('zho')).toBe('zh');
    expect(normLang('xyz')).toBe('xy');   // unknown → first two chars
    expect(normLang([])).toBe(null);
    expect(normLang(null)).toBe(null);
    expect(normLang('  ')).toBe(null);
  });
  it('yearFromGoogle takes the leading 4 chars', () => {
    expect(yearFromGoogle('2015-06-02')).toBe(2015);
    expect(yearFromGoogle('nonsense')).toBe(null);
    expect(yearFromGoogle(null)).toBe(null);
  });
  it('isbn13FromGoogleItem finds the ISBN_13 identifier', () => {
    expect(isbn13FromGoogleItem({ volumeInfo: { industryIdentifiers: [
      { type: 'ISBN_10', identifier: '0316246620' },
      { type: 'ISBN_13', identifier: '9780316246620' }] } })).toBe('9780316246620');
    expect(isbn13FromGoogleItem({})).toBe(null);
  });
});

describe('getJson', () => {
  it('caches a success and serves the second call from cache', async () => {
    const { db, close } = await makeTestDb();
    let calls = 0;
    uninstall = installHttpReplay({ 'https://x/ok': { status: 200, body: { a: 1 } } }, () => { calls++; });
    try {
      expect(await getJson(db, 'https://x/ok', 'openlibrary')).toEqual({ a: 1 });
      expect(await getJson(db, 'https://x/ok', 'openlibrary')).toEqual({ a: 1 });
      expect(calls).toBe(1); // second call served from Postgres
    } finally { await close(); }
  });

  it('negatively caches a 404 and does not refetch', async () => {
    const { db, close } = await makeTestDb();
    let calls = 0;
    uninstall = installHttpReplay({ 'https://x/missing': { status: 404 } }, () => { calls++; });
    try {
      expect(await getJson(db, 'https://x/missing', 'openlibrary')).toBe(null);
      expect(await getJson(db, 'https://x/missing', 'openlibrary')).toBe(null);
      expect(calls).toBe(1);
    } finally { await close(); }
  });

  it('retries a 503 once then gives up without caching', async () => {
    const { db, close } = await makeTestDb();
    let calls = 0;
    uninstall = installHttpReplay({ 'https://x/down': { status: 503 } }, () => { calls++; });
    try {
      expect(await getJson(db, 'https://x/down', 'openlibrary')).toBe(null);
      expect(calls).toBe(2); // _MAX_RETRIES = 2 total attempts
      expect(await getJson(db, 'https://x/down', 'openlibrary')).toBe(null);
      expect(calls).toBe(4); // never cached, so it tries again
    } finally { await close(); }
  });
});
```

- [ ] **Step 2: Write `helpers/httpReplay.ts`**

```ts
import { vi } from 'vitest';

export interface ReplayEntry { status: number; body?: unknown; headers?: Record<string, string>; }

/**
 * Replace global fetch with a fixture-driven stub. Any URL not present in the
 * map throws — a test must never reach the real network. onCall fires per
 * attempted fetch so tests can assert cache hits and retry counts.
 */
export function installHttpReplay(
  fixtures: Record<string, ReplayEntry>,
  onCall?: (url: string) => void
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    onCall?.(url);
    const entry = fixtures[url];
    if (!entry) throw new Error(`httpReplay: no fixture for ${url}`);
    return new Response(entry.body === undefined ? null : JSON.stringify(entry.body), {
      status: entry.status,
      headers: { 'content-type': 'application/json', ...(entry.headers ?? {}) },
    });
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}
```

- [ ] **Step 3: Verify failure** (module missing).

- [ ] **Step 4: Implement `catalog.ts`'s fetch layer** — port of `catalog.py:90-180`:

```ts
/**
 * Catalog client — port of mylibrary/catalog.py's fetch layer.
 * Differences from Python, both deliberate:
 *  - the disk cache becomes catalog_cache (Postgres), see catalogCache.ts;
 *  - throttling is per-invocation. Python's module-global monotonic gate is
 *    per-process; on Vercel each invocation is its own isolate, so cross-request
 *    spacing is not attempted. At invite-only single-user scale this matches
 *    Python's practical behavior (one process, one user at a time).
 */
import { cacheGet, cachePut } from './catalogCache';
import type { Db } from './db';

const USER_AGENT = 'MyLibrary/0.1 (personal book-analysis project)';
const MAX_RETRIES = 2;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const DEFAULT_REQ_PER_SEC = 8.0;

let lastCallAt = 0;
let throttleOverride: number | null = null;

/** Twin of catalog.set_rate — recommend() calls this in wave 3c. */
export function setRate(requestsPerSecond: number): void {
  throttleOverride = requestsPerSecond > 0 ? 1 / requestsPerSecond : 0;
}

function currentThrottle(): number {
  if (throttleOverride !== null) return throttleOverride;
  const rps = Number(process.env.MYLIBRARY_REQ_PER_SEC || '') || DEFAULT_REQ_PER_SEC;
  return rps > 0 ? 1 / rps : 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function throttle(): Promise<void> {
  const gap = currentThrottle() * 1000;
  const elapsed = Date.now() - lastCallAt;
  if (elapsed < gap) await sleep(gap - elapsed);
  lastCallAt = Date.now();
}

/** GET a JSON URL with Postgres cache + retry/backoff. Null on 404/failure. */
export async function getJson(db: Db, url: string, source: string): Promise<unknown | null> {
  const cached = await cacheGet(db, url);
  if (cached.hit) return cached.payload;

  let backoff = 1000;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    let resp: Response;
    try {
      resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    } catch {
      if (attempt === MAX_RETRIES) return null;
      await sleep(backoff); backoff *= 2;
      continue;
    }
    if (resp.status === 404) {
      await cachePut(db, url, source, null); // negative caching, same as Python
      return null;
    }
    if (RETRYABLE.has(resp.status)) {
      if (attempt === MAX_RETRIES) return null;
      const ra = resp.headers.get('Retry-After');
      const wait = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : backoff;
      await sleep(wait); backoff *= 2;
      continue;
    }
    let data: unknown;
    try { data = await resp.json(); } catch { return null; }
    await cachePut(db, url, source, data);
    return data;
  }
  return null;
}

const LANG_MAP: Record<string, string> = {
  eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de',
  ita: 'it', por: 'pt', rus: 'ru', jpn: 'ja', chi: 'zh', zho: 'zh',
  dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', pol: 'pl',
};

export function normLang(code: string | string[] | null | undefined): string | null {
  const raw = Array.isArray(code) ? (code.length ? code[0] : null) : code;
  if (!raw) return null;
  const c = String(raw).trim().toLowerCase();
  if (!c) return null;
  return LANG_MAP[c] ?? c.slice(0, 2);
}

export function yearFromGoogle(published: string | null | undefined): number | null {
  if (!published) return null;
  const n = parseInt(published.slice(0, 4), 10);
  return Number.isNaN(n) ? null : n;
}

export function isbn13FromGoogleItem(item: Record<string, any> | null): string | null {
  const ids = item?.volumeInfo?.industryIdentifiers ?? [];
  for (const id of ids) {
    if (id?.type === 'ISBN_13' && id?.identifier) return id.identifier;
  }
  return null;
}
```

Python's `int(published[:4])` raises only on `ValueError`; JS `parseInt('2015-06')` → 2015 and `parseInt('nons')` → NaN → null. Verify against the test's `'nonsense'` case: `parseInt('nons', 10)` is NaN. ✔

- [ ] **Step 5: Verify pass**; full `npm run test:server`.
- [ ] **Step 6: Commit gate** — `feat(node): catalog fetch layer with Postgres-backed cache`.

---

### Task 3: `search_books` port + `GET /catalog/search`

**Files:**
- Modify: `frontend/lib/server/catalog.ts` (add the source queries + search/dedup/rank)
- Create: `frontend/app/api/catalog/search/route.ts`
- Create: `scripts/gen_catalog_fixtures.py`
- Test: `frontend/lib/server/__tests__/catalog-search.test.ts`

**Interfaces:**
- Produces: `googleBooksQuery(db, q, maxResults)`, `openlibraryQuery(db, q, maxResults)`, `openlibraryTitle(db, title, maxResults)`, `searchBooks(db, query, maxResults): Promise<Candidate[]>`.
- `Candidate` = `{ source, resolved_id, title, author, subjects, description?, cover_url, year, isbn13?, language, raw }`.

- [ ] **Step 1: Record real catalog responses.** Create `scripts/gen_catalog_fixtures.py`:

```python
#!/usr/bin/env python3
"""Record real Open Library + Google Books responses for the Node catalog tests.

Run from the repo root:  python scripts/gen_catalog_fixtures.py

Isolation: uses a throwaway MYLIBRARY_DATA_DIR so the real disk cache is never
read or written. Records the URLs `search_books` issues for a fixed query set,
writing {url: {status, body}} for the Node httpReplay helper.
"""
from __future__ import annotations
import json, os, sys, tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["DATABASE_URL"] = ""
os.environ["SUPABASE_URL"] = ""
os.environ["SUPABASE_JWKS_URL"] = ""
os.environ["SUPABASE_JWT_SECRET"] = ""
os.environ["REDIS_URL"] = ""
os.environ["MYLIBRARY_DATA_DIR"] = tempfile.mkdtemp(prefix="catalog-fixtures-")

import httpx  # noqa: E402
from mylibrary import catalog  # noqa: E402

QUERIES = ["dune", "ancillary justice", "9780316246620"]
OUT = Path("frontend/lib/server/__tests__/fixtures/catalog")

recorded: dict[str, dict] = {}
_orig_get = httpx.get

def _spy(url, **kw):
    resp = _orig_get(url, **kw)
    try:
        body = resp.json()
    except Exception:
        body = None
    recorded[str(url)] = {"status": resp.status_code, "body": body}
    return resp

httpx.get = _spy

results = {}
for q in QUERIES:
    results[q] = catalog.search_books(q, max_results=8)

OUT.mkdir(parents=True, exist_ok=True)
(OUT / "http.json").write_text(json.dumps(recorded, indent=1))
(OUT / "expected.json").write_text(json.dumps(results, indent=1))
print(f"recorded {len(recorded)} URLs for {len(QUERIES)} queries -> {OUT}")
```

Run it: `python scripts/gen_catalog_fixtures.py`. This makes real network calls (that's the point — it's the recording step), but writes nothing to the real cache dir.

- [ ] **Step 2: Write the failing parity test** — replay the recorded HTTP and assert Node's `searchBooks` output equals Python's recorded `expected.json` for each query:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import http from './fixtures/catalog/http.json';
import expected from './fixtures/catalog/expected.json';
import { makeTestDb } from './helpers/pglite';
import { installHttpReplay } from './helpers/httpReplay';
import { searchBooks } from '../catalog';

let uninstall: (() => void) | undefined;
afterEach(() => { uninstall?.(); uninstall = undefined; });

describe('searchBooks parity', () => {
  for (const query of Object.keys(expected as Record<string, unknown>)) {
    it(`matches Python for "${query}"`, async () => {
      const { db, close } = await makeTestDb();
      uninstall = installHttpReplay(http as any);
      try {
        const got = await searchBooks(db, query, 8);
        // `raw` is the untouched upstream payload — identical by construction,
        // and enormous; compare the normalized fields the API actually returns.
        const strip = (c: any) => ({ ...c, raw: undefined });
        expect(got.map(strip)).toEqual((expected as any)[query].map(strip));
      } finally { await close(); }
    });
  }
});
```

- [ ] **Step 3: Verify failure**.

- [ ] **Step 4: Implement the query + search functions** in `catalog.ts` — ports of `catalog.py:254-300, 336-363, 512-614`:

```ts
export interface Candidate {
  source: string; resolved_id: string | null; title: string | null;
  author: string | null; subjects: string[]; description?: string | null;
  cover_url: string | null; year: number | null; isbn13?: string | null;
  language: string | null; raw: unknown;
}

const SEARCH_FETCH = 25;

export async function googleBooksQuery(db: Db, q: string, maxResults = 5): Promise<Candidate[]> {
  const capped = Math.max(1, Math.min(maxResults, 40)); // Google caps at 40
  const params = new URLSearchParams({ q, maxResults: String(capped) });
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (key) params.set('key', key);
  const url = `https://www.googleapis.com/books/v1/volumes?${params}`;
  const data = (await getJson(db, url, 'googlebooks')) as any;
  if (!data) return [];
  return (data.items ?? []).slice(0, capped).map((item: any) => {
    const info = item.volumeInfo ?? {};
    return {
      source: 'googlebooks',
      resolved_id: item.id ?? null,
      title: info.title ?? null,
      author: (info.authors ?? [null])[0] ?? null,
      subjects: info.categories ?? [],
      description: info.description ?? null,
      cover_url: (info.imageLinks ?? {}).thumbnail ?? null,
      year: yearFromGoogle(info.publishedDate),
      language: normLang(info.language),
      raw: item,
    };
  });
}

const OL_FIELDS = 'key,title,author_name,first_publish_year,cover_i,isbn,subject,language';

function olDocToCandidate(doc: any): Candidate {
  const coverId = doc.cover_i;
  const isbns: string[] = doc.isbn ?? [];
  return {
    source: 'openlibrary',
    resolved_id: doc.key ?? null,
    title: doc.title ?? null,
    author: (doc.author_name ?? [null])[0] ?? null,
    subjects: (doc.subject ?? []).slice(0, 25),
    cover_url: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : null,
    year: doc.first_publish_year ?? null,
    isbn13: isbns.find((i) => i.length === 13 && /^\d+$/.test(i)) ?? null,
    language: normLang(doc.language),
    raw: doc,
  };
}

export async function openlibraryQuery(db: Db, query: string, maxResults = 8): Promise<Candidate[]> {
  const q = (query ?? '').trim();
  if (!q) return [];
  const params = new URLSearchParams({ q, limit: String(maxResults), fields: OL_FIELDS });
  const data = (await getJson(db, `https://openlibrary.org/search.json?${params}`, 'openlibrary')) as any;
  if (!data) return [];
  return (data.docs ?? []).slice(0, maxResults).map(olDocToCandidate);
}

export async function openlibraryTitle(db: Db, title: string, maxResults = 20): Promise<Candidate[]> {
  const t = (title ?? '').trim();
  if (!t) return [];
  const params = new URLSearchParams({ title: t, limit: String(maxResults), fields: OL_FIELDS });
  const data = (await getJson(db, `https://openlibrary.org/search.json?${params}`, 'openlibrary')) as any;
  if (!data) return [];
  return (data.docs ?? []).slice(0, maxResults).map(olDocToCandidate);
}
```

**Critical ordering note:** Python's `URLSearchParams` equivalent (`httpx.QueryParams`) serializes in insertion order and percent-encodes with `%20` for spaces. JS `URLSearchParams` encodes spaces as `+`. **These produce different URLs, which means different cache keys AND different fixture lookups.** Compare a recorded URL from `http.json` against what Node builds; if they differ, normalize by building the query string manually:

```ts
const enc = (s: string) => encodeURIComponent(s); // %20 for spaces, matches httpx
const qs = `q=${enc(q)}&limit=${maxResults}&fields=${enc(OL_FIELDS)}`;
```

Verify this explicitly — it is the single most likely source of "no fixture for URL" failures in Step 5.

Now the search/dedup/rank helpers — ports of `catalog.py:436-506, 556-614`:

```ts
function normFull(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function searchDedupKey(title: string | null, author: string | null): string {
  const surname = author ? normFull(author).split(' ').slice(-1)[0] : '';
  return `${normFull(title)} ${surname}`;
}

function matchScore(query: string, cand: Candidate): number {
  const q = normFull(query);
  const title = normFull(cand.title);
  const author = normFull(cand.author);
  if (!q || !title) return 0;
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  const qTokens = new Set(q.split(' ').filter(Boolean));
  const tTokens = new Set(title.split(' ').filter(Boolean));
  if (qTokens.size && [...qTokens].every((t) => tTokens.has(t))) return 60;
  if (title.includes(q)) return 40;
  if (author && author.includes(q)) return 20;
  return 0;
}

function volumeNumber(title: string | null): number | null {
  if (!title) return null;
  const m = title.toLowerCase().match(/(?:#|book|vol\.?|volume)\s*(\d{1,3})/);
  return m ? parseInt(m[1], 10) : null;
}

function applySeriesGrouping(query: string, ranked: Candidate[]): Candidate[] {
  const q = normFull(query);
  if (!q) return ranked;
  const idx = ranked.map((c, i) => [i, c] as const)
    .filter(([, c]) => normFull(c.title).startsWith(q)).map(([i]) => i);
  if (idx.length < 3) return ranked;
  const cluster = idx.map((i) => ranked[i]);
  cluster.sort((a, b) => {
    const va = volumeNumber(a.title) ?? 1e6, vb = volumeNumber(b.title) ?? 1e6;
    if (va !== vb) return va - vb;
    return normFull(a.title) < normFull(b.title) ? -1 : normFull(a.title) > normFull(b.title) ? 1 : 0;
  });
  const anchor = idx[0];
  const inCluster = new Set(idx);
  const rest = ranked.filter((_, i) => !inCluster.has(i));
  return [...rest.slice(0, anchor), ...cluster, ...rest.slice(anchor)];
}

function mergeInto(keep: Candidate, extra: Candidate): void {
  for (const f of ['cover_url', 'isbn13', 'author', 'description', 'year'] as const) {
    if (!(keep as any)[f] && (extra as any)[f]) (keep as any)[f] = (extra as any)[f];
  }
  if (!keep.subjects?.length && extra.subjects?.length) keep.subjects = extra.subjects;
}

export async function searchBooks(db: Db, query: string, maxResults = 8): Promise<Candidate[]> {
  const q = (query ?? '').trim();
  if (!q) return [];

  const results: Candidate[] = [];
  for (const c of await googleBooksQuery(db, q, SEARCH_FETCH)) {
    c.isbn13 = isbn13FromGoogleItem(c.raw as any); results.push(c);
  }
  results.push(...(await openlibraryQuery(db, q, SEARCH_FETCH)));
  for (const c of await googleBooksQuery(db, `intitle:"${q}"`, SEARCH_FETCH)) {
    c.isbn13 = isbn13FromGoogleItem(c.raw as any); results.push(c);
  }
  results.push(...(await openlibraryTitle(db, q, SEARCH_FETCH)));

  const byKey = new Map<string, Candidate>();
  const byIsbn = new Map<string, Candidate>();
  const deduped: Candidate[] = [];
  for (const cand of results) {
    if (!cand.title) continue;
    const isbn = cand.isbn13;
    if (isbn && byIsbn.has(isbn)) { mergeInto(byIsbn.get(isbn)!, cand); continue; }
    const key = searchDedupKey(cand.title, cand.author);
    if (byKey.has(key)) { mergeInto(byKey.get(key)!, cand); continue; }
    byKey.set(key, cand);
    if (isbn) byIsbn.set(isbn, cand);
    deduped.push(cand);
  }

  // Python sorts by the tuple (match, hasCover, hasIsbn, year) DESCENDING.
  // Python's sort is STABLE, so equal keys keep insertion order — Array.sort is
  // also stable in modern V8, so returning 0 for ties reproduces it exactly.
  deduped.sort((a, b) => {
    const ka = [matchScore(query, a), a.cover_url ? 1 : 0, a.isbn13 ? 1 : 0, a.year ?? 0];
    const kb = [matchScore(query, b), b.cover_url ? 1 : 0, b.isbn13 ? 1 : 0, b.year ?? 0];
    for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return 0;
  });
  return applySeriesGrouping(query, deduped).slice(0, maxResults);
}
```

- [ ] **Step 5: The route** (`app/api/catalog/search/route.ts`) — port of `api.py:677-700` including the 30/min limit:

```ts
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { searchBooks } from '@/lib/server/catalog';
import { checkRateLimit, RATE_LIMITS } from '@/lib/server/ratelimit';

const Query = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

export const GET = withApi('/api/catalog/search', async (req, ctx) => {
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    throw new ApiError(422, `validation error: ${parsed.error.issues[0]?.message ?? 'invalid query'}`);
  }
  const db = getDb();
  const rl = await checkRateLimit(db, {
    key: `catalog_search:${ctx.user.userId}`, ...RATE_LIMITS.catalogSearch,
  });
  if (!rl.allowed) {
    // SlowAPI's shape: 429 with a Retry-After header.
    return new Response(JSON.stringify({ detail: 'Rate limit exceeded: 30 per 1 minute' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': String(rl.retryAfterSeconds) },
    });
  }
  const hits = await searchBooks(db, parsed.data.q, parsed.data.limit);
  ctx.timer.mark('catalog');
  return Response.json(
    hits.filter((h) => h.title).map((h) => ({
      source: h.source ?? 'unknown',
      catalog_id: h.resolved_id ?? null,
      title: h.title ?? '',
      author: h.author ?? null,
      year: h.year ?? null,
      isbn13: h.isbn13 ?? null,
      cover_url: h.cover_url ?? null,
      subjects: h.subjects ?? null,
      description: h.description ?? null,
    }))
  );
});
```

Confirm SlowAPI's actual 429 body against the running Python backend before trusting the string above: `curl -s -o /dev/null -w '%{http_code}' ...` in a loop past 30, then inspect the body. If it differs, match it.

- [ ] **Step 6: Verify pass**; full suites; type-check; lint.
- [ ] **Step 7: Commit gate** — `feat(node): catalog search + GET /api/catalog/search`.

---

### Task 4: Claude key resolution + client factory

**Files:**
- Create: `frontend/lib/server/claude.ts`, `frontend/lib/server/claudeErrors.ts`
- Create: `frontend/lib/server/__tests__/helpers/fakeClaude.ts`
- Test: `frontend/lib/server/__tests__/claude-key.test.ts`

**Interfaces:**
- Produces: `resolveAnthropicKey(db, userId): Promise<string | null>`; `makeAnthropicClient(apiKey): ClaudeClient`; `type ClaudeClient = { messages: { create(params): Promise<ClaudeMessage> } }`; `toolInput(message, toolName): Record<string, unknown> | null`.
- Produces (test helper): `fakeClaude(responses)` — records every `create` call's params for prompt assertions and returns queued responses.

**The status-vs-resolve discrepancy (deliberate, both are Python's):** `anthropic_key_status` returns `configured: resolve_anthropic_key(...) is not None`, so an env var set to `""` reports **configured: true** (wave 1 ported this via `!== undefined`). But every Claude flow does `if not api_key: raise RuntimeError(...)`, so `""` **raises**. Node must reproduce both: `resolveAnthropicKey` returns `null` for an empty string, while the status route keeps its wave-1 `!== undefined` check. Do not "harmonize" them.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { resolveAnthropicKey } from '../claude';
import { encrypt } from '../crypto';

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
let saved: string | undefined;
beforeEach(() => { saved = process.env.ANTHROPIC_API_KEY; process.env.ENCRYPTION_KEY = KEY; });
afterEach(() => { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; });

describe('resolveAnthropicKey', () => {
  it('prefers the stored decrypted key', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, { user_settings: [
        { id: 1, user_id: 'local', anthropic_api_key_encrypted: encrypt('sk-ant-stored') }] });
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
      expect(await resolveAnthropicKey(db, 'local')).toBe('sk-ant-stored');
    } finally { await close(); }
  });

  it('falls back to the env key when no row is stored', async () => {
    const { db, close } = await makeTestDb();
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
      expect(await resolveAnthropicKey(db, 'local')).toBe('sk-ant-env');
    } finally { await close(); }
  });

  it('returns null for an empty env key (Python `if not api_key` semantics)', async () => {
    const { db, close } = await makeTestDb();
    try {
      process.env.ANTHROPIC_API_KEY = '';
      expect(await resolveAnthropicKey(db, 'local')).toBe(null);
    } finally { await close(); }
  });
});
```

- [ ] **Step 2: Verify failure.**

- [ ] **Step 3: Implement `claude.ts`:**

```ts
/**
 * Anthropic key resolution + client factory — twin of
 * mylibrary/user_settings.resolve_anthropic_key and the per-module
 * `Anthropic(api_key=...)` construction.
 *
 * NOTE: an env key set to "" resolves to null here (Python's `if not api_key`
 * raises), while GET /settings/api-key/status still reports configured:true for
 * the same value (Python's `is not None`). That inconsistency is Python's and is
 * reproduced on purpose — do not harmonize them.
 */
import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { schema, type Db } from './db';
import { decrypt } from './crypto';

export async function resolveAnthropicKey(db: Db, userId: string): Promise<string | null> {
  const rows = await db.select().from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId));
  const stored = rows[0]?.anthropicApiKeyEncrypted;
  if (stored) {
    try { return decrypt(stored); } catch { /* fall through to env, same as a decrypt failure surfacing later */ }
  }
  return process.env.ANTHROPIC_API_KEY || null;
}

export interface ClaudeMessage {
  content: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
  usage?: Record<string, number> | null;
}
export interface ClaudeClient {
  messages: { create(params: Record<string, unknown>): Promise<ClaudeMessage> };
}

export function makeAnthropicClient(apiKey: string): ClaudeClient {
  return new Anthropic({ apiKey }) as unknown as ClaudeClient;
}

/** First tool_use block's input, or null — twin of the Python `for block in message.content` loops. */
export function toolInput(message: ClaudeMessage, toolName: string): Record<string, unknown> | null {
  for (const block of message.content ?? []) {
    if (block.type === 'tool_use' && (!toolName || block.name === toolName)) {
      return block.input ?? {};
    }
  }
  return null;
}
```

Python's `decrypt` failure would propagate; here it falls through to env. Note it in the verification record as a deliberate deviation, or re-raise if you prefer strict parity — but be consistent and document whichever you pick.

- [ ] **Step 4: `helpers/fakeClaude.ts`:**

```ts
import type { ClaudeClient, ClaudeMessage } from '../../claude';

export interface RecordedCall { params: Record<string, unknown>; }

/** Injectable Claude client. Records every create() call for prompt-parity
 *  assertions and returns queued responses in order. Never touches the network. */
export function fakeClaude(responses: ClaudeMessage[]): ClaudeClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  return {
    calls,
    messages: {
      async create(params: Record<string, unknown>) {
        calls.push({ params });
        if (i >= responses.length) throw new Error(`fakeClaude: no queued response #${i}`);
        return responses[i++];
      },
    },
  };
}
```

- [ ] **Step 5: Verify pass**; full suites.
- [ ] **Step 6: Commit gate** — `feat(node): Anthropic key resolution + injectable client`.

---

### Task 5: prompt-parity fixture generator

The heart of this wave's testing story. Python emits, for each Claude flow and a fixed DB state, the exact `create()` kwargs it would send — plus a real recorded response — so Node can assert byte-identical prompts and replay identical responses.

**Files:**
- Create: `scripts/gen_claude_fixtures.py`
- Generated: `frontend/lib/server/__tests__/fixtures/claude/prompts.json`, `responses.json`

- [ ] **Step 1: Write the generator.** It reuses wave 2's isolation preamble and SEED (import them rather than duplicating — `from gen_parity_fixtures import SEED, load_seed` after the sys.path insert). It monkey-patches `tracked_create` to capture kwargs, then either records a real Claude response (when `--live` and a key is present) or writes a hand-authored one.

```python
#!/usr/bin/env python3
"""Record Python's exact Claude create() kwargs (+ responses) for Node prompt parity.

Run from the repo root:
    python scripts/gen_claude_fixtures.py            # captured prompts, canned responses
    python scripts/gen_claude_fixtures.py --live     # also record REAL Claude responses (costs money)

Isolation identical to gen_parity_fixtures.py: empty-string env overrides set
BEFORE importing mylibrary, throwaway SQLite, fixed ENCRYPTION_KEY.
"""
from __future__ import annotations
import json, os, sys, tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # for gen_parity_fixtures import

FIXED_TEST_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
os.environ["DATABASE_URL"] = ""
os.environ["SUPABASE_URL"] = ""
os.environ["SUPABASE_JWKS_URL"] = ""
os.environ["SUPABASE_JWT_SECRET"] = ""
os.environ["REDIS_URL"] = ""
os.environ["ENCRYPTION_KEY"] = FIXED_TEST_KEY
os.environ["MYLIBRARY_DATA_DIR"] = tempfile.mkdtemp(prefix="claude-fixtures-")
LIVE = "--live" in sys.argv
if not LIVE:
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-fixture-not-used"

from mylibrary import config as _config  # noqa: E402
settings = _config.get_settings()
assert settings.db_url.startswith("sqlite"), f"NOT ISOLATED: {settings.db_url}"

from mylibrary import usage as usage_mod, directive as directive_mod  # noqa: E402
from mylibrary import archetype as archetype_mod, reveal as reveal_mod  # noqa: E402
from mylibrary.db import init_db  # noqa: E402
from gen_parity_fixtures import SEED, load_seed  # noqa: E402

OUT = Path("frontend/lib/server/__tests__/fixtures/claude")

captured: list[dict] = []
_real_tracked_create = usage_mod.tracked_create

def _capture(client, *, user_id, operation, **kw):
    # Record the exact kwargs Python would send. `tools`/`system`/`messages`
    # are what Node must reproduce byte-for-byte.
    captured.append({"operation": operation, "user_id": user_id, "kwargs": kw})
    if LIVE:
        msg = _real_tracked_create(client, user_id=user_id, operation=operation, **kw)
        return msg
    raise _StopBeforeCall()

class _StopBeforeCall(Exception):
    """Raised to abort a flow right after its prompt is captured (offline mode)."""

# Patch every module that imported tracked_create by name.
for mod in (directive_mod, archetype_mod, reveal_mod):
    mod.tracked_create = _capture

SCENARIOS = {
    "directive_distill": lambda: directive_mod.distill_directive(
        "I want more literary sci-fi, nothing grimdark, and no John Ringo.",
        current_text="Standalone novels preferred.",
    ),
    "archetype": lambda: archetype_mod.derive_archetype(),
    "reveal_lines": lambda: reveal_mod.generate_reveal_lines(),
}

def main() -> None:
    init_db()
    load_seed()
    out_prompts, out_responses = {}, {}
    for name, fn in SCENARIOS.items():
        captured.clear()
        try:
            fn()
        except _StopBeforeCall:
            pass
        assert captured, f"{name} captured no Claude call — check the monkey-patch"
        out_prompts[name] = captured[0]
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "prompts.json").write_text(json.dumps(out_prompts, indent=1, ensure_ascii=False))
    if LIVE:
        (OUT / "responses.json").write_text(json.dumps(out_responses, indent=1, ensure_ascii=False))
    print("wrote", OUT / "prompts.json", "scenarios:", list(out_prompts))

if __name__ == "__main__":
    main()
```

**Note on `reveal_lines`:** the seeded trait rows already have `reveal_line` set for traits 1–2 and null for 3–4, so the flow has pending work and will issue a call. If a future seed change fills every reveal line, the scenario silently captures nothing — the `assert captured` line is what catches that.

**Note on responses:** offline mode writes only prompts. Hand-author `responses.json` with one realistic tool_use payload per scenario (shape shown in Task 6/7/8's tests). Running `--live` once with a real key produces genuine responses; that costs a few cents and is optional. **Do not commit a `--live` run that contains anything sensitive** — these are tool inputs only, but read them before committing.

- [ ] **Step 2: Run it** — `python scripts/gen_claude_fixtures.py`. Inspect `prompts.json`: three scenarios, each with `kwargs.system`, `kwargs.tools`, `kwargs.messages`, `kwargs.model`, `kwargs.max_tokens`.
- [ ] **Step 3: Verify the wave-1/2 suites still pass** (this script imports the wave-2 generator but must not modify it).
- [ ] **Step 4: Commit gate** — `test(node): Python Claude prompt fixtures for wave-3a parity`.

---

### Task 6: `POST /directive/draft` (distill)

**Files:**
- Create: `frontend/lib/server/directiveDistill.ts`, `frontend/app/api/directive/draft/route.ts`
- Test: `frontend/lib/server/__tests__/parity-prompts.test.ts` (add the distill case), `parity-claude-flows.test.ts`

**Interfaces:**
- Produces: `DISTILL_MODEL`, `DISTILL_SYSTEM`, `DISTILL_TOOL`, `buildDistillPrompt(currentText, signals, message): string`, `existingSignals(db, userId)`, `distillDirective(db, client, {message, currentText, userId})`.

- [ ] **Step 1: Failing prompt-parity test**

```ts
import { describe, it, expect } from 'vitest';
import prompts from './fixtures/claude/prompts.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import seedJson from './fixtures/parity/seed.json';
import { existingSignals, buildDistillPrompt, DISTILL_SYSTEM, DISTILL_TOOL, DISTILL_MODEL } from '../directiveDistill';

describe('prompt parity: directive distill', () => {
  it('builds a byte-identical request to Python', async () => {
    const py = (prompts as any).directive_distill.kwargs;
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const signals = await existingSignals(db, 'local');
      const prompt = buildDistillPrompt(
        'Standalone novels preferred.', signals,
        'I want more literary sci-fi, nothing grimdark, and no John Ringo.'
      );
      expect(prompt).toBe(py.messages[0].content);
      expect(DISTILL_SYSTEM).toBe(py.system);
      expect(DISTILL_TOOL).toEqual(py.tools[0]);
      expect(DISTILL_MODEL).toBe(py.model);
      expect(1200).toBe(py.max_tokens);
    } finally { await close(); }
  });
});
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement `directiveDistill.ts`** — port `directive.py:122-273`. Copy `_DISTILL_SYSTEM` and `_DISTILL_TOOL` **verbatim** from the Python source (open the file; do not retype from memory — a single differing character fails the parity test, which is the point). `buildDistillPrompt` reproduces the concatenation exactly:

```ts
export function buildDistillPrompt(
  currentText: string | null, signals: Record<string, unknown>, message: string
): string {
  return (
    'CURRENT INSTRUCTIONS (may be empty):\n' +
    (currentText || '(none yet)') +
    '\n\nEXISTING SIGNALS (JSON - for conflict detection only):\n' +
    JSON.stringify(signals) +
    '\n\nREADER MESSAGE:\n"' + message + '"'
  );
}
```

**`JSON.stringify` vs `json.dumps` spacing:** Python's `json.dumps({"a": 1, "b": [1, 2]})` produces `{"a": 1, "b": [1, 2]}` (space after `:` and after `,`); `JSON.stringify` produces `{"a":1,"b":[1,2]}`. **They differ**, so any prompt embedding JSON fails byte parity unless corrected. Add a `pyJsonDumps` helper to `serialize.ts` and use it everywhere a prompt embeds JSON (this recurs throughout 3b and 3c).

Implement it as a recursive serializer — a regex patch over `JSON.stringify` output cannot work, because it would also rewrite separators inside string values:

```ts
export function pyJsonDumps(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(pyJsonDumps).join(', ') + ']';
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${JSON.stringify(k)}: ${pyJsonDumps(val)}`);
    return '{' + entries.join(', ') + '}';
  }
  return 'null';
}
```

Key **insertion order** must match Python's dict order — `existingSignals` must build its object in the same order Python does (`rejected_traits`, `more_like`, `less_like`). Non-ASCII: Python's `json.dumps` defaults to `ensure_ascii=True` (escapes non-ASCII), but `directive.py` passes the dict through plain `json.dumps(...)` — check the call site and match. If Python escapes, add an escaping pass.

`existingSignals` port (`directive.py:187-214`): query `taste_signal` rows for the user with `target_kind = 'book'`, resolve each `target_book_id` to `"{title} by {author}"` (title alone when author is null), split on `direction === 'more'`; plus rejected trait claims.

- [ ] **Step 4: The route** — port `api.py:352-363` including the 30/min limit and the `RuntimeError → 400` mapping. Body: `message` (1–1000 chars), `current_text` (≤4000, optional). Add `export const maxDuration = 60;` (single Haiku call).
- [ ] **Step 5: Behavior test** with `fakeClaude` returning a recorded `record_directive` tool_use; assert the 200 body is `{proposed_text, constraints, conflicts, assistant_message}` with constraints passed through `cleanDirectiveConstraints` (wave 2's function — reuse it, do not reimplement), and that the no-tool_use fallback returns `{proposed_text: current_text || '', constraints: {}, conflicts: [], assistant_message: ''}`.
- [ ] **Step 6: Verify pass**; full suites.
- [ ] **Step 7: Commit gate** — `feat(node): POST /api/directive/draft (Haiku distill)`.

---

### Task 7: `POST /profile/archetype`

**Files:**
- Create: `frontend/lib/server/archetypeDerive.ts`
- Modify: `frontend/app/api/profile/archetype/route.ts` (add POST alongside wave 1's GET)
- Test: prompt-parity case + behavior case

**Interfaces:**
- Consumes: wave 1's `lib/server/archetype.ts` (`AXIS_LETTERS`, `scoreToLetter`, `ARCHETYPE_HOOKS`) — reuse, do not duplicate.
- Produces: `ARCHETYPE_MODEL`, `ARCHETYPE_SYSTEM`, `ARCHETYPE_TOOL`, `buildArchetypePrompt(traits)`, `deriveArchetype(db, client, userId)`.

- [ ] **Step 1: Failing prompt-parity + behavior tests.** Behavior test asserts: clamping (a returned `1.7` clamps to `1.0`), the `score <= 0 → left_letter` boundary (**exactly 0.0 must yield the LEFT letter**), the 4-char code assembly order (lens, engine, range, resonance), the upsert into `reader_archetypes`, and the 200 body matching wave 1's `GET` shape.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** Copy `_TOOL` and `_SYSTEM` verbatim from `archetype.py:139-200`; `_MODEL` is `"claude-haiku-4-5-20251001"`, `max_tokens` 512, no prompt caching. `buildArchetypePrompt` ports `archetype.py:201-219`. Clamp helper:

```ts
function clampAxis(x: unknown): number {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new ApiError(400, 'Archetype scoring returned a non-numeric axis.');
  return Math.max(-1, Math.min(1, n));
}
```

Check the exact Python message for the non-finite case in `archetype.py`'s `_clamp_axis` and match it. Errors: no traits → `RuntimeError` → **400**; no tool_use → **400**; row missing after upsert → **500** `"Archetype upsert failed"`. Wrap the upsert in `db.transaction` (wave-2 convention). Add `export const maxDuration = 60;`.
- [ ] **Step 4: Verify pass**; full suites.
- [ ] **Step 5: Commit gate** — `feat(node): POST /api/profile/archetype (Haiku 4-axis derive)`.

---

### Task 8: `POST /profile/reveal-lines`

**Files:**
- Create: `frontend/lib/server/revealLines.ts`, `frontend/app/api/profile/reveal-lines/route.ts`
- Test: prompt-parity case + behavior cases

**Interfaces:**
- Produces: `REVEAL_MODEL`, `REVEAL_SYSTEM`, `REVEAL_FEWSHOTS`, `REVEAL_TOOL`, `buildRevealPrompt(traits)`, `generateRevealLines(db, client, userId, maxTokens?)`.
- Consumes: wave 2's `traitOut` from `lib/server/traits.ts` — the route returns **all** traits, not the generation summary.

- [ ] **Step 1: Failing tests.** Three behaviors matter beyond the prompt:
  1. **Idempotency / no-op:** when every trait already has a `reveal_line`, **no Claude call is made at all** (assert `client.calls.length === 0`) and no key is required.
  2. **Partial fill:** only traits with a null `reveal_line` are sent; returned ids outside that set are ignored; a trait that gained a line concurrently is not overwritten.
  3. **Response shape:** the route returns `TraitOut[]` for **all** the user's traits ordered by `inference_confidence DESC` — *not* the `{generated, traits, model}` dict `generate_reveal_lines` returns internally. This mismatch is the single easiest thing to get wrong here; `api.py:1132-1154` is the authority.

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** Copy `_SYSTEM`, `_FEWSHOTS` (5 tuples), and `_REVEAL_TOOL` verbatim from `reveal.py:25-74`. `buildRevealPrompt` ports `reveal.py:77-97` — note the examples block joins with `\n` and each entry is `  claim: "{claim}"\n  line:  "{line}"` (**two spaces after `line:`** — the alignment is load-bearing for byte parity). The trailing payload uses `json.dumps(traits, ensure_ascii=False)`, so use `pyJsonDumps` **without** ASCII escaping here (contrast with Task 6 — check each call site individually). `max_tokens` 1200, model Haiku.

Persistence (`reveal.py:141-167`): map returned `{id, reveal_line}` pairs, coerce id to int, trim the line, drop empties, skip ids not in the pending set, skip traits belonging to another user, skip traits that already have a line. Wrap in `db.transaction`.

- [ ] **Step 4: The route** — `RuntimeError → 400`; add `export const maxDuration = 60;`.
- [ ] **Step 5: Verify pass**; full suites.
- [ ] **Step 6: Commit gate** — `feat(node): POST /api/profile/reveal-lines`.

---

### Task 9: backend switcher flip

**Files:**
- Modify: `frontend/lib/backend.ts`, `frontend/lib/backend.test.ts`

- [ ] **Step 1: Failing jest cases**

```ts
// wave-3a: flipped to Node
expect(baseFor('/catalog/search?q=dune', 'GET')).toBe('/api');
expect(baseFor('/directive/draft', 'POST')).toBe('/api');
expect(baseFor('/profile/archetype', 'POST')).toBe('/api');
expect(baseFor('/profile/reveal-lines', 'POST')).toBe('/api');
// still Python — 3b/3c/4/5
expect(baseFor('/profile', 'POST')).toBe(PY);            // 3b full build
expect(baseFor('/profile/update', 'POST')).toBe(PY);     // 3b
expect(baseFor('/recommend', 'POST')).toBe(PY);          // 3c
expect(baseFor('/books/12/similar', 'POST')).toBe(PY);   // 3c
expect(baseFor('/discover', 'POST')).toBe(PY);           // 3c
expect(baseFor('/enrich/start', 'POST')).toBe(PY);       // wave 4
expect(baseFor('/admin/users', 'GET')).toBe(PY);         // wave 5
// unchanged from waves 1-2
expect(baseFor('/directive', 'PUT')).toBe('/api');
expect(baseFor('/profile/archetype', 'GET')).toBe('/api');
```

- [ ] **Step 2: Implement.** `/catalog/search` is a clean new prefix. The three POSTs are the subtle part: wave 2 set `{ prefix: '/profile', methods: ['GET', 'PATCH'] }` and `{ prefix: '/directive', methods: ['GET','PUT','DELETE'], exact: true }`. Adding POST to `/profile` wholesale would wrongly flip `POST /profile` (3b) and `POST /profile/reveal-lines`+`/archetype` together. Use exact rules:

```ts
  { prefix: '/catalog/search' },
  { prefix: '/profile/archetype', methods: ['POST'], exact: true },
  { prefix: '/profile/reveal-lines', methods: ['POST'], exact: true },
  { prefix: '/directive/draft', methods: ['POST'], exact: true },
```

Rule order matters only if two rules could both match — they can't here, but keep the more specific `/profile/...` entries **before** the generic `/profile` rule for readability. Confirm `POST /profile` (bare) still resolves to Python: no rule has prefix `/profile` with POST, and the exact rules require a longer path. The jest case above is the proof.

- [ ] **Step 3: Verify pass** — jest, tsc, lint.
- [ ] **Step 4: Commit gate** — `feat(node): flip wave-3a routes to Node in auto mode`.

---

### Task 10: full verification

- [ ] **Step 1: All suites** — `npx jest`, `npm run test:server`, `npm run type-check`, `npm run lint`, and `python -m pytest` (use the project venv: `.venv/bin/python -m pytest`). Python count must be unchanged — wave 3a only adds `scripts/`.

- [ ] **Step 2: Isolated side-by-side against a throwaway Postgres.** Wave 2's verification established this pattern; reuse it rather than pointing anything at the real dev database:

```bash
docker run -d --name mylib-w3a-verify -e POSTGRES_PASSWORD=throwaway \
  -e POSTGRES_DB=mylibrary_verify -p 55432:5432 public.ecr.aws/supabase/postgres:17.6.1.143
# the supabase image locks down `public` for the postgres role — grant first:
docker exec mylib-w3a-verify psql -U supabase_admin -d mylibrary_verify \
  -c "grant all on schema public to postgres; alter schema public owner to postgres;"
export DATABASE_URL="postgresql://postgres:throwaway@127.0.0.1:55432/mylibrary_verify"
export SUPABASE_URL= SUPABASE_JWKS_URL= SUPABASE_JWT_SECRET= REDIS_URL=
.venv/bin/python -m alembic upgrade head
# seed a few books, then start both backends against this DB (Python :8010, Next :3000)
```

**Before any write, prove isolation:** `curl -s localhost:3000/api/books | grep -o '"id":' | wc -l` must equal the number of books you seeded. If it doesn't, stop.

Then compare Node vs Python on: `/catalog/search?q=dune` (same candidate ordering — the ranking port is the risky part), `/catalog/search?q=` → 422 both, and the 30/min rate limit (loop 31 requests, expect a 429 with `Retry-After`). The three Claude routes need a real key; either supply one via `ANTHROPIC_API_KEY` for the throwaway process (a few cents) or skip and note it — the fixture tests already prove prompt equality.

**Tear down when done:** `docker rm -f mylib-w3a-verify` and stop both servers. Confirm ports 3000/8010/55432 are free.

- [ ] **Step 3: Real-app pass (required — tests alone don't count).** With the isolated stack running, load `/library` and use the add-a-book picker: type a query, confirm the search results render from `/api/catalog/search` (network tab), pick one, confirm it lands via `POST /api/books`. If the Chrome extension isn't connected, drive it by curl through the same handlers **and say so explicitly in the verification record** — do not describe a click-through that did not happen.

- [ ] **Step 4: Verify Vercel's function duration limit.** The spec flags this as a verification task. Check the current plan's max duration for fluid compute, then set `maxDuration` on the three Claude routes to the largest supported value ≤300. If the limit is below what a Haiku call needs (it won't be — these are all sub-30s), note it for 3b/3c where the profile and recommender calls are much longer.

- [ ] **Step 5: Push + preview.** Push `feat/node-backend` (push authorized as part of this plan; commits still gated). Confirm the Vercel build is READY.

- [ ] **Step 6: Write `docs/superpowers/plans/wave-3a-verification.md`** — same structure as waves 1–2: what ran, what was found, what's outstanding for Chase. Be explicit about anything not actually executed.

---

## Self-review (spec coverage)

- Spec wave-3 row, 3a's share: "catalog cache goes live" (Tasks 1–2), `/catalog/search` (Task 3), "directive distill" (Task 6), "archetype + reveal" (Tasks 7–8). ✔
- Spec's "Claude calls are record/replay in tests — no live spend in CI": Tasks 4–5 build exactly that, and the Global Constraints forbid live calls. ✔
- Spec's "Catalog cache: moves from Railway volume files to a Postgres `catalog_cache` table… entries live indefinitely": Task 1, no TTL. ✔
- Spec's "verify exact Vercel hobby-plan max function duration": Task 10 Step 4. ✔
- Deferred to 3b: `POST /profile`, `POST /profile/update`. Deferred to 3c: `POST /recommend`, `/books/{id}/similar`, `/discover`. Both listed in "Why wave 3 is split." ✔
- Carried conventions: transactions on multi-statement writes (Tasks 7–8), `parseIdParam` not needed (no `[id]` routes this wave), string-detail 422s, tenant scoping on every query. ✔

## Known risks, called out rather than discovered later

1. **URL encoding divergence** (Task 3 Step 4) — `httpx.QueryParams` uses `%20`, JS `URLSearchParams` uses `+`. Different URLs mean different cache keys and fixture misses. Verify against a recorded URL before assuming.
2. **`json.dumps` spacing** (Task 6) — Python emits `", "` / `": "` separators; `JSON.stringify` emits none. Every prompt that embeds JSON is affected, and this recurs throughout 3b and 3c. `pyJsonDumps` is the shared fix; get it right here.
3. **`ensure_ascii`** — differs per call site (`reveal.py` passes `ensure_ascii=False`, `directive.py` does not). Check each one; do not assume.
4. **Prompt drift is invisible without the parity test.** If a prompt fixture is regenerated after a Python change, the Node side must be updated in the same commit — otherwise the test passes against a stale expectation.

## Deferrals

- `POST /profile`, `POST /profile/update` → **wave 3b**.
- `POST /recommend`, `POST /books/{id}/similar`, `POST /discover` → **wave 3c**.
- Enrichment jobs, ingest/import/export, purge routes → **wave 4**.
- Admin routes; cutover (incl. the ShelfSprite rename per the spec's rebrand section) → **wave 5**.
