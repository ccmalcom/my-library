import { describe, test, expect } from 'vitest';
import { asc, eq } from 'drizzle-orm';
// Snapshot of the prompt as recorded at the Python cutover (2026-08-14). This is
// no longer a cross-backend parity check — it is a regression guard proving the
// deterministic retrieval pipeline still assembles an identical prompt. The
// recorder (scripts/gen_claude_fixtures.py) is gone, so if the prompt changes
// legitimately, update this fixture BY HAND and say why in the commit.
import prompts from './fixtures/claude/prompts.json';
import httpFixtures from './fixtures/claude/recommend-http.json';
import seedJson from './fixtures/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { installHttpReplay } from './helpers/httpReplay';
import { fakeClaude } from './helpers/fakeClaude';
import { schema } from '../db';
import { runRecommend } from '../recommendRun';

const PROFILED_AT = '2026-08-01 00:00:00'; // mirrors _prepare_recommend in the generator

/** Canned payload recorded for the prompt snapshot's seed call. */
const seedResponse = {
  content: [
    {
      type: 'tool_use',
      name: 'propose_search_queries',
      input: {
        queries: [
          { query: 'literary science fiction political systems', reason: 'fixture' },
          { query: 'anthropological science fiction first contact', reason: 'fixture' },
        ],
      },
    },
  ],
  usage: null,
};

const rerankResponse = (indices: number[]) => ({
  content: [
    {
      type: 'tool_use',
      name: 'rank_recommendations',
      input: {
        recommendations: indices.map((idx, i) => ({
          candidate_index: idx,
          score: 1 - i * 0.1,
          rationale: `  Because reasons ${idx}.  `,
          grounded_trait_ids: [1, 999], // 999 is not a real trait id
          grounded_book_ids: [1, 888], // 888 is not a loved book id
        })),
      },
    },
  ],
  usage: null,
});

async function seeded() {
  const { db, close } = await makeTestDb();
  await loadSeed(db, seedJson as any);
  await db.update(schema.profileMeta).set({ lastProfiledAt: PROFILED_AT });
  return { db, close };
}

function opts() {
  return { n: 10, useMetadata: true, useClaudeSeeds: true };
}

describe('runRecommend gates', () => {
  setupTestEnv();

  test('400s on an empty library, a missing profile, and a stale profile', async () => {
    const { db, close } = await makeTestDb();
    try {
      await expect(runRecommend(db, null, 'local', opts())).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('No loved books found'),
      });

      await loadSeed(db, seedJson as any);
      await db.update(schema.profileMeta).set({ lastProfiledAt: null });
      await expect(runRecommend(db, null, 'local', opts())).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('No taste profile found'),
      });

      // The seed is deliberately stale: 3 books carry a later feedback_updated_at.
      await db.update(schema.profileMeta).set({ lastProfiledAt: '2026-07-01 12:00:00' });
      await expect(runRecommend(db, null, 'local', opts())).rejects.toMatchObject({
        status: 400,
        detail:
          '3 book(s) have been rated/reviewed since the last profile build. Re-profile first (POST /profile/update) so recommendations reflect your current taste.',
      });
    } finally {
      await close();
    }
  });

  test('400s with the no-key message when a Claude stage is reached without a client', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await expect(runRecommend(db, null, 'local', opts())).rejects.toMatchObject({
        status: 400,
        detail: expect.stringContaining('No Anthropic API key configured'),
      });
    } finally {
      restore();
      await close();
    }
  });
});

describe('runRecommend happy path', () => {
  setupTestEnv();

  test('matches the recorded request snapshots', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([seedResponse, rerankResponse([0, 1, 2])] as any);
    try {
      await runRecommend(db, client, 'local', opts());
      expect(client.calls).toHaveLength(2);
      // Total equality: no extra params, no missing params, byte-identical prompts.
      expect(client.calls[0].params).toEqual((prompts as any).recommend_seed.kwargs);
      expect(client.calls[1].params).toEqual((prompts as any).recommend_rerank.kwargs);
    } finally {
      restore();
      await close();
    }
  });

  test('persists the served set and validates the ids Claude cited', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([seedResponse, rerankResponse([0, 1, 2])] as any);
    try {
      const out = (await runRecommend(db, client, 'local', opts())) as any;
      expect(out.served).toBe(3);
      expect(out.cold_start).toBe(false);
      expect(out.run_id).toMatch(/^[0-9a-f]{12}$/);
      expect(out.seed_queries).toEqual([
        'literary science fiction political systems',
        'anthropological science fiction first contact',
      ]);
      expect(out.recommendations[0].rank).toBe(1);
      // Rationale is trimmed. Do NOT assert WHICH candidate lands at rank 1: after the
      // score sort, _claude_rerank re-orders description-carrying candidates first, so
      // the winner depends on the replayed catalog payloads.
      expect(out.recommendations[0].rationale).toMatch(/^Because reasons \d+\.$/);

      const rows = await db
        .select()
        .from(schema.recommendations)
        .where(eq(schema.recommendations.runId, out.run_id))
        .orderBy(asc(schema.recommendations.rank));
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
      expect(rows.every((r) => r.status === 'served')).toBe(true);
      // Hallucinated ids are dropped (999 / 888); real ones survive.
      expect(rows.every((r) => JSON.stringify(r.groundedTraitIds) === '[1]')).toBe(true);
      expect(rows.every((r) => JSON.stringify(r.groundedBookIds) === '[1]')).toBe(true);
    } finally {
      restore();
      await close();
    }
  });

  test('drops out-of-range and duplicate candidate indices', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([seedResponse, rerankResponse([0, 0, 9999, 1])] as any);
    try {
      const out = (await runRecommend(db, client, 'local', opts())) as any;
      expect(out.served).toBe(2); // idx 0 once, idx 1 once
    } finally {
      restore();
      await close();
    }
  });

  test('use_claude_seeds=false makes no seed call and reports an empty seed pool', async () => {
    const { db, close } = await seeded();
    const restore = installHttpReplay(httpFixtures as any);
    const client = fakeClaude([rerankResponse([0])] as any);
    try {
      const out = (await runRecommend(db, client, 'local', {
        n: 10,
        useMetadata: true,
        useClaudeSeeds: false,
      })) as any;
      expect(client.calls).toHaveLength(1);
      expect(out.pool_seed).toBe(0);
      expect(out.seed_queries).toEqual([]);
    } finally {
      restore();
      await close();
    }
  });

  test('returns the no-candidates note without a rerank call when retrieval is empty', async () => {
    const { db, close } = await seeded();
    const client = fakeClaude([] as any);
    try {
      const out = (await runRecommend(db, client, 'local', {
        n: 10,
        useMetadata: false,
        useClaudeSeeds: false,
      })) as any;
      expect(client.calls).toHaveLength(0);
      expect(out).toMatchObject({ run_id: null, served: 0, candidates: 0, recommendations: [] });
      expect(out.note).toContain('Retrieval surfaced no new candidates');
    } finally {
      await close();
    }
  });
});
