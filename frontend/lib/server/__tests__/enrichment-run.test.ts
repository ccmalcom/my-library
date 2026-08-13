import { describe, expect, it } from 'vitest';
import { schema, type Db } from '../db';
import { enrichLibrary, persistResolution, type ResolutionResult } from '../enrichment';
import { makeTestDb } from './helpers/pglite';

async function seedBook(db: Db): Promise<number> {
  const [book] = await db
    .insert(schema.books)
    .values({
      userId: 'local',
      goodreadsBookId: '1',
      title: 'Dune',
      author: 'Frank Herbert',
      goodreadsRating: 5,
      source: 'test',
    })
    .returning({ id: schema.books.id });
  return book.id;
}

function enrichmentRows(db: Db) {
  return db
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
    .from(schema.enrichment);
}

const http = {
  requests: 0,
  rate_limited: 0,
  server_errors: 0,
  network_errors: 0,
  retries: 0,
  by_host: {},
};

async function seedNamedBook(
  db: Db,
  goodreadsBookId: string,
  title: string,
  options: { userId?: string; goodreadsRating?: number; appRating?: number | null } = {}
): Promise<number> {
  const [book] = await db
    .insert(schema.books)
    .values({
      userId: options.userId ?? 'local',
      goodreadsBookId,
      title,
      author: 'Test Author',
      goodreadsRating: options.goodreadsRating ?? 5,
      appRating: options.appRating ?? null,
      source: 'test',
    })
    .returning({ id: schema.books.id });
  return book.id;
}

function resolved(id: string, label: 'HIGH' | 'MEDIUM' | 'LOW' = 'HIGH'): ResolutionResult {
  return {
    candidate: {
      source: 'googlebooks',
      resolved_id: id,
      title: id,
      author: 'Test Author',
      subjects: [],
      description: null,
      cover_url: null,
      year: null,
      language: null,
      raw: { id },
    },
    label,
    method: label === 'HIGH' ? 'isbn:googlebooks' : 'search:googlebooks',
  };
}

async function seedExisting(db: Db, bookId: number, resolvedSource: string | null): Promise<void> {
  await db.insert(schema.enrichment).values({
    bookId,
    resolvedSource,
    resolvedId: resolvedSource ? `old-${bookId}` : null,
    subjects: [],
    resolutionConfidence: resolvedSource ? 0.95 : 0,
    confidenceLabel: resolvedSource ? 'HIGH' : 'LOW',
    matchMethod: resolvedSource ? 'isbn:googlebooks' : 'unresolved',
    rawResponse: resolvedSource ? { old: bookId } : null,
    resolvedAt: '2000-01-01 00:00:00.000',
  });
}

function compactRows(db: Db) {
  return db
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
}

function compactResolvedRow(
  bookId: number,
  resolvedId: string,
  rawResponse: unknown,
  resolvedAt: string | ReturnType<typeof expect.any> = expect.any(String)
) {
  return {
    bookId,
    resolvedSource: 'googlebooks',
    resolvedId,
    subjects: [],
    series: null,
    seriesPosition: null,
    description: null,
    coverUrl: null,
    resolutionConfidence: 0.95,
    confidenceLabel: 'HIGH',
    matchMethod: 'isbn:googlebooks',
    rawResponse,
    resolvedAt,
    language: null,
  };
}

