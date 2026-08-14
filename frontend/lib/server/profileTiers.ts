/**
 * Port of profile.py's tier construction (_tier, _book_payload, build_tiers).
 * The result is a Map, not an object: Python preserves the dict literal's
 * insertion order ('5','4.5','4','3.5','3','<=2','dnf','rejected') and V8 would
 * reorder the integer-like keys ahead of the rest, changing the byte-exact
 * prompt. '4.5' and '3.5' are not integer-like, so an object would order them
 * differently again -- the Map is what keeps the order stated rather than
 * inferred.
 */
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { schema, type Db } from './db';
import { effectiveRating } from './serialize';

export type BookRow = typeof schema.books.$inferSelect;
export type EnrichmentRow = typeof schema.enrichment.$inferSelect;
export type Tiers = Map<string, Record<string, unknown>[]>;

/**
 * Half stars get their own tiers so the profile sees the distinction the
 * reader actually drew. Diverges from Python's profile._tier on purpose --
 * Python is dead (Railway paused) and is not being kept in step.
 */
export function tierFor(rating: number): string {
  if (rating >= 5) return '5';
  if (rating >= 4.5) return '4.5';
  if (rating >= 4) return '4';
  if (rating >= 3.5) return '3.5';
  if (rating >= 3) return '3';
  return '<=2';
}

/**
 * Twin of profile._book_payload. Key insertion order is load-bearing (it becomes
 * JSON in the prompt), and `review` is appended only when app_review is truthy —
 * matching Python's conditional `payload["review"] = ...`.
 */
export function bookPayload(book: BookRow, enr: EnrichmentRow | null): Record<string, unknown> {
  const subjects = enr ? ((enr.subjects as string[] | null) ?? []).slice(0, 8) : [];
  // date columns read as 'YYYY-MM-DD'; Python takes `.year` off a date object.
  const readDate = book.dateRead || book.dateAdded;
  const payload: Record<string, unknown> = {
    id: book.id,
    title: book.title,
    author: book.author,
    year: book.yearPublished,
    pages: book.pageCount,
    subjects,
    series: enr ? enr.series : null,
    read_year: readDate ? Number(readDate.slice(0, 4)) : null,
  };
  if (book.appReview) payload.review = book.appReview.trim().slice(0, 1000);
  return payload;
}

/**
 * Twin of profile.build_tiers (called without less_like_books, as api.py does, so
 * no `less_like` bucket is ever added). Both queries carry an explicit ORDER BY:
 * their rows are serialized straight into the Claude prompt.
 */
export async function buildTiers(db: Db, userId: string): Promise<Tiers> {
  const tiers: Tiers = new Map([
    ['5', []],
    ['4.5', []],
    ['4', []],
    ['3.5', []],
    ['3', []],
    ['<=2', []],
    ['dnf', []],
    ['rejected', []],
  ]);

  const rows = await db
    .select({ book: schema.books, enrichment: schema.enrichment })
    .from(schema.books)
    .leftJoin(schema.enrichment, eq(schema.enrichment.bookId, schema.books.id))
    .where(and(eq(schema.books.userId, userId), eq(schema.books.excludeFromProfile, false)))
    .orderBy(asc(schema.books.id));

  for (const { book, enrichment } of rows) {
    if (book.exclusiveShelf === 'did-not-finish') {
      tiers.get('dnf')!.push(bookPayload(book, enrichment));
      continue;
    }
    const r = effectiveRating(book.appRating, book.goodreadsRating);
    if (r === null) continue;
    tiers.get(tierFor(r))!.push(bookPayload(book, enrichment));
  }

  const recs = await db
    .select({
      title: schema.recommendations.title,
      author: schema.recommendations.author,
      userNote: schema.recommendations.userNote,
    })
    .from(schema.recommendations)
    .where(
      and(
        eq(schema.recommendations.userId, userId),
        eq(schema.recommendations.status, 'rejected'),
        isNotNull(schema.recommendations.userNote)
      )
    )
    .orderBy(asc(schema.recommendations.id));

  for (const rec of recs) {
    tiers.get('rejected')!.push({ title: rec.title, author: rec.author, note: rec.userNote });
  }

  return tiers;
}
