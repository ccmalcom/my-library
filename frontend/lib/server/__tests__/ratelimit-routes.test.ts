import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { setupParityEnv } from './helpers/parity';
import { _setDbForTests } from '../db';
import { RATE_LIMITS } from '../ratelimit';
import { GET as catalogSearch } from '../../../app/api/catalog/search/route';
import { POST as directiveDraft } from '../../../app/api/directive/draft/route';

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
});
