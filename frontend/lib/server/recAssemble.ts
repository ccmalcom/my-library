/**
 * Stage 1 retrieval: port of recommend._metadata_pool, _seed_pool, _assemble,
 * _cap_pool and _fill_ol_descriptions.
 *
 * Every catalog call is awaited SEQUENTIALLY, exactly as Python runs them. Do not
 * "optimize" these loops into Promise.all: the request order is what the recorded
 * catalog fixture replays, and catalog.ts's throttle assumes serial calls.
 */
import {
  googleBooksAuthor,
  googleBooksQuery,
  googleBooksSubject,
  openlibrarySubject,
  openlibraryWorkDescription,
  type Candidate,
} from './catalog';
import type { Db } from './db';
import {
  allowedLanguages,
  applyAuthorCaps,
  dedupKey,
  EMPTY_DEDUP_KEY,
  fuzzyDuplicate,
  isLearnerEdition,
  languageOk,
  seriesOk,
} from './recFilters';
import type { RecSignal } from './recSignal';
import { pyRoundHalfEven } from './serialize';

/** recommend.py:53-56 tuning knobs. */
export const PER_QUERY = 8; // catalog hits per subject/author/seed query
export const SEED_QUERIES = 8; // search terms to ask Claude to propose
export const MAX_CANDIDATES = 60; // cap on the pool handed to the reranker (token budget)
export const SEED_RESERVE_SHARE = 0.3; // min share of the cap reserved for seed-only candidates

/** Python's (candidate, reason) tuple. */
export type PoolEntry = [Candidate, string];

export interface AssembledCandidate {
  title: string;
  author: string | null;
  year: number | null;
  isbn13: string | null;
  subjects: string[];
  description: string | null;
  cover_url: string | null;
  catalog_source: string | null;
  catalog_id: string | null;
  language: string | null;
  seed_reason: string;
  retrieval_pool: string;
}

/** The subset of the signal that assembly reads — lets 3c-2/3c-3 pass a book-anchored signal. */
export type AssembleSignal = Pick<
  RecSignal,
  | 'library_keys'
  | 'library_isbns'
  | 'library_series'
  | 'library_titles'
  | 'library_languages'
  | 'library_authors'
>;

/**
 * Deterministic expansion from the reader's loved subjects/authors. In cold-start
 * (thin library) author expansion is skipped -- it produces same-author clones -- and
 * discovery leans on subjects plus the Claude-seeded comp queries.
 */
export async function metadataPool(
  db: Db,
  signal: Pick<RecSignal, 'top_subjects' | 'top_authors'>,
  perQuery: number,
  coldStart: boolean
): Promise<PoolEntry[]> {
  const pool: PoolEntry[] = [];
  for (const subject of signal.top_subjects) {
    for (const c of await openlibrarySubject(db, subject, perQuery)) {
      pool.push([c, `subject:${subject}`]);
    }
    for (const c of await googleBooksSubject(db, subject, perQuery)) {
      pool.push([c, `subject:${subject}`]);
    }
  }
  if (!coldStart) {
    for (const author of signal.top_authors) {
      for (const c of await googleBooksAuthor(db, author, perQuery)) {
        pool.push([c, `author:${author}`]);
      }
    }
  }
  return pool;
}

/** Run Claude's proposed search terms against the live catalog (recommend._seed_pool). */
export async function seedPool(db: Db, queries: string[], perQuery: number): Promise<PoolEntry[]> {
  const pool: PoolEntry[] = [];
  for (const q of queries) {
    for (const c of await googleBooksQuery(db, q, perQuery)) {
      pool.push([c, `query:${q}`]);
    }
  }
  return pool;
}

type PendingCandidate = Omit<AssembledCandidate, 'retrieval_pool'> & { pools: Set<string> };

