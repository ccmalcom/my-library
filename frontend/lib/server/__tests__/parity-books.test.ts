import { describe, test } from 'vitest';
import { setupParityEnv, checkParity } from './helpers/parity';
import { GET } from '../../../app/api/books/route';

describe('GET /api/books parity', () => {
  setupParityEnv();
  const cases = [
    'GET /books',
    'GET /books?rated_only=true',
    'GET /books?shelf=read',
    'GET /books?limit=3&offset=2',
  ];
  for (const key of cases) {
    test(`empty: ${key}`, () => checkParity('empty', key, GET));
    test(`seeded: ${key}`, () => checkParity('seeded', key, GET));
  }
});
