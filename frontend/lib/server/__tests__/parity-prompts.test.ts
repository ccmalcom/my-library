import { and, asc, eq, isNull } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';
import prompts from './fixtures/claude/prompts.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import seedJson from './fixtures/parity/seed.json';
import { schema } from '../db';
import {
  existingSignals,
  buildDistillPrompt,
  DISTILL_SYSTEM,
  DISTILL_TOOL,
  DISTILL_MODEL,
} from '../directiveDistill';
import {
  buildArchetypePrompt,
  ARCHETYPE_SYSTEM,
  ARCHETYPE_TOOL,
  ARCHETYPE_MODEL,
} from '../archetypeDerive';
import { buildRevealPrompt, REVEAL_SYSTEM, REVEAL_TOOL, REVEAL_MODEL } from '../revealLines';
import { buildTiers } from '../profileTiers';
import { feedbackContext } from '../profileFeedback';
import {
  buildProfilePrompt,
  PROFILE_SYSTEM,
  PROFILE_TOOL,
  profileModel,
} from '../profileBuild';
import {
  buildUpdatePrompt,
  REVISE_SYSTEM,
  REVISE_TOOL,
  collectUpdateInputs,
} from '../profileUpdate';

describe('prompt parity: directive distill', () => {
  it('builds a byte-identical request to Python', async () => {
    const py = (prompts as any).directive_distill.kwargs;
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const signals = await existingSignals(db, 'local');
      const prompt = buildDistillPrompt(
        'Standalone novels preferred.',
        signals,
        'I want more literary sci-fi, nothing grimdark, and no John Ringo.'
      );
      expect(prompt).toBe(py.messages[0].content);
      expect(DISTILL_SYSTEM).toBe(py.system);
      expect(DISTILL_TOOL).toEqual(py.tools[0]);
      expect(DISTILL_MODEL).toBe(py.model);
      expect(1200).toBe(py.max_tokens);
    } finally {
      await close();
    }
  });

  it('trims the reader message before embedding it (Python: (message or "").strip())', () => {
    // The fixture message above has no leading/trailing whitespace, so it can't tell trimmed
    // apart from untrimmed/mistrimmed. This exercises buildDistillPrompt directly (a pure
    // function — no DB needed) with a padded message to prove the trim actually happens.
    const signals = { rejected_traits: [], more_like: [], less_like: [] };
    const prompt = buildDistillPrompt('Standalone novels preferred.', signals, '  hello  ');
    expect(prompt).toBe(
      'CURRENT INSTRUCTIONS (may be empty):\n' +
        'Standalone novels preferred.' +
        '\n\nEXISTING SIGNALS (JSON - for conflict detection only):\n' +
        '{"rejected_traits": [], "more_like": [], "less_like": []}' +
        '\n\nREADER MESSAGE:\n"hello"'
    );
  });
});

describe('prompt parity: archetype derive', () => {
  it('builds a byte-identical request to Python', async () => {
    const py = (prompts as any).archetype.kwargs;
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      // Same unfiltered-by-status, id-ordered query deriveArchetype runs (archetype.py's
      // query has no status filter either — all 4 seeded 'local' traits, including the
      // rejected one, are scored).
      const traits = await db
        .select({ claim: schema.tasteTraits.claim, polarity: schema.tasteTraits.polarity })
        .from(schema.tasteTraits)
        .where(eq(schema.tasteTraits.userId, 'local'))
        .orderBy(asc(schema.tasteTraits.id));
      const prompt = buildArchetypePrompt(traits);
      expect(prompt).toBe(py.messages[0].content);
      expect(ARCHETYPE_SYSTEM).toBe(py.system);
      expect(ARCHETYPE_TOOL).toEqual(py.tools[0]);
      expect(ARCHETYPE_MODEL).toBe(py.model);
      expect(512).toBe(py.max_tokens);
    } finally {
      await close();
    }
  });
});

describe('prompt parity: reveal lines', () => {
  it('builds a byte-identical request to Python', async () => {
    const py = (prompts as any).reveal_lines.kwargs;
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      // Python's `pending` query (reveal.py:110-114) has no explicit ORDER BY. The seed's
      // 'local' taste_traits (ids 1-4, inserted in that order) have ids 1 and 2 already
      // carrying a reveal_line, so only 3 and 4 are pending — id-ascending reproduces the
      // insertion/primary-key order SQLite's unordered query produced when the fixture was
      // captured (confirmed against the real fixture below: ids [3, 4] in that order).
      const pending = await db
        .select({
          id: schema.tasteTraits.id,
          claim: schema.tasteTraits.claim,
          polarity: schema.tasteTraits.polarity,
        })
        .from(schema.tasteTraits)
        .where(and(eq(schema.tasteTraits.userId, 'local'), isNull(schema.tasteTraits.revealLine)))
        .orderBy(asc(schema.tasteTraits.id));
      expect(pending.map((t) => t.id)).toEqual([3, 4]);

      const prompt = buildRevealPrompt(pending);
      expect(prompt).toBe(py.messages[0].content);
      expect(REVEAL_SYSTEM).toBe(py.system);
      expect(REVEAL_TOOL).toEqual(py.tools[0]);
      expect(REVEAL_MODEL).toBe(py.model);
      expect(1200).toBe(py.max_tokens);
    } finally {
      await close();
    }
  });
});

describe('prompt parity: full taste-profile build', () => {
  it('builds a byte-identical request to Python', async () => {
    const py = (prompts as any).profile_full.kwargs;
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const tiers = await buildTiers(db, 'local');
      const feedback = await feedbackContext(db, 'local');
      expect(buildProfilePrompt(tiers, feedback)).toBe(py.messages[0].content);
      expect(PROFILE_SYSTEM).toBe(py.system);
      expect(PROFILE_TOOL).toEqual(py.tools[0]);
      expect(profileModel()).toBe(py.model);
      expect(3000).toBe(py.max_tokens);
      expect(py.tool_choice).toEqual({ type: 'tool', name: 'record_taste_traits' });
    } finally {
      await close();
    }
  });
});

describe('prompt parity: incremental profile update', () => {
  it('builds a byte-identical request to Python', async () => {
    const py = (prompts as any).profile_update.kwargs;
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const inputs = await collectUpdateInputs(db, 'local', '2026-07-01 12:00:00');
      const feedback = await feedbackContext(db, 'local');
      expect(
        buildUpdatePrompt(inputs.currentTraits, inputs.booksMeta, inputs.changedIds, feedback)
      ).toBe(py.messages[0].content);
      expect(REVISE_SYSTEM).toBe(py.system);
      expect(REVISE_TOOL).toEqual(py.tools[0]);
      expect(profileModel()).toBe(py.model);
      expect(3000).toBe(py.max_tokens);
      expect(py.tool_choice).toEqual({ type: 'tool', name: 'revise_taste_traits' });
    } finally {
      await close();
    }
  });
});
