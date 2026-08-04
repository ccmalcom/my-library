import { and, eq } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { bookSummary } from '@/lib/server/books';
import { effectiveRating, utcnowTs } from '@/lib/server/serialize';
import { z } from 'zod';

const Body = z.object({
  rating: z.number().int().nullish(),
  review: z.string().nullish(),
  clear_review: z.boolean().default(false),
  date_read: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  exclude_from_profile: z.boolean().nullish(),
  is_favorite: z.boolean().nullish(),
});

export const PATCH = withApi('/api/books/[id]/feedback', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(422, `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`);
  }
  const b = parsed.data;
  const bookId = Number(ctx.params.id);

  // Port of library.set_book_feedback — validation order matters.
  if (b.rating != null && b.rating !== 0 && !(b.rating >= 1 && b.rating <= 5)) {
    throw new ApiError(422, 'rating must be between 1 and 5 (or 0 to clear).');
  }
  if (b.rating == null && b.review == null && !b.clear_review &&
      b.date_read == null && b.exclude_from_profile == null && b.is_favorite == null) {
    throw new ApiError(422, 'Nothing to update: pass a rating, review, date read, exclude flag, and/or favorite.');
  }

  const db = getDb();
  const rows = await db.select().from(schema.books)
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, ctx.user.userId)));
  const book = rows[0];
  if (!book) throw new ApiError(404, `Book ${bookId} not found.`);

  const next = { ...book };
  if (b.rating != null) next.appRating = b.rating === 0 ? null : b.rating;
  if (b.clear_review) next.appReview = null;
  else if (b.review != null) next.appReview = b.review.trim() || null;
  if (b.date_read != null) next.dateRead = b.date_read;
  if (b.exclude_from_profile != null) next.excludeFromProfile = b.exclude_from_profile;
  if (b.is_favorite != null) next.isFavorite = b.is_favorite;

  // Review-without-rating guard runs AFTER applying changes (DNF exempt) — Python order.
  if (next.appReview && effectiveRating(next.appRating, next.goodreadsRating) === null &&
      next.exclusiveShelf !== 'did-not-finish') {
    throw new ApiError(422,
      'A review requires a rating. Rate the book 1-5 (same update is fine) before saving a review.');
  }

  next.feedbackUpdatedAt = utcnowTs();
  await db.update(schema.books).set({
    appRating: next.appRating, appReview: next.appReview, dateRead: next.dateRead,
    excludeFromProfile: next.excludeFromProfile, isFavorite: next.isFavorite,
    feedbackUpdatedAt: next.feedbackUpdatedAt,
  }).where(eq(schema.books.id, bookId));
  ctx.timer.mark('db');
  return Response.json(bookSummary(next));
});
