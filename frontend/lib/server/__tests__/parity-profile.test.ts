import { describe, test } from 'vitest';
import { setupParityEnv, checkParity } from './helpers/parity';
import { GET as traits } from '../../../app/api/profile/route';
import { GET as status } from '../../../app/api/profile/status/route';

const sortChanged = (body: unknown) => {
  const b = body as { changed_book_ids?: number[] };
  if (Array.isArray(b?.changed_book_ids)) {
    return { ...b, changed_book_ids: [...b.changed_book_ids].sort((x, y) => x - y) };
  }
  return body;
};

describe('profile traits + status parity', () => {
  setupParityEnv();
  for (const stage of ['empty', 'seeded'] as const) {
    test(`${stage}: traits`, () => checkParity(stage, 'GET /profile', traits));
    // changed_book_ids order is DB-dependent in Python (no ORDER BY) — compare sorted.
    test(`${stage}: status`, () =>
      checkParity(stage, 'GET /profile/status', status, sortChanged));
  }
});
