import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from './fixtures/catalog/http.json';
import expected from './fixtures/catalog/expected.json';
import { makeTestDb } from './helpers/pglite';
import { installHttpReplay } from './helpers/httpReplay';
import {
  googleBooksByIsbn,
  googleBooksEnrichmentSearch,
  openlibraryByIsbn,
  openlibraryEnrichmentSearch,
  searchBooks,
  setRate,
} from '../catalog';

let uninstall: (() => void) | undefined;
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

// Hermeticity: these fixtures were recorded with no GOOGLE_BOOKS_API_KEY, so a `key=`
// query param appended by an ambient env value makes every fixture URL miss (this is
// the exact scenario finding 1's fix was verified against — see the reviewer's repro
// in the wave-3a fix report). Delete it regardless of what's in the real shell. Also
// pin MYLIBRARY_REQ_PER_SEC to a fast throttle so getJson's real setTimeout-based
// throttle doesn't add wall-clock delay across searchBooks' several getJson calls.
let savedKey: string | undefined;
let savedRps: string | undefined;
beforeEach(() => {
  savedKey = process.env.GOOGLE_BOOKS_API_KEY;
  savedRps = process.env.MYLIBRARY_REQ_PER_SEC;
  delete process.env.GOOGLE_BOOKS_API_KEY;
  process.env.MYLIBRARY_REQ_PER_SEC = '1000000';
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.GOOGLE_BOOKS_API_KEY;
  else process.env.GOOGLE_BOOKS_API_KEY = savedKey;
  if (savedRps === undefined) delete process.env.MYLIBRARY_REQ_PER_SEC;
  else process.env.MYLIBRARY_REQ_PER_SEC = savedRps;
});

describe('searchBooks parity', () => {
  for (const query of Object.keys(expected as Record<string, unknown>)) {
    it(`matches Python for "${query}"`, async () => {
      const { db, close } = await makeTestDb();
      uninstall = installHttpReplay(http as any);
      try {
        const got = await searchBooks(db, query, 8);
        // `raw` is the untouched upstream payload — identical by construction,
        // and enormous; compare the normalized fields the API actually returns.
        const strip = (c: any) => ({ ...c, raw: undefined });
        expect(got.map(strip)).toEqual((expected as any)[query].map(strip));
      } finally {
        await close();
      }
    });
  }
});

