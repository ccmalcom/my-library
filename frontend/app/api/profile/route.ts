import { desc, eq } from 'drizzle-orm';
import { withApi } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { traitOut } from '@/lib/server/traits';

export const GET = withApi('/api/profile', async (_req, ctx) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, ctx.user.userId))
    .orderBy(desc(schema.tasteTraits.inferenceConfidence));
  ctx.timer.mark('db');
  return Response.json(rows.map(traitOut));
});
