import { describe, it, expect } from 'vitest';
import responses from './fixtures/claude/responses.json';
import seedJson from './fixtures/parity/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { fakeClaude } from './helpers/fakeClaude';
import { distillDirective, existingSignals } from '../directiveDistill';
import { cleanDirectiveConstraints } from '../directive';
import type { Seed } from './helpers/pglite';

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

describe('existingSignals: book resolution + direction split', () => {
  // Scoped seed (not the shared fixtures/parity/seed.json, which has no taste_signal rows —
  // every other test that touches existingSignals exercises the more_like/less_like split
  // over zero rows). Proves: title+author formatting, title-alone formatting, the
  // more/less direction split, and the target_kind = 'book' filter (a row 3 with
  // target_kind = 'trait' but pointing at a real book id, direction 'more' — if the filter
  // were missing this would duplicate into more_like and fail the exact-equality assertion).
  const seed: Seed = {
    books: [
      {
        id: 1,
        user_id: 'local',
        title: 'Alpha',
        author: 'Ann Author',
        goodreads_rating: 4,
        source: 'goodreads',
      },
      {
        id: 2,
        user_id: 'local',
        title: 'Beta',
        author: null,
        goodreads_rating: 0,
        source: 'manual',
      },
    ],
    taste_signals: [
      { id: 1, user_id: 'local', direction: 'more', target_kind: 'book', target_book_id: 1 },
      { id: 2, user_id: 'local', direction: 'less', target_kind: 'book', target_book_id: 2 },
      { id: 3, user_id: 'local', direction: 'more', target_kind: 'trait', target_book_id: 1 },
    ],
    taste_traits: [
      {
        id: 1,
        user_id: 'local',
        claim: 'Avoids grimdark tone.',
        polarity: 'negative',
        inference_confidence: 0.6,
        status: 'rejected',
      },
    ],
  };

  it('resolves target_book_id to "{title} by {author}" (or title alone) and splits by direction', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seed);
      const signals = await existingSignals(db, 'local');
      expect(signals).toEqual({
        rejected_traits: ['Avoids grimdark tone.'],
        more_like: ['Alpha by Ann Author'],
        less_like: ['Beta'],
      });
    } finally {
      await close();
    }
  });
});
