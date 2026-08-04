import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { bookOut, VALID_SHELVES } from '@/lib/server/books';
import { effectiveRating, parseBoolParam, utcnowTs, todayIsoDate, pyList } from '@/lib/server/serialize';
import { sameWork } from '@/lib/server/dedup';

const Query = z.object({
  rated_only: z.string().optional(),
  shelf: z.string().optional(),
  limit: z.coerce.number().int().max(500).default(50),
  offset: z.coerce.number().int().default(0),
});

export const GET = withApi('/api/books', async (req, ctx) => {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = Query.safeParse(params);
  if (!parsed.success) {
    throw new ApiError(422, `validation error: ${parsed.error.issues[0]?.message ?? 'invalid query'}`);
  }
  const { shelf, limit, offset } = parsed.data;
  const ratedOnly = parseBoolParam(parsed.data.rated_only);

  const db = getDb();
  const where = shelf
    ? and(eq(schema.books.userId, ctx.user.userId), eq(schema.books.exclusiveShelf, shelf))
    : eq(schema.books.userId, ctx.user.userId);

  // Parity note: Python applies offset/limit in SQL, THEN filters rated_only in
  // Python — a page can return fewer than `limit` rows even when more rated books
  // exist. Reproduce exactly; do not "fix" by filtering in SQL.
  const rows = await db
    .select()
    .from(schema.books)
    .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
    .where(where)
    .orderBy(asc(schema.books.id))
    .offset(offset)
    .limit(limit);
  ctx.timer.mark('db');

  const out = [];
  for (const row of rows) {
    const b = row.books;
    if (ratedOnly && effectiveRating(b.appRating, b.goodreadsRating) === null) continue;
    out.push(bookOut(b, row.enrichment));
  }
  return Response.json(out);
});

const AddBook = z.object({
  title: z.string(),
  author: z.string().nullish(),
  year: z.number().int().nullish(),
  isbn13: z.string().nullish(),
  shelf: z.string().default('read'),
  rating: z.number().int().nullish(),
  review: z.string().nullish(),
  cover_url: z.string().nullish(),
  subjects: z.array(z.string()).nullish(),
  catalog_source: z.string().nullish(),
  catalog_id: z.string().nullish(),
});

export const POST = withApi('/api/books', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const parsed = AddBook.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(422, `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`);
  }
  const b = parsed.data;

  // Port of library.add_book — validation order matters for parity.
  const title = (b.title ?? '').trim();
  if (!title) throw new ApiError(422, 'title is required.');
  if (!VALID_SHELVES.includes(b.shelf)) {
    throw new ApiError(422, `shelf must be one of ${pyList(VALID_SHELVES)}.`);
  }
  if (b.rating != null && b.rating !== 0 && !(b.rating >= 1 && b.rating <= 5)) {
    throw new ApiError(422, 'rating must be between 1 and 5 (or omitted/0 for unrated).');
  }
  const author = (b.author ?? '').trim() || null;
  const isbn13 = (b.isbn13 ?? '').trim() || null;
  const review = (b.review ?? '').trim() || null;
  if (review && (b.rating == null || b.rating === 0)) {
    throw new ApiError(422, 'A review requires a rating (1-5). Rate the book, or omit the review.');
  }

  const db = getDb();
  // Dedup walk, scoped to this user (same-work identity — enrich.py::_same_work).
  const existing = await db
    .select({ title: schema.books.title, author: schema.books.author })
    .from(schema.books)
    .where(and(eq(schema.books.userId, ctx.user.userId), isNotNull(schema.books.title)));
  for (const row of existing) {
    if (sameWork(row.title, row.author, title, author)) {
      throw new ApiError(409, `"${title}" is already in your library.`);
    }
  }

  const rated = b.rating != null && b.rating !== 0;
  const [book] = await db
    .insert(schema.books)
    .values({
      userId: ctx.user.userId,
      title,
      author,
      isbn13,
      yearPublished: b.year ?? null,
      exclusiveShelf: b.shelf,
      source: 'manual',
      goodreadsRating: 0,
      dateAdded: todayIsoDate(),
      appRating: rated ? b.rating : null,
      appReview: review,
      feedbackUpdatedAt: rated || review ? utcnowTs() : null,
    })
    .returning();

  let enr = null;
  if (b.cover_url || b.subjects || b.catalog_source || b.catalog_id) {
    [enr] = await db
      .insert(schema.enrichment)
      .values({
        bookId: book.id,
        resolvedSource: b.catalog_source ?? null,
        resolvedId: b.catalog_id ?? null,
        subjects: b.subjects ?? [],
        coverUrl: b.cover_url ?? null,
        resolutionConfidence: 1.0,
        confidenceLabel: 'MANUAL',
        matchMethod: 'manual_add',
        resolvedAt: utcnowTs(),
      })
      .returning();
  }
  ctx.timer.mark('db');
  return Response.json(bookOut(book, enr), { status: 201 });
});
