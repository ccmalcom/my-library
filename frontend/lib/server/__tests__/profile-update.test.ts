import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { fakeClaude } from './helpers/fakeClaude';
import seedJson from './fixtures/parity/seed.json';
import type { Seed } from './helpers/pglite';
import { booksChangedSince, buildUpdatePrompt, updateTasteProfile } from '../profileUpdate';
import { pyFloat } from '../serialize';
import { schema } from '../db';

describe('booksChangedSince', () => {
  it('returns rated/DNF/favorited books whose feedback changed after the cutoff', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const changed = await booksChangedSince(db, '2026-07-01 12:00:00', 'local');
      // 2: favorited (unrated by app but goodreads 5) @ 07-15
      // 3: re-rated @ 07-20
      // 9: DNF @ 07-18
      // 7 changed @ 06-01, before the cutoff.
      expect(changed.map((b) => b.id)).toEqual([2, 3, 9]);
    } finally {
      await close();
    }
  });

  it('treats a null cutoff as "everything carrying feedback"', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const changed = await booksChangedSince(db, null, 'local');
      expect(changed.map((b) => b.id)).toEqual([2, 3, 7, 9]);
    } finally {
      await close();
    }
  });
});

describe('buildUpdatePrompt', () => {
  it('renders changed ids as a Python list repr, not a JS join', () => {
    const out = buildUpdatePrompt([], new Map(), [2, 3, 9], null);
    expect(out).toContain('CHANGED BOOK IDS (the edits driving this update): [2, 3, 9]');
    expect(out).not.toContain('2,3,9');
  });

  it('renders an empty changed list as []', () => {
    expect(buildUpdatePrompt([], new Map(), [], null)).toContain('update): []\n');
  });

  it('renders an integral inference_confidence as a Python float', () => {
    const traits = [
      {
        id: 1,
        claim: 'A.',
        polarity: 'reward',
        inference_confidence: pyFloat(1),
        exhibits: [1],
        contrasts: [],
      },
    ];
    const out = buildUpdatePrompt(traits, new Map(), [1], null);
    expect(out).toContain('"inference_confidence": 1.0');
    expect(out).not.toContain('"inference_confidence": 1,');
  });
});

function reviseResponse(traits: unknown[]) {
  return {
    content: [{ type: 'tool_use', name: 'revise_taste_traits', input: { traits } }],
    usage: { input_tokens: 5, output_tokens: 5 },
  };
}

