import { describe, test } from 'vitest';
import { setupParityEnv, checkParity } from './helpers/parity';
import { GET } from '../../../app/api/directive/route';

describe('GET /api/directive parity', () => {
  setupParityEnv();
  test('empty', () => checkParity('empty', 'GET /directive', GET));
  test('seeded', () => checkParity('seeded', 'GET /directive', GET));
});
