import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { getConfigValue, setConfigValue, isDebugMode, _resetDebugCache } from '../config';
import type { Db } from '../db';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _resetDebugCache();
});
afterEach(async () => close());

describe('config', () => {
  it('returns null for a missing key', async () => {
    expect(await getConfigValue(db, 'nope')).toBeNull();
  });

  it('sets and gets a value (upsert on repeat)', async () => {
    await setConfigValue(db, 'k', { a: 1 });
    expect(await getConfigValue(db, 'k')).toEqual({ a: 1 });
    await setConfigValue(db, 'k', false);
    expect(await getConfigValue(db, 'k')).toBe(false);
  });

  it('debug mode defaults to false', async () => {
    expect(await isDebugMode(db)).toBe(false);
  });

  it('debug mode reflects the stored flag and caches for 30s', async () => {
    await setConfigValue(db, 'debug_mode', true);
    expect(await isDebugMode(db, 1_000)).toBe(true);
    // Direct DB change without setConfigValue -> stale cache inside the TTL...
    await db.execute(`update app_config set value = 'false' where key = 'debug_mode'`);
    expect(await isDebugMode(db, 10_000)).toBe(true);
    // ...and fresh after the TTL.
    expect(await isDebugMode(db, 40_000)).toBe(false);
  });

  it('setConfigValue invalidates the debug cache immediately', async () => {
    await setConfigValue(db, 'debug_mode', true);
    expect(await isDebugMode(db, 1_000)).toBe(true);
    await setConfigValue(db, 'debug_mode', false);
    expect(await isDebugMode(db, 2_000)).toBe(false);
  });
});