describe('one-book enrichment persistence', () => {
  it('inserts a resolved candidate and replaces every enrichment-owned field on upsert', async () => {
    const { db, close } = await makeTestDb();
    try {
      const bookId = await seedBook(db);
      await persistResolution(db, bookId, {
        candidate: {
          source: 'openlibrary',
          resolved_id: '/works/OL1W',
          title: 'Dune',
          author: 'Frank Herbert',
          subjects: ['Science Fiction', 'Desert'],
          description: 'A description',
          cover_url: 'https://cover/1',
          year: 1965,
          language: 'en',
          raw: { key: '/works/OL1W' },
        },
        label: 'MEDIUM',
        method: 'search:openlibrary',
      });

      expect(await enrichmentRows(db)).toEqual([
        {
          bookId,
          resolvedSource: 'openlibrary',
          resolvedId: '/works/OL1W',
          subjects: ['Science Fiction', 'Desert'],
          series: null,
          seriesPosition: null,
          description: 'A description',
          coverUrl: 'https://cover/1',
          resolutionConfidence: 0.7,
          confidenceLabel: 'MEDIUM',
          matchMethod: 'search:openlibrary',
          rawResponse: { key: '/works/OL1W' },
          resolvedAt: expect.any(String),
          language: 'en',
        },
      ]);

      await persistResolution(db, bookId, {
        candidate: {
          source: 'googlebooks',
          resolved_id: 'google-1',
          title: 'Dune',
          author: null,
          subjects: [],
          description: null,
          cover_url: null,
          year: null,
          language: null,
          raw: { id: 'google-1' },
        },
        label: 'HIGH',
        method: 'isbn:googlebooks',
      });

      expect(await enrichmentRows(db)).toEqual([
        {
          bookId,
          resolvedSource: 'googlebooks',
          resolvedId: 'google-1',
          subjects: [],
          series: null,
          seriesPosition: null,
          description: null,
          coverUrl: null,
          resolutionConfidence: 0.95,
          confidenceLabel: 'HIGH',
          matchMethod: 'isbn:googlebooks',
          rawResponse: { id: 'google-1' },
          resolvedAt: expect.any(String),
          language: null,
        },
      ]);
    } finally {
      await close();
    }
  });

  it('updates only unresolved status fields and preserves stale resolved metadata', async () => {
    const { db, close } = await makeTestDb();
    try {
      const bookId = await seedBook(db);
      await db.insert(schema.enrichment).values({
        bookId,
        resolvedSource: 'openlibrary',
        resolvedId: '/works/OLD',
        subjects: ['old'],
        series: 'Old Series',
        seriesPosition: '2',
        description: 'old description',
        coverUrl: 'old cover',
        resolutionConfidence: 0.7,
        confidenceLabel: 'MEDIUM',
        matchMethod: 'search:openlibrary',
        rawResponse: { old: true },
        resolvedAt: '2000-01-01 00:00:00.000',
        language: 'en',
      });
      const unresolved: ResolutionResult = {
        candidate: null,
        label: 'NONE',
        method: 'unresolved',
      };

      await persistResolution(db, bookId, unresolved);

      expect(await enrichmentRows(db)).toEqual([
        {
          bookId,
          resolvedSource: 'openlibrary',
          resolvedId: '/works/OLD',
          subjects: ['old'],
          series: 'Old Series',
          seriesPosition: '2',
          description: 'old description',
          coverUrl: 'old cover',
          resolutionConfidence: 0.0,
          confidenceLabel: 'LOW',
          matchMethod: 'unresolved',
          rawResponse: { old: true },
          resolvedAt: expect.any(String),
          language: 'en',
        },
      ]);
    } finally {
      await close();
    }
  });
});

