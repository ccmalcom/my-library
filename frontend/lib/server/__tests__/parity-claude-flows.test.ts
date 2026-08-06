import { asc, eq } from 'drizzle-orm';
import { describe, it, expect, vi } from 'vitest';
import responses from './fixtures/claude/responses.json';
import prompts from './fixtures/claude/prompts.json';
import seedJson from './fixtures/parity/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { fakeClaude } from './helpers/fakeClaude';
import { distillDirective, existingSignals } from '../directiveDistill';
import { cleanDirectiveConstraints } from '../directive';
import { deriveArchetype, lookupArchetype } from '../archetypeDerive';
import { generateRevealLines, REVEAL_MODEL } from '../revealLines';
import {
  DISTILL_NO_KEY_MESSAGE,
  ARCHETYPE_NO_KEY_MESSAGE,
  REVEAL_NO_KEY_MESSAGE,
  PROFILE_NO_KEY_MESSAGE,
  NO_RATED_BOOKS_MESSAGE,
} from '../claudeErrors';
import { makeAnthropicClient } from '../claude';
import { traitOut } from '../traits';
import { _setDbForTests } from '../db';
import { schema } from '../db';
import type { Seed } from './helpers/pglite';
import { setupParityEnv } from './helpers/parity';
import { POST as postRevealLines } from '../../../app/api/profile/reveal-lines/route';
import { POST as postDirectiveDraft } from '../../../app/api/directive/draft/route';
import { POST as postArchetype } from '../../../app/api/profile/archetype/route';
import { POST as postProfile } from '../../../app/api/profile/route';
import { POST as postProfileUpdate } from '../../../app/api/profile/update/route';

