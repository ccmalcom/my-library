import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { installHttpReplay } from './helpers/httpReplay';
import { getJson, normLang, yearFromGoogle, isbn13FromGoogleItem } from '../catalog';

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

// Hermeticity: these tests must pass regardless of the ambient shell environment.
// GOOGLE_BOOKS_API_KEY isn't read by this file's own tests, but deleting it here too
// keeps both catalog test files consistent and defensive against future tests that
// call googleBooksQuery. MYLIBRARY_REQ_PER_SEC is pinned to a fast throttle so getJson's
// real setTimeout-based throttle/backoff doesn't add real wall-clock delay per test.
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

describe('catalog normalizers', () => {
  it('normLang maps MARC codes and arrays', () => {
    expect(normLang(['eng'])).toBe('en');
    expect(normLang('fre')).toBe('fr');
    expect(normLang('zho')).toBe('zh');
    expect(normLang('xyz')).toBe('xy'); // unknown → first two chars
    expect(normLang([])).toBe(null);
    expect(normLang(null)).toBe(null);
    expect(normLang('  ')).toBe(null);
  });
  it('yearFromGoogle takes the leading 4 chars', () => {
    expect(yearFromGoogle('2015-06-02')).toBe(2015);
    expect(yearFromGoogle('nonsense')).toBe(null);
    expect(yearFromGoogle(null)).toBe(null);
  });
  it('isbn13FromGoogleItem finds the ISBN_13 identifier', () => {
    expect(
      isbn13FromGoogleItem({
        volumeInfo: {
          industryIdentifiers: [
            { type: 'ISBN_10', identifier: '0316246620' },
            { type: 'ISBN_13', identifier: '9780316246620' },
          ],
        },
      })
    ).toBe('9780316246620');
    expect(isbn13FromGoogleItem({})).toBe(null);
  });
});

describe('getJson', () => {
  it('caches a success and serves the second call from cache', async () => {
    const { db, close } = await makeTestDb();
    let calls = 0;
    uninstall = installHttpReplay({ 'https://x/ok': { status: 200, body: { a: 1 } } }, () => {
      calls++;
    });
    try {
      expect(await getJson(db, 'https://x/ok', 'openlibrary')).toEqual({ a: 1 });
      expect(await getJson(db, 'https://x/ok', 'openlibrary')).toEqual({ a: 1 });
      expect(calls).toBe(1); // second call served from Postgres
    } finally {
      await close();
    }
  });

  it('negatively caches a 404 and does not refetch', async () => {
    const { db, close } = await makeTestDb();
    let calls = 0;
    uninstall = installHttpReplay({ 'https://x/missing': { status: 404 } }, () => {
      calls++;
    });
    try {
      expect(await getJson(db, 'https://x/missing', 'openlibrary')).toBe(null);
      expect(await getJson(db, 'https://x/missing', 'openlibrary')).toBe(null);
      expect(calls).toBe(1);
    } finally {
      await close();
    }
  });

  it('retries a 503 once then gives up without caching', async () => {
    const { db, close } = await makeTestDb();
    let calls = 0;
    uninstall = installHttpReplay({ 'https://x/down': { status: 503 } }, () => {
      calls++;
    });
    try {
      expect(await getJson(db, 'https://x/down', 'openlibrary')).toBe(null);
      expect(calls).toBe(2); // _MAX_RETRIES = 2 total attempts
      expect(await getJson(db, 'https://x/down', 'openlibrary')).toBe(null);
      expect(calls).toBe(4); // never cached, so it tries again
    } finally {
      await close();
    }
  });
});
