import { describe, test, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import seedJson from './fixtures/seed.json';
import httpFixtures from './fixtures/claude/recommend-http.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
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
  setupTestEnv();

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
