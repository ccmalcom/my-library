import { and, eq } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { bookSummary, VALID_SHELVES } from '@/lib/server/books';
import { effectiveRating, parseIdParam, pyList } from '@/lib/server/serialize';

export const PATCH = withApi('/api/books/[id]/shelf', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const shelf = typeof raw?.shelf === 'string' ? raw.shelf : null;
  if (shelf === null) throw new ApiError(422, 'validation error: shelf is required');
  if (!VALID_SHELVES.includes(shelf)) {
    throw new ApiError(422, `shelf must be one of ${pyList(VALID_SHELVES)}.`);
  }
  const bookId = parseIdParam(ctx.params.id);
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, ctx.user.userId)));
  const book = rows[0];
  if (!book) throw new ApiError(404, `Book ${bookId} not found.`);
  if (
    shelf !== 'did-not-finish' &&
    book.appReview &&
    effectiveRating(book.appRating, book.goodreadsRating) === null
  ) {
    throw new ApiError(
      422,
      'A review requires a rating. Rate the book 0.5 to 5 before moving it off did-not-finish.'
    );
  }
  await db.update(schema.books).set({ exclusiveShelf: shelf }).where(eq(schema.books.id, bookId));
  ctx.timer.mark('db');
  return Response.json(bookSummary({ ...book, exclusiveShelf: shelf }));
});
