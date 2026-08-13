import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { cacheKeyFor, cacheGet, cachePut } from '../catalogCache';

describe('catalog cache', () => {
  it('derives the same sha1 key Python uses', () => {
    // echo -n 'https://openlibrary.org/works/OL1W.json' | sha1sum
    expect(cacheKeyFor('https://openlibrary.org/works/OL1W.json')).toMatch(/^[0-9a-f]{40}$/);
    expect(cacheKeyFor('a')).toBe('86f7e437faa5a7fce15d1ddcb9eaeaea377667b8');
  });

  it('round-trips a payload', async () => {
    const { db, close } = await makeTestDb();
    try {
      expect(await cacheGet(db, 'https://x/1')).toEqual({ hit: false, payload: null });
      await cachePut(db, 'https://x/1', 'openlibrary', { docs: [1, 2] });
      expect(await cacheGet(db, 'https://x/1')).toEqual({ hit: true, payload: { docs: [1, 2] } });
    } finally { await close(); }
  });

  it('distinguishes a cached null (404) from a miss', async () => {
    const { db, close } = await makeTestDb();
    try {
      await cachePut(db, 'https://x/404', 'openlibrary', null);
      expect(await cacheGet(db, 'https://x/404')).toEqual({ hit: true, payload: null });
    } finally { await close(); }
  });

  it('re-putting the same url overwrites rather than erroring', async () => {
    const { db, close } = await makeTestDb();
    try {
      await cachePut(db, 'https://x/2', 'googlebooks', { a: 1 });
      await cachePut(db, 'https://x/2', 'googlebooks', { a: 2 });
      expect(await cacheGet(db, 'https://x/2')).toEqual({ hit: true, payload: { a: 2 } });
    } finally { await close(); }
  });
});
