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
function fakeClient(
  interpInput: unknown,
  rankedPayload?: unknown[]
): ClaudeClient & { calls: any[] } {
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
            {
              type: 'tool_use',
              name: 'rank_discovery',
              input: { recommendations: rankedPayload ?? [] },
            },
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
