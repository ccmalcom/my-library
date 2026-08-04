import { describe, test } from 'vitest';
import { setupParityEnv, checkParity } from './helpers/parity';
import { GET } from '../../../app/api/stats/route';

describe('GET /api/stats parity', () => {
  setupParityEnv();
  test('empty library', () => checkParity('empty', 'GET /stats', GET));
  test('seeded library', () => checkParity('seeded', 'GET /stats', GET));
});
