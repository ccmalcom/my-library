import {
  getCatalogStats,
  googleBooksByIsbn,
  googleBooksEnrichmentSearch,
  openlibraryByIsbn,
  openlibraryEnrichmentSearch,
  openlibraryWorkDescription,
  resetCatalogStats,
  setRate,
  type Candidate,
  type OpenLibraryIsbnCandidate,
} from './catalog';
import type { Db } from './db';
import { books, enrichment } from './schema';
import { eq } from 'drizzle-orm';
import { surname, normalizeTitle } from './dedup';
import { STRONG_SIM, titleSim } from './similarity';
import type { BookRow } from './books';
import { effectiveRating, serializeResolutionConfidence, utcnowTs } from './serialize';

export type ConfidenceLabel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export interface ScoredCandidate {
  candidate: Candidate | null;
  label: ConfidenceLabel;
}

export interface EnrichmentCatalog {
  openlibraryByIsbn(db: Db, isbn: string): Promise<OpenLibraryIsbnCandidate | null>;
  googleBooksByIsbn(db: Db, isbn: string): Promise<Candidate | null>;
  openlibraryEnrichmentSearch(db: Db, title: string, author: string | null): Promise<Candidate[]>;
  googleBooksEnrichmentSearch(db: Db, title: string, author: string | null): Promise<Candidate[]>;
}

export type ResolutionCandidate = OpenLibraryIsbnCandidate | Candidate;
export type MatchMethod =
  | 'isbn:openlibrary'
  | 'isbn:googlebooks'
  | 'search:openlibrary'
  | 'search:googlebooks'
  | 'unresolved';

export interface ResolutionResult {
  candidate: ResolutionCandidate | null;
  label: ConfidenceLabel;
  method: MatchMethod;
}

const productionCatalog: EnrichmentCatalog = {
  openlibraryByIsbn,
  googleBooksByIsbn,
  openlibraryEnrichmentSearch,
  googleBooksEnrichmentSearch,
};

const WEAK_SIM = 0.6;

