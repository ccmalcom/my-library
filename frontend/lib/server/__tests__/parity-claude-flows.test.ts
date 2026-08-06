import { eq } from 'drizzle-orm';
import { describe, it, expect } from 'vitest';
import responses from './fixtures/claude/responses.json';
import seedJson from './fixtures/parity/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { fakeClaude } from './helpers/fakeClaude';
import { distillDirective, existingSignals } from '../directiveDistill';
import { cleanDirectiveConstraints } from '../directive';
import { deriveArchetype, lookupArchetype } from '../archetypeDerive';
import { schema } from '../db';
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

describe('claude flow: archetype derive', () => {
  it('derives 4-axis scores from a record_archetype_scores tool_use response and updates the existing row', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const fixture = (responses as any).archetype;
      const client = fakeClaude([fixture]);
      const expected = fixture.content[0].input;

      const result = await deriveArchetype(db, client, 'local');

      expect(result).toEqual({
        code: 'RCBH',
        name: 'The Literary Wanderer',
        tagline: 'Voice and feeling, across every genre.',
        axisLens: expected.lens,
        axisEngine: expected.engine,
        axisRange: expected.range,
        axisResonance: expected.resonance,
        lensRationale: expected.lens_rationale,
        engineRationale: expected.engine_rationale,
        rangeRationale: expected.range_rationale,
        resonanceRationale: expected.resonance_rationale,
        derivedAt: result.derivedAt,
      });
      expect(client.calls).toHaveLength(1);

      // The seed already has a reader_archetypes row (id=1) for 'local' — this must
      // update that row in place, not insert a second one (upsert, not append-only).
      const rows = await db
        .select()
        .from(schema.readerArchetypes)
        .where(eq(schema.readerArchetypes.userId, 'local'));
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(1);
      expect(rows[0].code).toBe('RCBH');
      expect(rows[0].axisLens).toBe(expected.lens);
      expect(rows[0].lensRationale).toBe(expected.lens_rationale);
    } finally {
      await close();
    }
  });

  it('inserts a new row when the user has no prior derived archetype', async () => {
    const seed: Seed = {
      taste_traits: [
        {
          id: 1,
          user_id: 'local',
          claim: 'Drawn to idea-driven science fiction.',
          polarity: 'positive',
          inference_confidence: 0.9,
          status: 'confirmed',
        },
      ],
    };
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seed);
      const fixture = (responses as any).archetype;
      const client = fakeClaude([fixture]);

      await deriveArchetype(db, client, 'local');

      const rows = await db
        .select()
        .from(schema.readerArchetypes)
        .where(eq(schema.readerArchetypes.userId, 'local'));
      expect(rows).toHaveLength(1);
      expect(rows[0].code).toBe('RCBH');
    } finally {
      await close();
    }
  });

  it('clamps out-of-range axis scores to [-1, 1] (Python archetype.py::_clamp_axis)', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClaude([
        {
          content: [
            {
              type: 'tool_use',
              name: 'record_archetype_scores',
              input: {
                lens: 1.7,
                engine: -1.7,
                range: 0.5,
                resonance: -0.5,
                lens_rationale: '',
                engine_rationale: '',
                range_rationale: '',
                resonance_rationale: '',
              },
            },
          ],
        },
      ]);

      const result = await deriveArchetype(db, client, 'local');

      expect(result.axisLens).toBe(1.0);
      expect(result.axisEngine).toBe(-1.0);
      expect(result.axisRange).toBe(0.5);
      expect(result.axisResonance).toBe(-0.5);
    } finally {
      await close();
    }
  });

  it('scores exactly 0.0 as the LEFT letter on every axis (score > 0 is the only right-letter case)', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClaude([
        {
          content: [
            {
              type: 'tool_use',
              name: 'record_archetype_scores',
              input: {
                lens: 0.0,
                engine: 0.0,
                range: 0.0,
                resonance: 0.0,
                lens_rationale: '',
                engine_rationale: '',
                range_rationale: '',
                resonance_rationale: '',
              },
            },
          ],
        },
      ]);

      const result = await deriveArchetype(db, client, 'local');
      expect(result.code).toBe('IPBH');
    } finally {
      await close();
    }
  });

  it('assembles the 4-char code in lens, engine, range, resonance order', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClaude([
        {
          content: [
            {
              type: 'tool_use',
              name: 'record_archetype_scores',
              input: {
                lens: 1, // R
                engine: -1, // P
                range: 1, // D
                resonance: -1, // H
                lens_rationale: '',
                engine_rationale: '',
                range_rationale: '',
                resonance_rationale: '',
              },
            },
          ],
        },
      ]);

      const result = await deriveArchetype(db, client, 'local');
      expect(result.code).toBe('RPDH');
    } finally {
      await close();
    }
  });

  it('defaults an omitted rationale field to "" (Python: tool_input.get("..._rationale", ""))', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClaude([
        {
          content: [
            {
              type: 'tool_use',
              name: 'record_archetype_scores',
              input: { lens: 0.1, engine: 0.1, range: 0.1, resonance: 0.1 },
            },
          ],
        },
      ]);

      const result = await deriveArchetype(db, client, 'local');
      expect(result.lensRationale).toBe('');
      expect(result.engineRationale).toBe('');
      expect(result.rangeRationale).toBe('');
      expect(result.resonanceRationale).toBe('');
    } finally {
      await close();
    }
  });

  it('throws ApiError(400) when the user has no taste traits (archetype.py:236-238)', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, {});
      const client = fakeClaude([]);
      await expect(deriveArchetype(db, client, 'local')).rejects.toMatchObject({
        status: 400,
        detail: 'No taste profile found. Build your taste profile first.',
      });
      expect(client.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it('throws ApiError(400) when the response has no tool_use block (archetype.py:265-267)', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClaude([{ content: [{ type: 'text', text: 'no tool call' }] }]);
      await expect(deriveArchetype(db, client, 'local')).rejects.toMatchObject({
        status: 400,
        detail: 'Claude response missing tool payload (record_archetype_scores).',
      });
    } finally {
      await close();
    }
  });

  it('throws ApiError(400) on a non-finite axis score (archetype.py::_clamp_axis)', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClaude([
        {
          content: [
            {
              type: 'tool_use',
              name: 'record_archetype_scores',
              input: {
                lens: Infinity,
                engine: 0,
                range: 0,
                resonance: 0,
                lens_rationale: '',
                engine_rationale: '',
                range_rationale: '',
                resonance_rationale: '',
              },
            },
          ],
        },
      ]);
      await expect(deriveArchetype(db, client, 'local')).rejects.toMatchObject({
        status: 400,
        detail: 'Claude returned a non-finite axis score.',
      });
    } finally {
      await close();
    }
  });

  it('lookupArchetype throws ApiError(400) for an unrecognized code (archetype.py:288-290, defensive — all 16 codes are covered in practice)', () => {
    expect(() => lookupArchetype('ZZZZ')).toThrow();
    try {
      lookupArchetype('ZZZZ');
      expect.unreachable();
    } catch (err) {
      expect((err as any).status).toBe(400);
      expect((err as any).detail).toBe('Unknown archetype code derived: ZZZZ');
    }
  });
});
