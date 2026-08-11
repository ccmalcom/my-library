import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { schema, type Db } from '../db';
import { importRows } from '../import-books';
import { parseCanonical, parseGoodreads, type ImportRow } from '../import-csv';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => ({ db, close } = await makeTestDb()));
afterEach(async () => close());

function row(title: string, values: Partial<ImportRow> = {}): ImportRow {
  return {
    title,
    author: null,
    additionalAuthors: null,
    isbn13: null,
    shelf: null,
    rating: null,
    review: null,
    dateRead: null,
    dateAdded: null,
    pageCount: null,
    yearPublished: null,
    externalId: null,
    ...values,
  };
}

function expectedBook(values: Partial<typeof schema.books.$inferSelect>) {
  return {
    id: expect.any(Number),
    userId: 'local',
    goodreadsBookId: null,
    title: '',
    author: null,
    additionalAuthors: null,
    isbn13: null,
    exclusiveShelf: null,
    goodreadsRating: 0,
    appRating: null,
    appReview: null,
    feedbackUpdatedAt: null,
    dateRead: null,
    dateAdded: null,
    pageCount: null,
    yearPublished: null,
    source: 'canonical_import',
    excludeFromProfile: false,
    isFavorite: false,
    ...values,
  };
}

describe('importRows', () => {
  test('existing books update only the exact eligible non-null tuple', async () => {
    const [book] = await db
      .insert(schema.books)
      .values({
        userId: 'local',
        goodreadsBookId: '7',
        title: 'Owned Title',
        author: 'Old Author',
        additionalAuthors: 'Keep Me',
        isbn13: 'OLD',
        exclusiveShelf: 'read',
        goodreadsRating: 2,
        appRating: 5,
        appReview: 'Owned review',
        feedbackUpdatedAt: '2026-01-02 03:04:05',
        dateRead: '2025-01-01',
        dateAdded: '2025-01-02',
        pageCount: 100,
        yearPublished: 1990,
        source: 'manual',
      })
      .returning();
    await db.transaction((tx) =>
      importRows(tx, 'local', 'storygraph_import', [
        row('Incoming Title', {
          author: 'New Author',
          isbn13: 'NEW',
          shelf: 'to-read',
          rating: 4,
          review: 'Must not clobber',
          dateAdded: '2026-01-01',
          pageCount: 222,
          yearPublished: 2020,
          externalId: '7',
        }),
      ])
    );
    expect((await db.select().from(schema.books).where(eq(schema.books.id, book.id)))[0]).toEqual({
      ...book,
      author: 'New Author',
      isbn13: 'NEW',
      exclusiveShelf: 'to-read',
      goodreadsRating: 4,
      dateAdded: '2026-01-01',
      pageCount: 222,
      yearPublished: 2020,
    });
  });

  test('fresh rated non-Goodreads insert seeds review but leaves app rating null', async () => {
    await db.transaction((tx) =>
      importRows(tx, 'local', 'storygraph_import', [
        row('Seeded', {
          author: 'A Writer',
          shelf: 'read',
          rating: 5,
          review: 'Seed me',
          dateRead: '2026-01-01',
        }),
      ])
    );
    const [{ id: _id, ...stored }] = await db.select().from(schema.books);
    const { id: _expectedId, ...expected } = expectedBook({
      title: 'Seeded',
      author: 'A Writer',
      exclusiveShelf: 'read',
      goodreadsRating: 5,
      appReview: 'Seed me',
      feedbackUpdatedAt: expect.any(String),
      dateRead: '2026-01-01',
      source: 'storygraph_import',
    });
    expect(stored).toEqual(expected);
  });

  test('fresh review without a rating does not seed owned feedback fields', async () => {
    await db.transaction((tx) =>
      importRows(tx, 'local', 'canonical_import', [row('Unrated', { review: 'No rating' })])
    );
    const [{ id: _id, ...stored }] = await db.select().from(schema.books);
    const { id: _expectedId, ...expected } = expectedBook({ title: 'Unrated' });
    expect(stored).toEqual(expected);
  });

  test('counters allow skipped and rated rows to increment orthogonally', async () => {
    const parsed = parseCanonical(
      'title,author,additional_authors,isbn13,shelf,rating,review,date_read,date_added,page_count,year_published\r\n,, ,,,5,,,,,\r\nDune,Frank Herbert,,,read,5,,,,,\r\nDune,Frank Herbert,,,to-read,4,,,,,\r\n'
    );
    const counts = await db.transaction((tx) =>
      importRows(tx, 'local', 'canonical_import', parsed.rows)
    );
    expect({
      format: parsed.format,
      total_rows: parsed.totalRows,
      skipped: parsed.skipped,
      ...counts,
    }).toEqual({
      format: 'canonical',
      total_rows: 3,
      skipped: 1,
      inserted: 1,
      updated: 1,
      rated: 2,
    });
  });

  test('one transaction rolls back the complete row loop', async () => {
    await expect(
      db.transaction(async (tx) => {
        await importRows(tx, 'local', 'canonical_import', [row('First')]);
        throw new Error('rollback probe');
      })
    ).rejects.toThrow('rollback probe');
    expect(await db.select().from(schema.books)).toEqual([]);
  });

  test('external ID uses external-ID-only precedence even without a match', async () => {
    const [original] = await db
      .insert(schema.books)
      .values({
        userId: 'local',
        title: 'Dune',
        author: 'Frank Herbert',
        isbn13: '9780441172719',
        goodreadsRating: 0,
        source: 'manual',
      })
      .returning();
    expect(
      await db.transaction((tx) =>
        importRows(tx, 'local', 'goodreads_import', [
          row('Dune', {
            author: 'Frank Herbert',
            isbn13: '9780441172719',
            rating: 5,
            externalId: '99',
          }),
        ])
      )
    ).toEqual({ inserted: 1, updated: 0, rated: 1 });
    expect(await db.select().from(schema.books).orderBy(schema.books.id)).toEqual([
      original,
      expectedBook({
        id: expect.any(Number),
        goodreadsBookId: '99',
        title: 'Dune',
        author: 'Frank Herbert',
        isbn13: '9780441172719',
        goodreadsRating: 5,
        source: 'goodreads_import',
      }),
    ]);
  });

  test('ISBN takes precedence over title and surname fallback', async () => {
    const [isbnBook, titleBook] = await db
      .insert(schema.books)
      .values([
        {
          userId: 'local',
          title: 'Other',
          author: 'Someone Else',
          isbn13: 'MATCH',
          goodreadsRating: 0,
          source: 'manual',
        },
        {
          userId: 'local',
          title: 'Dune',
          author: 'Frank Herbert',
          goodreadsRating: 1,
          source: 'manual',
        },
      ])
      .returning();
    await db.transaction((tx) =>
      importRows(tx, 'local', 'canonical_import', [
        row('Dune', { author: 'Frank Herbert', isbn13: 'MATCH', rating: 4 }),
      ])
    );
    expect(await db.select().from(schema.books).orderBy(schema.books.id)).toEqual([
      { ...isbnBook, author: 'Frank Herbert', goodreadsRating: 4 },
      titleBook,
    ]);
  });

  test('normalized title plus author surname provides fallback matching', async () => {
    const [book] = await db
      .insert(schema.books)
      .values({
        userId: 'local',
        title: 'Dune: Deluxe Edition',
        author: 'Frank Herbert',
        goodreadsRating: 1,
        source: 'manual',
      })
      .returning();
    await db.transaction((tx) =>
      importRows(tx, 'local', 'canonical_import', [
        row('Dune (Anniversary)', { author: 'F. Herbert', shelf: 'read', rating: 5 }),
      ])
    );
    expect(await db.select().from(schema.books)).toEqual([
      { ...book, author: 'F. Herbert', exclusiveShelf: 'read', goodreadsRating: 5 },
    ]);
  });

  test('same-batch inserts are indexed for later-row deduplication', async () => {
    expect(
      await db.transaction((tx) =>
        importRows(tx, 'local', 'canonical_import', [
          row('Dune', { author: 'Frank Herbert', isbn13: 'MATCH', rating: 3 }),
          row('Different title', {
            author: 'New Author',
            isbn13: 'MATCH',
            shelf: 'read',
            rating: 5,
          }),
        ])
      )
    ).toEqual({ inserted: 1, updated: 1, rated: 2 });
    expect(await db.select().from(schema.books)).toEqual([
      expectedBook({
        title: 'Dune',
        author: 'New Author',
        isbn13: 'MATCH',
        exclusiveShelf: 'read',
        goodreadsRating: 5,
      }),
    ]);
  });

  test('Goodreads My Review omission never seeds owned feedback', async () => {
    const parsed = parseGoodreads(
      'Book Id,Title,Author,My Rating,My Review\r\n7,Dune,Frank Herbert,5,Ignore me\r\n'
    );
    await db.transaction((tx) => importRows(tx, 'local', 'goodreads_import', parsed.rows));
    expect(await db.select().from(schema.books)).toEqual([
      expectedBook({
        goodreadsBookId: '7',
        title: 'Dune',
        author: 'Frank Herbert',
        goodreadsRating: 5,
        source: 'goodreads_import',
      }),
    ]);
  });

  test('deduplication is isolated across tenants', async () => {
    const [other] = await db
      .insert(schema.books)
      .values({
        userId: 'other',
        goodreadsBookId: '7',
        title: 'Other Tenant',
        author: 'Owner',
        isbn13: 'MATCH',
        goodreadsRating: 2,
        source: 'manual',
      })
      .returning();
    await db.transaction((tx) =>
      importRows(tx, 'local', 'canonical_import', [
        row('Local', { author: 'Reader', isbn13: 'MATCH', rating: 4 }),
      ])
    );
    expect(await db.select().from(schema.books)).toEqual([
      other,
      expectedBook({ title: 'Local', author: 'Reader', isbn13: 'MATCH', goodreadsRating: 4 }),
    ]);
  });
});
