import { withApi } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { deleteLibraryRows, deleteProfileRows } from '@/lib/server/purge';

export const DELETE = withApi('/api/library', async (_req, ctx) => {
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    // Python order: derived profile first, then enrichment-before-books.
    const profile = await deleteProfileRows(tx, ctx.user.userId);
    const books_removed = await deleteLibraryRows(tx, ctx.user.userId);
    return { books_removed, ...profile, profile_reset: true as const };
  });
  ctx.timer.mark('db');
  return Response.json(result);
});
