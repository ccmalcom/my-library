import { withApi } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { deleteAccountRows } from '@/lib/server/purge';

export const DELETE = withApi('/api/account', async (_req, ctx) => {
  const db = getDb();
  const result = await db.transaction((tx) => deleteAccountRows(tx, ctx.user.userId));
  ctx.timer.mark('db');
  return Response.json(result);
});
