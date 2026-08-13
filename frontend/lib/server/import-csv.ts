import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { VALID_SHELVES } from './books';
import { roundRatingHalfUp } from './serialize';

export const SOURCE_FOR = {
  goodreads: 'goodreads_import',
  storygraph: 'storygraph_import',
  canonical: 'canonical_import',
  generic: 'csv_import',
} as const;

export interface ImportRow {
  title: string;
  author: string | null;
  additionalAuthors: string | null;
  isbn13: string | null;
  shelf: string | null;
  rating: number | null;
  review: string | null;
  dateRead: string | null;
  dateAdded: string | null;
  pageCount: number | null;
  yearPublished: number | null;
  externalId: string | null;
}

export interface ParsedImport {
  rows: ImportRow[];
  totalRows: number;
  skipped: number;
  format: keyof typeof SOURCE_FOR;
}

export const PY_DICT_READER_OPTIONS = {
  bom: true,
  columns: true,
  delimiter: ',',
  quote: '"',
  escape: '"',
  // Python's csv module accepts a quote that is not at the start of a field and
  // returns it literally; csv-parse throws Invalid Opening Quote without this.
  // Goodreads exports ISBNs Excel-escaped as ="9780441172719", so every real
  // export hits it. See import-csv-quotes.test.ts for the measured matrix and
  // the two shapes where Node still diverges from Python.
  relax_quotes: true,
  relax_column_count: true,
  skip_empty_lines: true,
  record_delimiter: ['\r\n', '\n', '\r'] satisfies string[],
} as const;

export const CANONICAL_FIELDS = [
  'title',
  'author',
  'additional_authors',
  'isbn13',
  'shelf',
  'rating',
  'review',
  'date_read',
  'date_added',
  'page_count',
  'year_published',
] as const;

export const PY_EXCEL_WRITER_OPTIONS = {
  header: true,
  columns: CANONICAL_FIELDS,
  delimiter: ',',
  quote: '"',
  escape: '"',
  quoted: false,
  quoted_empty: false,
  quoted_match: /[\r\n]/,
  record_delimiter: '\r\n',
  eof: true,
} as const;

export type CsvRecord = Record<string, string | null | string[]> & {
  __extra?: string[];
};

export interface ParsedCsvRecords {
  headers: string[];
  rows: CsvRecord[];
}

export function parseCsvRecords(text: string): ParsedCsvRecords {
  let headers: string[] = [];
  const rows = parse<CsvRecord, Record<string, string>>(text, {
    ...PY_DICT_READER_OPTIONS,
    columns(columns: string[]) {
      headers = columns;
      return columns;
    },
    on_record(record: Record<string, string>, context) {
      const row: CsvRecord = {};
      for (const header of headers) row[header] = record[header] ?? null;

      const rawRecord = context.error?.record;
      if (Array.isArray(rawRecord) && rawRecord.length > headers.length) {
        row.__extra = rawRecord.slice(headers.length) as string[];
      }
      return row;
    },
  });
  return { headers, rows };
}

export type CanonicalCsvRecord = Record<(typeof CANONICAL_FIELDS)[number], string>;

export function stringifyCanonical(records: CanonicalCsvRecord[]): string {
  return stringify(records, PY_EXCEL_WRITER_OPTIONS);
}

