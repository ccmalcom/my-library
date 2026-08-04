import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupParityEnv } from './helpers/parity';
import { runScenario } from './helpers/write-parity';
import { makeTestDb, loadSeed, type Seed } from './helpers/pglite';
import seedJson from './fixtures/parity/seed.json';
import { _setDbForTests, schema } from '../db';
import { PATCH } from '../../../app/api/profile/traits/[id]/route';

describe('write parity: traits', () => {
  setupParityEnv();
  it('trait-patch', () => runScenario('trait-patch'));
});

function patchTrait(id: number, body: unknown) {
  return PATCH(
    new Request(`http://test/api/profile/traits/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: { id: String(id) } }
  );
}

// Direct behavioral check of the nuance the recorded scenario can't prove on its own:
// write-parity's maskVolatile collapses every non-null verdict_updated_at to '<set>',
// so a bug that (wrongly) re-stamps it on a claim-only edit would still pass the
// scenario replay. These assertions compare the actual stored values instead.
describe('trait verdict_updated_at stamping nuance', () => {
  setupParityEnv();

  it('claim-only edit leaves verdict_updated_at untouched; status/weight edits stamp it', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as unknown as Seed);
      _setDbForTests(db);

      // Trait 1 starts with verdict_updated_at = null in the seed.
      const seeded = (
        await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 1))
      )[0];
      expect(seeded.verdictUpdatedAt).toBeNull();

      // 1. Confirm it -> stamps verdict_updated_at.
      const res1 = await patchTrait(1, { status: 'confirmed' });
      expect(res1.status).toBe(200);
      const afterConfirm = (
        await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 1))
      )[0];
      expect(afterConfirm.verdictUpdatedAt).not.toBeNull();
      const stampAfterConfirm = afterConfirm.verdictUpdatedAt;

      // 2. Claim-only edit -> must NOT touch verdict_updated_at (byte-identical value).
      const res2 = await patchTrait(1, { claim: 'Edited claim.' });
      expect(res2.status).toBe(200);
      const afterClaimEdit = (
        await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 1))
      )[0];
      expect(afterClaimEdit.status).toBe('edited');
      expect(afterClaimEdit.verdictUpdatedAt).toBe(stampAfterConfirm);

      // 3. Force the timestamp to a known-past sentinel, then a weight-only edit must
      //    move it forward (deterministic, not relying on wall-clock granularity).
      await db
        .update(schema.tasteTraits)
        .set({ verdictUpdatedAt: '2020-01-01 00:00:00' })
        .where(eq(schema.tasteTraits.id, 1));
      const res3 = await patchTrait(1, { user_weight: 0.3 });
      expect(res3.status).toBe(200);
      const afterWeightEdit = (
        await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 1))
      )[0];
      expect(afterWeightEdit.verdictUpdatedAt).not.toBe('2020-01-01 00:00:00');
      expect(afterWeightEdit.userWeight).toBe(0.3);
      // Claim edited in step 2 must survive the weight-only edit untouched.
      expect(afterWeightEdit.claim).toBe('Edited claim.');
      expect(afterWeightEdit.status).toBe('edited');
    } finally {
      _setDbForTests(null);
      await close();
    }
  });
});

// Direct behavioral check of another nuance the recorded scenario can't prove: `claim`
// sets status to 'edited', but a verdict (`status`/`user_weight`) in the request must
// override it — per the comment in route.ts, "verdict overrides 'edited'". The scenario
// never sends `claim` and `status` together in one PATCH, nor a status-only PATCH after
// a prior claim edit already set status to 'edited', so neither ordering dependency in
// the route's two `if` blocks is actually exercised without these assertions.
describe('trait status-overrides-claim-edited nuance', () => {
  setupParityEnv();

  it('claim + status in the SAME PATCH call: status wins over claim-set "edited"', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as unknown as Seed);
      _setDbForTests(db);

      // Trait 3 starts 'proposed' in the seed.
      const seeded = (
        await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 3))
      )[0];
      expect(seeded.status).toBe('proposed');

      const res = await patchTrait(3, { claim: 'Revised claim text.', status: 'confirmed' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('confirmed');
      expect(body.claim).toBe('Revised claim text.');

      const afterCombined = (
        await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 3))
      )[0];
      expect(afterCombined.status).toBe('confirmed');
      expect(afterCombined.claim).toBe('Revised claim text.');
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  it('status-only PATCH after a prior claim edit overrides the "edited" status it set', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as unknown as Seed);
      _setDbForTests(db);

      // 1. Claim-only edit -> status becomes 'edited'.
      const res1 = await patchTrait(3, { claim: 'First revision.' });
      expect(res1.status).toBe(200);
      const afterClaim = (
        await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 3))
      )[0];
      expect(afterClaim.status).toBe('edited');

      // 2. Status-only PATCH in a later request -> overrides 'edited'.
      const res2 = await patchTrait(3, { status: 'rejected' });
      expect(res2.status).toBe(200);
      const afterStatus = (
        await db.select().from(schema.tasteTraits).where(eq(schema.tasteTraits.id, 3))
      )[0];
      expect(afterStatus.status).toBe('rejected');
      // Claim from step 1 survives the status-only edit untouched.
      expect(afterStatus.claim).toBe('First revision.');
    } finally {
      _setDbForTests(null);
      await close();
    }
  });
});
