import { describe, test } from 'vitest';
import { setupParityEnv, checkParity } from './helpers/parity';
import { GET } from '../../../app/api/profile/archetype/route';

describe('GET /api/profile/archetype parity', () => {
  setupParityEnv();
  test('empty → 404', () => checkParity('empty', 'GET /profile/archetype', GET));
  test('seeded → stored archetype', () =>
    checkParity('seeded', 'GET /profile/archetype', GET));
});
