import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { setupParityEnv } from './helpers/parity';
import { runScenario } from './helpers/write-parity';
import { loadSeed, makeTestDb, type Seed } from './helpers/pglite';
import seedJson from './fixtures/parity/seed.json';
import { _setDbForTests } from '../db';
import { DELETE as deleteBook } from '../../../app/api/books/[id]/route';
import { PATCH as patchBookFeedback } from '../../../app/api/books/[id]/feedback/route';
import { PATCH as patchBookShelf } from '../../../app/api/books/[id]/shelf/route';
import { PATCH as patchBookEnrichment } from '../../../app/api/books/[id]/enrichment/route';
import { PATCH as patchRecFeedback } from '../../../app/api/recommendations/[id]/feedback/route';
import { PATCH as patchTrait } from '../../../app/api/profile/traits/[id]/route';

describe('write parity: books', () => {
  setupParityEnv();
  it('add-book-basic', () => runScenario('add-book-basic'));
  it('add-book-rated-review', () => runScenario('add-book-rated-review'));
  it('add-book-duplicate', () => runScenario('add-book-duplicate'));
  it('add-book-sibling-subtitle', () => runScenario('add-book-sibling-subtitle'));
  it('add-book-invalid', () => runScenario('add-book-invalid'));
  it('book-feedback', () => runScenario('book-feedback'));
  it('book-feedback-invalid', () => runScenario('book-feedback-invalid'));
  it('book-shelf', () => runScenario('book-shelf'));
  it('enrichment-correction', () => runScenario('enrichment-correction'));
  it('delete-book', () => runScenario('delete-book'));
});

describe('half-star ratings', () => {
  setupParityEnv();
  let closeDb: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const { db, close } = await makeTestDb();
    await loadSeed(db, seedJson as unknown as Seed);
    _setDbForTests(db);
    closeDb = close;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _setDbForTests(null);
    await closeDb?.();
    closeDb = undefined;
  });

  async function patchRating(rating: number) {
    return patchBookFeedback(
      new Request('http://test/api/books/1/feedback', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating }),
      }),
      { params: { id: '1' } }
    );
  }

  function silenceLogs() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  }

  // Assert the persisted value, not just the status: a route that accepted 4.5
  // but truncated it to 4 on the way to the column would still return 200.
  it('accepts rating 4.5 and stores it as 4.5', async () => {
    const res = await patchRating(4.5);
    expect(res.status).toBe(200);
    expect((await res.json()).app_rating).toBe(4.5);
  });

  it('accepts rating 0.5 and stores it as 0.5', async () => {
    const res = await patchRating(0.5);
    expect(res.status).toBe(200);
    expect((await res.json()).app_rating).toBe(0.5);
  });

  it('rejects off-grid rating 3.7', async () => {
    silenceLogs();
    const res = await patchRating(3.7);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: 'rating must be 0.5 to 5 in half-star steps (or 0 to clear).',
    });
  });

  it('still accepts rating 0 as the clear sentinel', async () => {
    const res = await patchRating(0);
    expect(res.status).toBe(200);
  });

  it('still rejects out-of-range rating 7 with the manual guard message', async () => {
    silenceLogs();
    const res = await patchRating(7);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      detail: 'rating must be 0.5 to 5 in half-star steps (or 0 to clear).',
    });
  });
});

// Cross-cutting fix (final wave-2 review, finding 2): a non-numeric [id] path param
// used to reach Postgres as `Number('abc')` -> NaN, which the driver rejects with an
// uncaught "invalid input syntax for type integer" error that withApi could only
// surface as a generic 500. parseIdParam() now catches this before any query runs,
// producing the same clean 422 FastAPI's `id: int` path converter would. One case per
// affected route is enough here — the exhaustive input-shape coverage lives in
// serialize.test.ts's parseIdParam unit tests.
describe('malformed [id] path params return 422, not 500', () => {
  setupParityEnv();
  afterEach(() => vi.restoreAllMocks());
  function silenceLogs() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  }
  const expected422 = { detail: 'validation error: id must be an integer' };

  it('DELETE /books/abc', async () => {
    silenceLogs();
    const res = await deleteBook(new Request('http://test/api/books/abc', { method: 'DELETE' }), {
      params: { id: 'abc' },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(expected422);
  });

  it('PATCH /books/abc/feedback', async () => {
    silenceLogs();
    const res = await patchBookFeedback(
      new Request('http://test/api/books/abc/feedback', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      { params: { id: 'abc' } }
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(expected422);
  });

  it('PATCH /books/abc/shelf', async () => {
    silenceLogs();
    const res = await patchBookShelf(
      new Request('http://test/api/books/abc/shelf', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shelf: 'read' }),
      }),
      { params: { id: 'abc' } }
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(expected422);
  });

  it('PATCH /books/abc/enrichment', async () => {
    silenceLogs();
    const res = await patchBookEnrichment(
      new Request('http://test/api/books/abc/enrichment', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ catalog_source: 'openlibrary', catalog_id: 'OL1W' }),
      }),
      { params: { id: 'abc' } }
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(expected422);
  });

  it('PATCH /recommendations/abc/feedback', async () => {
    silenceLogs();
    const res = await patchRecFeedback(
      new Request('http://test/api/recommendations/abc/feedback', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'accepted' }),
      }),
      { params: { id: 'abc' } }
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(expected422);
  });

  it('PATCH /profile/traits/abc', async () => {
    silenceLogs();
    const res = await patchTrait(
      new Request('http://test/api/profile/traits/abc', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_note: 'note' }),
      }),
      { params: { id: 'abc' } }
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(expected422);
  });
});
