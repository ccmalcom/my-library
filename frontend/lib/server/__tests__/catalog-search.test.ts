import { describe, it, expect, afterEach } from 'vitest';
import http from './fixtures/catalog/http.json';
import expected from './fixtures/catalog/expected.json';
import { makeTestDb } from './helpers/pglite';
import { installHttpReplay } from './helpers/httpReplay';
import { searchBooks } from '../catalog';

let uninstall: (() => void) | undefined;
afterEach(() => { uninstall?.(); uninstall = undefined; });

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
      } finally { await close(); }
    });
  }
});
