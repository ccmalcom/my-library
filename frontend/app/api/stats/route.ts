import { asc, eq } from 'drizzle-orm';
import { withApi } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { effectiveRating, round2 } from '@/lib/server/serialize';

export const GET = withApi('/api/stats', async (_req, ctx) => {
  const db = getDb();
  const userId = ctx.user.userId;

  const books = await db
    .select()
    .from(schema.books)
    .where(eq(schema.books.userId, userId))
    .orderBy(asc(schema.books.id));
  const enrRows = await db
    .select({ e: schema.enrichment })
    .from(schema.enrichment)
    .innerJoin(schema.books, eq(schema.enrichment.bookId, schema.books.id))
    .where(eq(schema.books.userId, userId));
  const traits = await db
    .select()
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, userId));
  ctx.timer.mark('db');

  const rated = books.filter((b) => effectiveRating(b.appRating, b.goodreadsRating) !== null);

  const ratingDist: Record<string, number> = {};
  for (const b of rated) {
    const r = String(effectiveRating(b.appRating, b.goodreadsRating));
    ratingDist[r] = (ratingDist[r] ?? 0) + 1;
  }
  const shelfDist: Record<string, number> = {};
  for (const b of books) {
    const s = b.exclusiveShelf ?? 'unknown';
    shelfDist[s] = (shelfDist[s] ?? 0) + 1;
  }
  const hasIsbn = books.filter((b) => b.isbn13).length;

  const confDist: Record<string, number> = {};
  for (const { e } of enrRows) {
    const label = e.confidenceLabel ?? 'NONE';
    confDist[label] = (confDist[label] ?? 0) + 1;
  }
  const ratedIds = new Set(rated.map((b) => b.id));
  const ratedEnriched = enrRows.filter(({ e }) => ratedIds.has(e.bookId)).length;

  const traitPolarity: Record<string, number> = {};
  for (const t of traits) {
    traitPolarity[t.polarity] = (traitPolarity[t.polarity] ?? 0) + 1;
  }

  const nRated = rated.length;
  const meanRating =
    nRated > 0
      ? round2(
          rated.reduce(
            (sum, b) => sum + (effectiveRating(b.appRating, b.goodreadsRating) ?? 0),
            0
          ) / nRated
        )
      : null;

  return Response.json({
    total: books.length,
    rated: nRated,
    unrated: books.length - nRated,
    mean_rating: meanRating,
    by_star: ratingDist,
    shelves: shelfDist,
    has_isbn13: hasIsbn,
    enrichment: {
      rows: enrRows.length,
      rated_books_enriched: ratedEnriched,
      confidence: confDist,
    },
    taste_traits: {
      total: traits.length,
      by_polarity: traitPolarity,
    },
  });
});
