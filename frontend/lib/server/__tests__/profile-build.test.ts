import { describe, it, expect } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { fakeClaude } from './helpers/fakeClaude';
import seedJson from './fixtures/parity/seed.json';
import type { Seed } from './helpers/pglite';
import { tierFor, buildTiers } from '../profileTiers';
import { pyJsonDumps } from '../serialize';
import {
  feedbackContext,
  feedbackBlock,
  claimTokens,
  removeRejectedClaims,
} from '../profileFeedback';
import { extractTasteProfile } from '../profileBuild';
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

describe('tierFor with half stars', () => {
  it('gives half stars their own buckets', () => {
    expect(tierFor(5)).toBe('5');
    expect(tierFor(4.5)).toBe('4.5');
    expect(tierFor(4)).toBe('4');
    expect(tierFor(3.5)).toBe('3.5');
    expect(tierFor(3)).toBe('3');
  });

  it('collapses everything at or below 2.5 into <=2', () => {
    expect(tierFor(2.5)).toBe('<=2');
    expect(tierFor(2)).toBe('<=2');
    expect(tierFor(0.5)).toBe('<=2');
  });

  it('still treats above-5 as the top tier', () => {
    expect(tierFor(5.5)).toBe('5');
  });
});

describe('buildTiers key order', () => {
  it('emits buckets in prompt order', async () => {
    const { db, close } = await makeTestDb();
    try {
      // Order is load-bearing: the Map is serialized into the Claude prompt,
      // and '4.5'/'3.5' are not integer-like, so a plain object would order
      // them differently again.
      const tiers = await buildTiers(db, 'local');
      expect([...tiers.keys()]).toEqual(['5', '4.5', '4', '3.5', '3', '<=2', 'dnf', 'rejected']);
    } finally {
      await close();
    }
  });
});

describe('buildTiers', () => {
  it('groups the seeded library into the eight half-star tiers, in prompt order', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const tiers = await buildTiers(db, 'local');

      // This deliberately diverges from Python's six buckets per Global Constraint 1.
      expect([...tiers.keys()]).toEqual(['5', '4.5', '4', '3.5', '3', '<=2', 'dnf', 'rejected']);

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
        'id',
        'title',
        'author',
        'year',
        'pages',
        'subjects',
        'series',
        'read_year',
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
        'id',
        'title',
        'author',
        'year',
        'pages',
        'subjects',
        'series',
        'read_year',
        'review',
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
      expect(ctx.more_like).toEqual(['Dune by Frank Herbert', 'The Fifth Season by N.K. Jemisin']);
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
    confirmed: [],
    edited: [],
    rejected: [],
    downweighted: [],
    more_like: [],
    less_like: [],
    favorites: [],
    directive_text: null,
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
      downweighted: [
        { claim: 'Likes long books.', user_weight: 0.5 },
        { claim: 'X.', user_weight: 1 },
      ],
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
    const kept = removeRejectedClaims(
      [t('Enjoys hard science fiction.')],
      ['Enjoys sparkly vampire romance.']
    );
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

function traitsResponse(traits: unknown[]) {
  return {
    content: [{ type: 'tool_use', name: 'record_taste_traits', input: { traits } }],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

describe('extractTasteProfile', () => {
  it('persists returned traits, replaces prior proposed ones, and stamps profile_meta', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const client = fakeClaude([
        traitsResponse([
          {
            claim: '  Rewards dense political world-building.  ',
            polarity: 'reward',
            exhibits: [1, 2, 9999], // 9999 is not in the library and must be filtered
            contrasts: [6],
            inference_confidence: 0.87,
          },
        ]),
      ]);

      const out = await extractTasteProfile(db, client, 'local');

      expect(out.mode).toBe('full');
      expect(out.traits_saved).toBe(1);
      expect(out.model).toBe('claude-sonnet-5');
      expect(out.rated_books).toBe(13); // every tier except `rejected`

      const rows = await db
        .select()
        .from(schema.tasteTraits)
        .where(eq(schema.tasteTraits.userId, 'local'))
        .orderBy(asc(schema.tasteTraits.id));

      const proposed = rows.filter((r) => r.status === 'proposed');
      expect(proposed).toHaveLength(1);
      expect(proposed[0].claim).toBe('Rewards dense political world-building.'); // trimmed
      expect(proposed[0].exhibits).toEqual([1, 2]); // 9999 filtered out
      expect(proposed[0].contrasts).toEqual([6]);

      // Seeded confirmed (id 2) and rejected (id 4) traits survive; proposed 1 and 3 are gone.
      const statuses = rows.map((r) => r.status).sort();
      expect(statuses).toEqual(['confirmed', 'proposed', 'rejected']);

      const meta = await db
        .select()
        .from(schema.profileMeta)
        .where(eq(schema.profileMeta.userId, 'local'));
      expect(meta[0].lastProfileKind).toBe('full');
      expect(meta[0].lastProfiledAt).not.toBe('2026-07-01 12:00:00');
    } finally {
      await close();
    }
  });

  it('drops traits that paraphrase a rejected or user-locked claim', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      const client = fakeClaude([
        traitsResponse([
          {
            claim: 'Avoids grimdark tone entirely.',
            polarity: 'aversion',
            exhibits: [6],
            contrasts: [],
            inference_confidence: 0.5,
          },
          {
            claim: 'Values competence and problem-solving protagonists.',
            polarity: 'reward',
            exhibits: [3],
            contrasts: [],
            inference_confidence: 0.9,
          },
          {
            claim: 'Rewards slow, atmospheric fiction.',
            polarity: 'reward',
            exhibits: [1],
            contrasts: [],
            inference_confidence: 0.6,
          },
        ]),
      ]);

      const out = await extractTasteProfile(db, client, 'local');
      expect(out.traits_saved).toBe(1);

      const proposed = await db
        .select()
        .from(schema.tasteTraits)
        .where(
          and(eq(schema.tasteTraits.userId, 'local'), eq(schema.tasteTraits.status, 'proposed'))
        );
      expect(proposed.map((p) => p.claim)).toEqual(['Rewards slow, atmospheric fiction.']);
    } finally {
      await close();
    }
  });

  it('records a usage_events row under operation profile_full', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as Seed);
      await extractTasteProfile(db, fakeClaude([traitsResponse([])]), 'local');
      const events = await db.select().from(schema.usageEvents);
      expect(events.some((e) => e.operation === 'profile_full' && e.userId === 'local')).toBe(true);
    } finally {
      await close();
    }
  });

  it('throws a 400-shaped error when the user has no rated books', async () => {
    const { db, close } = await makeTestDb();
    try {
      // No seed at all: zero books.
      const client = fakeClaude([]);
      await expect(extractTasteProfile(db, client, 'local')).rejects.toThrow(
        'No rated books found. Run ingest (and enrich) first.'
      );
      // And it must fail BEFORE any Claude call.
      expect(client.calls).toHaveLength(0);
    } finally {
      await close();
    }
  });
});