// finding 3 (wave-3a final review): directive/draft and profile/archetype's POST handlers
// had zero end-to-end route coverage (unlike reveal-lines' POST below), only service-level
// coverage of distillDirective/deriveArchetype. Both routes resolve their own Anthropic
// client via makeAnthropicClient(apiKey) (claude.ts) rather than taking an injected one, so
// getting fakeClaude onto the real route's success path means mocking that one factory
// function — everything else in the module (resolveAnthropicKey, toolInput) stays real via
// importOriginal, so the no-key/validation branches below still exercise real code.
vi.mock('@/lib/server/claude', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../claude')>();
  return { ...actual, makeAnthropicClient: vi.fn(actual.makeAnthropicClient) };
});

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
  // more/less direction split, and the target_kind = 'book' filter (row 8 with
  // target_kind = 'trait' but pointing at a real book id, direction 'more' — if the filter
  // were missing this would duplicate into more_like and fail the exact-equality assertion).
  //
  // Row ids are deliberately inserted OUT of ascending order (7 then 3; 10, 6, 9, 5) so this
  // test actually constrains existingSignals' `ORDER BY id ASC` (finding 4, wave-3a final
  // review): loadSeed inserts rows via sequential per-row INSERTs, and an unordered SELECT
  // over a freshly-inserted, never-updated table comes back in that same physical/insertion
  // order in practice (the same assumption revealLines.ts's own ordering test relies on) — so
  // with only one row per list (the previous version of this test), an unordered query and an
  // `ORDER BY id ASC` query are indistinguishable. Two rows per list, inserted id-descending,
  // makes them diverge: without the ORDER BY this test's assertions below would fail.
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
      {
        id: 3,
        user_id: 'local',
        title: 'Gamma',
        author: 'Greg Author',
        goodreads_rating: 5,
        source: 'goodreads',
      },
      {
        id: 4,
        user_id: 'local',
        title: 'Delta',
        author: null,
        goodreads_rating: 0,
        source: 'manual',
      },
    ],
    taste_signals: [
      { id: 10, user_id: 'local', direction: 'less', target_kind: 'book', target_book_id: 4 },
      { id: 6, user_id: 'local', direction: 'more', target_kind: 'book', target_book_id: 3 },
      { id: 9, user_id: 'local', direction: 'less', target_kind: 'book', target_book_id: 2 },
      { id: 5, user_id: 'local', direction: 'more', target_kind: 'book', target_book_id: 1 },
      { id: 8, user_id: 'local', direction: 'more', target_kind: 'trait', target_book_id: 1 },
    ],
    taste_traits: [
      {
        id: 7,
        user_id: 'local',
        claim: 'Dislikes unreliable narrators.',
        polarity: 'negative',
        inference_confidence: 0.5,
        status: 'rejected',
      },
      {
        id: 3,
        user_id: 'local',
        claim: 'Avoids grimdark tone.',
        polarity: 'negative',
        inference_confidence: 0.6,
        status: 'rejected',
      },
    ],
  };

  it('resolves target_book_id to "{title} by {author}" (or title alone), splits by direction, and orders every list by id ascending', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seed);
      const signals = await existingSignals(db, 'local');
      expect(signals).toEqual({
        rejected_traits: ['Avoids grimdark tone.', 'Dislikes unreliable narrators.'], // id 3, then id 7
        more_like: ['Alpha by Ann Author', 'Gamma by Greg Author'], // id 5, then id 6
        less_like: ['Beta', 'Delta'], // id 9, then id 10
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

describe('claude flow: reveal lines', () => {
  it('idempotent: no Claude call and no key needed when every trait already has a reveal_line (reveal.py:115-116)', async () => {
    const seed: Seed = {
      taste_traits: [
        {
          id: 1,
          user_id: 'local',
          claim: 'A',
          polarity: 'positive',
          inference_confidence: 0.9,
          status: 'proposed',
          reveal_line: 'Line A.',
        },
        {
          id: 2,
          user_id: 'local',
          claim: 'B',
          polarity: 'negative',
          inference_confidence: 0.5,
          status: 'proposed',
          reveal_line: 'Line B.',
        },
      ],
    };
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seed);

      const client = fakeClaude([]);
      const result = await generateRevealLines(db, client, 'local');
      expect(result).toEqual({ generated: 0, traits: 0, model: REVEAL_MODEL });
      expect(client.calls).toHaveLength(0);

      // A null client (no key configured) must also be safe here: Python only resolves a
      // key after confirming there's pending work, and there's none in this seed.
      const result2 = await generateRevealLines(db, null, 'local');
      expect(result2).toEqual({ generated: 0, traits: 0, model: REVEAL_MODEL });
    } finally {
      await close();
    }
  });

  it('throws ApiError(400, REVEAL_NO_KEY_MESSAGE) when there IS pending work but client is null (reveal.py:121-126)', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      await expect(generateRevealLines(db, null, 'local')).rejects.toMatchObject({
        status: 400,
        detail: REVEAL_NO_KEY_MESSAGE,
      });
      // Nothing was written.
      const trait3 = (
        await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 3))
      )[0];
      expect(trait3.revealLine).toBeNull();
    } finally {
      await close();
    }
  });

  it('generates lines only for pending traits (ids 3, 4) and persists them, leaving already-filled traits untouched (reveal.py:100-167)', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const fixture = (responses as any).reveal_lines;
      const client = fakeClaude([fixture]);

      const result = await generateRevealLines(db, client, 'local');
      expect(result).toEqual({ generated: 2, traits: 2, model: REVEAL_MODEL });
      expect(client.calls).toHaveLength(1);
      // Ties generateRevealLines's OWN pending-trait query (not just the pure
      // buildRevealPrompt helper covered by parity-prompts.test.ts) to the byte-exact
      // Python-captured prompt — catches a row-order regression in the query itself.
      expect((client.calls[0].params as any).messages[0].content).toBe(
        (prompts as any).reveal_lines.kwargs.messages[0].content
      );

      const rows = await db
        .select()
        .from(schema.tasteTraits)
        .where(eq(schema.tasteTraits.userId, 'local'))
        .orderBy(asc(schema.tasteTraits.id));
      expect(rows.map((r) => r.revealLine)).toEqual([
        'You read to argue with civilizations.', // id 1 — untouched, already had a line
        'Give you a problem and a wrench.', // id 2 — untouched, already had a line
        'You commit once and rarely wander back for a series.', // id 3 — newly written
        "Grimdark just isn't for you. You'd rather find light in the dark.", // id 4 — newly written
      ]);
    } finally {
      await close();
    }
  });

  it("only queries the requested user's pending traits — another tenant's pending trait (id 101) is excluded", async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const fixture = (responses as any).reveal_lines;
      const client = fakeClaude([fixture]);

      const result = await generateRevealLines(db, client, 'local');
      expect(result.traits).toBe(2); // not 3 — 'other' user's pending trait 101 excluded

      const other = (
        await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 101))
      )[0];
      expect(other.revealLine).toBeNull();
    } finally {
      await close();
    }
  });

  it('ignores returned ids outside the pending set — an already-filled trait and a nonexistent id are both dropped (reveal.py:154, 157-158)', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const client = fakeClaude([
        {
          content: [
            {
              type: 'tool_use',
              name: 'record_reveal_lines',
              input: {
                lines: [
                  { id: 3, reveal_line: 'A line for trait 3.' },
                  { id: 1, reveal_line: 'Should be ignored: not in the pending set.' },
                  { id: 999, reveal_line: 'Should be ignored: does not exist.' },
                ],
              },
            },
          ],
        },
      ]);

      const result = await generateRevealLines(db, client, 'local');
      expect(result).toEqual({ generated: 1, traits: 2, model: REVEAL_MODEL });

      const trait1 = (
        await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 1))
      )[0];
      expect(trait1.revealLine).toBe('You read to argue with civilizations.'); // unchanged

      const trait3 = (
        await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 3))
      )[0];
      expect(trait3.revealLine).toBe('A line for trait 3.');

      const trait4 = (
        await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 4))
      )[0];
      expect(trait4.revealLine).toBeNull(); // no line returned for it — stays null
    } finally {
      await close();
    }
  });

  it('does not overwrite a trait that gained a reveal_line concurrently between the Claude call and persistence (reveal.py:162-163)', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const fixture = (responses as any).reveal_lines; // proposes lines for both id 3 and id 4
      const calls: Array<{ params: Record<string, unknown> }> = [];
      const client = {
        calls,
        messages: {
          async create(params: Record<string, unknown>) {
            calls.push({ params });
            // Simulate another concurrent generation filling trait 3's reveal_line between
            // this call's prompt being built and its own persistence step running.
            await db
              .update(schema.tasteTraits)
              .set({ revealLine: 'Filled by someone else, concurrently.' })
              .where(eq(schema.tasteTraits.id, 3));
            return fixture;
          },
        },
      };

      const result = await generateRevealLines(db, client as any, 'local');
      expect(result.generated).toBe(1); // only id 4 — id 3 was already filled by persist time

      const trait3 = (
        await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 3))
      )[0];
      expect(trait3.revealLine).toBe('Filled by someone else, concurrently.'); // not overwritten

      const trait4 = (
        await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 4))
      )[0];
      expect(trait4.revealLine).toBe(
        "Grimdark just isn't for you. You'd rather find light in the dark."
      );
    } finally {
      await close();
    }
  });
});

