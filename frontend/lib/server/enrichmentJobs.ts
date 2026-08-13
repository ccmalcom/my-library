import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './db';
import { enrichLibrary } from './enrichment';
import { books, enrichment, enrichJobs } from './schema';
import { effectiveRating, tsToIso, utcnowTs } from './serialize';

export const FUNCTION_CEILING_SECONDS = 300; // Assumption: live Vercel Hobby + Fluid compute supports this.
// TEMPORARY — REVERT TO 240_000 AFTER THE CONTINUATION TEST.
// Lowered to 100s so a real enrichment run is forced to span multiple chunks and actually
// exercise the after()->/api/enrich/tick continuation, which has never executed in production
// (2026-08-13 smoke: a forced 159-book run finished in 221s, 18s under the 240s budget, so
// /api/enrich/start ran once and /api/enrich/tick zero times). This MUST be tested against the
// production custom domain: Vercel SSO protection is enabled for all_except_custom_domains, and
// rearmAfterResponse self-fetches request.url's origin with only the CRON_SECRET bearer, so on a
// preview deployment the tick is intercepted by the protection layer and fails in a way that is
// indistinguishable from a broken CRON_SECRET.
// Safe while it lasts: this changes how work is split across invocations, never the work or the
// data, and 100s sits far under the 300s maxDuration ceiling. Expect 3 chunks / 2 ticks / attempts
// = 3 for a 221s run, against MAX_JOB_ATTEMPTS of 25.
export const CHUNK_BUDGET_MS = 100_000; // TEMPORARY (was 240_000 — leaves 60s under the ceiling).
export const LEASE_SECONDS = 300;
export const STALE_JOB_SECONDS = 1_800;
export const MAX_JOB_ATTEMPTS = 25;
export const INTERRUPTED_MESSAGE = 'Enrichment was interrupted, please retry.';
export const STALLED_MESSAGE = 'Enrichment made no progress; please retry.';
export const ATTEMPTS_MESSAGE = 'Enrichment exceeded its retry limit; please retry.';

export interface JobOptions {
  force: boolean;
  limit: number | null;
}

export const defaultJobOptions: JobOptions = { force: false, limit: null };

export interface PublicJob {
  job_id: string;
  status: string;
  progress: number;
  total: number;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export type EnrichJobRow = typeof enrichJobs.$inferSelect;

export interface NewJobValues {
  jobId: string;
  userId: string;
  status: string;
  progress: number;
  total: number;
  force: boolean;
  runLimit: number | null;
}

export type JobInsert = (db: Db, values: NewJobValues) => Promise<EnrichJobRow>;

export function serializeJob(row: EnrichJobRow): PublicJob {
  return {
    job_id: row.jobId,
    status: row.status,
    progress: row.progress,
    total: row.total,
    error: row.error,
    started_at: tsToIso(row.startedAt),
    finished_at: tsToIso(row.finishedAt),
  };
}

function storedOptions(row: EnrichJobRow): JobOptions {
  return { force: row.force, limit: row.runLimit };
}

export async function findActiveJob(db: Db, userId: string): Promise<EnrichJobRow | null> {
  const rows = await db
    .select()
    .from(enrichJobs)
    .where(and(eq(enrichJobs.userId, userId), inArray(enrichJobs.status, ['pending', 'running'])))
    .limit(1);
  return rows[0] ?? null;
}

const insertJob: JobInsert = async (db, values) => {
  const rows = await db.insert(enrichJobs).values(values).returning();
  const row = rows[0];
  if (!row) throw new Error('enrich job insert returned no row');
  return row;
};

function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('message' in current && typeof current.message === 'string') messages.push(current.message);
    current = 'cause' in current ? current.cause : null;
  }
  return messages;
}

function isActiveUserViolation(error: unknown): boolean {
  return errorMessages(error).some((message) => message.includes('uq_enrich_jobs_active_user'));
}

export async function createOrGetActiveJob(
  db: Db,
  userId: string,
  options: JobOptions,
  create: JobInsert = insertJob
): Promise<{ created: boolean; job: PublicJob; options: JobOptions }> {
  const active = await findActiveJob(db, userId);
  if (active) return { created: false, job: serializeJob(active), options: storedOptions(active) };

  try {
    const row = await create(db, {
      jobId: randomUUID(),
      userId,
      status: 'pending',
      // progress/total are NOT NULL with no server default in the Alembic-owned
      // table -- Python supplies them from the ORM-level `default=0`. Omitting
      // them here makes drizzle emit SQL `default`, which Postgres rejects.
      progress: 0,
      total: 0,
      force: options.force,
      runLimit: options.limit,
    });
    return { created: true, job: serializeJob(row), options: storedOptions(row) };
  } catch (error) {
    if (!isActiveUserViolation(error)) throw error;
    const winner = await findActiveJob(db, userId);
    if (!winner) throw error;
    return { created: false, job: serializeJob(winner), options: storedOptions(winner) };
  }
}

function storageTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function timestampMillis(timestamp: string): number {
  return Date.parse(`${timestamp.replace(' ', 'T')}Z`);
}

export async function failIfStale(
  db: Db,
  row: EnrichJobRow,
  now = new Date()
): Promise<EnrichJobRow> {
  if (row.status !== 'running' || row.startedAt === null) return row;
  if (now.getTime() - timestampMillis(row.startedAt) <= STALE_JOB_SECONDS * 1_000) return row;

  const finishedAt = storageTimestamp(now);
  await db
    .update(enrichJobs)
    .set({
      status: 'error',
      error: INTERRUPTED_MESSAGE,
      finishedAt,
      leaseExpiresAt: null,
    })
    .where(eq(enrichJobs.id, row.id));
  return {
    ...row,
    status: 'error',
    error: INTERRUPTED_MESSAGE,
    finishedAt,
    leaseExpiresAt: null,
  };
}

export interface ActiveJobRepairSummary {
  examined: number;
  rearmed: number;
  failed: number;
  dispatchFailed: number;
}

export async function repairActiveJobs(
  db: Db,
  now: Date,
  dispatch: (jobId: string) => void | Promise<void>
): Promise<ActiveJobRepairSummary> {
  const activeRows = await db
    .select()
    .from(enrichJobs)
    .where(inArray(enrichJobs.status, ['pending', 'running']));
  let rearmed = 0;
  let failed = 0;
  let dispatchFailed = 0;

  for (const row of activeRows) {
    const repaired = await failIfStale(db, row, now);
    if (repaired.status === 'error') {
      failed += 1;
      continue;
    }
    if (
      repaired.leaseExpiresAt === null ||
      timestampMillis(repaired.leaseExpiresAt) <= now.getTime()
    ) {
      try {
        await dispatch(repaired.jobId);
        rearmed += 1;
      } catch (error) {
        dispatchFailed += 1;
        console.error(`Failed to dispatch enrichment job ${repaired.jobId}`, error);
      }
    }
  }

  return { examined: activeRows.length, rearmed, failed, dispatchFailed };
}

interface RawJobRow {
  id: number;
  job_id: string;
  user_id: string;
  status: string;
  progress: number;
  total: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  lease_expires_at: string | null;
  attempts: number;
  force: boolean;
  run_limit: number | null;
  created_at: string;
}

function hydrateJob(row: RawJobRow): EnrichJobRow {
  return {
    id: row.id,
    jobId: row.job_id,
    userId: row.user_id,
    status: row.status,
    progress: row.progress,
    total: row.total,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    leaseExpiresAt: row.lease_expires_at,
    attempts: row.attempts,
    force: row.force,
    runLimit: row.run_limit,
    createdAt: row.created_at,
  };
}

export async function claimJob(db: Db, jobId: string, now: Date): Promise<EnrichJobRow | null> {
  const nowTs = storageTimestamp(now);
  const leaseTs = storageTimestamp(new Date(now.getTime() + LEASE_SECONDS * 1_000));
  const result = await db.execute(sql`
    update enrich_jobs
    set status = 'running',
        started_at = coalesce(started_at, ${nowTs}),
        lease_expires_at = ${leaseTs},
        attempts = attempts + 1
    where job_id = ${jobId}
      and status in ('pending', 'running')
      and (lease_expires_at is null or lease_expires_at <= ${nowTs})
    returning *
  `);
  const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
  const row = rows[0] as RawJobRow | undefined;
  return row ? hydrateJob(row) : null;
}

interface RunOptions extends JobOptions {
  startedAt: string;
}

export interface RunClaimedChunkDeps {
  nowMs: () => number;
  runOne: (db: Db, bookId: number, options: JobOptions) => Promise<void>;
  dispatch: (jobId: string) => Promise<void>;
}

export interface RunClaimedChunkResult {
  outcome: 'done' | 'error' | 'continued';
  progressBefore: number;
  progressAfter: number;
  remaining: number;
  rearmed: boolean;
}

interface CandidateRow {
  book: typeof books.$inferSelect;
  enrichment: typeof enrichment.$inferSelect | null;
}

async function candidateRows(db: Db, userId: string): Promise<CandidateRow[]> {
  const rows = await db
    .select({ book: books, enrichment })
    .from(books)
    .leftJoin(enrichment, eq(enrichment.bookId, books.id))
    .where(eq(books.userId, userId));
  return rows.filter(({ book }) => effectiveRating(book.appRating, book.goodreadsRating) !== null);
}

function processedThisRun(rows: CandidateRow[], startedAt: string): number {
  return rows.filter((row) => row.enrichment !== null && row.enrichment.resolvedAt >= startedAt)
    .length;
}

function selectableRows(rows: CandidateRow[], options: RunOptions): CandidateRow[] {
  return rows.filter(({ enrichment: existing }) =>
    options.force ? existing === null || existing.resolvedAt < options.startedAt : existing === null
  );
}

function limitedCount(count: number, limit: number | null): number {
  if (limit === null) return count;
  return Math.min(count, limit);
}

