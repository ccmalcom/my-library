/**
 * Port of mylibrary/invites.py — the invite lifecycle behind the /admin API.
 * Tasks 6-8 add createInvite, backfillFromSupabase and revokeUser here.
 */
import { count, desc, eq } from 'drizzle-orm';
import { getDb, schema, type Db } from '@/lib/server/db';
import { tsToIso, utcnowTs } from '@/lib/server/serialize';
import { deleteUser, inviteUser, listUsers } from '@/lib/server/supabaseAdmin';
import { deleteAccountRows } from '@/lib/server/purge';
import { upsertUserSettings } from '@/lib/server/settings';
import { encrypt } from '@/lib/server/crypto';

export interface AdminUser {
  id: number;
  email: string;
  status: string;
  supabase_user_id: string | null;
  invited_by: string | null;
  created_at: string | null;
  revoked_at: string | null;
  book_count: number;
}

export class InviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InviteError';
  }
}

/** Test seam, mirroring _setDbForTests. Production always uses the real client. */
let inviteUserImpl: typeof inviteUser = inviteUser;
export function _setInviteUserForTests(fn: typeof inviteUser | null): void {
  inviteUserImpl = fn ?? inviteUser;
}

let listUsersImpl: typeof listUsers = listUsers;
export function _setListUsersForTests(fn: typeof listUsers | null): void {
  listUsersImpl = fn ?? listUsers;
}

let deleteUserImpl: typeof deleteUser = deleteUser;
export function _setDeleteUserForTests(fn: typeof deleteUser | null): void {
  deleteUserImpl = fn ?? deleteUser;
}

/** Phase 4 of revokeUser, as one unit. Transactional inside; see the note above. */
type PurgeFn = (userId: string) => Promise<unknown>;
const realPurge: PurgeFn = (userId) => getDb().transaction((tx) => deleteAccountRows(tx, userId));

let purgeImpl: PurgeFn = realPurge;
export function _setDeleteAccountForTests(fn: PurgeFn | null): void {
  purgeImpl = fn ?? realPurge;
}

/**
 * Port of invites.py::create_invite. Idempotent on the lowercased, stripped email.
 *
 * NOT wrapped in a transaction, deliberately: Python calls GoTrue first and then
 * writes the display name, the encrypted key, and the invite row in three
 * separate sessions. The GoTrue call cannot be rolled back, so one enclosing
 * transaction would report a partially-applied invite as a clean failure.
 */
export async function createInvite(opts: {
  email: string;
  invitedBy: string;
  displayName?: string | null;
  anthropicApiKey?: string | null;
}): Promise<AdminUser> {
  const email = (opts.email ?? '').trim().toLowerCase();
  if (!email) throw new InviteError('email must not be empty');

  const result = await inviteUserImpl(email); // may throw SupabaseAdminError
  const sbId = result.id;

  const db = getDb();
  if (sbId) {
    // Python guards on the untrimmed value but STORES the trimmed one:
    // user_settings.py does `name = (name or "").strip()` and
    // `raw_key = (raw_key or "").strip()`. Trim on the way in, not just in the guard.
    const displayName = opts.displayName?.trim();
    if (displayName) {
      await upsertUserSettings(db, sbId, { displayName });
    }
    const apiKey = opts.anthropicApiKey?.trim();
    if (apiKey) {
      await upsertUserSettings(db, sbId, { anthropicApiKeyEncrypted: encrypt(apiKey) });
    }
  }

  const existing = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.email, email))
    .limit(1);

  if (existing.length) {
    await db
      .update(schema.invites)
      .set({
        invitedBy: opts.invitedBy,
        supabaseUserId: sbId,
        status: 'active',
        revokedAt: null,
      })
      .where(eq(schema.invites.id, existing[0].id));
  } else {
    await db.insert(schema.invites).values({
      email,
      invitedBy: opts.invitedBy,
      supabaseUserId: sbId,
      status: 'active',
      revokedAt: null,
    });
  }

  const [row] = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.email, email))
    .limit(1);

  // Python returns _invite_dict(row) with NO book_count key; FastAPI's
  // AdminUserOut then supplies the default of 0. Match the serialized result.
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    supabase_user_id: row.supabaseUserId,
    invited_by: row.invitedBy,
    created_at: tsToIso(row.createdAt),
    revoked_at: tsToIso(row.revokedAt),
    book_count: 0,
  };
}