describe('POST /api/profile/reveal-lines route', () => {
  setupParityEnv();

  it(
    'idempotent no-op requires no configured key at the real route, and returns TraitOut[] for ALL ' +
      'traits ordered by inference_confidence DESC — not the internal {generated, traits, model} ' +
      'dict generateRevealLines returns (api.py:1132-1153)',
    async () => {
      const seed: Seed = {
        taste_traits: [
          {
            id: 1,
            user_id: 'local',
            claim: 'A',
            polarity: 'positive',
            inference_confidence: 0.9,
            status: 'proposed',
            reveal_line: 'Line A.',
          },
          {
            id: 2,
            user_id: 'local',
            claim: 'B',
            polarity: 'negative',
            inference_confidence: 0.5,
            status: 'proposed',
            reveal_line: 'Line B.',
          },
        ],
      };
      const { db, close } = await makeTestDb();
      try {
        await loadSeed(db, seed);
        _setDbForTests(db);

        // setupParityEnv's beforeEach already deletes ANTHROPIC_API_KEY and there is no
        // stored user_settings key in this seed — if the route required a key
        // unconditionally (Task 6/7's pattern) this would 400 instead of 200.
        const res = await postRevealLines(
          new Request('http://test/api/profile/reveal-lines', { method: 'POST' })
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body)).toBe(true);
        expect(body).toHaveLength(2);
        // inference_confidence DESC: 0.9 (id 1) then 0.5 (id 2).
        expect(body.map((t: any) => t.id)).toEqual([1, 2]);

        const row1 = (
          await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 1))
        )[0];
        const row2 = (
          await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 2))
        )[0];
        expect(body[0]).toEqual(traitOut(row1));
        expect(body[1]).toEqual(traitOut(row2));

        // Not the internal generation-summary shape.
        expect(body[0]).not.toHaveProperty('generated');
        expect(body).not.toHaveProperty('generated');
        expect(body).not.toHaveProperty('model');
      } finally {
        _setDbForTests(null);
        await close();
      }
    }
  );
});

