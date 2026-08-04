import { describe, test } from 'vitest';
import { setupParityEnv, checkParity } from './helpers/parity';
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
});
