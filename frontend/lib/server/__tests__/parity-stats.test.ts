import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupParityEnv, checkParity } from './helpers/parity';
import { loadSeed, makeTestDb, type Seed } from './helpers/pglite';
import seedJson from './fixtures/parity/seed.json';
import { _setDbForTests, schema, type Db } from '../db';
import { GET } from '../../../app/api/stats/route';

describe('GET /api/stats parity', () => {
  setupParityEnv();
  test('empty library', () => checkParity('empty', 'GET /stats', GET));
  test('seeded library', () => checkParity('seeded', 'GET /stats', GET));
});

describe('half-star rating buckets', () => {
  setupParityEnv();
  let db: Db;
  let closeDb: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const testDb = await makeTestDb();
    db = testDb.db;
    await loadSeed(db, seedJson as unknown as Seed);
    _setDbForTests(db);
    closeDb = testDb.close;
  });

  afterEach(async () => {
    _setDbForTests(null);
    await closeDb?.();
    closeDb = undefined;
  });

  test('serializes whole and half-star bucket keys without trailing decimals', async () => {
    await db.update(schema.books).set({ appRating: 4 }).where(eq(schema.books.id, 1));
    await db.update(schema.books).set({ appRating: 4.5 }).where(eq(schema.books.id, 2));

    const response = await GET(new Request('http://test/api/stats'));
    const body = await response.json();

    expect(body.by_star['4.5']).toBe(1);
    expect(body.by_star['4']).toBeGreaterThanOrEqual(1);
    expect(body.by_star['4.0']).toBeUndefined();
  });
});
