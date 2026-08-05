import { and, eq } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { parseIdParam } from '@/lib/server/serialize';

// Port of library.remove_book + api.py's DELETE /books/{book_id} — permanently
// removes a book from the library. The DB FK has no ON DELETE CASCADE (Python's
// cascade is ORM-level only), so the enrichment row must be deleted first.
export const DELETE = withApi('/api/books/[id]', async (_req, ctx) => {
  const bookId = parseIdParam(ctx.params.id);
  const db = getDb();
  const rows = await db.select().from(schema.books)
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, ctx.user.userId)));
  const book = rows[0];
  if (!book) throw new ApiError(404, `Book ${bookId} not found.`);
  // Both deletes must land atomically — a failure between them would silently
  // orphan the enrichment row (or lose it while the book row survives).
  await db.transaction(async (tx) => {
    await tx.delete(schema.enrichment).where(eq(schema.enrichment.bookId, bookId));
    await tx.delete(schema.books).where(eq(schema.books.id, bookId));
  });
  ctx.timer.mark('db');
  return Response.json({ id: bookId, title: book.title, removed: true });
});
