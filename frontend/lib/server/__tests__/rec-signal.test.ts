import { describe, test, expect } from 'vitest';
import { makeTestDb, loadSeed } from './helpers/pglite';
import seedJson from './fixtures/parity/seed.json';
import { buildSignal, isColdStart, mostCommon } from '../recSignal';
import { isPyFloat } from '../serialize';

describe('mostCommon', () => {
  test('sorts by count desc, breaking ties by insertion order (Counter.most_common)', () => {
    const counts = new Map([
      ['b', 2],
      ['a', 2],
      ['c', 1],
    ]);
    expect(mostCommon(counts, 2)).toEqual(['b', 'a']);
    expect(mostCommon(counts, 10)).toEqual(['b', 'a', 'c']);
    expect(mostCommon(new Map(), 3)).toEqual([]);
  });
});

describe('buildSignal', () => {
  test('summarizes the seeded library the way Python does', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const s = await buildSignal(db, 'local');

      // loved = effective_rating >= 4, sorted by (rating, read_year||0) DESC, stable.
      // Dune (5, read 2025) leads; the other 5s keep id order because read_year is null.
      expect(s.loved.map((b) => b.id)).toEqual([1, 2, 3, 7, 11, 12, 13, 4, 10, 14]);
      expect(s.loved[0]).toMatchObject({ id: 1, title: 'Dune', rating: 5, read_year: 2025 });
      expect(s.loved[1].read_year).toBeNull();
      expect(s.loved[0].subjects).toHaveLength(3);

      // Exclusion sets cover the WHOLE library, not just loved books.
      expect(s.library_keys.size).toBeGreaterThanOrEqual(14);
      expect(s.library_isbns.has('9780441013593')).toBe(true);
      expect(s.library_titles).toContain('Piranesi'); // to-read shelf still excluded
      expect(s.library_authors.has('herbert')).toBe(true);

      // Another tenant's books never leak in.
      expect(s.library_titles).not.toContain("Someone Else's Book");

      expect(s.rated_count).toBeGreaterThan(0);
      expect(s.top_subjects.length).toBeLessThanOrEqual(8);
      expect(s.top_authors.length).toBeLessThanOrEqual(6);

      // Traits: rejected ones are dropped; confidence and user_weight are PyFloats so
      // they render as 0.95 / 1.0 rather than JS's 0.95 / 1.
      expect(s.traits.every((t) => t.status !== 'rejected')).toBe(true);
      expect(isPyFloat(s.traits[0].confidence)).toBe(true);
      expect(isPyFloat(s.traits[0].user_weight)).toBe(true);

      // Ordered mappings must be Maps, not objects (V8 reorders integer-like keys).
      expect(s.reject_reason_counts).toBeInstanceOf(Map);
      expect(s.library_series).toBeInstanceOf(Map);
    } finally {
      await close();
    }
  });

  test('an empty library yields an empty, well-formed signal', async () => {
    const { db, close } = await makeTestDb();
    try {
      const s = await buildSignal(db, 'local');
      expect(s.loved).toEqual([]);
      expect(s.rated_count).toBe(0);
      expect(s.traits).toEqual([]);
      expect(s.directive_text).toBeNull();
      expect(s.directive_constraints).toEqual({});
      expect(isColdStart(s)).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('isColdStart', () => {
  test('trips below either threshold', () => {
    const mk = (loved: number, rated: number) =>
      ({ loved: Array(loved).fill({}), rated_count: rated }) as any;
    expect(isColdStart(mk(8, 12))).toBe(false);
    expect(isColdStart(mk(7, 12))).toBe(true);
    expect(isColdStart(mk(8, 11))).toBe(true);
  });
});
