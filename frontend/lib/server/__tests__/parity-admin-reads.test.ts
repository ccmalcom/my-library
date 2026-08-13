import { describe, test } from 'vitest';
import { setupParityEnv, checkParity } from './helpers/parity';
import { GET as adminMe } from '../../../app/api/admin/me/route';
import { GET as adminUsers } from '../../../app/api/admin/users/route';

describe('GET /api/admin/me parity', () => {
  setupParityEnv();
  // Local mode (no SUPABASE_URL) makes every caller an admin, exactly as
  // Python's is_admin() short-circuits when auth_enabled is false.
  test('empty library', () => checkParity('empty', 'GET /admin/me', adminMe));
  test('seeded library', () => checkParity('seeded', 'GET /admin/me', adminMe));
});

describe('GET /api/admin/users parity', () => {
  setupParityEnv();
  test('empty roster', () => checkParity('empty', 'GET /admin/users', adminUsers));
  test('seeded roster', () => checkParity('seeded', 'GET /admin/users', adminUsers));
});
