import { describe, expect, it } from 'vitest';
import type { Candidate, OpenLibraryIsbnCandidate } from '../catalog';
import type { Db } from '../db';
import { normalizeFullTitle, normalizeTitle, surname } from '../dedup';
import { type EnrichmentCatalog, resolveOne, scoreCandidates, searchTitle } from '../enrichment';
import { ratio, STRONG_SIM, titleSim } from '../similarity';

function book(title: string, author: string | null) {
  return { title, author };
}

function candidate(title: string, author: string | null): Candidate {
  return {
    source: 'test',
    resolved_id: title,
    title,
    author,
    subjects: [],
    cover_url: null,
    year: null,
    language: null,
    raw: {},
  };
}

function olIsbnCandidate(title: string): OpenLibraryIsbnCandidate {
  return {
    source: 'openlibrary',
    resolved_id: title,
    title,
    subjects: [],
    cover_url: null,
    description: null,
    raw: { isbn: 'fixture', record: {} },
  };
}

const dbStub = {} as Db;

function resolutionBook(title: string, author: string | null, isbn13: string | null) {
  return { title, author, isbn13 };
}

function fakeCatalog(
  values: {
    olIsbn?: OpenLibraryIsbnCandidate | null;
    googleIsbn?: Candidate | null;
    olSearch?: Candidate[];
    googleSearch?: Candidate[];
  } = {}
): { catalog: EnrichmentCatalog; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    catalog: {
      async openlibraryByIsbn(_db, isbn) {
        calls.push(`ol-isbn:${isbn}`);
        return values.olIsbn ?? null;
      },
      async googleBooksByIsbn(_db, isbn) {
        calls.push(`google-isbn:${isbn}`);
        return values.googleIsbn ?? null;
      },
      async openlibraryEnrichmentSearch(_db, title, author) {
        calls.push(`ol-search:${title}:${author ?? ''}`);
        return values.olSearch ?? [];
      },
      async googleBooksEnrichmentSearch(_db, title, author) {
        calls.push(`google-search:${title}:${author ?? ''}`);
        return values.googleSearch ?? [];
      },
    },
  };
}

describe('enrichment title helpers', () => {
  it('normalizes titles, surnames, and search titles exactly like Python', () => {
    expect({
      normalized: normalizeTitle('The Name: A Novel (Deluxe)!'),
      full: normalizeFullTitle('Dune: Special Edition (Hardcover)'),
      surname: surname('Ursula K. Le Guin'),
      search: searchTitle('Evenfall (In the Company of Shadows)'),
    }).toEqual({
      normalized: 'the name',
      full: 'dune special edition',
      surname: 'guin',
      search: 'Evenfall',
    });
  });

  it('matches Python SequenceMatcher ratios at both strong-boundary neighbors', () => {
    expect({
      exactStrong: ratio('abcdefghijklmnopqrst', 'abcdefghijklmnopqxyz'),
      belowStrong: ratio('abcdefghijklmnopqrst', 'abcdefghijklmnopwxyz'),
      strongConst: STRONG_SIM,
    }).toEqual({ exactStrong: 0.85, belowStrong: 0.8, strongConst: 0.85 });
  });

  it('uses the shared enrichment title similarity', () => {
    expect(titleSim('Dune: A Novel', 'Dune (Deluxe)')).toBe(1);
  });
});

