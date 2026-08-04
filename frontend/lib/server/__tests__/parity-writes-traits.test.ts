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