/**
 * Port of invites.py::backfill_from_supabase. Creates an "active" invite row for
 * every Supabase user with no local row (e.g. added in the dashboard). Matches
 * by supabase_user_id; existing rows are left untouched.
 */
export async function backfillFromSupabase(opts: {
  invitedBy: string;
}): Promise<{ added: number; total_supabase_users: number }> {
  const sbUsers = await listUsersImpl(); // may throw SupabaseAdminError

  const db = getDb();
  // Python's single session_scope makes the whole backfill atomic; mirror it here.
  const added = await db.transaction(async (tx) => {
    const existing = await tx.select({ sid: schema.invites.supabaseUserId }).from(schema.invites);
    const known = new Set(existing.map((r) => r.sid).filter((s): s is string => s !== null));

    let count = 0;
    for (const u of sbUsers) {
      const sbId = u.id;
      if (!sbId || known.has(sbId)) continue;
      await tx.insert(schema.invites).values({
        email: (u.email ?? '').trim().toLowerCase(),
        invitedBy: opts.invitedBy,
        supabaseUserId: sbId,
        status: 'active',
      });
      known.add(sbId);
      count += 1;
    }
    return count;
  });
  return { added, total_supabase_users: sbUsers.length };
}

/**
 * Port of invites.py::revoke_user. Delete the Supabase user, purge their app
 * data, mark the invite revoked.
 *
 * DELIBERATELY NOT TRANSACTIONAL -- do not "fix" this. Phase order is:
 *   1. read the row          2. GoTrue DELETE (irreversible)
 *   3. commit status=revoked 4. purge app data
 * Step 3 lands in its own transaction BEFORE step 4 so that a purge failure
 * still leaves the row readable as 'revoked'. The Supabase account is already
 * gone at that point, so a retry must skip deleteUser -- calling it again 404s.
 * A single enclosing transaction would roll the flag back and make every retry
 * fail permanently.
 */
export async function revokeUser(opts: {
  supabaseUserId: string;
}): Promise<{ supabase_user_id: string; status: string }> {
  const supabaseUserId = opts.supabaseUserId;
  if (!supabaseUserId) throw new InviteError('supabase_user_id is required');

  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.supabaseUserId, supabaseUserId))
    .limit(1);
  if (!row) throw new InviteError('invite not found for supabase_user_id');

  const alreadyRevoked = row.status === 'revoked';

  if (!alreadyRevoked) {
    await deleteUserImpl(supabaseUserId); // may throw SupabaseAdminError

    // Own transaction, before the purge. See the comment above.
    await db
      .update(schema.invites)
      .set({ status: 'revoked', revokedAt: utcnowTs() })
      .where(eq(schema.invites.supabaseUserId, supabaseUserId));
  }

  // Phase 4. Transactional in itself, but NOT sharing a transaction with the
  // revoked-flag commit above -- that separation is the whole point.
  await purgeImpl(supabaseUserId);

  return { supabase_user_id: supabaseUserId, status: 'revoked' };
}

/**
 * Port of invites.py::list_roster — every invite, newest first, annotated with
 * the user's current book count. Python orders by (created_at desc, id desc)
 * and defaults a missing count to 0 via counts.get(..., 0).
 */
export async function listRoster(db: Db = getDb()): Promise<AdminUser[]> {
  const rows = await db
    .select()
    .from(schema.invites)
    .orderBy(desc(schema.invites.createdAt), desc(schema.invites.id));

  const counts = await db
    .select({ userId: schema.books.userId, n: count(schema.books.id) })
    .from(schema.books)
    .groupBy(schema.books.userId);

  const byUser = new Map(counts.map((c) => [c.userId, Number(c.n)]));

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    status: row.status,
    supabase_user_id: row.supabaseUserId,
    invited_by: row.invitedBy,
    created_at: tsToIso(row.createdAt),
    revoked_at: tsToIso(row.revokedAt),
    book_count: row.supabaseUserId ? (byUser.get(row.supabaseUserId) ?? 0) : 0,
  }));
}
