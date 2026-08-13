import { describe, test } from 'vitest';
import { setupParityEnv, checkParity } from './helpers/parity';
import { GET as subjects } from '../../../app/api/profile/subjects/route';
import { GET as highlights } from '../../../app/api/profile/highlights/route';

describe('profile subjects + highlights parity', () => {
  setupParityEnv();
  for (const stage of ['empty', 'seeded'] as const) {
    test(`${stage}: subjects`, () => checkParity(stage, 'GET /profile/subjects', subjects));
    test(`${stage}: highlights`, () => checkParity(stage, 'GET /profile/highlights', highlights));
  }
});
