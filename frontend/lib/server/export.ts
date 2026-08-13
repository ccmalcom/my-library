import { asc, eq } from 'drizzle-orm';
import { stringifyCanonical, type CanonicalCsvRecord } from './import-csv';
import { schema, type Db } from './db';
import { effectiveRating, pyJsonDumpsIndented, tsToIso } from './serialize';

type Book = typeof schema.books.$inferSelect;
type Signal = typeof schema.tasteSignal.$inferSelect;

function csvText(books: Book[]): string {
  const records: CanonicalCsvRecord[] = books.map((book) => ({
    title: book.title,
    author: book.author ?? '',
    additional_authors: book.additionalAuthors ?? '',
    isbn13: book.isbn13 ?? '',
    shelf: book.exclusiveShelf ?? '',
    rating: String(effectiveRating(book.appRating, book.goodreadsRating) ?? ''),
    review: book.appReview ?? '',
    date_read: book.dateRead ?? '',
    date_added: book.dateAdded ?? '',
    page_count: book.pageCount == null ? '' : String(book.pageCount),
    year_published: book.yearPublished == null ? '' : String(book.yearPublished),
  }));
  return stringifyCanonical(records);
}

function pythonUtcIso(now: Date): string {
  return `${now.toISOString().slice(0, -1)}000+00:00`;
}

export function exportJsonText(books: Book[], signals: Signal[], now = new Date()): string {
  return pyJsonDumpsIndented({
    version: 1,
    exported_at: pythonUtcIso(now),
    books: books.map((book) => ({
      title: book.title,
      author: book.author,
      additional_authors: book.additionalAuthors,
      isbn13: book.isbn13,
      shelf: book.exclusiveShelf,
      goodreads_rating: book.goodreadsRating,
      app_rating: book.appRating,
      app_review: book.appReview,
      effective_rating: effectiveRating(book.appRating, book.goodreadsRating),
      is_favorite: book.isFavorite,
      exclude_from_profile: book.excludeFromProfile,
      date_read: book.dateRead,
      date_added: book.dateAdded,
      page_count: book.pageCount,
      year_published: book.yearPublished,
      source: book.source,
    })),
    taste_signals: signals.map((signal) => ({
      direction: signal.direction,
      target_kind: signal.targetKind,
      target_book_id: signal.targetBookId,
      snapshot: signal.snapshot,
      created_at: tsToIso(signal.createdAt),
    })),
  });
}

export async function buildExport(db: Db, userId: string, format: 'csv' | 'json'): Promise<string> {
  const books = await db
    .select()
    .from(schema.books)
    .where(eq(schema.books.userId, userId))
    .orderBy(asc(schema.books.id));
  if (format === 'csv') return csvText(books);
  const signals = await db
    .select()
    .from(schema.tasteSignal)
    .where(eq(schema.tasteSignal.userId, userId))
    .orderBy(asc(schema.tasteSignal.id));
  return exportJsonText(books, signals);
}

export function utcDateStamp(now: Date): string {
  return now.toISOString().slice(0, 10).replaceAll('-', '');
}
