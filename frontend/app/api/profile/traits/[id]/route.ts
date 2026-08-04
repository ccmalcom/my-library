import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { traitOut } from '@/lib/server/traits';
import { utcnowTs } from '@/lib/server/serialize';

const Body = z.object({
  claim: z.string().nullish(),
  user_note: z.string().nullish(),
  status: z.enum(['confirmed', 'rejected']).nullish(),
  user_weight: z.number().min(0).max(1).nullish(),
});

/** Port of api.py::update_trait + library.set_trait_verdict — edits a taste trait's
 *  claim text, user note, status, and/or weight. Editing the claim sets status to
 *  'edited'; confirming/rejecting or adjusting weight stamps verdict_updated_at (which
 *  is what marks the profile dirty) — a claim-only edit does NOT stamp it. */
export const PATCH = withApi('/api/profile/traits/[id]', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(422, `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`);
  }
  const b = parsed.data;
  if (b.claim == null && b.user_note == null && b.status == null && b.user_weight == null) {
    throw new ApiError(422, 'at least one field (claim, user_note, status, user_weight) must be provided');
  }
  const traitId = Number(ctx.params.id);
  const db = getDb();
  const rows = await db.select().from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.id, traitId));
  const trait = rows[0];
  if (!trait || trait.userId !== ctx.user.userId) {
    throw new ApiError(404, `Trait ${traitId} not found`);
  }
  const updates: Partial<typeof trait> = {};
  if (b.claim != null) { updates.claim = b.claim.trim(); updates.status = 'edited'; }
  if (b.user_note != null) updates.userNote = b.user_note;
  if (b.status != null || b.user_weight != null) {
    if (b.status != null) updates.status = b.status; // verdict overrides 'edited'
    if (b.user_weight != null) updates.userWeight = b.user_weight;
    updates.verdictUpdatedAt = utcnowTs();
  }
  await db.update(schema.tasteTraits).set(updates)
    .where(eq(schema.tasteTraits.id, traitId));
  ctx.timer.mark('db');
  return Response.json(traitOut({ ...trait, ...updates }));
});