describe('POST /api/directive/draft route', () => {
  setupParityEnv();

  it('422s on an invalid body (message below the 1-char minimum)', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      const res = await postDirectiveDraft(
        new Request('http://test/api/directive/draft', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: '' }),
        })
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.detail).toMatch(/^validation error: /);
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  it('400s with the exact DISTILL_NO_KEY_MESSAGE when no key is configured (api.py:358-361)', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      // Deliberately does NOT load seedJson: that shared fixture has a stored, decryptable
      // anthropic_api_key_encrypted for user_id 'local' (left over from wave-2's api-key
      // write-parity fixtures), which would make resolveAnthropicKey succeed and this route
      // build a REAL Anthropic client — a live network call in a test, and a plan violation
      // (see this wave's Global Constraints). No seed data is needed for this assertion:
      // the route resolves the key before touching taste_traits/taste_signal at all, and an
      // empty user_settings table falls through to ANTHROPIC_API_KEY, which setupParityEnv's
      // beforeEach has already deleted, so resolveAnthropicKey correctly resolves to null.
      const res = await postDirectiveDraft(
        new Request('http://test/api/directive/draft', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'more literary sci-fi please' }),
        })
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ detail: DISTILL_NO_KEY_MESSAGE });
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  it(
    'succeeds end-to-end with current_text omitted (nullish -> null), via fakeClaude wired into the ' +
      'real makeAnthropicClient(apiKey) construction path (see the vi.mock at the top of this file)',
    async () => {
      const { db, close } = await makeTestDb();
      try {
        await loadSeed(db, seedJson as any);
        _setDbForTests(db);
        process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-real-key'; // never dials out — makeAnthropicClient is mocked
        const fixture = (responses as any).directive_distill;
        vi.mocked(makeAnthropicClient).mockReturnValueOnce(fakeClaude([fixture]));

        const res = await postDirectiveDraft(
          new Request('http://test/api/directive/draft', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              message: 'I want more literary sci-fi, nothing grimdark, and no John Ringo.',
            }),
          })
        );
        expect(res.status).toBe(200);
        const expected = fixture.content[0].input;
        expect(await res.json()).toEqual({
          proposed_text: expected.proposed_text,
          constraints: cleanDirectiveConstraints(expected.constraints),
          conflicts: expected.conflicts,
          assistant_message: expected.assistant_message,
        });
      } finally {
        _setDbForTests(null);
        await close();
      }
    }
  );

  it('also accepts an explicit current_text: null without a 422 (Zod .nullish() — both variants reach the route)', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      _setDbForTests(db);
      process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-real-key';
      const fixture = (responses as any).directive_distill;
      vi.mocked(makeAnthropicClient).mockReturnValueOnce(fakeClaude([fixture]));

      const res = await postDirectiveDraft(
        new Request('http://test/api/directive/draft', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'anything', current_text: null }),
        })
      );
      expect(res.status).toBe(200);
    } finally {
      _setDbForTests(null);
      await close();
    }
  });
});

