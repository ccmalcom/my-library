import { describe, expect, it, vi, afterEach } from 'vitest';
import { setupParityEnv } from './helpers/parity';
import { runScenario } from './helpers/write-parity';
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
