import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from './fixtures/catalog/http.json';
import expected from './fixtures/catalog/expected.json';
import { makeTestDb } from './helpers/pglite';
import { installHttpReplay } from './helpers/httpReplay';
import { searchBooks } from '../catalog';

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

// Hermeticity: these fixtures were recorded with no GOOGLE_BOOKS_API_KEY, so a `key=`
// query param appended by an ambient env value makes every fixture URL miss (this is
// the exact scenario finding 1's fix was verified against — see the reviewer's repro
// in the wave-3a fix report). Delete it regardless of what's in the real shell. Also
// pin MYLIBRARY_REQ_PER_SEC to a fast throttle so getJson's real setTimeout-based
// throttle doesn't add wall-clock delay across searchBooks' several getJson calls.
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

describe('searchBooks parity', () => {
  for (const query of Object.keys(expected as Record<string, unknown>)) {
    it(`matches Python for "${query}"`, async () => {
      const { db, close } = await makeTestDb();
      uninstall = installHttpReplay(http as any);
      try {
        const got = await searchBooks(db, query, 8);
        // `raw` is the untouched upstream payload — identical by construction,
        // and enormous; compare the normalized fields the API actually returns.
        const strip = (c: any) => ({ ...c, raw: undefined });
        expect(got.map(strip)).toEqual((expected as any)[query].map(strip));
      } finally {
        await close();
      }
    });
  }
});
