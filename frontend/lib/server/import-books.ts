import { and, eq } from 'drizzle-orm';
import { schema, type DbTx } from './db';
import type { ImportRow } from './import-csv';
import { utcnowTs } from './serialize';

export const UPDATE_ELIGIBLE_FIELDS = [
  'author',
  'additionalAuthors',
  'isbn13',
  'exclusiveShelf',
  'dateRead',
  'dateAdded',
  'pageCount',
  'yearPublished',
  'goodreadsRating',
] as const;

type Book = typeof schema.books.$inferSelect;
type BookInsert = typeof schema.books.$inferInsert;
type UpdateField = (typeof UPDATE_ELIGIBLE_FIELDS)[number];

export interface ImportCounts {
  inserted: number;
  updated: number;
  rated: number;
}

function normalizeTitle(title: string | null): string {
  if (!title) return '';
  return title
    .toLowerCase()
    .split(':')[0]
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function surname(author: string | null): string {
  if (!author) return '';
  return normalizeTitle(author).split(' ').at(-1) ?? '';
}

function titleKey(title: string | null, author: string | null): string {
  return `${normalizeTitle(title)}\u0000${surname(author)}`;
}

export async function importRows(
  tx: DbTx,
  userId: string,
  source: string,
  rows: ImportRow[]
): Promise<ImportCounts> {
  const existing = await tx.select().from(schema.books).where(eq(schema.books.userId, userId));
  const byExternalId = new Map<string, Book>();
  const byIsbn = new Map<string, Book>();
  const byTitleKey = new Map<string, Book>();

  for (const book of existing) {
    if (book.goodreadsBookId) byExternalId.set(book.goodreadsBookId, book);
    if (book.isbn13) byIsbn.set(book.isbn13, book);
    const key = titleKey(book.title, book.author);
    if (!byTitleKey.has(key)) byTitleKey.set(key, book);
  }

  let inserted = 0;
  let updated = 0;
  let rated = 0;

  for (const row of rows) {
    if (row.rating) rated += 1;

    let match: Book | undefined;
    if (row.externalId !== null) {
      match = byExternalId.get(row.externalId);
    } else {
      if (row.isbn13) match = byIsbn.get(row.isbn13);
      if (!match) match = byTitleKey.get(titleKey(row.title, row.author));
    }

    const incoming: Record<UpdateField, string | number | null> = {
      author: row.author,
      additionalAuthors: row.additionalAuthors,
      isbn13: row.isbn13,
      exclusiveShelf: row.shelf,
      dateRead: row.dateRead,
      dateAdded: row.dateAdded,
      pageCount: row.pageCount,
      yearPublished: row.yearPublished,
      goodreadsRating: row.rating,
    };

    if (match) {
      const values: Partial<BookInsert> = {};
      for (const field of UPDATE_ELIGIBLE_FIELDS) {
        const value = incoming[field];
        if (value !== null) Object.assign(values, { [field]: value });
      }
      if (Object.keys(values).length > 0) {
        await tx
          .update(schema.books)
          .set(values)
          .where(and(eq(schema.books.userId, userId), eq(schema.books.id, match.id)));
        Object.assign(match, values);
      }
      updated += 1;
      continue;
    }

    const seedReview = Boolean(row.review && row.rating);
    const [book] = await tx
      .insert(schema.books)
      .values({
        userId,
        goodreadsBookId: row.externalId,
        title: row.title,
        author: row.author,
        additionalAuthors: row.additionalAuthors,
        isbn13: row.isbn13,
        exclusiveShelf: row.shelf,
        goodreadsRating: row.rating || 0,
        appRating: null,
        appReview: seedReview ? row.review : null,
        feedbackUpdatedAt: seedReview ? utcnowTs() : null,
        dateRead: row.dateRead,
        dateAdded: row.dateAdded,
        pageCount: row.pageCount,
        yearPublished: row.yearPublished,
        source,
      })
      .returning();

    if (row.isbn13 && !byIsbn.has(row.isbn13)) byIsbn.set(row.isbn13, book);
    const key = titleKey(row.title, row.author);
    if (!byTitleKey.has(key)) byTitleKey.set(key, book);
    if (book.goodreadsBookId && !byExternalId.has(book.goodreadsBookId)) {
      byExternalId.set(book.goodreadsBookId, book);
    }
    inserted += 1;
  }

  return { inserted, updated, rated };
}
