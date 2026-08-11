import { expect, it } from 'vitest';
import { schema } from '../db';
import { enrichLibrary } from '../enrichment';
import { setRate } from '../catalog';
import expected from './fixtures/catalog/enrichment-expected.json';
import http from './fixtures/catalog/http.json';
import { installHttpReplay } from './helpers/httpReplay';
import { loadSeed, makeTestDb } from './helpers/pglite';

interface PersistedEnrichmentRow {
  bookId: number;
  resolvedSource: string | null;
  resolvedId: string | null;
  subjects: unknown;
  series: string | null;
  seriesPosition: string | null;
  description: string | null;
  coverUrl: string | null;
  resolutionConfidence: number;
  confidenceLabel: string | null;
  matchMethod: string | null;
  rawResponse: unknown;
  resolvedAt: string;
  language: string | null;
}

function toRecordedEnrichmentRow(row: PersistedEnrichmentRow) {
  return {
    book_id: row.bookId,
    confidence_label: row.confidenceLabel,
    cover_url: row.coverUrl,
    description: row.description,
    language: row.language,
    match_method: row.matchMethod,
    raw_response: row.rawResponse,
    resolution_confidence: row.resolutionConfidence,
    resolved_at: '<TIMESTAMP>',
    resolved_id: row.resolvedId,
    resolved_source: row.resolvedSource,
    series: row.series,
    series_position: row.seriesPosition,
    subjects: row.subjects,
  };
}

it("matches Python's recorded synchronous enrichment summary and rows", async () => {
  const { db, close } = await makeTestDb();
  const savedKey = process.env.GOOGLE_BOOKS_API_KEY;
  delete process.env.GOOGLE_BOOKS_API_KEY;
  setRate(1_000_000);

  const calls: string[] = [];
  const restoreReplay = installHttpReplay(http, (url) => calls.push(url));
  try {
    await loadSeed(db, {
      books: expected.seed.map((row) => ({ ...row, source: 'goodreads_import' })),
      enrichment: expected.seed_enrichment,
    });

    const summary = await enrichLibrary(db, { userId: 'fixture-user' });
    const rows = await db
      .select({
        bookId: schema.enrichment.bookId,
        resolvedSource: schema.enrichment.resolvedSource,
        resolvedId: schema.enrichment.resolvedId,
        subjects: schema.enrichment.subjects,
        series: schema.enrichment.series,
        seriesPosition: schema.enrichment.seriesPosition,
        description: schema.enrichment.description,
        coverUrl: schema.enrichment.coverUrl,
        resolutionConfidence: schema.enrichment.resolutionConfidence,
        confidenceLabel: schema.enrichment.confidenceLabel,
        matchMethod: schema.enrichment.matchMethod,
        rawResponse: schema.enrichment.rawResponse,
        resolvedAt: schema.enrichment.resolvedAt,
        language: schema.enrichment.language,
      })
      .from(schema.enrichment)
      .orderBy(schema.enrichment.bookId);

    for (const row of rows) {
      // Postgres strips trailing zeros from the fractional seconds on read, so a
      // timestamp written as `.510` comes back as `.51` and one written as `.000`
      // comes back with no fraction at all. Pinning \d{3} here made this assertion
      // fail roughly one run in a hundred.
      expect(row.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/);
    }
    const normalizedRows = rows.map(toRecordedEnrichmentRow);

    expect({ summary, rows: normalizedRows }).toEqual({
      summary: expected.summary,
      rows: expected.rows,
    });
    // Compared as sorted multisets, not as a sequence. Python's book query has no
    // ORDER BY (enrich.py:218), so which book is enriched first is unspecified in
    // BOTH runtimes -- PGlite's left join happened to yield 2,7,1,3,4,5 where the
    // recorder's SQLite yielded 1,2,3,4,5,7. Sorting still proves the exact set:
    // no URL Python did not emit, and none of Python's missing. The order that IS
    // specified -- ISBN before search, Open Library before Google within one book --
    // is asserted by the resolution-order tests in enrichment-score.test.ts.
    expect([...calls].sort()).toEqual([...expected.urls].sort());
  } finally {
    restoreReplay();
    if (savedKey === undefined) delete process.env.GOOGLE_BOOKS_API_KEY;
    else process.env.GOOGLE_BOOKS_API_KEY = savedKey;
    await close();
  }
});
