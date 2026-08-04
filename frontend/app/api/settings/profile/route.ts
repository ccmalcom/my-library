import { eq } from 'drizzle-orm';
import { withApi } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';

export const GET = withApi('/api/settings/profile', async (_req, ctx) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, ctx.user.userId));
  ctx.timer.mark('db');
  return Response.json({ display_name: rows[0]?.displayName ?? null });
});
