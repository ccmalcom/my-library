import { describe, it, expect } from 'vitest';
import { makeTestDb, loadSeed } from './helpers/pglite';
import seedJson from './fixtures/parity/seed.json';
import type { Seed } from './helpers/pglite';
import { booksChangedSince, buildUpdatePrompt } from '../profileUpdate';
import { pyFloat } from '../serialize';

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
      { id: 1, claim: 'A.', polarity: 'reward', inference_confidence: pyFloat(1), exhibits: [1], contrasts: [] },
    ];
    const out = buildUpdatePrompt(traits, new Map(), [1], null);
    expect(out).toContain('"inference_confidence": 1.0');
    expect(out).not.toContain('"inference_confidence": 1,');
  });
});
