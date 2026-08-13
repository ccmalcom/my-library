import { describe, expect, test } from 'vitest';
import {
  buildImportPreview,
  detectFormat,
  parseCanonical,
  parseCsvRecords,
  parseDateOnly,
  parseGeneric,
  parseGoodreads,
  parseIntValue,
  parseStorygraph,
  stringifyCanonical,
} from '../import-csv';
import { roundRatingHalfStar } from '../rating';
import { pyRoundHalfEven } from '../serialize';

describe('Python csv compatibility', () => {
  test('returns headers when no data records exist', () => {
    expect(parseCsvRecords('a,b,c\r\n')).toEqual({
      headers: ['a', 'b', 'c'],
      rows: [],
    });
    expect(parseCsvRecords('a,b,c\r\n\r\n')).toEqual({
      headers: ['a', 'b', 'c'],
      rows: [],
    });
    expect(parseCsvRecords('')).toEqual({ headers: [], rows: [] });
  });

  test('strips the BOM from a header-only input', () => {
    expect(parseCsvRecords('\uFEFFa,b,c\r\n')).toEqual({
      headers: ['a', 'b', 'c'],
      rows: [],
    });
  });

  test('matches DictReader/DictWriter on quoting, newlines, BOM, ragged rows, and trailing blank line', () => {
    // Python strips this BOM while decoding with utf-8-sig; here the reader does that job.
    const text =
      '\uFEFFa,b,c\r\n"x,y","say ""hi""","line1\nline2"\r\nplain,"lone\rreturn"\r\nshort,only\r\ntoo,many,cells,EXTRA\r\n\r\n';
    expect(parseCsvRecords(text)).toEqual({
      headers: ['a', 'b', 'c'],
      rows: [
        { a: 'x,y', b: 'say "hi"', c: 'line1\nline2' },
        { a: 'plain', b: 'lone\rreturn', c: null },
        { a: 'short', b: 'only', c: null },
        { a: 'too', b: 'many', c: 'cells', __extra: ['EXTRA'] },
      ],
    });
    expect(
      stringifyCanonical([
        {
          title: 'x,y',
          author: 'say "hi"',
          additional_authors: 'line1\nline2',
          isbn13: 'lone\rreturn',
          shelf: '',
          rating: '',
          review: '',
          date_read: '',
          date_added: '',
          page_count: '',
          year_published: '',
        },
      ])
    ).toBe(
      'title,author,additional_authors,isbn13,shelf,rating,review,date_read,date_added,page_count,year_published\r\n' +
        '"x,y","say ""hi""","line1\nline2","lone\rreturn",,,,,,,\r\n'
    );
  });
});

test('star rounding is half-up on the half-star grid, not Python banker rounding', () => {
  // Half-star grid, halves going up. Banker's rounding would send 4.25 to 4.0
  // and 0.25 to 0.0 -- import stars must not route through pyRound.
  expect(roundRatingHalfStar(4.25)).toBe(4.5);
  expect(roundRatingHalfStar(4.24)).toBe(4);
  expect(roundRatingHalfStar(0.4)).toBe(0.5);
  expect(roundRatingHalfStar(9)).toBe(5);
  expect(pyRoundHalfEven(4.5)).toBe(4);
});

const emptyOptionals = {
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
};