describe('updateTasteProfile', () => {
  it('revises the trait set from the seeded changes', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const client = fakeClaude([
        reviseResponse([
          {
            claim: 'Rewards problem-solving under pressure.',
            polarity: 'reward',
            exhibits: [3],
            contrasts: [9999],
            inference_confidence: 0.9,
          },
        ]),
      ]);

      const out = await updateTasteProfile(db, client, 'local');

      expect(out.mode).toBe('update');
      expect(out.changed_books).toBe(3); // books 2, 3, 9
      expect(out.traits_before).toBe(2); // seeded proposed traits 1 and 3
      expect(out.traits_after).toBe(1);
      expect(typeof out.books_sent).toBe('number');

      const proposed = await db
        .select()
        .from(schema.tasteTraits)
        .where(
          and(eq(schema.tasteTraits.userId, 'local'), eq(schema.tasteTraits.status, 'proposed'))
        );
      expect(proposed).toHaveLength(1);
      // 9999 is not in books_meta, so it is filtered from contrasts.
      expect(proposed[0].contrasts).toEqual([]);

      const events = await db.select().from(schema.usageEvents);
      expect(events.some((e) => e.operation === 'profile_update')).toBe(true);
    } finally {
      await close();
    }
  });

  it('falls back to a full build when there is no prior profile', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await db
        .delete(schema.tasteTraits)
        .where(
          and(eq(schema.tasteTraits.userId, 'local'), eq(schema.tasteTraits.status, 'proposed'))
        );

      const client = fakeClaude([reviseResponse([])]);
      const out = await updateTasteProfile(db, client, 'local');
      expect(out.mode).toBe('full');
      // The full builder must have been the one that called Claude.
      expect(client.calls[0].params.tool_choice).toEqual({
        type: 'tool',
        name: 'record_taste_traits',
      });
    } finally {
      await close();
    }
  });

  it('falls back to a full build after an enrichment correction', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await db
        .update(schema.profileMeta)
        .set({ enrichmentCorrectedAt: '2026-07-25 12:00:00' })
        .where(eq(schema.profileMeta.userId, 'local'));

      const client = fakeClaude([reviseResponse([])]);
      const out = await updateTasteProfile(db, client, 'local');
      expect(out.mode).toBe('full');
      // The full builder must have been the one that called Claude, not the revise path.
      expect(client.calls[0].params.tool_choice).toEqual({
        type: 'tool',
        name: 'record_taste_traits',
      });
    } finally {
      await close();
    }
  });

  it('returns the up-to-date note without calling Claude when nothing changed', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      // Push the last-profiled stamp past every change in the seed.
      await db
        .update(schema.profileMeta)
        .set({ lastProfiledAt: '2027-01-01 00:00:00', recFeedbackUpdatedAt: null })
        .where(eq(schema.profileMeta.userId, 'local'));

      const client = fakeClaude([]);
      const out = await updateTasteProfile(db, client, 'local');

      expect(out).toEqual({
        mode: 'update',
        changed_books: 0,
        traits_before: 2,
        traits_after: 2,
        note: 'Profile already up to date — no rating/review changes since last build.',
        model: 'claude-sonnet-5',
      });
      expect('books_sent' in out).toBe(false);
      expect(client.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('falls back to a full build when only exclusion toggles changed', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await db
        .update(schema.profileMeta)
        .set({ lastProfiledAt: '2027-01-01 00:00:00', recFeedbackUpdatedAt: null })
        .where(eq(schema.profileMeta.userId, 'local'));
      // One excluded book with feedback after the cutoff: it counts as `changed`
      // but is filtered out of `changed_ids`.
      await db
        .update(schema.books)
        .set({ excludeFromProfile: true, feedbackUpdatedAt: '2027-02-01 00:00:00' })
        .where(eq(schema.books.id, 3));

      const client = fakeClaude([reviseResponse([])]);
      const out = await updateTasteProfile(db, client, 'local');
      expect(out.mode).toBe('full');
      // The full builder must have been the one that called Claude, not the revise path.
      expect(client.calls[0].params.tool_choice).toEqual({
        type: 'tool',
        name: 'record_taste_traits',
      });
    } finally {
      await close();
    }
  });

  it('falls through to the revise call with an empty changed-ids list when only feedback changed', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      // Push the last-profiled stamp past every book change in the seed, but stamp
      // rec_feedback_updated_at AFTER that cutoff: no changed books, but feedback
      // arrived since the last build. Branch-table row 5.
      await db
        .update(schema.profileMeta)
        .set({ lastProfiledAt: '2027-01-01 00:00:00', recFeedbackUpdatedAt: '2027-02-01 00:00:00' })
        .where(eq(schema.profileMeta.userId, 'local'));

      const client = fakeClaude([reviseResponse([])]);
      const out = await updateTasteProfile(db, client, 'local');

      expect(out.mode).toBe('update');
      expect(out.changed_books).toBe(0);
      // Must have fallen through to the Claude call (not the early-return note path).
      expect(client.calls).toHaveLength(1);
      expect(client.calls[0].params.tool_choice).toEqual({
        type: 'tool',
        name: 'revise_taste_traits',
      });
      const messages = client.calls[0].params.messages as { content: string }[];
      expect(messages[0].content).toContain('CHANGED BOOK IDS (the edits driving this update): []');
    } finally {
      await close();
    }
  });
});
