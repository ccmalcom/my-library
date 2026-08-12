import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupParityEnv } from './helpers/parity';
import { runScenario } from './helpers/write-parity';
import { loadSeed, makeTestDb, type Seed } from './helpers/pglite';
import seedJson from './fixtures/parity/seed.json';
import { _setDbForTests } from '../db';
import {
  _setDeleteAccountForTests,
  _setDeleteUserForTests,
  _setInviteUserForTests,
  _setListUsersForTests,
  listRoster,
  revokeUser,
} from '../invites';

const FAKE_INVITE = async (email: string) => ({
  id: `sb-${email.split('@')[0]}`,
  email,
});

const FAKE_SB_USERS = [
  { id: 'local', email: 'reader1@example.com' },
  { id: 'other', email: 'reader2@example.com' },
  { id: 'sb-dashboard', email: 'dashboard.created@example.com' },
];

describe('write parity: admin', () => {
  setupParityEnv();

  // Module-level seam, mirroring _setDbForTests. withApi's signature is
  // (req, routeCtx?) with routeCtx = { params? } -- there is no way to thread
  // a dependency object through the handler, so injection lives in the module.
  beforeEach(() => {
    _setInviteUserForTests(FAKE_INVITE);
    _setListUsersForTests(async () => FAKE_SB_USERS);
    _setDeleteUserForTests(async () => undefined);
  });
  afterEach(() => {
    _setInviteUserForTests(null);
    _setListUsersForTests(null);
    _setDeleteUserForTests(null);
  });

  it('admin_invite', () => runScenario('admin_invite'));
  it('admin_backfill', () => runScenario('admin_backfill'));
  it('admin_revoke', () => runScenario('admin_revoke'));
  it('admin_revoke_unknown', () => runScenario('admin_revoke_unknown'));

  it('leaves the row revoked when the purge fails, so a retry skips the GoTrue delete', async () => {
    // This is the reason revokeUser is not transactional. No fixture can show
    // it: Python's recorded run never has delete_account throw.
    const { db, close } = await makeTestDb();
    let deleteUserCalls = 0;
    _setDeleteUserForTests(async () => {
      deleteUserCalls += 1;
    });
    try {
      await loadSeed(db, seedJson as unknown as Seed);
      _setDbForTests(db);

      // Force the purge to fail on the first attempt only.
      let failPurge = true;
      _setDeleteAccountForTests(async () => {
        if (failPurge) throw new Error('purge exploded');
        return undefined;
      });

      await expect(revokeUser({ supabaseUserId: 'other' })).rejects.toThrow('purge exploded');
      expect(deleteUserCalls).toBe(1);

      // The row must already read 'revoked' despite the purge failing.
      const roster = await listRoster(db);
      const row = roster.find((r) => r.supabase_user_id === 'other');
      expect(row?.status).toBe('revoked');
      expect(row?.revoked_at).not.toBeNull();

      // Retry: GoTrue must NOT be called a second time.
      failPurge = false;
      await revokeUser({ supabaseUserId: 'other' });
      expect(deleteUserCalls).toBe(1);
    } finally {
      _setDeleteAccountForTests(null);
      _setDeleteUserForTests(null);
      _setDbForTests(null);
      await close();
    }
  });
});
