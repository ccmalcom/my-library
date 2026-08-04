import { and, asc, desc, eq } from 'drizzle-orm';
import { withApi } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { recOut } from '@/lib/server/recs';

/** Port of recommend.py::latest_recommendations — most recent run, rank order. */
export const GET = withApi('/api/recommendations', async (_req, ctx) => {
  const db = getDb();
  const last = await db
    .select()
    .from(schema.recommendations)
    .where(eq(schema.recommendations.userId, ctx.user.userId))
    .orderBy(desc(schema.recommendations.createdAt), desc(schema.recommendations.id))
    .limit(1);
  if (last.length === 0) {
    ctx.timer.mark('db');
    return Response.json([]);
  }
  const rows = await db
    .select()
    .from(schema.recommendations)
    .where(
      and(
        eq(schema.recommendations.userId, ctx.user.userId),
        eq(schema.recommendations.runId, last[0].runId)
      )
    )
    .orderBy(asc(schema.recommendations.rank));
  ctx.timer.mark('db');
  return Response.json(rows.map(recOut));
});
