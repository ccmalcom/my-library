import { afterEach, beforeEach, expect, test } from 'vitest';
import { POST as preview } from '../../../app/api/import/preview/route';
import { POST as importRoute } from '../../../app/api/import/route';
import { GET as exportRoute } from '../../../app/api/export/route';
import { _setDbForTests, schema, type Db } from '../db';
import { exportJsonText } from '../export';
import { parseCanonical } from '../import-csv';
import { makeTestDb } from './helpers/pglite';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
});
afterEach(async () => {
  _setDbForTests(null);
  await close();
});

function upload(filename: string, contents: BlobPart): Request {
  const form = new FormData();
  form.set('file', new File([contents], filename, { type: 'text/csv' }));
  return new Request('http://test/api/import/preview', { method: 'POST', body: form });
}

function importUpload(
  filename: string,
  contents: BlobPart,
  fields: Record<string, string> = {}
): Request {
  const form = new FormData();
  form.set('file', new File([contents], filename, { type: 'text/csv' }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request('http://test/api/import', { method: 'POST', body: form });
}

test('POST preview returns the exact ordered StoryGraph preview object', async () => {
  const res = await preview(
    upload('books.CSV', 'Title,Authors,Read Status,Star Rating\r\nDune,Frank Herbert,Read,4.5\r\n')
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    format: 'storygraph',
    headers: ['Title', 'Authors', 'Read Status', 'Star Rating'],
    sample_rows: [
      {
        Title: 'Dune',
        Authors: 'Frank Herbert',
        'Read Status': 'Read',
        'Star Rating': '4.5',
      },
    ],
    suggested_mapping: {
      title: 'Title',
      author: 'Authors',
      isbn13: null,
      rating: 'Star Rating',
      review: null,
      shelf: 'Read Status',
      date_read: null,
    },
  });
});

test('POST preview rejects missing file, bad suffix, bad UTF-8, and oversize body exactly', async () => {
  const missing = await preview(
    new Request('http://test/api/import/preview', { method: 'POST', body: new FormData() })
  );
  expect({ status: missing.status, body: await missing.json() }).toEqual({
    status: 422,
    body: {
      detail: [{ type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null }],
    },
  });

  const suffix = await preview(upload('books.txt', 'x'));
  expect({ status: suffix.status, body: await suffix.json() }).toEqual({
    status: 422,
    body: { detail: 'Uploaded file must be a .csv' },
  });

  const encoding = await preview(upload('books.csv', new Uint8Array([0xff])));
  expect({ status: encoding.status, body: await encoding.json() }).toEqual({
    status: 422,
    body: { detail: 'File must be UTF-8 encoded CSV.' },
  });

  const size = await preview(upload('books.csv', new Uint8Array(10 * 1024 * 1024 + 1)));
  expect({ status: size.status, body: await size.json() }).toEqual({
    status: 413,
    body: { detail: 'Uploaded CSV exceeds the 10 MiB limit.' },
  });
});

test('POST preview accepts lowercase and uppercase CSV suffixes', async () => {
  const csv = 'Title,Authors\r\nDune,Frank Herbert\r\n';
  const lower = await preview(upload('books.csv', csv));
  const upper = await preview(upload('BOOKS.CSV', csv));
  expect({ status: lower.status, body: await lower.json() }).toEqual({
    status: 200,
    body: {
      format: 'unknown',
      headers: ['Title', 'Authors'],
      sample_rows: [{ Title: 'Dune', Authors: 'Frank Herbert' }],
      suggested_mapping: {
        title: 'Title',
        author: 'Authors',
        isbn13: null,
        rating: null,
        review: null,
        shelf: null,
        date_read: null,
      },
    },
  });
  expect({ status: upper.status, body: await upper.json() }).toEqual({
    status: 200,
    body: {
      format: 'unknown',
      headers: ['Title', 'Authors'],
      sample_rows: [{ Title: 'Dune', Authors: 'Frank Herbert' }],
      suggested_mapping: {
        title: 'Title',
        author: 'Authors',
        isbn13: null,
        rating: null,
        review: null,
        shelf: null,
        date_read: null,
      },
    },
  });
});

test('POST import parses generic mapping and returns exact counters from one committed loop', async () => {
  const mapping = JSON.stringify({
    title: 'Book Title',
    author: 'Writer',
    rating: 'Stars',
    shelf: 'Status',
    review: 'Notes',
    date_read: 'Finished',
  });
  const res = await importRoute(
    importUpload(
      'generic.csv',
      'Book Title,Writer,Stars,Status,Notes,Finished\r\nDune,Frank Herbert,4.5,Read,Excellent,01/01/2026\r\n,Nobody,5,Read,skip me,01/02/2026\r\n',
      { format: 'generic', mapping }
    )
  );
  expect({ status: res.status, body: await res.json() }).toEqual({
    status: 200,
    body: { format: 'generic', total_rows: 2, skipped: 1, inserted: 1, updated: 0, rated: 1 },
  });
  const [{ id: _id, ...book }] = await db.select().from(schema.books);
  expect(book).toEqual({
    userId: 'local',
    goodreadsBookId: null,
    title: 'Dune',
    author: 'Frank Herbert',
    additionalAuthors: null,
    isbn13: null,
    exclusiveShelf: 'read',
    goodreadsRating: 5,
    appRating: null,
    appReview: 'Excellent',
    feedbackUpdatedAt: expect.any(String),
    dateRead: '2026-01-01',
    dateAdded: null,
    pageCount: null,
    yearPublished: null,
    source: 'csv_import',
    excludeFromProfile: false,
    isFavorite: false,
  });
});

test.each([
  [
    'invalid JSON mapping',
    { format: 'generic', mapping: '{' },
    422,
    { detail: 'mapping must be valid JSON.' },
  ],
  [
    'mapping list',
    { format: 'generic', mapping: '[]' },
    422,
    { detail: 'mapping must be a JSON object of string keys and values.' },
  ],
  [
    'mapping non-string value',
    { format: 'generic', mapping: '{"title":7}' },
    422,
    { detail: 'mapping must be a JSON object of string keys and values.' },
  ],
  [
    'generic no mapping',
    { format: 'generic' },
    422,
    { detail: "A 'title' column mapping is required." },
  ],
  [
    'generic mapping no title',
    { format: 'generic', mapping: '{"author":"Writer"}' },
    422,
    { detail: "A 'title' column mapping is required." },
  ],
  [
    'auto undetectable',
    { format: 'auto' },
    422,
    { detail: 'Could not detect the file format. Provide a column mapping (generic import).' },
  ],
  [
    'missing format',
    {},
    422,
    { detail: 'Could not detect the file format. Provide a column mapping (generic import).' },
  ],
  ['unknown format', { format: 'xml' }, 422, { detail: 'Unknown format: xml' }],
  [
    'empty mapping',
    { format: 'generic', mapping: '' },
    422,
    { detail: "A 'title' column mapping is required." },
  ],
] as const)(
  'POST import rejects %s exactly without writing',
  async (_name, fields, status, body) => {
    const res = await importRoute(
      importUpload('generic.csv', 'Name,Writer\r\nDune,Frank Herbert\r\n', fields)
    );
    expect({ status: res.status, body: await res.json() }).toEqual({ status, body });
    expect(await db.select().from(schema.books)).toEqual([]);
  }
);

test('POST import validates the upload before a malformed mapping', async () => {
  const res = await importRoute(importUpload('generic.txt', 'Title\r\nDune\r\n', { mapping: '{' }));
  expect({ status: res.status, body: await res.json() }).toEqual({
    status: 422,
    body: { detail: 'Uploaded file must be a .csv' },
  });
});

test('POST import rejects missing file, bad UTF-8, and oversize uploads exactly', async () => {
  const missingForm = new FormData();
  const missing = await importRoute(
    new Request('http://test/api/import', { method: 'POST', body: missingForm })
  );
  expect({ status: missing.status, body: await missing.json() }).toEqual({
    status: 422,
    body: {
      detail: [{ type: 'missing', loc: ['body', 'file'], msg: 'Field required', input: null }],
    },
  });
  const encoding = await importRoute(importUpload('books.csv', new Uint8Array([0xff])));
  expect({ status: encoding.status, body: await encoding.json() }).toEqual({
    status: 422,
    body: { detail: 'File must be UTF-8 encoded CSV.' },
  });
  const size = await importRoute(importUpload('books.csv', new Uint8Array(10 * 1024 * 1024 + 1)));
  expect({ status: size.status, body: await size.json() }).toEqual({
    status: 413,
    body: { detail: 'Uploaded CSV exceeds the 10 MiB limit.' },
  });
});

test('CSV export is byte-exact and round-trips through the canonical parser', async () => {
  await db.insert(schema.books).values({
    userId: 'local',
    title: 'Comma, "Quote"\nLine',
    author: null,
    additionalAuthors: 'A\rB',
    isbn13: null,
    exclusiveShelf: 'read',
    goodreadsRating: 2,
    appRating: 4,
    appReview: 'Review, yes',
    dateRead: '2026-01-01',
    dateAdded: null,
    pageCount: 0,
    yearPublished: 2020,
    source: 'manual',
  });
  const res = await exportRoute(new Request('http://test/api/export?format=csv'));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  expect(res.headers.get('content-disposition')).toMatch(
    /^attachment; filename="mylibrary-backup-\d{8}\.csv"$/
  );
  const bytes = await res.text();
  expect(bytes).toBe(
    'title,author,additional_authors,isbn13,shelf,rating,review,date_read,date_added,page_count,year_published\r\n"Comma, ""Quote""\nLine",,"A\rB",,read,4,"Review, yes",2026-01-01,,0,2020\r\n'
  );
  expect(parseCanonical(bytes)).toEqual({
    format: 'canonical',
    totalRows: 1,
    skipped: 0,
    rows: [
      {
        title: 'Comma, "Quote"\nLine',
        author: null,
        additionalAuthors: 'A\rB',
        isbn13: null,
        shelf: 'read',
        rating: 4,
        review: 'Review, yes',
        dateRead: '2026-01-01',
        dateAdded: null,
        pageCount: 0,
        yearPublished: 2020,
        externalId: null,
      },
    ],
  });
});

test('JSON export has exact Python bytes, escaping, key order, and ascending IDs', async () => {
  await db.insert(schema.books).values({
    id: 20,
    userId: 'local',
    title: 'Dune',
    author: 'Frank Herbert',
    goodreadsRating: 5,
    appReview: 'café📚\x7f',
    exclusiveShelf: 'read',
    dateRead: '2026-01-01',
    pageCount: 412,
    yearPublished: 1965,
    source: 'goodreads',
  });
  await db.insert(schema.tasteSignal).values([
    {
      id: 9,
      userId: 'local',
      direction: 'avoid',
      targetKind: 'author',
      targetBookId: null,
      snapshot: { z: 2 },
      createdAt: '2026-02-02 03:04:05',
    },
    {
      id: 3,
      userId: 'local',
      direction: 'more',
      targetKind: 'book',
      targetBookId: 20,
      snapshot: { a: 1 },
      createdAt: '2026-01-02 03:04:05',
    },
  ]);
  const books = await db.select().from(schema.books);
  const signals = await db.select().from(schema.tasteSignal).orderBy(schema.tasteSignal.id);
  expect(exportJsonText(books, signals, new Date('2026-08-10T12:34:56.123Z'))).toBe(`{
  "version": 1,
  "exported_at": "2026-08-10T12:34:56.123000+00:00",
  "books": [
    {
      "title": "Dune",
      "author": "Frank Herbert",
      "additional_authors": null,
      "isbn13": null,
      "shelf": "read",
      "goodreads_rating": 5,
      "app_rating": null,
      "app_review": "caf\\u00e9\\ud83d\\udcda\\u007f",
      "effective_rating": 5,
      "is_favorite": false,
      "exclude_from_profile": false,
      "date_read": "2026-01-01",
      "date_added": null,
      "page_count": 412,
      "year_published": 1965,
      "source": "goodreads"
    }
  ],
  "taste_signals": [
    {
      "direction": "more",
      "target_kind": "book",
      "target_book_id": 20,
      "snapshot": {
        "a": 1
      },
      "created_at": "2026-01-02T03:04:05"
    },
    {
      "direction": "avoid",
      "target_kind": "author",
      "target_book_id": null,
      "snapshot": {
        "z": 2
      },
      "created_at": "2026-02-02T03:04:05"
    }
  ]
}`);
});

test('export is tenant-isolated, rejects invalid formats, and defaults to CSV', async () => {
  await db.insert(schema.books).values({
    userId: 'other',
    title: 'Secret',
    goodreadsRating: 5,
    source: 'manual',
  });
  await db.insert(schema.tasteSignal).values({
    userId: 'other',
    direction: 'more',
    targetKind: 'book',
    snapshot: { secret: true },
  });
  const csv = await exportRoute(new Request('http://test/api/export'));
  expect(await csv.text()).toBe(
    'title,author,additional_authors,isbn13,shelf,rating,review,date_read,date_added,page_count,year_published\r\n'
  );
  const json = await exportRoute(new Request('http://test/api/export?format=json'));
  const jsonText = await json.text();
  expect(jsonText).toMatch(
    /^\{\n  "version": 1,\n  "exported_at": ".+",\n  "books": \[\],\n  "taste_signals": \[\]\n\}$/
  );
  expect(jsonText).not.toContain('Secret');
  const invalid = await exportRoute(new Request('http://test/api/export?format=xml'));
  expect({ status: invalid.status, body: await invalid.json() }).toEqual({
    status: 422,
    body: { detail: "format must be 'csv' or 'json'." },
  });
});

test('export queries books in ascending ID order independent of insertion selection order', async () => {
  await db.insert(schema.books).values([
    { id: 40, userId: 'local', title: 'Later', goodreadsRating: 0, source: 'manual' },
    { id: 4, userId: 'local', title: 'Earlier', goodreadsRating: 0, source: 'manual' },
  ]);
  const csv = await exportRoute(new Request('http://test/api/export?format=csv'));
  expect((await csv.text()).split('\r\n').slice(1, 3)).toEqual([
    'Earlier,,,,,,,,,,',
    'Later,,,,,,,,,,',
  ]);
  const json = await exportRoute(new Request('http://test/api/export?format=json'));
  expect((JSON.parse(await json.text()) as { books: Array<{ title: string }> }).books).toEqual([
    expect.objectContaining({ title: 'Earlier' }),
    expect.objectContaining({ title: 'Later' }),
  ]);
});
