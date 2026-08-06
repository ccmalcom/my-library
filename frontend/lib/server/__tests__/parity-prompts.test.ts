import { asc, eq } from 'drizzle-orm';
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
