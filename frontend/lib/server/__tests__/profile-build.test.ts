import { describe, it, expect } from 'vitest';
import { makeTestDb, loadSeed } from './helpers/pglite';
import seedJson from './fixtures/parity/seed.json';
import type { Seed } from './helpers/pglite';
import { tierFor, buildTiers } from '../profileTiers';
import { pyJsonDumps } from '../serialize';

describe('tierFor', () => {
  it('buckets ratings the way profile._tier does', () => {
    expect(tierFor(5)).toBe('5');
    expect(tierFor(4)).toBe('4');
    expect(tierFor(3)).toBe('3');
    expect(tierFor(2)).toBe('<=2');
    expect(tierFor(1)).toBe('<=2');
  });
});

describe('buildTiers', () => {
  it('groups the seeded library into Python-ordered tiers', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const tiers = await buildTiers(db, 'local');

      // Key order must match profile.py's dict literal exactly.
      expect([...tiers.keys()]).toEqual(['5', '4', '3', '<=2', 'dnf', 'rejected']);

      const ids = (k: string) => tiers.get(k)!.map((b) => b.id);
      // 1,2,11,12,13 are goodreads_rating 5; 3 is app_rating 5; 7 is app_rating 5.
      expect(ids('5')).toEqual([1, 2, 3, 7, 11, 12, 13]);
      expect(ids('4')).toEqual([4, 10, 14]);
      expect(ids('3')).toEqual([5]);
      expect(ids('<=2')).toEqual([6]);
      // Book 9 is did-not-finish; it is bucketed before its rating is considered.
      expect(ids('dnf')).toEqual([9]);
      // Book 8 is unrated and on to-read: excluded entirely.
      expect(ids('5').concat(ids('4'), ids('3'), ids('<=2'))).not.toContain(8);
      // The other tenant's books must never appear.
      expect(JSON.stringify([...tiers.values()])).not.toContain('101');
    } finally {
      await close();
    }
  });

  it('carries the payload fields profile._book_payload emits, in order', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const tiers = await buildTiers(db, 'local');
      const dune = tiers.get('5')!.find((b) => b.id === 1)!;

      expect(Object.keys(dune)).toEqual([
        'id', 'title', 'author', 'year', 'pages', 'subjects', 'series', 'read_year',
      ]);
      expect(dune).toMatchObject({
        id: 1,
        title: 'Dune',
        author: 'Frank Herbert',
        year: 1965,
        pages: 412,
        subjects: ['science fiction', 'space opera', 'politics'],
        series: null,
        read_year: 2025, // date_read 2025-11-02 wins over date_added 2025-10-01
      });

      // A book with an app_review gets a trailing `review` key; one without does not.
      const phm = tiers.get('5')!.find((b) => b.id === 3)!;
      expect(Object.keys(phm)).toEqual([
        'id', 'title', 'author', 'year', 'pages', 'subjects', 'series', 'read_year', 'review',
      ]);
      expect(phm.review).toBe('Loved the problem-solving.');

      // Book 9 (DNF) has no enrichment row at all.
      const tltl = tiers.get('dnf')![0];
      expect(tltl).toMatchObject({ id: 9, subjects: [], series: null });
    } finally {
      await close();
    }
  });

  it('surfaces rejected recommendations that carry a note, and only those', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const tiers = await buildTiers(db, 'local');
      // rec 1 is rejected WITH a note; rec 5 is rejected with user_note null.
      expect(tiers.get('rejected')).toEqual([
        { title: 'Blindsight', author: 'Peter Watts', note: 'not for me' },
      ]);
    } finally {
      await close();
    }
  });

  it('serializes with Python key order once handed to pyJsonDumps', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const tiers = await buildTiers(db, 'local');
      const json = pyJsonDumps(tiers);
      expect(json.indexOf('"5"')).toBeLessThan(json.indexOf('"4"'));
      expect(json.indexOf('"4"')).toBeLessThan(json.indexOf('"3"'));
      expect(json.indexOf('"3"')).toBeLessThan(json.indexOf('"<=2"'));
    } finally {
      await close();
    }
  });
});
