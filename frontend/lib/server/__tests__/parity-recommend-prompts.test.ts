import { describe, it, expect } from 'vitest';
import prompts from './fixtures/claude/prompts.json';
import httpFixtures from './fixtures/claude/recommend-http.json';
import seedJson from './fixtures/parity/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupParityEnv } from './helpers/parity';
import { installHttpReplay } from './helpers/httpReplay';
import { buildSignal, isColdStart } from '../recSignal';
import {
  assemble,
  fillOlDescriptions,
  metadataPool,
  seedPool,
  MAX_CANDIDATES,
  PER_QUERY,
  SEED_QUERIES,
} from '../recAssemble';
import { applyDirectiveConstraints } from '../recFilters';
import {
  buildSeedPrompt,
  buildRerankPrompt,
  SEED_SYSTEM,
  SEED_TOOL,
  SEED_MODEL,
  SEED_MAX_TOKENS,
  RANK_SYSTEM,
  RANK_TOOL,
  RANK_MAX_TOKENS,
  rankModel,
} from '../recPrompts';

// Must stay identical to _SEED_QUERIES_CANNED in scripts/gen_claude_fixtures.py --
// these strings determine which Google Books URLs recommend-http.json contains.
const CANNED_SEED_QUERIES = [
  'literary science fiction political systems',
  'anthropological science fiction first contact',
];

describe('prompt parity: recommend stage 1b (seed queries)', () => {
  setupParityEnv();

  it('builds a byte-identical request to Python', async () => {
    const py = (prompts as any).recommend_seed.kwargs;
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const signal = await buildSignal(db, 'local');
      // The seed prompt is built from the signal alone -- no catalog, no profile gate.
      expect(buildSeedPrompt(signal, SEED_QUERIES)).toEqual(py.messages[0].content);
      expect(SEED_SYSTEM).toBe(py.system);
      expect(SEED_TOOL).toEqual(py.tools[0]);
      expect(SEED_MODEL).toBe(py.model);
      expect(SEED_MAX_TOKENS).toBe(py.max_tokens);
      expect(py.tool_choice).toEqual({ type: 'tool', name: 'propose_search_queries' });
      expect(py.messages[0].role).toBe('user');
    } finally {
      await close();
    }
  });
});

describe('prompt parity: recommend stage 2 (rerank)', () => {
  setupParityEnv();

  it("rebuilds Python's candidate list and rerank prompt from replayed catalog traffic", async () => {
    const py = (prompts as any).recommend_rerank.kwargs;
    const { db, close } = await makeTestDb();
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await loadSeed(db, seedJson as any);
      const signal = await buildSignal(db, 'local');
      const coldStart = isColdStart(signal);
      // The seeded library is deliberately NOT cold-start (10 loved, 12 rated), so
      // author expansion runs -- which is what the recorded inauthor: URLs cover.
      expect(coldStart).toBe(false);

      const meta = await metadataPool(db, signal, PER_QUERY, coldStart);
      const seed = await seedPool(db, CANNED_SEED_QUERIES, PER_QUERY);
      let candidates = assemble(meta, seed, signal, MAX_CANDIDATES);
      candidates = applyDirectiveConstraints(candidates, signal.directive_constraints);
      await fillOlDescriptions(db, candidates);
      expect(candidates.length).toBeGreaterThan(0);

      // This single assertion covers the whole deterministic retrieval core: pool
      // order, dedup, every filter, author caps and cap ordering all feed the
      // CANDIDATES JSON inside this prompt.
      expect(buildRerankPrompt(candidates, signal, 10)).toEqual(py.messages[0].content);
      expect(RANK_SYSTEM).toBe(py.system);
      expect(RANK_TOOL).toEqual(py.tools[0]);
      expect(rankModel()).toBe(py.model);
      expect(RANK_MAX_TOKENS).toBe(py.max_tokens);
      expect(py.tool_choice).toEqual({ type: 'tool', name: 'rank_recommendations' });
    } finally {
      restore();
      await close();
    }
  });
});
