import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from './fixtures/catalog/http.json';
import { makeTestDb } from './helpers/pglite';
import { installHttpReplay } from './helpers/httpReplay';
import { searchBooks } from '../catalog';

/**
 * Behavioral tests for add-book search RANKING, against real catalog pools recorded
 * by `scripts/gen_search_ranking_fixtures.py`.
 *
 * These are deliberately NOT parity tests. `catalog-search.test.ts` pins Node's output
 * byte-for-byte against recorded Python; this file pins the ranking Python got WRONG
 * (todo.md, "Add-book search ranking scores correct matches 0"). Python's `_match_score`
 * is not being fixed — it serves no traffic and is deleted with the rest of `mylibrary/`.
 *
 * Every assertion here is about a book the user obviously meant, so they read as
 * statements of intent rather than snapshots.
 */

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

// Same hermeticity pinning as catalog-search.test.ts: an ambient GOOGLE_BOOKS_API_KEY
// appends a `key=` param that makes every recorded URL miss, and the real throttle
// would add wall-clock delay across searchBooks' four fetches.
let savedKey: string | undefined;
let savedRps: string | undefined;
beforeEach(() => {
  savedKey = process.env.GOOGLE_BOOKS_API_KEY;
  savedRps = process.env.MYLIBRARY_REQ_PER_SEC;
  delete process.env.GOOGLE_BOOKS_API_KEY;
  process.env.MYLIBRARY_REQ_PER_SEC = '1000000';
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.GOOGLE_BOOKS_API_KEY;
  else process.env.GOOGLE_BOOKS_API_KEY = savedKey;
  if (savedRps === undefined) delete process.env.MYLIBRARY_REQ_PER_SEC;
  else process.env.MYLIBRARY_REQ_PER_SEC = savedRps;
});

async function search(query: string) {
  const { db, close } = await makeTestDb();
  uninstall = installHttpReplay(http as any);
  try {
    return await searchBooks(db, query, 8);
  } finally {
    await close();
  }
}

describe('punctuation in the query must not change the ranking', () => {
  // Defect 1: normFull mapped every non-alphanumeric to a SPACE, so the candidate
  // "The Android's Dream" normalized to `the android s dream` with a stray `s`
  // token. The query `the androids dream` then missed all five bands and scored 0,
  // tying with noise and losing the year-DESC tiebreaker to recent junk.
  it('ranks The Android’s Dream first when the apostrophe is omitted', async () => {
    const got = await search('the androids dream');
    expect(got[0]?.title).toBe("The Android's Dream");
    expect(got[0]?.author).toBe('John Scalzi');
  });

  it('still ranks The Android’s Dream first when the apostrophe is typed', async () => {
    const got = await search("the android's dream");
    expect(got[0]?.title).toBe("The Android's Dream");
    expect(got[0]?.author).toBe('John Scalzi');
  });
});

describe('a query may name both the title and the author', () => {
  // Defect 2: the scorer compared the query against the title OR the author, never
  // both, so `lock in scalzi` scored 0 against *Lock In* by John Scalzi while the
  // study guide "Trivia-On-Books Lock in by John Scalzi" scored 60 (every token in
  // its own title). Adding the author made results strictly worse.
  it('ranks Lock In first for "lock in scalzi"', async () => {
    const got = await search('lock in scalzi');
    expect(got[0]?.title).toBe('Lock In');
    expect(got[0]?.author).toBe('John Scalzi');
  });

  it('ranks Lock In first when the author comes first', async () => {
    const got = await search('scalzi lock in');
    expect(got[0]?.title).toBe('Lock In');
    expect(got[0]?.author).toBe('John Scalzi');
  });

  it('does not rank a study guide above the book it is about', async () => {
    const got = await search('lock in scalzi');
    const real = got.findIndex((c) => c.title === 'Lock In');
    const guide = got.findIndex((c) => /trivia-on-books/i.test(c.title ?? ''));
    expect(real).toBeGreaterThanOrEqual(0);
    if (guide >= 0) expect(real).toBeLessThan(guide);
  });
});
