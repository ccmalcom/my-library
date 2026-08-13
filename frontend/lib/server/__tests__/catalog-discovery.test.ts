import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb } from './helpers/pglite';
import { installHttpReplay } from './helpers/httpReplay';
import {
  googleBooksSubject,
  googleBooksAuthor,
  openlibrarySubject,
  openlibraryWorkDescription,
} from '../catalog';

// Hermeticity: a developer with GOOGLE_BOOKS_API_KEY exported would produce a
// `key=` query param that no fixture URL matches, failing every test here.
let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.GOOGLE_BOOKS_API_KEY;
  delete process.env.GOOGLE_BOOKS_API_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.GOOGLE_BOOKS_API_KEY;
  else process.env.GOOGLE_BOOKS_API_KEY = savedKey;
});

describe('googleBooksSubject / googleBooksAuthor', () => {
  test('quote the term and delegate to googleBooksQuery', async () => {
    const { db, close } = await makeTestDb();
    const seen: string[] = [];
    const restore = installHttpReplay(
      {
        'https://www.googleapis.com/books/v1/volumes?q=subject%3A%22space+opera%22&maxResults=3': {
          status: 200,
          body: { items: [{ id: 'g1', volumeInfo: { title: 'S' } }] },
        },
        'https://www.googleapis.com/books/v1/volumes?q=inauthor%3A%22Ursula+K.+Le+Guin%22&maxResults=3':
          {
            status: 200,
            body: { items: [{ id: 'g2', volumeInfo: { title: 'A' } }] },
          },
      },
      (u) => seen.push(u)
    );
    try {
      expect((await googleBooksSubject(db, 'space opera', 3))[0].resolved_id).toBe('g1');
      expect((await googleBooksAuthor(db, 'Ursula K. Le Guin', 3))[0].resolved_id).toBe('g2');
      expect(seen).toHaveLength(2);
    } finally {
      restore();
      await close();
    }
  });
});

describe('openlibrarySubject', () => {
  test('slugifies the subject and maps works to candidates', async () => {
    const { db, close } = await makeTestDb();
    const restore = installHttpReplay({
      'https://openlibrary.org/subjects/science_fiction.json?limit=2': {
        status: 200,
        body: {
          works: [
            {
              key: '/works/OL1W',
              title: 'A Work',
              authors: [{ name: 'An Author' }],
              cover_id: 42,
              first_publish_year: 1999,
            },
            { key: '/works/OL2W', title: 'No Author Work', authors: [], cover_id: null },
          ],
        },
      },
    });
    try {
      const out = await openlibrarySubject(db, 'Science Fiction!', 2);
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({
        source: 'openlibrary',
        resolved_id: '/works/OL1W',
        title: 'A Work',
        author: 'An Author',
        subjects: ['Science Fiction!'], // Python echoes the CALLER's subject, unslugged
        cover_url: 'https://covers.openlibrary.org/b/id/42-M.jpg',
        year: 1999,
        language: null, // Python's dict has no "language" key at all
      });
      expect(out[1].author).toBeNull();
      expect(out[1].cover_url).toBeNull();
      expect(out[1].year).toBeNull();
    } finally {
      restore();
      await close();
    }
  });

  test('returns [] for a subject that slugifies to empty, without any HTTP call', async () => {
    const { db, close } = await makeTestDb();
    const seen: string[] = [];
    const restore = installHttpReplay({}, (u) => seen.push(u));
    try {
      expect(await openlibrarySubject(db, '!!!', 5)).toEqual([]);
      expect(seen).toEqual([]);
    } finally {
      restore();
      await close();
    }
  });
});

describe('openlibraryWorkDescription', () => {
  test('strips the leading slash and unwraps both description shapes', async () => {
    const { db, close } = await makeTestDb();
    const restore = installHttpReplay({
      'https://openlibrary.org/works/OL1W.json': {
        status: 200,
        body: { description: 'A plain string.' },
      },
      'https://openlibrary.org/works/OL2W.json': {
        status: 200,
        body: { description: { type: '/type/text', value: 'A typed value.' } },
      },
      'https://openlibrary.org/works/OL3W.json': {
        status: 200,
        body: { notes: 'Falls back to notes.' },
      },
      'https://openlibrary.org/works/OL4W.json': { status: 200, body: {} },
      'https://openlibrary.org/works/OL5W.json': { status: 404 },
    });
    try {
      expect(await openlibraryWorkDescription(db, '/works/OL1W')).toBe('A plain string.');
      expect(await openlibraryWorkDescription(db, 'works/OL2W')).toBe('A typed value.');
      expect(await openlibraryWorkDescription(db, '/works/OL3W')).toBe('Falls back to notes.');
      expect(await openlibraryWorkDescription(db, '/works/OL4W')).toBeNull();
      expect(await openlibraryWorkDescription(db, '/works/OL5W')).toBeNull();
      expect(await openlibraryWorkDescription(db, '')).toBeNull();
    } finally {
      restore();
      await close();
    }
  });
});
