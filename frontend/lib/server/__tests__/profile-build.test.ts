import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestDb, loadSeed } from './helpers/pglite';
import seedJson from './fixtures/parity/seed.json';
import type { Seed } from './helpers/pglite';
import { tierFor, buildTiers } from '../profileTiers';
import { pyJsonDumps } from '../serialize';
import { feedbackContext, feedbackBlock, claimTokens, removeRejectedClaims } from '../profileFeedback';
import { schema } from '../db';

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

describe('feedbackContext', () => {
  it('buckets trait verdicts, favorites and the directive from the seed', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const ctx = await feedbackContext(db, 'local');

      expect(ctx.confirmed).toEqual(['Values competence and problem-solving protagonists.']);
      expect(ctx.edited).toEqual([]);
      expect(ctx.rejected).toEqual(['Avoids grimdark tone.']);
      // Trait 4 has user_weight 0.0 but status 'rejected', so it is NOT downweighted.
      expect(ctx.downweighted).toEqual([]);
      expect(ctx.favorites).toEqual(['The Dispossessed by Ursula K. Le Guin']);
      expect(ctx.directive_text).toBe('More literary sci-fi, no grimdark.');
      // The shared seed has no taste_signal rows.
      expect(ctx.more_like).toEqual([]);
      expect(ctx.less_like).toEqual([]);
    } finally {
      await close();
    }
  });

  it('splits taste signals into more/less by direction, in id order', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      // Seeded out of id order on purpose: an unordered query could pass by luck.
      await db.insert(schema.tasteSignal).values([
        { id: 2, userId: 'local', targetKind: 'book', targetBookId: 5, direction: 'less' },
        { id: 1, userId: 'local', targetKind: 'book', targetBookId: 1, direction: 'more' },
        { id: 3, userId: 'local', targetKind: 'book', targetBookId: 12, direction: 'more' },
        // Another tenant's signal must be ignored.
        { id: 4, userId: 'other', targetKind: 'book', targetBookId: 101, direction: 'more' },
        // A rec-kind signal is out of scope for this bucket.
        { id: 5, userId: 'local', targetKind: 'rec', targetBookId: 2, direction: 'more' },
      ]);

      const ctx = await feedbackContext(db, 'local');
      expect(ctx.more_like).toEqual([
        'Dune by Frank Herbert',
        'The Fifth Season by N.K. Jemisin',
      ]);
      expect(ctx.less_like).toEqual(['Foundation by Isaac Asimov']);
    } finally {
      await close();
    }
  });

  it('treats an empty constraints object as no directive (Python dict falsiness)', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await db
        .update(schema.userDirective)
        .set({ nlText: null, constraints: {} })
        .where(eq(schema.userDirective.userId, 'local'));
      const ctx = await feedbackContext(db, 'local');
      expect(ctx.directive_text).toBeNull();
    } finally {
      await close();
    }
  });
});

describe('feedbackBlock', () => {
  const empty = {
    confirmed: [], edited: [], rejected: [], downweighted: [],
    more_like: [], less_like: [], favorites: [], directive_text: null,
  };

  it('returns an empty string when nothing is set', () => {
    expect(feedbackBlock(empty)).toBe('');
    expect(feedbackBlock(null)).toBe('');
  });

  it('merges confirmed and edited into one locked-traits line', () => {
    const out = feedbackBlock({ ...empty, confirmed: ['A.'], edited: ['B.'] });
    expect(out).toBe(
      '\n\n## User Feedback\n' +
        '- The following traits are already locked in by the user and are stored ' +
        'separately — do NOT output them (or reworded variants) in your trait ' +
        'list, and do not contradict them: A.; B.\n'
    );
  });

  it('renders a downweighted float the way Python str(float) does', () => {
    const out = feedbackBlock({
      ...empty,
      downweighted: [{ claim: 'Likes long books.', user_weight: 0.5 }, { claim: 'X.', user_weight: 1 }],
    });
    expect(out).toContain('Likes long books. (weight 0.5); X. (weight 1.0)');
  });

  it('emits one dash-prefixed line per populated bucket, in Python order', () => {
    const out = feedbackBlock({
      ...empty,
      rejected: ['R.'],
      more_like: ['M by A'],
      less_like: ['L by B'],
      favorites: ['F by C'],
      directive_text: '  Keep it literary.  ',
    });
    const lines = out.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('rejected by the user');
    expect(lines[1]).toContain('MORE recommendations like: M by A');
    expect(lines[2]).toContain('FEWER recommendations like: L by B');
    expect(lines[3]).toContain('all-time favorite books');
    expect(lines[4]).toContain('custom instructions');
    expect(lines[4]).toContain('Keep it literary.'); // trimmed
  });
});

describe('removeRejectedClaims', () => {
  const t = (claim: string) => ({ claim });

  it('returns the input untouched when there is nothing rejected', () => {
    const traits = [t('A.')];
    expect(removeRejectedClaims(traits, [])).toBe(traits);
  });

  it('drops a case-insensitive substring match in either direction', () => {
    const kept = removeRejectedClaims(
      [t('Loves SPARKLY VAMPIRE romance above all.'), t('Rewards dense world-building.')],
      ['sparkly vampire romance']
    );
    expect(kept.map((x) => x.claim)).toEqual(['Rewards dense world-building.']);
  });

  it('drops a reworded variant on >=60% significant-token overlap', () => {
    // rejected tokens: {enjoys, sparkly, vampire, romance} -> 3/4 = 0.75
    const kept = removeRejectedClaims(
      [t('Sparkly vampire stories are a romance staple here.')],
      ['Enjoys sparkly vampire romance.']
    );
    expect(kept).toEqual([]);
  });

  it('keeps a trait below the overlap threshold', () => {
    // 1/4 = 0.25
    const kept = removeRejectedClaims([t('Enjoys hard science fiction.')], ['Enjoys sparkly vampire romance.']);
    expect(kept.map((x) => x.claim)).toEqual(['Enjoys hard science fiction.']);
  });

  it('keeps a trait whose claim is empty rather than matching everything', () => {
    // Guard on Python's `if claim_lower and ...`: '' is a substring of every string.
    const kept = removeRejectedClaims([{ claim: '' }], ['Anything at all.']);
    expect(kept).toHaveLength(1);
  });
});

describe('claimTokens', () => {
  it('lowercases, splits on non-alphanumerics and drops stopwords', () => {
    expect([...claimTokens('The reader, above all, is NOT a fan of X-99.')].sort()).toEqual(
      ['99', 'fan', 'reader', 'x'].sort()
    );
  });
});
