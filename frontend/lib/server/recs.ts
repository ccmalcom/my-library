import { and, eq, isNotNull } from 'drizzle-orm';
import { schema, type Db } from './db';
import { tsToIso } from './serialize';
import { sameWork } from './dedup';

/** Port of schemas.py::RecommendationOut (note: no reject_reasons field). */
export function recOut(r: typeof schema.recommendations.$inferSelect) {
  return {
    id: r.id,
    run_id: r.runId,
    rank: r.rank,
    title: r.title,
    author: r.author,
    year: r.year,
    isbn13: r.isbn13,
    cover_url: r.coverUrl,
    subjects: r.subjects,
    description: r.description,
    catalog_source: r.catalogSource,
    catalog_id: r.catalogId,
    retrieval_pool: r.retrievalPool,
    seed_reason: r.seedReason,
    score: r.score,
    rationale: r.rationale,
    grounded_trait_ids: r.groundedTraitIds,
    grounded_book_ids: r.groundedBookIds,
    status: r.status,
    user_note: r.userNote,
    created_at: tsToIso(r.createdAt),
  };
}

/** Port of feedback_vocab.REJECT_REASONS — order matters for the pyList() 422 detail. */
export const REJECT_REASONS = [
  'wrong_genre', 'too_dark', 'tried_author', 'too_long',
  'not_now', 'overhyped', 'wrong_vibe',
] as const;

type RecRow = typeof schema.recommendations.$inferSelect;

/** Idempotently land a recommended book in the user's library on `shelf`.
 *  Port of api.py::_ensure_library_book (same-work dedup, stub enrichment). */
export async function ensureLibraryBook(db: Db, rec: RecRow, shelf: string, userId: string) {
  const existing = await db.select().from(schema.books)
    .where(and(eq(schema.books.userId, userId), isNotNull(schema.books.title)));
  for (const b of existing) {
    if (sameWork(b.title, b.author, rec.title, rec.author)) {
      const enr = (await db.select().from(schema.enrichment)
        .where(eq(schema.enrichment.bookId, b.id)))[0] ?? null;
      return { book: b, enrichment: enr };
    }
  }
  const [book] = await db.insert(schema.books).values({
    userId, title: rec.title, author: rec.author, isbn13: rec.isbn13,
    yearPublished: rec.year, exclusiveShelf: shelf,
    source: 'recommendation', goodreadsRating: 0,
  }).returning();
  const [enr] = await db.insert(schema.enrichment).values({
    bookId: book.id, resolvedSource: rec.catalogSource, resolvedId: rec.catalogId,
    subjects: rec.subjects, description: rec.description, coverUrl: rec.coverUrl,
    resolutionConfidence: 1.0, confidenceLabel: 'RECOMMENDATION',
    matchMethod: 'recommendation_' + shelf,
  }).returning();
  return { book, enrichment: enr };
}
