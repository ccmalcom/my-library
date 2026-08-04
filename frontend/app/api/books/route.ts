import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { bookOut } from '@/lib/server/books';
import { effectiveRating, parseBoolParam } from '@/lib/server/serialize';

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