/** Python enrich._search_title: strip parentheticals, collapse whitespace, KEEP case. */
export function searchTitle(title: string | null): string {
  return (title ?? '')
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Python enrich._score_candidates. */
export function scoreCandidates(
  book: Pick<BookRow, 'title' | 'author'>,
  candidates: Candidate[]
): ScoredCandidate {
  if (!candidates.length) return { candidate: null, label: 'NONE' };

  const scored = candidates
    .map((candidate, index) => ({ candidate, index, score: titleSim(book.title, candidate.title) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = scored[0].candidate;
  const bestSim = titleSim(book.title, best.title);
  const secondSim = scored.length > 1 ? titleSim(book.title, scored[1].candidate.title) : 0.0;
  const bookSurname = surname(book.author);
  const authorOk =
    !book.author ||
    !best.author ||
    bookSurname === surname(best.author) ||
    normalizeTitle(best.author).includes(bookSurname);

  const ambiguous = bestSim >= STRONG_SIM && secondSim >= STRONG_SIM;
  if (bestSim >= STRONG_SIM && authorOk && !ambiguous) {
    return { candidate: best, label: 'MEDIUM' };
  }
  // The weak threshold is inert in Python: both this branch and fallthrough are LOW.
  if (bestSim >= WEAK_SIM) return { candidate: best, label: 'LOW' };
  return { candidate: best, label: 'LOW' };
}

/** Python enrich._resolve_one: ISBN trust and catalog order are intentional. */
export async function resolveOne(
  db: Db,
  book: Pick<BookRow, 'title' | 'author' | 'isbn13'>,
  catalog: EnrichmentCatalog = productionCatalog
): Promise<ResolutionResult> {
  if (book.isbn13) {
    const openLibraryIsbn = await catalog.openlibraryByIsbn(db, book.isbn13);
    if (openLibraryIsbn) {
      return { candidate: openLibraryIsbn, label: 'HIGH', method: 'isbn:openlibrary' };
    }
    const googleIsbn = await catalog.googleBooksByIsbn(db, book.isbn13);
    if (googleIsbn) {
      return { candidate: googleIsbn, label: 'HIGH', method: 'isbn:googlebooks' };
    }
  }

  const title = searchTitle(book.title);
  const openLibrary = scoreCandidates(
    book,
    await catalog.openlibraryEnrichmentSearch(db, title, book.author)
  );
  if (openLibrary.candidate && openLibrary.label === 'MEDIUM') {
    return {
      candidate: openLibrary.candidate,
      label: openLibrary.label,
      method: 'search:openlibrary',
    };
  }

  const google = scoreCandidates(
    book,
    await catalog.googleBooksEnrichmentSearch(db, title, book.author)
  );
  if (google.candidate && google.label === 'MEDIUM') {
    return { candidate: google.candidate, label: google.label, method: 'search:googlebooks' };
  }
  if (openLibrary.candidate) {
    return { candidate: openLibrary.candidate, label: 'LOW', method: 'search:openlibrary' };
  }
  if (google.candidate) {
    return { candidate: google.candidate, label: 'LOW', method: 'search:googlebooks' };
  }
  return { candidate: null, label: 'NONE', method: 'unresolved' };
}

/** Persist one resolved or unresolved book with Python's replacement/stale-data semantics. */
export async function persistResolution(
  db: Db,
  bookId: number,
  result: ResolutionResult
): Promise<void> {
  const candidate = result.candidate;

  if (!candidate) {
    const unresolved = {
      resolutionConfidence: serializeResolutionConfidence('NONE'),
      confidenceLabel: 'LOW',
      matchMethod: 'unresolved',
      resolvedAt: utcnowTs(),
    };
    await db.transaction(async (tx) => {
      await tx
        .insert(enrichment)
        .values({ bookId, ...unresolved })
        .onConflictDoUpdate({
          target: enrichment.bookId,
          set: unresolved,
        });
    });
    return;
  }

  let description = candidate.description ?? null;
  if (
    !description &&
    candidate.source === 'openlibrary' &&
    candidate.resolved_id?.startsWith('/works/')
  ) {
    description = await openlibraryWorkDescription(db, candidate.resolved_id);
  }

  const resolved = {
    resolvedSource: candidate.source,
    resolvedId: candidate.resolved_id,
    subjects: candidate.subjects || [],
    series: null,
    seriesPosition: null,
    description,
    coverUrl: candidate.cover_url,
    resolutionConfidence: serializeResolutionConfidence(result.label),
    confidenceLabel: result.label,
    matchMethod: result.method,
    rawResponse: candidate.raw,
    resolvedAt: utcnowTs(),
    language: 'language' in candidate ? candidate.language : null,
  };
  await db.transaction(async (tx) => {
    await tx
      .insert(enrichment)
      .values({ bookId, ...resolved })
      .onConflictDoUpdate({
        target: enrichment.bookId,
        set: resolved,
      });
  });
}

export type EnrichmentProgress = (
  completed: number,
  total: number,
  title: string,
  label: string
) => void;

export interface EnrichLibraryOptions {
  userId: string;
  force?: boolean;
  limit?: number | null;
  includeUnrated?: boolean;
  retryUnresolved?: boolean;
  requestsPerSecond?: number | null;
  progress?: EnrichmentProgress;
  resolver?: (
    db: Db,
    book: Pick<BookRow, 'id' | 'title' | 'author' | 'isbn13'>
  ) => Promise<ResolutionResult>;
}

export interface EnrichmentSummary {
  total: number;
  processed: number;
  HIGH: number;
  MEDIUM: number;
  LOW: number;
  unresolved: number;
  skipped_existing: number;
  http: ReturnType<typeof getCatalogStats>;
}

/** Python enrich.enrich_library: selection, progress, durability, and summary orchestration. */
export async function enrichLibrary(
  db: Db,
  options: EnrichLibraryOptions
): Promise<EnrichmentSummary> {
  resetCatalogStats();
  if (options.requestsPerSecond !== null && options.requestsPerSecond !== undefined) {
    setRate(options.requestsPerSecond);
  }

  const summary = {
    total: 0,
    processed: 0,
    HIGH: 0,
    MEDIUM: 0,
    LOW: 0,
    unresolved: 0,
    skipped_existing: 0,
  };
  const rows = await db
    .select({ book: books, enrichment })
    .from(books)
    .leftJoin(enrichment, eq(enrichment.bookId, books.id))
    .where(eq(books.userId, options.userId));
  const candidates = rows.filter(
    ({ book }) =>
      options.includeUnrated || effectiveRating(book.appRating, book.goodreadsRating) !== null
  );
  const work = candidates.filter(
    ({ enrichment: existing }) =>
      options.force ||
      existing === null ||
      (options.retryUnresolved && existing.resolvedSource === null)
  );
  const skipped = candidates.length - work.length;
  summary.skipped_existing = skipped;
  const limitedWork =
    options.limit === null || options.limit === undefined ? work : work.slice(0, options.limit);
  const fullTotal = skipped + limitedWork.length;
  summary.total = fullTotal;
  const progress = options.progress;
  if (progress) progress(skipped, fullTotal, '', 'starting');

  const resolver = options.resolver ?? resolveOne;
  for (const [index, { book }] of limitedWork.entries()) {
    const result = await resolver(db, book);
    await persistResolution(db, book.id, result);
    let progressLabel: string;
    if (!result.candidate) {
      summary.unresolved += 1;
      progressLabel = 'unresolved';
    } else {
      summary[result.label as Exclude<ConfidenceLabel, 'NONE'>] += 1;
      progressLabel = result.label;
    }
    summary.processed += 1;
    if (progress) progress(skipped + index + 1, fullTotal, book.title, progressLabel);
  }

  return { ...summary, http: getCatalogStats() };
}