function textCell(row: CsvRecord, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

export function cleanIsbn(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let value = raw.trim();
  if (value.startsWith('=')) value = value.slice(1);
  value = value
    .trim()
    .replace(/^"+|"+$/g, '')
    .trim();
  return value || null;
}

const PYTHON_FLOAT_LITERAL =
  /^[+-]?(?:(?:\d(?:_?\d)*)?(?:\.\d(?:_?\d)*)|\d(?:_?\d)*\.?)(?:[eE][+-]?\d(?:_?\d)*)?$/;

function parsePythonFloat(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (!text || !PYTHON_FLOAT_LITERAL.test(text)) return null;
  const value = Number(text.replaceAll('_', ''));
  // Intentional deviation: Python raises OverflowError for infinity; malformed CSV cells return null here.
  return Number.isFinite(value) ? value : null;
}

export function parseIntValue(raw: string | null | undefined): number | null {
  const value = parsePythonFloat(raw);
  return value == null ? null : Math.trunc(value);
}

export function parseDateOnly(raw: string | null | undefined): string | null {
  if (raw == null || !raw.trim()) return null;
  const value = raw.trim();
  const match = /^(?:(\d{4})([/-])(\d{1,2})\2(\d{1,2})|(\d{1,2})\/(\d{1,2})\/(\d{4}))$/.exec(value);
  if (!match) return null;
  const year = Number(match[1] ?? match[7]);
  const month = Number(match[3] ?? match[5]);
  const day = Number(match[4] ?? match[6]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const SHELF_SYNONYMS: Record<string, string> = {
  read: 'read',
  'currently-reading': 'currently-reading',
  'currently reading': 'currently-reading',
  reading: 'currently-reading',
  'to-read': 'to-read',
  'to read': 'to-read',
  'want to read': 'to-read',
  tbr: 'to-read',
  'did-not-finish': 'did-not-finish',
  'did not finish': 'did-not-finish',
  dnf: 'did-not-finish',
  abandoned: 'did-not-finish',
};

export function normalizeShelf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (VALID_SHELVES.includes(key as (typeof VALID_SHELVES)[number])) return key;
  return SHELF_SYNONYMS[key] ?? null;
}

function parseRating(raw: string | null): number | null {
  const value = parsePythonFloat(raw);
  return value == null ? null : roundRatingHalfUp(value);
}

function firstAuthor(raw: string | null): [string | null, string | null] {
  if (!raw) return [null, null];
  const parts = raw
    .replaceAll(' and ', ', ')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return [parts[0] ?? null, parts.slice(1).join(', ') || null];
}

function baseResult(
  format: ParsedImport['format'],
  text: string,
  convert: (row: CsvRecord) => ImportRow | null
): ParsedImport {
  const parsed = parseCsvRecords(text);
  const rows: ImportRow[] = [];
  let skipped = 0;
  for (const record of parsed.rows) {
    const row = convert(record);
    if (row) rows.push(row);
    else skipped += 1;
  }
  return { rows, totalRows: parsed.rows.length, skipped, format };
}

export function parseGoodreads(text: string): ParsedImport {
  return baseResult('goodreads', text, (row) => {
    const title = (textCell(row, 'Title') ?? '').trim();
    if (!title) return null;
    const rating = parseIntValue(textCell(row, 'My Rating')) ?? 0;
    return {
      title,
      author: (textCell(row, 'Author') ?? '').trim() || null,
      additionalAuthors: (textCell(row, 'Additional Authors') ?? '').trim() || null,
      isbn13: cleanIsbn(textCell(row, 'ISBN13')) ?? cleanIsbn(textCell(row, 'ISBN')),
      shelf: (textCell(row, 'Exclusive Shelf') ?? '').trim() || null,
      rating: rating || null,
      review: null,
      dateRead: parseDateOnly(textCell(row, 'Date Read')),
      dateAdded: parseDateOnly(textCell(row, 'Date Added')),
      pageCount: parseIntValue(textCell(row, 'Number of Pages')),
      yearPublished:
        parseIntValue(textCell(row, 'Original Publication Year')) ??
        parseIntValue(textCell(row, 'Year Published')),
      externalId: (textCell(row, 'Book Id') ?? '').trim() || null,
    };
  });
}

function isbn13Only(raw: string | null): string | null {
  const value = cleanIsbn(raw);
  return value && /^\d{13}$/.test(value) ? value : null;
}

export function parseStorygraph(text: string): ParsedImport {
  return baseResult('storygraph', text, (row) => {
    const title = (textCell(row, 'Title') ?? '').trim();
    if (!title) return null;
    const [author, extra] = firstAuthor(textCell(row, 'Authors'));
    const contributors = (textCell(row, 'Contributors') ?? '').trim() || null;
    return {
      title,
      author,
      additionalAuthors: [extra, contributors].filter(Boolean).join(', ') || null,
      isbn13: isbn13Only(textCell(row, 'ISBN/UID')),
      shelf: normalizeShelf(textCell(row, 'Read Status')),
      rating: parseRating(textCell(row, 'Star Rating')),
      review: (textCell(row, 'Review') ?? '').trim() || null,
      dateRead: parseDateOnly(textCell(row, 'Last Date Read')),
      dateAdded: parseDateOnly(textCell(row, 'Date Added')),
      pageCount: null,
      yearPublished: null,
      externalId: null,
    };
  });
}

export function detectFormat(
  headers: string[]
): 'goodreads' | 'storygraph' | 'canonical' | 'unknown' {
  const exact = new Set(headers.map((header) => header.trim()));
  const lower = new Set(headers.map((header) => header.trim().toLowerCase()));
  if (exact.has('Book Id') && exact.has('Exclusive Shelf')) return 'goodreads';
  if (exact.has('Read Status') && exact.has('Star Rating')) return 'storygraph';
  if (['title', 'shelf', 'rating'].every((header) => lower.has(header))) return 'canonical';
  return 'unknown';
}

export function parseCanonical(text: string): ParsedImport {
  return baseResult('canonical', text, (row) => {
    const title = (textCell(row, 'title') ?? '').trim();
    if (!title) return null;
    return {
      title,
      author: (textCell(row, 'author') ?? '').trim() || null,
      additionalAuthors: (textCell(row, 'additional_authors') ?? '').trim() || null,
      isbn13: cleanIsbn(textCell(row, 'isbn13')),
      shelf: normalizeShelf(textCell(row, 'shelf')),
      rating: parseRating(textCell(row, 'rating')),
      review: (textCell(row, 'review') ?? '').trim() || null,
      dateRead: parseDateOnly(textCell(row, 'date_read')),
      dateAdded: parseDateOnly(textCell(row, 'date_added')),
      pageCount: parseIntValue(textCell(row, 'page_count')),
      yearPublished: parseIntValue(textCell(row, 'year_published')),
      externalId: null,
    };
  });
}

const MAPPING_FIELDS = [
  'title',
  'author',
  'isbn13',
  'rating',
  'review',
  'shelf',
  'date_read',
] as const;
const SUGGEST_HINTS: Record<(typeof MAPPING_FIELDS)[number], readonly string[]> = {
  title: ['title', 'book'],
  author: ['author', 'writer', 'by'],
  isbn13: ['isbn'],
  rating: ['rating', 'stars', 'star', 'score'],
  review: ['review', 'notes', 'comment'],
  shelf: ['shelf', 'status', 'read status', 'bookshelf'],
  date_read: ['date read', 'read date', 'finished'],
};

export function suggestMapping(
  headers: string[]
): Record<(typeof MAPPING_FIELDS)[number], string | null> {
  const out = Object.fromEntries(MAPPING_FIELDS.map((field) => [field, null])) as Record<
    (typeof MAPPING_FIELDS)[number],
    string | null
  >;
  for (const field of MAPPING_FIELDS) {
    for (const header of headers) {
      const lower = header.trim().toLowerCase();
      if (SUGGEST_HINTS[field].some((hint) => lower.includes(hint))) {
        out[field] = header;
        break;
      }
    }
  }
  return out;
}

export function parseGeneric(text: string, mapping: Record<string, string>): ParsedImport {
  const titleColumn = mapping.title;
  if (!titleColumn) throw new Error("A 'title' column mapping is required.");
  return baseResult('generic', text, (row) => {
    const cell = (field: string) => (mapping[field] ? textCell(row, mapping[field]) : null);
    const title = (textCell(row, titleColumn) ?? '').trim();
    if (!title) return null;
    return {
      title,
      author: (cell('author') ?? '').trim() || null,
      additionalAuthors: null,
      isbn13: cleanIsbn(cell('isbn13')),
      shelf: normalizeShelf(cell('shelf')),
      rating: parseRating(cell('rating')),
      review: (cell('review') ?? '').trim() || null,
      dateRead: parseDateOnly(cell('date_read')),
      dateAdded: null,
      pageCount: null,
      yearPublished: null,
      externalId: null,
    };
  });
}

export function parseImport(
  text: string,
  format: string,
  mapping?: Record<string, string>
): ParsedImport {
  let resolved = format;
  if (resolved === 'auto') {
    resolved = detectFormat(parseCsvRecords(text).headers);
    if (resolved === 'unknown') {
      throw new Error(
        'Could not detect the file format. Provide a column mapping (generic import).'
      );
    }
  }
  if (resolved === 'goodreads') return parseGoodreads(text);
  if (resolved === 'storygraph') return parseStorygraph(text);
  if (resolved === 'canonical') return parseCanonical(text);
  if (resolved === 'generic') return parseGeneric(text, mapping ?? {});
  throw new Error(`Unknown format: ${resolved}`);
}

export function buildImportPreview(text: string) {
  const { headers, rows } = parseCsvRecords(text);
  const format = detectFormat(headers);
  return {
    format,
    headers,
    sample_rows: rows
      .slice(0, 5)
      .map((row) =>
        Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value || '']))
      ),
    suggested_mapping: suggestMapping(headers),
  };
}