describe('POST /api/profile/archetype route', () => {
  setupParityEnv();

  it('400s with the exact ARCHETYPE_NO_KEY_MESSAGE when no key is configured (api.py:230-234)', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      // Deliberately does NOT load seedJson: see the identical note on the directive/draft
      // no-key test above. The route resolves the key before ever querying taste_traits, so
      // no seed data is needed, and loading the shared fixture would falsely "configure" a
      // key via its stored user_settings row for 'local', triggering a real network call.
      const res = await postArchetype(
        new Request('http://test/api/profile/archetype', { method: 'POST' })
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ detail: ARCHETYPE_NO_KEY_MESSAGE });
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  it('400s "No taste profile found" when a key IS configured but the user has zero taste traits (archetype.py:236-238)', async () => {
    const { db, close } = await makeTestDb();
    try {
      // No loadSeed at all — zero taste_traits rows for 'local'. deriveArchetype's own guard
      // fires before ever touching Claude, so makeAnthropicClient's default (real,
      // unmocked-for-this-test) passthrough is fine: constructing an Anthropic client is
      // local/synchronous and never dials out on its own.
      _setDbForTests(db);
      process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-real-key';
      const res = await postArchetype(
        new Request('http://test/api/profile/archetype', { method: 'POST' })
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        detail: 'No taste profile found. Build your taste profile first.',
      });
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  it(
    'succeeds end-to-end via fakeClaude wired into the real makeAnthropicClient(apiKey) construction ' +
      'path, and a subsequent GET reflects the same freshly-derived row (no POST/GET shape drift)',
    async () => {
      const { db, close } = await makeTestDb();
      try {
        await loadSeed(db, seedJson as any);
        _setDbForTests(db);
        process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-real-key';
        const fixture = (responses as any).archetype;
        vi.mocked(makeAnthropicClient).mockReturnValueOnce(fakeClaude([fixture]));

        const res = await postArchetype(
          new Request('http://test/api/profile/archetype', { method: 'POST' })
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        const expected = fixture.content[0].input;
        expect(body.code).toBe('RCBH');
        expect(body.name).toBe('The Literary Wanderer');
        expect(body.tagline).toBe('Voice and feeling, across every genre.');
        expect(body.lens).toEqual({
          score: expected.lens,
          letter: 'R',
          rationale: expected.lens_rationale,
        });
        expect(typeof body.derived_at).toBe('string');
        expect(body.is_stale).toBe(false);
      } finally {
        _setDbForTests(null);
        await close();
      }
    }
  );

  // The 500 "Archetype upsert failed" branch (route.ts: `if (!row) throw new ApiError(500, ...)`)
  // requires deriveArchetype to resolve successfully WITHOUT having written a reader_archetypes
  // row for ctx.user.userId — but deriveArchetype's own db.transaction always upserts a row for
  // exactly that userId before returning (archetypeDerive.ts:246-259), and the route re-queries
  // with that same userId immediately after. Structurally unreachable through the real route,
  // confirming Task 7's own report; not forcing an artificial/awkward test for it.
});

// Finding 1 (wave-3b final review): neither of this wave's two new POST routes had any
// route-level coverage — only GET /api/profile (parity-profile.test.ts) and the
// extractTasteProfile/updateTasteProfile service functions (profile-build.test.ts,
// profile-update.test.ts) were exercised directly. Follows the exact pattern established
// above for directive/draft and profile/archetype: the vi.mock('@/lib/server/claude', ...)
// at the top of this file leaves resolveAnthropicKey/toolInput real, so the no-key path
// below runs real code, and only makeAnthropicClient's return value is swapped for
// fakeClaude on the success path.
function traitsToolResponse(traits: unknown[]) {
  return {
    content: [{ type: 'tool_use', name: 'record_taste_traits', input: { traits } }],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function reviseToolResponse(traits: unknown[]) {
  return {
    content: [{ type: 'tool_use', name: 'revise_taste_traits', input: { traits } }],
    usage: { input_tokens: 5, output_tokens: 5 },
  };
}

describe('POST /api/profile route', () => {
  setupParityEnv();

  it('400s with the exact PROFILE_NO_KEY_MESSAGE when no key is configured (api.py:642-645)', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      // Deliberately does NOT load seedJson — see the identical note on the directive/draft
      // and archetype no-key tests above. resolveAnthropicKey resolves before extractTasteProfile
      // ever touches book data, so no seed is needed: an empty user_settings table falls
      // through to ANTHROPIC_API_KEY, which setupParityEnv's beforeEach has already deleted.
      const res = await postProfile(new Request('http://test/api/profile', { method: 'POST' }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ detail: PROFILE_NO_KEY_MESSAGE });
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  it('400s with the exact NO_RATED_BOOKS_MESSAGE when a key IS configured but the user has zero rated books', async () => {
    const { db, close } = await makeTestDb();
    try {
      // No loadSeed at all — zero books for 'local'. extractTasteProfile's own guard fires
      // before ever touching Claude (mirrors the archetype route's "no taste traits" test),
      // so makeAnthropicClient's default (real, unmocked-for-this-test) passthrough is fine.
      _setDbForTests(db);
      process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-real-key';
      const res = await postProfile(new Request('http://test/api/profile', { method: 'POST' }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ detail: NO_RATED_BOOKS_MESSAGE });
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  it(
    'succeeds end-to-end via fakeClaude wired into the real makeAnthropicClient(apiKey) ' +
      'construction path, returning the {mode, rated_books, tiers, traits_saved, model} shape',
    async () => {
      const { db, close } = await makeTestDb();
      try {
        await loadSeed(db, seedJson as any);
        _setDbForTests(db);
        process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-real-key';
        vi.mocked(makeAnthropicClient).mockReturnValueOnce(
          fakeClaude([
            traitsToolResponse([
              {
                claim: 'Rewards dense political world-building.',
                polarity: 'reward',
                exhibits: [1, 2],
                contrasts: [6],
                inference_confidence: 0.87,
              },
            ]),
          ])
        );

        const res = await postProfile(new Request('http://test/api/profile', { method: 'POST' }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.mode).toBe('full');
        expect(body.rated_books).toBe(13); // every tier except `rejected`, per profile-build.test.ts
        expect(body.traits_saved).toBe(1);
        expect(body.model).toBe('claude-sonnet-5');
        expect(body.tiers).toEqual({ '5': 7, '4': 3, '3': 1, '<=2': 1, dnf: 1, rejected: 1 });
      } finally {
        _setDbForTests(null);
        await close();
      }
    }
  );
});

describe('POST /api/profile/update route', () => {
  setupParityEnv();

  it('400s with the exact PROFILE_NO_KEY_MESSAGE when no key is configured (api.py:909-916)', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      // Same rationale as the /api/profile no-key test above — no seed needed.
      const res = await postProfileUpdate(
        new Request('http://test/api/profile/update', { method: 'POST' })
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ detail: PROFILE_NO_KEY_MESSAGE });
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  it(
    '400s with the exact NO_RATED_BOOKS_MESSAGE when a key IS configured, there is no prior ' +
      'profile, and the user has zero rated books: updateTasteProfile.py\'s own "no prior profile" ' +
      'branch (existing.length === 0) delegates straight to extractTasteProfile, which is the ' +
      'most direct no-Claude-call scenario this route naturally exercises',
    async () => {
      const { db, close } = await makeTestDb();
      try {
        // No loadSeed: zero proposed traits and no profile_meta row yet, so
        // updateTasteProfile falls through to extractTasteProfile before any Claude call.
        _setDbForTests(db);
        process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-real-key';
        const res = await postProfileUpdate(
          new Request('http://test/api/profile/update', { method: 'POST' })
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ detail: NO_RATED_BOOKS_MESSAGE });
      } finally {
        _setDbForTests(null);
        await close();
      }
    }
  );

  it(
    'succeeds end-to-end via fakeClaude wired into the real makeAnthropicClient(apiKey) ' +
      'construction path, revising the seeded profile from its detected book changes',
    async () => {
      const { db, close } = await makeTestDb();
      try {
        await loadSeed(db, seedJson as any);
        _setDbForTests(db);
        process.env.ANTHROPIC_API_KEY = 'sk-test-not-a-real-key';
        vi.mocked(makeAnthropicClient).mockReturnValueOnce(
          fakeClaude([
            reviseToolResponse([
              {
                claim: 'Rewards problem-solving under pressure.',
                polarity: 'reward',
                exhibits: [3],
                contrasts: [],
                inference_confidence: 0.9,
              },
            ]),
          ])
        );

        const res = await postProfileUpdate(
          new Request('http://test/api/profile/update', { method: 'POST' })
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.mode).toBe('update');
        expect(body.changed_books).toBe(3); // seeded books 2, 3, 9 — see profile-update.test.ts
        expect(body.traits_before).toBe(2); // seeded proposed traits 1 and 3
        expect(body.traits_after).toBe(1);
        expect(body.model).toBe('claude-sonnet-5');
      } finally {
        _setDbForTests(null);
        await close();
      }
    }
  );
});
