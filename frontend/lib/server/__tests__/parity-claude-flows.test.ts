import { describe, it, expect } from 'vitest';
import responses from './fixtures/claude/responses.json';
import seedJson from './fixtures/parity/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { fakeClaude } from './helpers/fakeClaude';
import { distillDirective } from '../directiveDistill';
import { cleanDirectiveConstraints } from '../directive';

describe('claude flow: directive distill', () => {
  it('returns the distilled proposal from a record_directive tool_use response', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const fixture = (responses as any).directive_distill;
      const client = fakeClaude([fixture]);

      const out = await distillDirective(db, client, {
        message: 'I want more literary sci-fi, nothing grimdark, and no John Ringo.',
        currentText: 'Standalone novels preferred.',
        userId: 'local',
      });

      const expected = fixture.content[0].input;
      expect(out).toEqual({
        proposed_text: expected.proposed_text,
        constraints: cleanDirectiveConstraints(expected.constraints),
        conflicts: expected.conflicts,
        assistant_message: expected.assistant_message,
      });
      expect(client.calls).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it('falls back to an empty proposal when the response has no tool_use block', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClaude([{ content: [{ type: 'text', text: 'no tool call here' }] }]);

      const out = await distillDirective(db, client, {
        message: 'anything',
        currentText: 'Standalone novels preferred.',
        userId: 'local',
      });

      expect(out).toEqual({
        proposed_text: 'Standalone novels preferred.',
        constraints: {},
        conflicts: [],
        assistant_message: '',
      });
    } finally {
      await close();
    }
  });

  it('falls back to an empty string proposal when currentText is null and there is no tool_use', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClaude([{ content: [] }]);

      const out = await distillDirective(db, client, {
        message: 'anything',
        currentText: null,
        userId: 'local',
      });

      expect(out).toEqual({
        proposed_text: '',
        constraints: {},
        conflicts: [],
        assistant_message: '',
      });
    } finally {
      await close();
    }
  });
});
