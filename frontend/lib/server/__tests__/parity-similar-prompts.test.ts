import { describe, it, expect } from 'vitest';
import prompts from './fixtures/claude/prompts.json';
import httpFixtures from './fixtures/claude/recommend-http.json';
import seedJson from './fixtures/parity/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupParityEnv } from './helpers/parity';
import { installHttpReplay } from './helpers/httpReplay';
import { buildBookSignal } from '../recSignal';
import {
  assemble,
  fillOlDescriptions,
  metadataPool,
  seedPool,
  MAX_CANDIDATES,
  PER_QUERY,
  SEED_QUERIES,
} from '../recAssemble';
import { SEED_MODEL, SEED_MAX_TOKENS, SEED_TOOL, RANK_MAX_TOKENS, rankModel } from '../recPrompts';
import {
  BOOK_FACET_SYSTEM,
  SIMILAR_RANK_SYSTEM,
  SIMILAR_RANK_TOOL,
  buildBookFacetPrompt,
  buildSimilarRerankPrompt,
} from '../recSimilarPrompts';

// Must stay identical to SIMILAR_BOOK_ID / _SIMILAR_QUERIES_CANNED in
// scripts/gen_claude_fixtures.py -- together they determine which catalog URLs
// recommend-http.json contains for this path.
const SIMILAR_BOOK_ID = 1;
const CANNED_SIMILAR_QUERIES = [
  'desert planet political intrigue science fiction',
  'ecological science fiction messianic prophecy',
];

describe('prompt parity: similar stage 1b (book facet queries)', () => {
  setupParityEnv();

  it('builds a byte-identical request to Python', async () => {
    const py = (prompts as any).similar_seed.kwargs;
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const signal = (await buildBookSignal(db, 'local', SIMILAR_BOOK_ID))!;
      // The facet prompt is built from the anchor alone -- no catalog, no profile.
      expect(buildBookFacetPrompt(signal.anchor, SEED_QUERIES)).toEqual(py.messages[0].content);
      expect(BOOK_FACET_SYSTEM).toBe(py.system);
      // Python reuses _SEED_TOOL verbatim for this call.
      expect(SEED_TOOL).toEqual(py.tools[0]);
      expect(SEED_MODEL).toBe(py.model);
      expect(SEED_MAX_TOKENS).toBe(py.max_tokens);
      expect(py.tool_choice).toEqual({ type: 'tool', name: 'propose_search_queries' });
      expect(py.messages[0].role).toBe('user');
      // The anchor's `series` is null in the SEED; assert it renders as JSON null
      // rather than being dropped from the object.
      expect(py.messages[0].content[0].text).toContain('"series": null');
    } finally {
      await close();
    }
  });
});

describe('prompt parity: similar stage 2 (rerank)', () => {
  setupParityEnv();

  it("rebuilds Python's candidate list and rerank prompt from replayed catalog traffic", async () => {
    const py = (prompts as any).similar_rerank.kwargs;
    const { db, close } = await makeTestDb();
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await loadSeed(db, seedJson as any);
      const signal = (await buildBookSignal(db, 'local', SIMILAR_BOOK_ID))!;

      // cold_start is always false on this path: library thinness is irrelevant
      // to a single seed book, so author expansion always runs.
      const meta = await metadataPool(db, signal, PER_QUERY, false);
      const seed = await seedPool(db, CANNED_SIMILAR_QUERIES, PER_QUERY);
      const candidates = assemble(meta, seed, signal, MAX_CANDIDATES);
      // NOT applyDirectiveConstraints: recommend_similar never calls it (V7).
      await fillOlDescriptions(db, candidates);
      expect(candidates.length).toBeGreaterThan(0);

      // This single assertion covers the deterministic retrieval core AS IT RUNS
      // ON THIS PATH: pool order, dedup, language + learner filters, author caps
      // and description ordering all feed the CANDIDATES JSON inside this prompt.
      //
      // COVERAGE this path adds over parity-recommend-prompts.test.ts:
      //  - fillOlDescriptions genuinely runs (the recommend fixture records zero
      //    /works/ URLs, because its 138-candidate pool trims description-less OL
      //    candidates in capPool). Here the pool is far under the cap of 60.
      //  - capPool's `length <= cap` early return is the branch taken.
      //  - the series and fuzzy-duplicate filters are inert (empty library_series
      //    and library_titles), which is exactly what Python does here.
      //
      // The fixture is a snapshot of live catalog data: re-recording churns a
      // candidate or two as Google Books re-ranks. That is expected -- this proves
      // Node reproduces whatever was recorded, not one specific candidate list.
      expect(buildSimilarRerankPrompt(candidates, signal.anchor, 8)).toEqual(
        py.messages[0].content
      );
      expect(SIMILAR_RANK_SYSTEM).toBe(py.system);
      expect(SIMILAR_RANK_TOOL).toEqual(py.tools[0]);
      expect(rankModel()).toBe(py.model);
      expect(RANK_MAX_TOKENS).toBe(py.max_tokens);
      expect(py.tool_choice).toEqual({ type: 'tool', name: 'rank_similar_books' });
    } finally {
      restore();
      await close();
    }
  });

  it('sends the identical SEED BOOK block in both stages', async () => {
    // Python builds the same book_context string in _book_facet_queries and
    // _rerank_similar, so the ephemeral cache prefix is shared across the two calls.
    const seedBlock = (prompts as any).similar_seed.kwargs.messages[0].content[0];
    const rerankBlock = (prompts as any).similar_rerank.kwargs.messages[0].content[0];
    expect(seedBlock).toEqual(rerankBlock);
    expect(seedBlock.cache_control).toEqual({ type: 'ephemeral' });
  });
});
