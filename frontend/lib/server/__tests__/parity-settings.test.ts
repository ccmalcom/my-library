import { describe, test, expect } from 'vitest';
import { setupParityEnv, checkParity } from './helpers/parity';
import { makeTestDb } from './helpers/pglite';
import { _setDbForTests } from '../db';
import { GET as keyStatus } from '../../../app/api/settings/api-key/status/route';
import { GET as profileSettings } from '../../../app/api/settings/profile/route';
import { GET as usage } from '../../../app/api/settings/usage/route';

describe('settings reads parity', () => {
  setupParityEnv();
  for (const stage of ['empty', 'seeded'] as const) {
    test(`${stage}: api-key status`, () =>
      checkParity(stage, 'GET /settings/api-key/status', keyStatus));
    test(`${stage}: profile settings`, () =>
      checkParity(stage, 'GET /settings/profile', profileSettings));
    test(`${stage}: usage`, () => checkParity(stage, 'GET /settings/usage', usage));
  }

  // No Python fixture for this: it's a Node-only env-parsing edge case (empty-string env
  // vars, a real state in the isolated-local-env convention and possible deployment
  // misconfiguration). `??` only falls back on null/undefined, so an empty string used to
  // parseFloat('') into NaN and poison cap_usd/pct/warn silently. setupParityEnv()'s
  // beforeEach/afterEach (registered above) already save/restore env + the db seam, so this
  // test only needs to override the two vars and close its own PGlite instance.
  test('empty-string env vars fall back to defaults instead of NaN', async () => {
    process.env.MYLIBRARY_MONTHLY_SOFT_CAP_USD = '';
    process.env.MYLIBRARY_USAGE_WARN_THRESHOLD = '';
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      const res = await usage(new Request('http://test/api/settings/usage'));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        spent_usd: 0,
        cap_usd: 5.0,
        pct: 0,
        warn: false,
        by_operation: {},
      });
    } finally {
      await close();
    }
  });
});