describe('scoreCandidates', () => {
  it.each([
    ['empty candidates is internal NONE', [], null, 'NONE', 'John Doe'],
    [
      'unique score exactly 0.85 with compatible author is MEDIUM',
      [candidate('abcdefghijklmnopqxyz', 'Jane Doe')],
      'abcdefghijklmnopqxyz',
      'MEDIUM',
      'John Doe',
    ],
    [
      'score immediately below 0.85 is LOW',
      [candidate('abcdefghijklmnopwxyz', 'Jane Doe')],
      'abcdefghijklmnopwxyz',
      'LOW',
      'John Doe',
    ],
    [
      'missing book author is compatible and MEDIUM',
      [candidate('abcdefghijklmnopqxyz', 'Someone')],
      'abcdefghijklmnopqxyz',
      'MEDIUM',
      null,
    ],
    [
      'missing candidate author is compatible and MEDIUM',
      [candidate('abcdefghijklmnopqxyz', null)],
      'abcdefghijklmnopqxyz',
      'MEDIUM',
      'John Doe',
    ],
    [
      'equal surname is compatible and MEDIUM',
      [candidate('abcdefghijklmnopqxyz', 'Janet Doe')],
      'abcdefghijklmnopqxyz',
      'MEDIUM',
      'John Doe',
    ],
    [
      'surname contained in normalized candidate author is MEDIUM',
      [candidate('abcdefghijklmnopqxyz', 'The Doe Writing Group')],
      'abcdefghijklmnopqxyz',
      'MEDIUM',
      'John Doe',
    ],
    [
      'incompatible author makes a strong unique title LOW',
      [candidate('abcdefghijklmnopqxyz', 'Jane Roe')],
      'abcdefghijklmnopqxyz',
      'LOW',
      'John Doe',
    ],
  ] as const)('%s', (_name, candidates, selectedTitle, label, author) => {
    expect(scoreCandidates(book('abcdefghijklmnopqrst', author), [...candidates])).toEqual({
      candidate: selectedTitle === null ? null : candidates[0],
      label,
    });
  });

  it('second score exactly 0.85 makes the result ambiguous LOW', () => {
    const candidates = [
      candidate('abcdefghijklmnopqrst', 'Jane Doe'),
      candidate('abcdefghijklmnopqxyz', 'Jane Doe'),
    ];
    expect(scoreCandidates(book('abcdefghijklmnopqrst', 'John Doe'), candidates)).toEqual({
      candidate: candidates[0],
      label: 'LOW',
    });
  });

  it('second score immediately below 0.85 leaves the best MEDIUM', () => {
    const candidates = [
      candidate('abcdefghijklmnopqrst', 'Jane Doe'),
      candidate('abcdefghijklmnopwxyz', 'Jane Doe'),
    ];
    expect(scoreCandidates(book('abcdefghijklmnopqrst', 'John Doe'), candidates)).toEqual({
      candidate: candidates[0],
      label: 'MEDIUM',
    });
  });

  it("score exactly 0.60 returns LOW through Python's inert weak branch", () => {
    const selected = candidate('abcdefghijklxxxxxxxx', 'Jane Doe');
    expect(scoreCandidates(book('abcdefghijklmnopqrst', 'John Doe'), [selected])).toEqual({
      candidate: selected,
      label: 'LOW',
    });
  });

  it("score immediately below 0.60 also returns LOW through Python's fallthrough", () => {
    const selected = candidate('abcdefghijkxxxxxxxxx', 'Jane Doe');
    expect(scoreCandidates(book('abcdefghijklmnopqrst', 'John Doe'), [selected])).toEqual({
      candidate: selected,
      label: 'LOW',
    });
  });

  it('stable sorting keeps the first equal-scoring candidate', () => {
    const first = candidate('abcdefghijklmnopqxyz', 'Jane Roe');
    const second = candidate('abcdefghijklmnopqxyz', 'Jane Doe');
    expect(scoreCandidates(book('abcdefghijklmnopqrst', 'John Doe'), [first, second])).toEqual({
      candidate: first,
      label: 'LOW',
    });
  });
});