async function deriveState(
  db: Db,
  userId: string,
  options: RunOptions
): Promise<{ progress: number; remaining: number; total: number }> {
  const rows = await candidateRows(db, userId);
  const processed = processedThisRun(rows, options.startedAt);
  const preexisting = rows.filter(
    (row) => row.enrichment !== null && row.enrichment.resolvedAt < options.startedAt
  ).length;
  const selectable = selectableRows(rows, options).length;
  const allowance = options.limit === null ? selectable : Math.max(0, options.limit - processed);
  const remaining = Math.min(selectable, allowance);
  const initialWork = options.force
    ? rows.length
    : rows.filter((row) => row.enrichment === null).length + processed;
  const skipped = options.force ? 0 : preexisting;
  const total = skipped + limitedCount(initialWork, options.limit);
  return {
    progress: processed + (options.force ? 0 : preexisting),
    remaining,
    total,
  };
}

export async function countPersistedEnrichment(
  db: Db,
  userId: string,
  options: RunOptions
): Promise<number> {
  return (await deriveState(db, userId, options)).progress;
}

async function hasWorkRemaining(db: Db, userId: string, options: RunOptions): Promise<boolean> {
  return (await deriveState(db, userId, options)).remaining > 0;
}

async function nextUnenrichedBook(
  db: Db,
  userId: string,
  options: RunOptions
): Promise<typeof books.$inferSelect | null> {
  const rows = await candidateRows(db, userId);
  return selectableRows(rows, options)[0]?.book ?? null;
}

async function writeDerivedProgress(
  db: Db,
  jobId: string,
  derived: number,
  total: number
): Promise<void> {
  await db.update(enrichJobs).set({ progress: derived, total }).where(eq(enrichJobs.jobId, jobId));
}

async function writeTerminal(
  db: Db,
  jobId: string,
  status: 'done' | 'error',
  progress: number,
  total: number,
  error: string | null
): Promise<void> {
  await db
    .update(enrichJobs)
    .set({
      status,
      progress,
      total,
      error: error?.slice(0, 2_000) ?? null,
      finishedAt: utcnowTs(),
      leaseExpiresAt: null,
    })
    .where(eq(enrichJobs.jobId, jobId));
}

export function oneBookEnrichmentRunner(userId: string): RunClaimedChunkDeps['runOne'] {
  return async (db, bookId, options) => {
    await enrichLibrary(db, { userId, force: options.force, bookIds: [bookId] });
  };
}

export async function runClaimedChunk(
  db: Db,
  job: EnrichJobRow,
  deps: RunClaimedChunkDeps
): Promise<RunClaimedChunkResult> {
  if (job.startedAt === null) throw new Error('claimed enrichment job has no started_at');
  const options: RunOptions = {
    force: job.force,
    limit: job.runLimit,
    startedAt: job.startedAt,
  };
  const initial = await deriveState(db, job.userId, options);
  const progressBefore = initial.progress;

  if (job.attempts > MAX_JOB_ATTEMPTS) {
    await writeTerminal(db, job.jobId, 'error', progressBefore, initial.total, ATTEMPTS_MESSAGE);
    return {
      outcome: 'error',
      progressBefore,
      progressAfter: progressBefore,
      remaining: initial.remaining,
      rearmed: false,
    };
  }

  const startedMs = deps.nowMs();
  let lastDerived = progressBefore;
  while (await hasWorkRemaining(db, job.userId, options)) {
    if (deps.nowMs() - startedMs >= CHUNK_BUDGET_MS) break;
    const next = await nextUnenrichedBook(db, job.userId, options);
    if (!next) break;
    await deps.runOne(db, next.id, options);
    const derived = await countPersistedEnrichment(db, job.userId, options);
    await writeDerivedProgress(db, job.jobId, derived, initial.total);
    if (derived === lastDerived) break;
    lastDerived = derived;
  }
  const finalState = await deriveState(db, job.userId, options);
  const progressAfter = finalState.progress;

  if (finalState.remaining === 0) {
    await writeTerminal(db, job.jobId, 'done', progressAfter, initial.total, null);
    return {
      outcome: 'done',
      progressBefore,
      progressAfter,
      remaining: 0,
      rearmed: false,
    };
  }

  if (progressAfter === progressBefore) {
    await writeTerminal(db, job.jobId, 'error', progressAfter, initial.total, STALLED_MESSAGE);
    return {
      outcome: 'error',
      progressBefore,
      progressAfter,
      remaining: finalState.remaining,
      rearmed: false,
    };
  }

  await db
    .update(enrichJobs)
    .set({ progress: progressAfter, total: initial.total, leaseExpiresAt: null })
    .where(eq(enrichJobs.jobId, job.jobId));
  let rearmed = true;
  try {
    await deps.dispatch(job.jobId);
  } catch (error) {
    rearmed = false;
    console.error(`Failed to dispatch enrichment job ${job.jobId}`, error);
  }
  return {
    outcome: 'continued',
    progressBefore,
    progressAfter,
    remaining: finalState.remaining,
    rearmed,
  };
}
