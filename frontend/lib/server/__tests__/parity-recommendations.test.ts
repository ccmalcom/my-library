import { describe, test } from 'vitest';
import { setupParityEnv, checkParity } from './helpers/parity';
import { GET as latest } from '../../../app/api/recommendations/route';
import { GET as rejected } from '../../../app/api/recommendations/rejected/route';

describe('recommendations reads parity', () => {
  setupParityEnv();
  for (const stage of ['empty', 'seeded'] as const) {
    test(`${stage}: latest run`, () =>
      checkParity(stage, 'GET /recommendations', latest));
    test(`${stage}: rejected`, () =>
      checkParity(stage, 'GET /recommendations/rejected', rejected));
  }
});