describe('resolveOne', () => {
  it('trusts the first Open Library ISBN candidate as HIGH without verification', async () => {
    const openLibrary = olIsbnCandidate('A Completely Wrong Title');
    const { catalog, calls } = fakeCatalog({ olIsbn: openLibrary });
    const result = await resolveOne(
      dbStub,
      resolutionBook('Expected Title', 'Expected Author', '111'),
      catalog
    );
    expect({ result, calls }).toEqual({
      result: { candidate: openLibrary, label: 'HIGH', method: 'isbn:openlibrary' },
      calls: ['ol-isbn:111'],
    });
  });

  it('falls from Open Library ISBN to an unverified Google ISBN HIGH', async () => {
    const google = candidate('Still Wrong', 'Still Wrong');
    const { catalog, calls } = fakeCatalog({ olIsbn: null, googleIsbn: google });
    const result = await resolveOne(dbStub, resolutionBook('Expected', 'Author', '222'), catalog);
    expect({ result, calls }).toEqual({
      result: { candidate: google, label: 'HIGH', method: 'isbn:googlebooks' },
      calls: ['ol-isbn:222', 'google-isbn:222'],
    });
  });

  it('Open Library MEDIUM stops before Google search', async () => {
    const openLibrary = candidate('Expected', 'Author');
    const { catalog, calls } = fakeCatalog({ olSearch: [openLibrary] });
    const result = await resolveOne(dbStub, resolutionBook('Expected', 'Author', null), catalog);
    expect({ result, calls }).toEqual({
      result: { candidate: openLibrary, label: 'MEDIUM', method: 'search:openlibrary' },
      calls: ['ol-search:Expected:Author'],
    });
  });

  it('Open Library LOW still runs Google and Google MEDIUM wins', async () => {
    const openLibrary = candidate('Wrong', 'Author');
    const google = candidate('Expected', 'Author');
    const { catalog, calls } = fakeCatalog({ olSearch: [openLibrary], googleSearch: [google] });
    const result = await resolveOne(dbStub, resolutionBook('Expected', 'Author', null), catalog);
    expect({ result, calls }).toEqual({
      result: { candidate: google, label: 'MEDIUM', method: 'search:googlebooks' },
      calls: ['ol-search:Expected:Author', 'google-search:Expected:Author'],
    });
  });

  it('Open Library LOW wins over a numerically better Google LOW', async () => {
    const openLibrary = candidate('Unrelated', 'Author');
    const google = candidate('Expected', 'Jane Roe');
    const { catalog, calls } = fakeCatalog({ olSearch: [openLibrary], googleSearch: [google] });
    const result = await resolveOne(
      dbStub,
      resolutionBook('Expected', 'Right Author', null),
      catalog
    );
    expect({ result, calls }).toEqual({
      result: { candidate: openLibrary, label: 'LOW', method: 'search:openlibrary' },
      calls: ['ol-search:Expected:Right Author', 'google-search:Expected:Right Author'],
    });
  });

  it('Google LOW is used when Open Library is empty', async () => {
    const google = candidate('Wrong', 'Author');
    const { catalog, calls } = fakeCatalog({ googleSearch: [google] });
    const result = await resolveOne(dbStub, resolutionBook('Expected', 'Author', null), catalog);
    expect({ result, calls }).toEqual({
      result: { candidate: google, label: 'LOW', method: 'search:googlebooks' },
      calls: ['ol-search:Expected:Author', 'google-search:Expected:Author'],
    });
  });

  it('no candidates returns internal NONE and unresolved', async () => {
    const { catalog, calls } = fakeCatalog();
    const result = await resolveOne(dbStub, resolutionBook('Expected', 'Author', null), catalog);
    expect({ result, calls }).toEqual({
      result: { candidate: null, label: 'NONE', method: 'unresolved' },
      calls: ['ol-search:Expected:Author', 'google-search:Expected:Author'],
    });
  });

  it('search strips the series parenthetical before both catalog calls', async () => {
    const openLibrary = candidate('Wrong', 'Author');
    const { catalog, calls } = fakeCatalog({ olSearch: [openLibrary] });
    const result = await resolveOne(
      dbStub,
      resolutionBook('Expected (Series Name)', 'Raw Author', null),
      catalog
    );
    expect({ result, calls }).toEqual({
      result: { candidate: openLibrary, label: 'LOW', method: 'search:openlibrary' },
      calls: ['ol-search:Expected:Raw Author', 'google-search:Expected:Raw Author'],
    });
  });
});