/** Merge both pools, drop library books + duplicates, tag provenance, cap size. */
export function assemble(
  metadataEntries: PoolEntry[],
  seedEntries: PoolEntry[],
  signal: AssembleSignal,
  cap: number
): AssembledCandidate[] {
  const allowedLangs = allowedLanguages(signal.library_languages);
  // A Map, so values() yields Python's dict insertion order.
  const byKey = new Map<string, PendingCandidate>();

  const add = (cand: Candidate, reason: string, poolName: string): void => {
    const title = cand.title;
    if (!title) return;
    const key = dedupKey(title, cand.author ?? null);
    if (signal.library_keys.has(key) || key === EMPTY_DEDUP_KEY) return;
    const isbn = cand.isbn13 ?? null;
    if (isbn && signal.library_isbns.has(isbn)) return;
    if (!languageOk(cand.language, allowedLangs)) return;
    if (!seriesOk(title, signal.library_series)) return;
    if (fuzzyDuplicate(title, signal.library_titles)) return;
    if (isLearnerEdition(cand)) return;

    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, {
        title,
        author: cand.author ?? null,
        year: cand.year ?? null,
        isbn13: isbn,
        subjects: (cand.subjects ?? []).slice(0, 8),
        description: cand.description ?? null,
        cover_url: cand.cover_url ?? null,
        catalog_source: cand.source ?? null,
        catalog_id: cand.resolved_id ?? null,
        language: cand.language ?? null,
        pools: new Set([poolName]),
        seed_reason: reason,
      });
    } else {
      existing.pools.add(poolName);
      if (!existing.author && cand.author) existing.author = cand.author;
      if (!existing.subjects.length && cand.subjects?.length) {
        existing.subjects = cand.subjects.slice(0, 8);
      }
      if (!existing.description && cand.description) existing.description = cand.description;
      if (!existing.language && cand.language) existing.language = cand.language;
    }
  };

  for (const [cand, reason] of metadataEntries) add(cand, reason, 'metadata');
  for (const [cand, reason] of seedEntries) add(cand, reason, 'claude_seed');

  const candidates: AssembledCandidate[] = [];
  for (const { pools, ...rest } of byKey.values()) {
    candidates.push({ ...rest, retrieval_pool: pools.size > 1 ? 'both' : [...pools][0] });
  }
  return capPool(applyAuthorCaps(candidates, signal.library_authors), cap);
}

/**
 * Trim to `cap` without letting the (larger) metadata pool starve the Claude-seeded
 * one. If we paid for seed queries, their candidates must actually reach the
 * reranker. 'both'-pool candidates are the most grounded and are always kept.
 * Within each bucket, candidates with a description sort first.
 */
export function capPool(candidates: AssembledCandidate[], cap: number): AssembledCandidate[] {
  if (candidates.length <= cap) return candidates;

  // Python's sorted() is stable, as is Array.sort in V8, so equal keys keep order.
  const descFirst = (lst: AssembledCandidate[]) =>
    [...lst].sort((a, b) => (a.description ? 0 : 1) - (b.description ? 0 : 1));

  const both = descFirst(candidates.filter((c) => c.retrieval_pool === 'both'));
  const meta = descFirst(candidates.filter((c) => c.retrieval_pool === 'metadata'));
  const seed = descFirst(candidates.filter((c) => c.retrieval_pool === 'claude_seed'));

  let chosen = both.slice(0, cap);
  const remaining = cap - chosen.length;
  if (remaining <= 0) return chosen;

  // Guarantee seed-only candidates a minimum slice of what is left (if any exist).
  // pyRoundHalfEven, not Math.round: Python's round() breaks .5 toward even.
  const seedQuota = Math.min(seed.length, pyRoundHalfEven(cap * SEED_RESERVE_SHARE), remaining);
  chosen = chosen.concat(seed.slice(0, seedQuota));
  chosen = chosen.concat(meta.slice(0, cap - chosen.length));
  // Backfill any slack (e.g. too few metadata hits) with leftover seed candidates.
  if (chosen.length < cap) {
    chosen = chosen.concat(seed.slice(seedQuota, seedQuota + (cap - chosen.length)));
  }
  return chosen.slice(0, cap);
}

/**
 * Fetch Work descriptions for OL candidates the pool query left without one. The OL
 * subjects endpoint returns works but no descriptions; we already hold the work key,
 * so one extra cached GET per OL candidate fills the gap. MUTATES in place, like Python.
 */
export async function fillOlDescriptions(db: Db, candidates: AssembledCandidate[]): Promise<void> {
  for (const c of candidates) {
    if (c.description || c.catalog_source !== 'openlibrary') continue;
    const workKey = c.catalog_id;
    // Python assigns unconditionally, so a miss overwrites null with null.
    if (workKey) c.description = await openlibraryWorkDescription(db, workKey);
  }
}
