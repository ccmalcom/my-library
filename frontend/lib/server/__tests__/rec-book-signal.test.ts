import { describe, test, expect } from 'vitest';
import seedJson from './fixtures/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { buildBookSignal } from '../recSignal';
import { dedupKey } from '../recFilters';

describe('buildBookSignal', () => {
  test('seeds discovery from ONE book but excludes the WHOLE library', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const signal = (await buildBookSignal(db, 'local', 1))!;
      expect(signal).not.toBeNull();

      // Discovery seeds come from book 1 (Dune) alone.
      expect(signal.top_subjects).toEqual(['science fiction', 'space opera', 'politics']);
      expect(signal.top_authors).toEqual(['Frank Herbert']);
      expect(signal.anchor).toEqual({
        id: 1,
        title: 'Dune',
        author: 'Frank Herbert',
        year: 1965,
        subjects: ['science fiction', 'space opera', 'politics'],
        description: 'Melange, sandworms, prophecy.',
        series: null,
      });

      // Exclusion sets still cover every book the reader owns.
      expect(signal.library_keys.has(dedupKey('Kindred', 'Octavia E. Butler'))).toBe(true);
      expect(signal.library_keys.has(dedupKey('Dune', 'Frank Herbert'))).toBe(true);
      expect(signal.library_isbns.has('9780441013593')).toBe(true);
      expect(signal.library_authors.has('butler')).toBe(true);
    } finally {
      await close();
    }
  });

  test('PYTHON QUIRK: library_series and library_titles are always empty here', async () => {
    // _build_book_signal returns neither key; _assemble reads them as
    // `signal.get(...) or {}` / `or []`, so the series filter and the
    // fuzzy-duplicate filter are INERT on the similar path. Reproduced
    // deliberately -- do NOT populate them from the library.
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const signal = (await buildBookSignal(db, 'local', 1))!;
      expect(signal.library_series.size).toBe(0);
      expect(signal.library_titles).toEqual([]);
    } finally {
      await close();
    }
  });

  test('PYTHON QUIRK: rejected recommendations are NOT excluded', async () => {
    // _build_signal folds rejected recs into library_keys so they never resurface.
    // _build_book_signal does not, so a rejected book can come back as "similar".
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      const signal = (await buildBookSignal(db, 'local', 1))!;
      const rejected = (seedJson as any).recommendations.filter(
        (r: any) => r.status === 'rejected'
      );
      expect(rejected.length).toBeGreaterThan(0);
      for (const r of rejected) {
        expect(signal.library_keys.has(dedupKey(r.title, r.author))).toBe(false);
      }
    } finally {
      await close();
    }
  });

  test('an unenriched book still yields an anchor, with empty subjects', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      // Book 9 (Too Like the Lightning) has no enrichment row in the SEED.
      const signal = (await buildBookSignal(db, 'local', 9))!;
      expect(signal.top_subjects).toEqual([]);
      expect(signal.anchor.subjects).toEqual([]);
      expect(signal.anchor.description).toBeNull();
      expect(signal.anchor.series).toBeNull();
      expect(signal.anchor.author).toBe('Ada Palmer');
    } finally {
      await close();
    }
  });

  test('returns null for a missing book and for another tenant’s book', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      expect(await buildBookSignal(db, 'local', 999)).toBeNull();
      // Book 101 belongs to the other seeded tenant.
      expect(await buildBookSignal(db, 'local', 101)).toBeNull();
    } finally {
      await close();
    }
  });
});
