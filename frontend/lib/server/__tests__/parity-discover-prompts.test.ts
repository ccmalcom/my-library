import { describe, it, expect } from 'vitest';
import prompts from './fixtures/claude/prompts.json';
import httpFixtures from './fixtures/claude/recommend-http.json';
import seedJson from './fixtures/parity/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupParityEnv } from './helpers/parity';
import { installHttpReplay } from './helpers/httpReplay';
import { buildSignal, type RecSignal } from '../recSignal';
import {
  assemble,
  discoveryPool,
  fillOlDescriptions,
  MAX_CANDIDATES,
  PER_QUERY,
} from '../recAssemble';
import { applyDiscoveryConstraints, cleanConstraints } from '../recFilters';
import { SEED_MODEL, SEED_MAX_TOKENS, RANK_MAX_TOKENS, rankModel } from '../recPrompts';
import {
  DISCOVER_SYSTEM,
  DISCOVER_TOOL,
  DISCOVER_RANK_SYSTEM,
  DISCOVER_RANK_TOOL,
  buildInterpretPrompt,
  buildDiscoverRerankPrompt,
} from '../recDiscoverPrompts';

// Must stay identical to DISCOVER_QUERY / _DISCOVER_INTERP_CANNED in
// scripts/gen_claude_fixtures.py -- together they determine which catalog URLs
// recommend-http.json contains for this path.
const DISCOVER_QUERY = 'something like The Fifth Season but gentler';
const CANNED_INTERPRETATION = 'Epic fantasy with a broken world, but warmer in tone.';
const CANNED_QUERIES = ['literary fantasy found family', 'gentle epic fantasy hopeful tone'];
const CANNED_RAW_CONSTRAINTS = {
  languages: ['ENG', ' fr ', ''],
  min_year: '1990',
  max_year: 2020,
  exclude_subjects: [' War ', 'grief', ''],
  page_count_max: 400,
  standalone: true,
};

describe('prompt parity: discover stage A (interpret)', () => {
  setupParityEnv();

  it('builds a byte-identical request to Python', async () => {
    const py = (prompts as any).discover_interpret.kwargs;
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const signal = await buildSignal(db, 'local');
      // Stage A is built from the query + profile alone -- no catalog.
      expect(buildInterpretPrompt(DISCOVER_QUERY, signal)).toEqual(py.messages[0].content);
      expect(DISCOVER_SYSTEM).toBe(py.system);
      expect(DISCOVER_TOOL).toEqual(py.tools[0]);
      expect(SEED_MODEL).toBe(py.model); // discovery reuses the Haiku seed model
      expect(SEED_MAX_TOKENS).toBe(py.max_tokens);
      expect(py.tool_choice).toEqual({ type: 'tool', name: 'interpret_request' });
      expect(py.messages[0].role).toBe('user');
    } finally {
      await close();
    }
  });
});

describe('prompt parity: discover stage B (rerank)', () => {
  setupParityEnv();

  it("rebuilds Python's candidate list and rerank prompt from replayed catalog traffic", async () => {
    const py = (prompts as any).discover_rerank.kwargs;
    const { db, close } = await makeTestDb();
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await loadSeed(db, seedJson as any);
      let signal = await buildSignal(db, 'local');

      const constraints = cleanConstraints(CANNED_RAW_CONSTRAINTS);
      expect(constraints).toEqual({
        languages: ['en', 'fr'],
        min_year: 1990,
        max_year: 2020,
        exclude_subjects: ['war', 'grief'],
      });

      // A stated language constraint REPLACES the library's languages for this run.
      signal = {
        ...signal,
        library_languages: new Set(constraints.languages as string[]),
      } as RecSignal;

      let pool = await discoveryPool(db, CANNED_QUERIES, PER_QUERY);
      pool = applyDiscoveryConstraints(pool, constraints);
      // Discovery passes an EMPTY metadata pool: the interpreted queries are the
      // whole pool, so every candidate comes out tagged 'claude_seed'.
      const candidates = assemble([], pool, signal, MAX_CANDIDATES);
      await fillOlDescriptions(db, candidates);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every((c) => c.retrieval_pool === 'claude_seed')).toBe(true);

      // This single assertion covers the deterministic discovery chain: the
      // two-source pool order, the pre-assembly constraint filter, the language
      // override, dedup, author caps and description ordering all feed the
      // CANDIDATES JSON inside this prompt.
      //
      // The fixture is a snapshot of live catalog data: re-recording churns a
      // candidate or two as Google Books re-ranks. That is expected -- this proves
      // Node reproduces whatever was recorded, not one specific candidate list.
      expect(
        buildDiscoverRerankPrompt(candidates, DISCOVER_QUERY, CANNED_INTERPRETATION, signal, 10)
      ).toEqual(py.messages[0].content);
      expect(DISCOVER_RANK_SYSTEM).toBe(py.system);
      expect(DISCOVER_RANK_TOOL).toEqual(py.tools[0]);
      expect(rankModel()).toBe(py.model);
      expect(RANK_MAX_TOKENS).toBe(py.max_tokens);
      expect(py.tool_choice).toEqual({ type: 'tool', name: 'rank_discovery' });
    } finally {
      restore();
      await close();
    }
  });

  it('uses a DIFFERENT profile-context header from stage A', async () => {
    // The two prefixes differ by one substring in Python. Unifying them would be a
    // silent parity break that no other assertion here would catch.
    const a = (prompts as any).discover_interpret.kwargs.messages[0].content[0].text;
    const b = (prompts as any).discover_rerank.kwargs.messages[0].content[0].text;
    expect(a.startsWith('READER TASTE PROFILE (secondary context; the request rules):\n')).toBe(
      true
    );
    expect(b.startsWith('READER TASTE PROFILE (secondary - the request rules):\n')).toBe(true);
    expect(a).not.toBe(b);
  });
});
