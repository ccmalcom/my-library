import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { setupParityEnv } from './helpers/parity';
import { _setDbForTests } from '../db';
import { RATE_LIMITS } from '../ratelimit';
import { GET as catalogSearch } from '../../../app/api/catalog/search/route';
import { POST as directiveDraft } from '../../../app/api/directive/draft/route';
import { POST as booksSimilar } from '../../../app/api/books/[id]/similar/route';
import { POST as discoverRoute } from '../../../app/api/discover/route';
import { POST as enrichStart } from '../../../app/api/enrich/start/route';
import { enrichJobs } from '../schema';

// Cross-cutting: finding 2 of the wave-3a final review. Both routes hand-build the
// same corrected 429 shape by calling the shared rateLimitExceededResponse helper
// (ratelimit.ts) — nothing previously proved that shape actually reaches an HTTP
// response from a real, rate-limited request. Drives checkRateLimit past its 30/minute
// limit through the real exported route handlers (the pattern established in
// parity-claude-flows.test.ts's reveal-lines route describe block: setupParityEnv() +
// _setDbForTests(db) + calling the route function directly with a real Request).
describe('429 rate-limit response shape, driven through the real routes', () => {
  setupParityEnv();
  afterEach(() => vi.restoreAllMocks());

  function silenceLogs() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  }

  async function assertCorrected429(res: Response): Promise<void> {
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Rate limit exceeded: 30 per 1 minute' });
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('retry-after')).toBeNull();
    expect(res.headers.get('x-ratelimit-limit')).toBeNull();
    expect(res.headers.get('x-ratelimit-remaining')).toBeNull();
  }

  it('GET /api/catalog/search returns the corrected body once the 30/minute limit is exceeded', async () => {
    silenceLogs();
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      expect(RATE_LIMITS.catalogSearch).toEqual({ limit: 30, windowSeconds: 60 });

      // q=' ' (a single space) satisfies Query's z.string().min(1) but trims to '' inside
      // searchBooks, short-circuiting before any fetch — no httpReplay/network needed to
      // drive 30 clean "allowed" requests.
      let last: Response | undefined;
      for (let i = 0; i < RATE_LIMITS.catalogSearch.limit + 1; i++) {
        last = await catalogSearch(new Request('http://test/api/catalog/search?q=%20'));
      }
      await assertCorrected429(last!);
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  it('POST /api/directive/draft returns the corrected body once the 30/minute limit is exceeded', async () => {
    silenceLogs();
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      expect(RATE_LIMITS.directiveDraft).toEqual({ limit: 30, windowSeconds: 60 });

      // setupParityEnv deletes ANTHROPIC_API_KEY and this test seeds no user_settings row,
      // so every "allowed" request 400s on the no-key branch (checked AFTER the rate limit
      // in the route) before ever touching Claude — no fakeClaude/mocking needed to drive
      // 30 requests past the limit.
      const body = JSON.stringify({ message: 'more literary sci-fi please' });
      let last: Response | undefined;
      for (let i = 0; i < RATE_LIMITS.directiveDraft.limit + 1; i++) {
        last = await directiveDraft(
          new Request('http://test/api/directive/draft', {
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

  it('POST /api/enrich/start enforces RATE_LIMITS.enrichStart as five per minute per authenticated user', async () => {
    silenceLogs();
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      expect(RATE_LIMITS.enrichStart).toEqual({ limit: 5, windowSeconds: 60 });
      await db.insert(enrichJobs).values({
        jobId: 'active-local-job',
        progress: 0,
        total: 0,
        userId: 'local',
        status: 'running',
      });
      let last: Response | undefined;
      for (let i = 0; i < RATE_LIMITS.enrichStart.limit + 1; i++) {
        last = await enrichStart(
          new Request('http://test/api/enrich/start', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          })
        );
      }
      expect({ status: last!.status, body: await last!.json() }).toEqual({
        status: 429,
        body: { error: 'Rate limit exceeded: 5 per 1 minute' },
      });
    } finally {
      _setDbForTests(null);
      await close();
    }
  });
});
