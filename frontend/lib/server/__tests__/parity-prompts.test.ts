import { describe, it, expect } from 'vitest';
import prompts from './fixtures/claude/prompts.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import seedJson from './fixtures/parity/seed.json';
import {
  existingSignals,
  buildDistillPrompt,
  DISTILL_SYSTEM,
  DISTILL_TOOL,
  DISTILL_MODEL,
} from '../directiveDistill';

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
});
