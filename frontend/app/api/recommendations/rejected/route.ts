import { and, desc, eq } from 'drizzle-orm';
import { withApi } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { recOut } from '@/lib/server/recs';

export const GET = withApi('/api/recommendations/rejected', async (_req, ctx) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.recommendations)
    .where(
      and(
        eq(schema.recommendations.userId, ctx.user.userId),
        eq(schema.recommendations.status, 'rejected')
      )
    )
    .orderBy(desc(schema.recommendations.createdAt), desc(schema.recommendations.id));
  ctx.timer.mark('db');
  return Response.json(rows.map(recOut));
});
