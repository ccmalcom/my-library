import { desc, eq } from 'drizzle-orm';
import { withApi } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { tsToIso } from '@/lib/server/serialize';

export const GET = withApi('/api/profile', async (_req, ctx) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, ctx.user.userId))
    .orderBy(desc(schema.tasteTraits.inferenceConfidence));
  ctx.timer.mark('db');
  return Response.json(
    rows.map((t) => ({
      id: t.id,
      claim: t.claim,
      reveal_line: t.revealLine,
      polarity: t.polarity,
      exhibits: t.exhibits,
      contrasts: t.contrasts,
      inference_confidence: t.inferenceConfidence,
      status: t.status,
      user_note: t.userNote,
      user_weight: t.userWeight,
      verdict_updated_at: tsToIso(t.verdictUpdatedAt),
      created_at: tsToIso(t.createdAt),
    }))
  );
});