test('date parsing is timezone-free and cannot shift to the prior day', () => {
  process.env.TZ = 'America/Los_Angeles';
  const cases: [string, string | null][] = [
    ['01/01/2026', '2026-01-01'],
    ['2026/01/02', '2026-01-02'],
    ['2026-01-03', '2026-01-03'],
    ['2026/1/2', '2026-01-02'],
    ['2026/1/02', '2026-01-02'],
    ['2026-1-3', '2026-01-03'],
    ['2026-01-3', '2026-01-03'],
    ['1/2/2026', '2026-01-02'],
    ['26/1/2', null],
    ['2026/01-02', null],
    ['2026-01/02', null],
    ['01-01-2026', null],
    ['2026-13-01', null],
  ];
  for (const [input, expected] of cases) expect(parseDateOnly(input)).toBe(expected);
  expect(
    new Date('2026-01-01').toLocaleDateString('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  ).toBe('12/31/2025');
});

const numericCases: [string, number | null, number | null][] = [
  ['0x10', null, null],
  ['0b101', null, null],
  ['0o17', null, null],
  ['1_000', 1000, 5],
  ['1_0.5', 10, 5],
  ['1e3', 1000, 5],
  ['1E3', 1000, 5],
  // 0.5, not 1: half stars survive import as of the half-star wave. The old
  // whole-star helper promoted this to 1.
  ['.5', 0, 0.5],
  ['5.', 5, 5],
  ['+5', 5, 5],
  [' 7 ', 7, 5],
  ['nan', null, null],
  ['NaN', null, null],
  ['0xg', null, null],
  ['4abc', null, null],
  ['_1', null, null],
  ['1_', null, null],
  ['1__0', null, null],
  ['inf', null, null],
  ['-inf', null, null],
  ['Infinity', null, null],
  ['1e400', null, null],
];

test('integer parsing matches Python decimal float literals without propagating overflow', () => {
  for (const [input, expected] of numericCases) expect(parseIntValue(input)).toBe(expected);
});

test('rating parsing uses the same Python decimal float literal rules', () => {
  for (const [input, , expected] of numericCases) {
    const result = parseCanonical(
      `title,author,additional_authors,isbn13,shelf,rating,review,date_read,date_added,page_count,year_published\nBook,,,,,${input},,,,,\n`
    );
    expect(result.rows[0]?.rating).toBe(expected);
  }
});

test('parses a complete Goodreads row and drops its review', () => {
  expect(
    parseGoodreads(
      'Book Id,Title,Author,Additional Authors,ISBN13,ISBN,Exclusive Shelf,My Rating,My Review,Date Read,Date Added,Number of Pages,Original Publication Year,Year Published\r\n7,Dune,Frank Herbert,Brian Herbert,"=""9780441172719""",fallback,read,4.9,ignored,2026/01/02,01/03/2026,412.9,,1965.8\r\n'
    )
  ).toEqual({
    format: 'goodreads',
    totalRows: 1,
    skipped: 0,
    rows: [
      {
        title: 'Dune',
        author: 'Frank Herbert',
        additionalAuthors: 'Brian Herbert',
        isbn13: '9780441172719',
        shelf: 'read',
        rating: 4,
        review: null,
        dateRead: '2026-01-02',
        dateAdded: '2026-01-03',
        pageCount: 412,
        yearPublished: 1965,
        externalId: '7',
      },
    ],
  });
});

test('parses a complete StoryGraph row with half-up rating and review', () => {
  expect(
    parseStorygraph(
      'Title,Authors,Contributors,ISBN/UID,Read Status,Star Rating,Review,Last Date Read,Date Added\nDune,"Frank Herbert and Brian Herbert",Editor,9780441172719,Currently Reading,4.9,Great,2026-01-02,2026/01/03\n'
    )
  ).toEqual({
    format: 'storygraph',
    totalRows: 1,
    skipped: 0,
    rows: [
      {
        title: 'Dune',
        author: 'Frank Herbert',
        additionalAuthors: 'Brian Herbert, Editor',
        isbn13: '9780441172719',
        shelf: 'currently-reading',
        rating: 5,
        review: 'Great',
        dateRead: '2026-01-02',
        dateAdded: '2026-01-03',
        pageCount: null,
        yearPublished: null,
        externalId: null,
      },
    ],
  });
});

describe('storygraph half stars', () => {
  test('preserves a half-star rating', () => {
    const csv =
      'Title,Authors,Contributors,ISBN/UID,Read Status,Star Rating,Review,Last Date Read,Date Added\n' +
      'Piranesi,Susanna Clarke,,,read,4.5,,2024-01-02,2024-01-01\n';
    const parsed = parseStorygraph(csv);
    expect(parsed.rows[0].rating).toBe(4.5);
  });

  test('snaps an off-grid rating to the nearest half', () => {
    const csv =
      'Title,Authors,Contributors,ISBN/UID,Read Status,Star Rating,Review,Last Date Read,Date Added\n' +
      'Piranesi,Susanna Clarke,,,read,3.7,,2024-01-02,2024-01-01\n';
    const parsed = parseStorygraph(csv);
    expect(parsed.rows[0].rating).toBe(3.5);
  });
});

test('parses a complete canonical row', () => {
  expect(
    parseCanonical(
      'title,author,additional_authors,isbn13,shelf,rating,review,date_read,date_added,page_count,year_published\nDune,Frank Herbert,Someone,9780441172719,tbr,4.9,Great,01/02/2026,2026-01-03,412.8,1965.9\n'
    )
  ).toEqual({
    format: 'canonical',
    totalRows: 1,
    skipped: 0,
    rows: [
      {
        title: 'Dune',
        author: 'Frank Herbert',
        additionalAuthors: 'Someone',
        isbn13: '9780441172719',
        shelf: 'to-read',
        rating: 5,
        review: 'Great',
        dateRead: '2026-01-02',
        dateAdded: '2026-01-03',
        pageCount: 412,
        yearPublished: 1965,
        externalId: null,
      },
    ],
  });
});

test('parses a complete generic row from its mapping', () => {
  expect(
    parseGeneric(
      'Book,Writer,Code,Status,Stars,Notes,Finished\nDune,Frank Herbert,9780441172719,dnf,4.9,Great,2026/01/02\n',
      {
        title: 'Book',
        author: 'Writer',
        isbn13: 'Code',
        shelf: 'Status',
        rating: 'Stars',
        review: 'Notes',
        date_read: 'Finished',
      }
    )
  ).toEqual({
    format: 'generic',
    totalRows: 1,
    skipped: 0,
    rows: [
      {
        title: 'Dune',
        author: 'Frank Herbert',
        additionalAuthors: null,
        isbn13: '9780441172719',
        shelf: 'did-not-finish',
        rating: 5,
        review: 'Great',
        dateRead: '2026-01-02',
        dateAdded: null,
        pageCount: null,
        yearPublished: null,
        externalId: null,
      },
    ],
  });
});

test('detects formats in precedence order and falls back to unknown', () => {
  expect(
    detectFormat([
      ' Book Id ',
      'Exclusive Shelf',
      'Read Status',
      'Star Rating',
      'title',
      'shelf',
      'rating',
    ])
  ).toBe('goodreads');
  expect(detectFormat(['Read Status', 'Star Rating', 'title', 'shelf', 'rating'])).toBe(
    'storygraph'
  );
  expect(detectFormat([' TITLE ', 'SHELF', 'Rating'])).toBe('canonical');
  expect(detectFormat(['name', 'creator'])).toBe('unknown');
});

test('counts blank titles while skipping them and handles empty shapes', () => {
  expect(parseCanonical('title,author\n,Nobody\nDune,Frank Herbert\n')).toEqual({
    format: 'canonical',
    totalRows: 2,
    skipped: 1,
    rows: [{ ...emptyOptionals, title: 'Dune', author: 'Frank Herbert' }],
  });
  expect(parseCanonical('')).toEqual({ format: 'canonical', totalRows: 0, skipped: 0, rows: [] });
  expect(parseCanonical('title,author\n')).toEqual({
    format: 'canonical',
    totalRows: 0,
    skipped: 0,
    rows: [],
  });
  expect(
    parseCanonical(
      'title,author,additional_authors,isbn13,shelf,rating,review,date_read,date_added,page_count,year_published\nOnly Title,,,,,,,,,,\n'
    )
  ).toEqual({
    format: 'canonical',
    totalRows: 1,
    skipped: 0,
    rows: [{ ...emptyOptionals, title: 'Only Title' }],
  });
});

test('builds an ordered preview capped at five rows with falsey cells coerced', () => {
  const preview = buildImportPreview(
    'title,shelf,rating,Writer\nOne,read,5,A\nTwo,,,B\nThree,read,3,C\nFour,read,2,D\nFive,read,1,E\nSix,read,5,F\n'
  );
  expect(Object.keys(preview)).toEqual(['format', 'headers', 'sample_rows', 'suggested_mapping']);
  expect(Object.keys(preview.suggested_mapping)).toEqual([
    'title',
    'author',
    'isbn13',
    'rating',
    'review',
    'shelf',
    'date_read',
  ]);
  expect(preview).toEqual({
    format: 'canonical',
    headers: ['title', 'shelf', 'rating', 'Writer'],
    sample_rows: [
      { title: 'One', shelf: 'read', rating: '5', Writer: 'A' },
      { title: 'Two', shelf: '', rating: '', Writer: 'B' },
      { title: 'Three', shelf: 'read', rating: '3', Writer: 'C' },
      { title: 'Four', shelf: 'read', rating: '2', Writer: 'D' },
      { title: 'Five', shelf: 'read', rating: '1', Writer: 'E' },
    ],
    suggested_mapping: {
      title: 'title',
      author: 'Writer',
      isbn13: null,
      rating: 'rating',
      review: null,
      shelf: 'shelf',
      date_read: null,
    },
  });
});