describe('enrichment catalog operations', () => {
  it('uses the exact enrichment lookup URLs and returns whole normalized candidates', async () => {
    const { db, close } = await makeTestDb();
    setRate(1_000_000);
    const calls: string[] = [];
    const fixtures = {
      'https://openlibrary.org/api/books?bibkeys=ISBN:111&jscmd=data&format=json': {
        status: 200,
        body: {
          'ISBN:111': {
            key: '/books/OL1M',
            title: 'Wrong title is still trusted',
            subjects: [{ name: 'Space' }],
            cover: { medium: 'https://cover/1' },
            description: { value: 'Edition description' },
          },
        },
      },
      'https://openlibrary.org/search.json?title=Dune&limit=5&author=Frank+Herbert': {
        status: 200,
        body: {
          docs: [
            {
              key: '/works/OL1W',
              title: 'Dune',
              author_name: ['Frank Herbert'],
              subject: ['SF'],
              cover_i: 7,
              first_publish_year: 1965,
              language: ['eng'],
            },
          ],
        },
      },
      'https://www.googleapis.com/books/v1/volumes?q=isbn%3A222&maxResults=5': {
        status: 200,
        body: {
          items: [
            {
              id: 'g1',
              volumeInfo: {
                title: 'Google ISBN',
                authors: ['A Writer'],
                categories: ['Fiction'],
                language: 'en',
              },
            },
          ],
        },
      },
      'https://www.googleapis.com/books/v1/volumes?q=intitle%3A%22Dune%22+inauthor%3A%22Frank+Herbert%22&maxResults=5':
        {
          status: 200,
          body: {
            items: [
              {
                id: 'g2',
                volumeInfo: {
                  title: 'Dune',
                  authors: ['Frank Herbert'],
                  publishedDate: '1965',
                  language: 'eng',
                },
              },
            ],
          },
        },
    };
    uninstall = installHttpReplay(fixtures, (url) => calls.push(url));
    try {
      expect(await openlibraryByIsbn(db, '111')).toEqual({
        source: 'openlibrary',
        resolved_id: '/books/OL1M',
        title: 'Wrong title is still trusted',
        subjects: ['Space'],
        cover_url: 'https://cover/1',
        description: 'Edition description',
        raw: { isbn: '111', record: fixtures[Object.keys(fixtures)[0]].body['ISBN:111'] },
      });
      expect(await openlibraryEnrichmentSearch(db, 'Dune', 'Frank Herbert')).toEqual([
        {
          source: 'openlibrary',
          resolved_id: '/works/OL1W',
          title: 'Dune',
          author: 'Frank Herbert',
          subjects: ['SF'],
          cover_url: 'https://covers.openlibrary.org/b/id/7-M.jpg',
          year: 1965,
          language: 'en',
          raw: fixtures[Object.keys(fixtures)[1]].body.docs[0],
        },
      ]);
      expect(await googleBooksByIsbn(db, '222')).toEqual({
        source: 'googlebooks',
        resolved_id: 'g1',
        title: 'Google ISBN',
        author: 'A Writer',
        subjects: ['Fiction'],
        description: null,
        cover_url: null,
        year: null,
        language: 'en',
        raw: fixtures[Object.keys(fixtures)[2]].body.items[0],
      });
      expect(await googleBooksEnrichmentSearch(db, 'Dune', 'Frank Herbert')).toEqual([
        {
          source: 'googlebooks',
          resolved_id: 'g2',
          title: 'Dune',
          author: 'Frank Herbert',
          subjects: [],
          description: null,
          cover_url: null,
          year: 1965,
          language: 'en',
          raw: fixtures[Object.keys(fixtures)[3]].body.items[0],
        },
      ]);
      expect(calls).toEqual(Object.keys(fixtures));
    } finally {
      await close();
    }
  });

  it('fills an ISBN description through edition-to-work traversal', async () => {
    const { db, close } = await makeTestDb();
    const calls: string[] = [];
    const fixtures = {
      'https://openlibrary.org/api/books?bibkeys=ISBN:333&jscmd=data&format=json': {
        status: 200,
        body: { 'ISBN:333': { key: '/books/OL3M', title: 'Traversal', subjects: [] } },
      },
      'https://openlibrary.org/books/OL3M.json': {
        status: 200,
        body: { works: [{ key: '/works/OL3W' }] },
      },
      'https://openlibrary.org/works/OL3W.json': {
        status: 200,
        body: { description: { value: 'Work description' } },
      },
    };
    uninstall = installHttpReplay(fixtures, (url) => calls.push(url));
    try {
      expect(await openlibraryByIsbn(db, '333')).toEqual({
        source: 'openlibrary',
        resolved_id: '/books/OL3M',
        title: 'Traversal',
        subjects: [],
        cover_url: null,
        description: 'Work description',
        raw: { isbn: '333', record: fixtures[Object.keys(fixtures)[0]].body['ISBN:333'] },
      });
      expect(calls).toEqual(Object.keys(fixtures));
    } finally {
      await close();
    }
  });

  it('omits author from an authorless Open Library enrichment search', async () => {
    const { db, close } = await makeTestDb();
    const calls: string[] = [];
    const fixtures = {
      'https://openlibrary.org/search.json?title=Dune&limit=5': {
        status: 200,
        body: { docs: [] },
      },
    };
    uninstall = installHttpReplay(fixtures, (url) => calls.push(url));
    try {
      expect(await openlibraryEnrichmentSearch(db, 'Dune', null)).toEqual([]);
      expect(calls).toEqual(Object.keys(fixtures));
    } finally {
      await close();
    }
  });
});