describe('library enrichment orchestration', () => {
  it('selects, skips, limits, reports progress, and isolates tenants', async () => {
    const { db, close } = await makeTestDb();
    try {
      const rated = await seedNamedBook(db, '101', 'Rated new');
      await seedNamedBook(db, '102', 'App-rated zero', { goodreadsRating: 0, appRating: 0 });
      await seedNamedBook(db, '103', 'Unrated', { goodreadsRating: 0 });
      const resolvedExisting = await seedNamedBook(db, '104', 'Resolved existing');
      const unresolvedExisting = await seedNamedBook(db, '105', 'Unresolved existing', {
        goodreadsRating: 0,
      });
      const other = await seedNamedBook(db, '106', 'Other user', { userId: 'other' });
      await seedExisting(db, resolvedExisting, 'googlebooks');
      await seedExisting(db, unresolvedExisting, null);
      await seedExisting(db, other, 'googlebooks');

      const resolvedBookIds: number[] = [];
      const progress: Array<[number, number, string, string]> = [];
      const summary = await enrichLibrary(db, {
        userId: 'local',
        limit: 1,
        resolver: async (_db, book) => {
          resolvedBookIds.push(book.id);
          return resolved(`new-${book.id}`);
        },
        progress: (...args) => progress.push(args),
      });

      expect({ summary, resolvedBookIds, progress }).toEqual({
        summary: {
          total: 2,
          processed: 1,
          HIGH: 1,
          MEDIUM: 0,
          LOW: 0,
          unresolved: 0,
          skipped_existing: 1,
          http,
        },
        resolvedBookIds: [rated],
        progress: [
          [1, 2, '', 'starting'],
          [2, 2, 'Rated new', 'HIGH'],
        ],
      });
      expect(await compactRows(db)).toEqual([
        {
          bookId: rated,
          resolvedSource: 'googlebooks',
          resolvedId: `new-${rated}`,
          subjects: [],
          series: null,
          seriesPosition: null,
          description: null,
          coverUrl: null,
          resolutionConfidence: 0.95,
          confidenceLabel: 'HIGH',
          matchMethod: 'isbn:googlebooks',
          rawResponse: { id: `new-${rated}` },
          resolvedAt: expect.any(String),
          language: null,
        },
        {
          bookId: resolvedExisting,
          resolvedSource: 'googlebooks',
          resolvedId: `old-${resolvedExisting}`,
          subjects: [],
          series: null,
          seriesPosition: null,
          description: null,
          coverUrl: null,
          resolutionConfidence: 0.95,
          confidenceLabel: 'HIGH',
          matchMethod: 'isbn:googlebooks',
          rawResponse: { old: resolvedExisting },
          resolvedAt: '2000-01-01 00:00:00',
          language: null,
        },
        {
          bookId: unresolvedExisting,
          resolvedSource: null,
          resolvedId: null,
          subjects: [],
          series: null,
          seriesPosition: null,
          description: null,
          coverUrl: null,
          resolutionConfidence: 0,
          confidenceLabel: 'LOW',
          matchMethod: 'unresolved',
          rawResponse: null,
          resolvedAt: '2000-01-01 00:00:00',
          language: null,
        },
        {
          bookId: other,
          resolvedSource: 'googlebooks',
          resolvedId: `old-${other}`,
          subjects: [],
          series: null,
          seriesPosition: null,
          description: null,
          coverUrl: null,
          resolutionConfidence: 0.95,
          confidenceLabel: 'HIGH',
          matchMethod: 'isbn:googlebooks',
          rawResponse: { old: other },
          resolvedAt: '2000-01-01 00:00:00',
          language: null,
        },
      ]);
    } finally {
      await close();
    }
  });

  it('force reprocesses resolved and unresolved rows but not ineligible unrated rows', async () => {
    const { db, close } = await makeTestDb();
    try {
      const resolvedId = await seedNamedBook(db, '201', 'Resolved');
      const unresolvedId = await seedNamedBook(db, '202', 'Unresolved');
      const unratedId = await seedNamedBook(db, '203', 'Unrated', { goodreadsRating: 0 });
      await seedExisting(db, resolvedId, 'googlebooks');
      await seedExisting(db, unresolvedId, null);
      await seedExisting(db, unratedId, 'googlebooks');
      const calls: number[] = [];
      const summary = await enrichLibrary(db, {
        userId: 'local',
        force: true,
        resolver: async (_db, book) => {
          calls.push(book.id);
          return resolved(`forced-${book.id}`);
        },
      });
      expect({ summary, calls, rows: await compactRows(db) }).toEqual({
        summary: {
          total: 2,
          processed: 2,
          HIGH: 2,
          MEDIUM: 0,
          LOW: 0,
          unresolved: 0,
          skipped_existing: 0,
          http,
        },
        calls: [resolvedId, unresolvedId],
        rows: [
          compactResolvedRow(resolvedId, `forced-${resolvedId}`, { id: `forced-${resolvedId}` }),
          compactResolvedRow(unresolvedId, `forced-${unresolvedId}`, {
            id: `forced-${unresolvedId}`,
          }),
          compactResolvedRow(
            unratedId,
            `old-${unratedId}`,
            { old: unratedId },
            '2000-01-01 00:00:00'
          ),
        ],
      });
    } finally {
      await close();
    }
  });

  it('retryUnresolved reprocesses only existing rows with null resolvedSource', async () => {
    const { db, close } = await makeTestDb();
    try {
      const resolvedId = await seedNamedBook(db, '301', 'Resolved');
      const unresolvedId = await seedNamedBook(db, '302', 'Unresolved');
      await seedExisting(db, resolvedId, 'googlebooks');
      await seedExisting(db, unresolvedId, null);
      const calls: number[] = [];
      const summary = await enrichLibrary(db, {
        userId: 'local',
        retryUnresolved: true,
        resolver: async (_db, book) => {
          calls.push(book.id);
          return resolved(`retry-${book.id}`);
        },
      });
      expect({ summary, calls, rows: await compactRows(db) }).toEqual({
        summary: {
          total: 2,
          processed: 1,
          HIGH: 1,
          MEDIUM: 0,
          LOW: 0,
          unresolved: 0,
          skipped_existing: 1,
          http,
        },
        calls: [unresolvedId],
        rows: [
          compactResolvedRow(
            resolvedId,
            `old-${resolvedId}`,
            { old: resolvedId },
            '2000-01-01 00:00:00'
          ),
          compactResolvedRow(unresolvedId, `retry-${unresolvedId}`, {
            id: `retry-${unresolvedId}`,
          }),
        ],
      });
    } finally {
      await close();
    }
  });

  it('includeUnrated admits a book whose appRating and goodreadsRating are both null-equivalent', async () => {
    const { db, close } = await makeTestDb();
    try {
      const bookId = await seedNamedBook(db, '401', 'Unrated', { goodreadsRating: 0 });
      const summary = await enrichLibrary(db, {
        userId: 'local',
        includeUnrated: true,
        resolver: async () => resolved('included'),
      });
      expect({ summary, rows: await compactRows(db) }).toEqual({
        summary: {
          total: 1,
          processed: 1,
          HIGH: 1,
          MEDIUM: 0,
          LOW: 0,
          unresolved: 0,
          skipped_existing: 0,
          http,
        },
        rows: [compactResolvedRow(bookId, 'included', { id: 'included' })],
      });
    } finally {
      await close();
    }
  });

  it('limit zero processes nothing but retains skipped_existing in total and starting progress', async () => {
    const { db, close } = await makeTestDb();
    try {
      const existing = await seedNamedBook(db, '501', 'Existing');
      await seedNamedBook(db, '502', 'New');
      await seedExisting(db, existing, 'googlebooks');
      const progress: Array<[number, number, string, string]> = [];
      const summary = await enrichLibrary(db, {
        userId: 'local',
        limit: 0,
        resolver: async () => resolved('impossible'),
        progress: (...args) => progress.push(args),
      });
      expect({ summary, progress, rows: await compactRows(db) }).toEqual({
        summary: {
          total: 1,
          processed: 0,
          HIGH: 0,
          MEDIUM: 0,
          LOW: 0,
          unresolved: 0,
          skipped_existing: 1,
          http,
        },
        progress: [[1, 1, '', 'starting']],
        rows: [
          compactResolvedRow(existing, `old-${existing}`, { old: existing }, '2000-01-01 00:00:00'),
        ],
      });
    } finally {
      await close();
    }
  });

  it('negative limit reproduces Python slicing by dropping that many rows from the tail', async () => {
    const { db, close } = await makeTestDb();
    try {
      const first = await seedNamedBook(db, '601', 'First');
      const second = await seedNamedBook(db, '602', 'Second');
      await seedNamedBook(db, '603', 'Third');
      const calls: number[] = [];
      const summary = await enrichLibrary(db, {
        userId: 'local',
        limit: -1,
        resolver: async (_db, book) => {
          calls.push(book.id);
          return resolved(`negative-${book.id}`);
        },
      });
      expect({ summary, calls, rows: await compactRows(db) }).toEqual({
        summary: {
          total: 2,
          processed: 2,
          HIGH: 2,
          MEDIUM: 0,
          LOW: 0,
          unresolved: 0,
          skipped_existing: 0,
          http,
        },
        calls: [first, second],
        rows: [
          compactResolvedRow(first, `negative-${first}`, { id: `negative-${first}` }),
          compactResolvedRow(second, `negative-${second}`, { id: `negative-${second}` }),
        ],
      });
    } finally {
      await close();
    }
  });

  it('stores and reports an unresolved result as LOW zero confidence', async () => {
    const { db, close } = await makeTestDb();
    try {
      const bookId = await seedNamedBook(db, '701', 'Missing');
      const progress: Array<[number, number, string, string]> = [];
      const summary = await enrichLibrary(db, {
        userId: 'local',
        resolver: async () => ({ candidate: null, label: 'NONE', method: 'unresolved' }),
        progress: (...args) => progress.push(args),
      });
      expect({ summary, progress, rows: await compactRows(db) }).toEqual({
        summary: {
          total: 1,
          processed: 1,
          HIGH: 0,
          MEDIUM: 0,
          LOW: 0,
          unresolved: 1,
          skipped_existing: 0,
          http,
        },
        progress: [
          [0, 1, '', 'starting'],
          [1, 1, 'Missing', 'unresolved'],
        ],
        rows: [
          {
            bookId,
            resolvedSource: null,
            resolvedId: null,
            subjects: null,
            series: null,
            seriesPosition: null,
            description: null,
            coverUrl: null,
            resolutionConfidence: 0,
            confidenceLabel: 'LOW',
            matchMethod: 'unresolved',
            rawResponse: null,
            resolvedAt: expect.any(String),
            language: null,
          },
        ],
      });
    } finally {
      await close();
    }
  });

  it('commits each completed book before a later resolver failure', async () => {
    const { db, close } = await makeTestDb();
    try {
      const first = await seedNamedBook(db, '801', 'First');
      await seedNamedBook(db, '802', 'Second');
      const progress: Array<[number, number, string, string]> = [];
      await expect(
        enrichLibrary(db, {
          userId: 'local',
          resolver: async (_db, book) => {
            if (book.id !== first) throw new Error('catalog exploded');
            return resolved('durable-first');
          },
          progress: (...args) => progress.push(args),
        })
      ).rejects.toThrow('catalog exploded');
      expect({ progress, rows: await compactRows(db) }).toEqual({
        progress: [
          [0, 2, '', 'starting'],
          [1, 2, 'First', 'HIGH'],
        ],
        rows: [compactResolvedRow(first, 'durable-first', { id: 'durable-first' })],
      });
    } finally {
      await close();
    }
  });
});
