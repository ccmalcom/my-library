import { eq } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { upsertUserSettings } from '@/lib/server/settings';

export const GET = withApi('/api/settings/profile', async (_req, ctx) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, ctx.user.userId));
  ctx.timer.mark('db');
  return Response.json({ display_name: rows[0]?.displayName ?? null });
});

export const PUT = withApi('/api/settings/profile', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const name = typeof raw?.display_name === 'string' ? raw.display_name.trim() : '';
  if (!name) throw new ApiError(422, 'Display name must not be empty.');
  const db = getDb();
  const displayName = await db.transaction(async (tx) => {
    await upsertUserSettings(tx, ctx.user.userId, { displayName: name });
    const rows = await tx.select().from(schema.userSettings)
      .where(eq(schema.userSettings.userId, ctx.user.userId));
    return rows[0]?.displayName ?? null;
  });
  ctx.timer.mark('db');
  return Response.json({ display_name: displayName });
});
