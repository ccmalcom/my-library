import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db';
import { enrichLibrary, type EnrichmentSummary } from '../enrichment';
import {
  CHUNK_BUDGET_MS,
  MAX_JOB_ATTEMPTS,
  ATTEMPTS_MESSAGE,
  STALLED_MESSAGE,
  claimJob,
  createOrGetActiveJob,
  defaultJobOptions,
  repairActiveJobs,
  runClaimedChunk,
  serializeJob,
  type EnrichJobRow,
  type JobInsert,
} from '../enrichmentJobs';
import { books, enrichment, enrichJobs } from '../schema';
import { makeTestDb } from './helpers/pglite';

function errorText(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  return [
    error instanceof Error ? error.message : String(error),
    cause instanceof Error ? cause.message : String(cause ?? ''),
  ].join(' ');
}

async function seedBooks(db: Db, userId: string, ids: number[]): Promise<void> {
  await db.insert(books).values(
    ids.map((id) => ({
      id,
      userId,
      goodreadsBookId: `${userId}-${id}`,
      title: `Book ${id}`,
      author: 'Test Author',
      goodreadsRating: 5,
      source: 'test',
    }))
  );
}

async function seedEnrichment(
  db: Db,
  bookIds: number[],
  resolvedAt = '2026-08-11 12:00:01.000'
): Promise<void> {
  for (const bookId of bookIds) {
    await db
      .insert(enrichment)
      .values({ bookId, resolutionConfidence: 0, resolvedAt })
      .onConflictDoUpdate({
        target: enrichment.bookId,
        set: { resolutionConfidence: 0, resolvedAt },
      });
  }
}

async function seedClaimedJob(
  db: Db,
  values: {
    jobId: string;
    userId: string;
    progress: number;
    total: number;
    attempts: number;
    force?: boolean;
    runLimit?: number | null;
  }
): Promise<void> {
  await db.insert(enrichJobs).values({
    ...values,
    status: 'running',
    startedAt: '2026-08-11 12:00:00.000',
    leaseExpiresAt: '2026-08-11 12:05:00.000',
  });
}

function claimed(
  jobId: string,
  userId: string,
  attempts = 1,
  options: { force?: boolean; runLimit?: number | null } = {}
): EnrichJobRow {
  return {
    id: 1,
    jobId,
    userId,
    status: 'running',
    progress: 0,
    total: 0,
    startedAt: '2026-08-11 12:00:00.000',
    finishedAt: null,
    error: null,
    leaseExpiresAt: '2026-08-11 12:05:00.000',
    attempts,
    force: options.force ?? false,
    runLimit: options.runLimit ?? null,
    createdAt: '2026-08-11 12:00:00.000',
  };
}

async function publicJob(db: Db, jobId: string) {
  const [row] = await db.select().from(enrichJobs).where(eq(enrichJobs.jobId, jobId));
  if (!row) throw new Error(`missing job ${jobId}`);
  return serializeJob(row);
}

function sequenceClock(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

function summary(processed: number, skippedExisting: number): EnrichmentSummary {
  return {
    total: processed + skippedExisting,
    processed,
    HIGH: processed,
    MEDIUM: 0,
    LOW: 0,
    unresolved: 0,
    skipped_existing: skippedExisting,
    http: {
      requests: 0,
      rate_limited: 0,
      server_errors: 0,
      network_errors: 0,
      retries: 0,
      by_host: {},
    },
  };
}

async function captureViolation(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a database constraint violation');
}

describe('enrichment jobs', () => {
  it('the partial unique index rejects a second active job but permits terminal history', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db
        .insert(enrichJobs)
        .values({ jobId: 'job-1', progress: 0, total: 0, userId: 'user-a', status: 'pending' });
      let message = '';
      try {
        await db
          .insert(enrichJobs)
          .values({ jobId: 'job-2', progress: 0, total: 0, userId: 'user-a', status: 'running' });
      } catch (error) {
        message = errorText(error);
      }
      await db.update(enrichJobs).set({ status: 'done' }).where(eq(enrichJobs.jobId, 'job-1'));
      await db
        .insert(enrichJobs)
        .values({ jobId: 'job-3', progress: 0, total: 0, userId: 'user-a', status: 'pending' });
      const rows = await db
        .select({ jobId: enrichJobs.jobId, status: enrichJobs.status })
        .from(enrichJobs)
        .where(eq(enrichJobs.userId, 'user-a'));
      expect({ rejected: message.includes('uq_enrich_jobs_active_user'), rows }).toEqual({
        rejected: true,
        rows: [
          { jobId: 'job-1', status: 'done' },
          { jobId: 'job-3', status: 'pending' },
        ],
      });
    } finally {
      await close();
    }
  });

  it('returns the existing active job and serializes exactly seven public fields', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db.insert(enrichJobs).values({
        jobId: 'winner',
        userId: 'user-a',
        status: 'running',
        progress: 2,
        total: 7,
        attempts: 1,
      });
      const result = await createOrGetActiveJob(db, 'user-a', defaultJobOptions);
      expect(result).toEqual({
        created: false,
        job: {
          job_id: 'winner',
          status: 'running',
          progress: 2,
          total: 7,
          error: null,
          started_at: null,
          finished_at: null,
        },
        options: defaultJobOptions,
      });
    } finally {
      await close();
    }
  });

  it("returns the stored options of an existing active job, not the caller's", async () => {
    const { db, close } = await makeTestDb();
    try {
      await db.insert(enrichJobs).values({
        jobId: 'configured',
        progress: 0,
        total: 0,
        userId: 'user-a',
        status: 'pending',
        force: true,
        runLimit: 5,
      });
      const result = await createOrGetActiveJob(db, 'user-a', defaultJobOptions);
      expect(result).toEqual({
        created: false,
        job: {
          job_id: 'configured',
          status: 'pending',
          progress: 0,
          total: 0,
          error: null,
          started_at: null,
          finished_at: null,
        },
        options: { force: true, limit: 5 },
      });
    } finally {
      await close();
    }
  });

  it('conditional UPDATE RETURNING claims once and returns no row while leased', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db
        .insert(enrichJobs)
        .values({ jobId: 'claim-me', progress: 0, total: 0, userId: 'user-a', status: 'pending' });
      const first = await claimJob(db, 'claim-me', new Date('2026-08-11T12:00:00Z'));
      const second = await claimJob(db, 'claim-me', new Date('2026-08-11T12:00:01Z'));
      expect({
        first: first && {
          jobId: first.jobId,
          userId: first.userId,
          status: first.status,
          attempts: first.attempts,
        },
        second,
      }).toEqual({
        first: { jobId: 'claim-me', userId: 'user-a', status: 'running', attempts: 1 },
        second: null,
      });
    } finally {
      await close();
    }
  });

  it('recovers only the active-user unique violation by returning the winner', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db.insert(enrichJobs).values({
        jobId: 'capture-active',
        progress: 0,
        total: 0,
        userId: 'capture-user',
        status: 'pending',
      });
      const activeViolation = await captureViolation(() =>
        db.insert(enrichJobs).values({
          jobId: 'capture-loser',
          progress: 0,
          total: 0,
          userId: 'capture-user',
          status: 'running',
        })
      );
      expect(errorText(activeViolation).includes('uq_enrich_jobs_active_user')).toEqual(true);

      const insert: JobInsert = async (_db, values) => {
        await db.insert(enrichJobs).values({
          jobId: 'race-winner',
          progress: 0,
          total: 0,
          userId: values.userId,
          status: 'pending',
          force: true,
          runLimit: 5,
        });
        throw activeViolation;
      };
      const result = await createOrGetActiveJob(db, 'race-user', defaultJobOptions, insert);
      expect(result).toEqual({
        created: false,
        job: {
          job_id: 'race-winner',
          status: 'pending',
          progress: 0,
          total: 0,
          error: null,
          started_at: null,
          finished_at: null,
        },
        options: { force: true, limit: 5 },
      });
    } finally {
      await close();
    }
  });

  it('propagates a non-active-user unique violation instead of re-reading', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db.insert(enrichJobs).values({
        jobId: 'duplicate-id',
        progress: 0,
        total: 0,
        userId: 'first-user',
        status: 'done',
      });
      const jobIdViolation = await captureViolation(() =>
        db.insert(enrichJobs).values({
          jobId: 'duplicate-id',
          progress: 0,
          total: 0,
          userId: 'second-user',
          status: 'done',
        })
      );
      expect(errorText(jobIdViolation).includes('enrich_jobs_job_id_key')).toEqual(true);

      const insert: JobInsert = async () => {
        throw jobIdViolation;
      };
      let thrown: unknown;
      try {
        await createOrGetActiveJob(db, 'race-user', defaultJobOptions, insert);
      } catch (error) {
        thrown = error;
      }
      const rows = await db
        .select({ jobId: enrichJobs.jobId, userId: enrichJobs.userId, status: enrichJobs.status })
        .from(enrichJobs);
      expect({ sameError: thrown === jobIdViolation, rows }).toEqual({
        sameError: true,
        rows: [{ jobId: 'duplicate-id', userId: 'first-user', status: 'done' }],
      });
    } finally {
      await close();
    }
  });

  it('recomputes progress from enrichment rows after each book instead of accumulating', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedBooks(db, 'user-a', [1, 2, 3]);
      await seedEnrichment(db, [1], '2026-08-11 11:00:00.000');
      await seedClaimedJob(db, {
        jobId: 'job',
        userId: 'user-a',
        progress: 99,
        total: 3,
        attempts: 1,
      });
      const result = await runClaimedChunk(db, claimed('job', 'user-a'), {
        nowMs: sequenceClock([0, 1, 2]),
        runOne: async (_db, bookId) => {
          await seedEnrichment(db, [bookId]);
        },
        dispatch: async () => undefined,
      });
      expect({ result, job: await publicJob(db, 'job') }).toEqual({
        result: {
          outcome: 'done',
          progressBefore: 1,
          progressAfter: 3,
          remaining: 0,
          rearmed: false,
        },
        job: {
          job_id: 'job',
          status: 'done',
          progress: 3,
          total: 3,
          error: null,
          started_at: expect.any(String),
          finished_at: expect.any(String),
        },
      });
    } finally {
      await close();
    }
  });

  it('fails a zero-progress chunk with work remaining and does not re-arm', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedBooks(db, 'user-a', [1]);
      await seedClaimedJob(db, {
        jobId: 'stalled',
        userId: 'user-a',
        progress: 0,
        total: 1,
        attempts: 1,
      });
      const dispatch = vi.fn();
      const result = await runClaimedChunk(db, claimed('stalled', 'user-a'), {
        nowMs: sequenceClock([0, 1]),
        runOne: async () => undefined,
        dispatch,
      });
      expect({
        result,
        dispatches: dispatch.mock.calls,
        job: await publicJob(db, 'stalled'),
      }).toEqual({
        result: {
          outcome: 'error',
          progressBefore: 0,
          progressAfter: 0,
          remaining: 1,
          rearmed: false,
        },
        dispatches: [],
        job: {
          job_id: 'stalled',
          status: 'error',
          progress: 0,
          total: 1,
          error: STALLED_MESSAGE,
          started_at: expect.any(String),
          finished_at: expect.any(String),
        },
      });
    } finally {
      await close();
    }
  });

  it('fails attempts overflow with a real error before work and does not re-arm', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedBooks(db, 'user-a', [1]);
      await seedClaimedJob(db, {
        jobId: 'overflow',
        userId: 'user-a',
        progress: 0,
        total: 1,
        attempts: MAX_JOB_ATTEMPTS + 1,
      });
      const runOne = vi.fn();
      const dispatch = vi.fn();
      const result = await runClaimedChunk(
        db,
        claimed('overflow', 'user-a', MAX_JOB_ATTEMPTS + 1),
        { nowMs: () => 0, runOne, dispatch }
      );
      expect({
        result,
        work: runOne.mock.calls,
        dispatches: dispatch.mock.calls,
        job: await publicJob(db, 'overflow'),
      }).toEqual({
        result: {
          outcome: 'error',
          progressBefore: 0,
          progressAfter: 0,
          remaining: 1,
          rearmed: false,
        },
        work: [],
        dispatches: [],
        job: {
          job_id: 'overflow',
          status: 'error',
          progress: 0,
          total: 1,
          error: ATTEMPTS_MESSAGE,
          started_at: expect.any(String),
          finished_at: expect.any(String),
        },
      });
    } finally {
      await close();
    }
  });

  it('stops at a book boundary after CHUNK_BUDGET_MS and re-arms only after progress', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedBooks(db, 'user-a', [1, 2, 3]);
      await seedClaimedJob(db, {
        jobId: 'continued',
        userId: 'user-a',
        progress: 0,
        total: 3,
        attempts: 1,
      });
      const work: number[] = [];
      const dispatch = vi.fn(async () => undefined);
      const result = await runClaimedChunk(db, claimed('continued', 'user-a'), {
        nowMs: sequenceClock([0, 1, CHUNK_BUDGET_MS]),
        runOne: async (_db, bookId) => {
          work.push(bookId);
          await seedEnrichment(db, [bookId]);
        },
        dispatch,
      });
      const [row] = await db.select().from(enrichJobs).where(eq(enrichJobs.jobId, 'continued'));
      expect({
        result,
        work,
        dispatches: dispatch.mock.calls,
        job: serializeJob(row),
        leaseExpiresAt: row.leaseExpiresAt,
      }).toEqual({
        result: {
          outcome: 'continued',
          progressBefore: 0,
          progressAfter: 1,
          remaining: 2,
          rearmed: true,
        },
        work: [1],
        dispatches: [['continued']],
        job: {
          job_id: 'continued',
          status: 'running',
          progress: 1,
          total: 3,
          error: null,
          started_at: expect.any(String),
          finished_at: null,
        },
        leaseExpiresAt: null,
      });
    } finally {
      await close();
    }
  });

  it('keeps a continued chunk reclaimable when continuation dispatch rejects', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedBooks(db, 'user-a', [1, 2, 3]);
      await seedClaimedJob(db, {
        jobId: 'dispatch-failed',
        userId: 'user-a',
        progress: 0,
        total: 3,
        attempts: 1,
      });
      const result = await runClaimedChunk(db, claimed('dispatch-failed', 'user-a'), {
        nowMs: sequenceClock([0, 1, CHUNK_BUDGET_MS]),
        runOne: async (_db, bookId) => {
          await seedEnrichment(db, [bookId]);
        },
        dispatch: async () => {
          throw new Error('dispatch unavailable');
        },
      });
      const [row] = await db
        .select()
        .from(enrichJobs)
        .where(eq(enrichJobs.jobId, 'dispatch-failed'));

      expect({
        result,
        progress: row.progress,
        total: row.total,
        status: row.status,
        leaseExpiresAt: row.leaseExpiresAt,
      }).toEqual({
        result: {
          outcome: 'continued',
          progressBefore: 0,
          progressAfter: 1,
          remaining: 2,
          rearmed: false,
        },
        progress: 1,
        total: 3,
        status: 'running',
        leaseExpiresAt: null,
      });
    } finally {
      await close();
    }
  });

  it('continues repairing later active jobs when a middle dispatch rejects', async () => {
    const { db, close } = await makeTestDb();
    try {
      await db.insert(enrichJobs).values([
        { jobId: 'repair-first', userId: 'user-a', status: 'pending', progress: 0, total: 0 },
        { jobId: 'repair-middle', userId: 'user-b', status: 'pending', progress: 0, total: 0 },
        { jobId: 'repair-last', userId: 'user-c', status: 'pending', progress: 0, total: 0 },
      ]);
      const dispatch = vi.fn(async (jobId: string) => {
        if (jobId === 'repair-middle') throw new Error('dispatch unavailable');
      });

      const result = await repairActiveJobs(db, new Date('2026-08-11T12:00:00Z'), dispatch);

      expect({ result, dispatches: dispatch.mock.calls }).toEqual({
        result: { examined: 3, rearmed: 2, failed: 0, dispatchFailed: 1 },
        dispatches: [['repair-first'], ['repair-middle'], ['repair-last']],
      });
    } finally {
      await close();
    }
  });

  it('restricts candidates to bookIds only when the option is present', async () => {
    const { db, close } = await makeTestDb();
    try {
      await seedBooks(db, 'user-a', [1, 2, 3]);
      const resolver = async (_db: Db, book: { id: number }) => ({
        candidate: {
          source: 'googlebooks' as const,
          resolved_id: `book-${book.id}`,
          title: `Book ${book.id}`,
          author: 'Test Author',
          subjects: [],
          description: null,
          cover_url: null,
          year: null,
          language: null,
          raw: { id: book.id },
        },
        label: 'HIGH' as const,
        method: 'isbn:googlebooks' as const,
      });
      const restricted = await enrichLibrary(db, {
        userId: 'user-a',
        force: true,
        bookIds: [2],
        resolver,
      });
      const unrestricted = await enrichLibrary(db, { userId: 'user-a', force: true, resolver });
      expect({ restricted, unrestricted }).toEqual({
        restricted: summary(1, 0),
        unrestricted: summary(3, 0),
      });
    } finally {
      await close();
    }
  });
});

describe('enrichment dispatch', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'test-cron-secret');
  });

  afterEach(async () => {
    const { _setDispatchForTests } = await import('../enrichmentDispatch');
    _setDispatchForTests(null);
    vi.unstubAllEnvs();
  });

  it('rejects missing and mismatched internal bearer secrets without reading a user id', async () => {
    const { isValidCronSecret } = await import('../enrichmentDispatch');
    const requests = [
      new Request('https://app.test/api/enrich/tick'),
      new Request('https://app.test/api/enrich/tick', {
        headers: { authorization: 'Basic test-cron-secret' },
      }),
      new Request('https://app.test/api/enrich/tick', {
        headers: { authorization: 'Bearer wrong' },
      }),
      new Request('https://app.test/api/enrich/tick', {
        headers: { authorization: 'Bearer test-cron-secret-extra' },
      }),
    ];

    expect(requests.map(isValidCronSecret)).toEqual([false, false, false, false]);
  });

  it('accepts the exact internal bearer secret', async () => {
    const { isValidCronSecret } = await import('../enrichmentDispatch');
    const request = new Request('https://app.test/api/enrich/tick', {
      headers: { authorization: 'Bearer test-cron-secret' },
    });

    expect(isValidCronSecret(request)).toEqual(true);
  });

  it('treats an unset server secret as unauthorized rather than throwing', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const { isValidCronSecret } = await import('../enrichmentDispatch');
    const request = new Request('https://app.test/api/enrich/tick', {
      headers: { authorization: 'Bearer candidate-secret' },
    });

    expect(isValidCronSecret(request)).toEqual(false);
  });

  it('dispatches only job_id to the same-origin tick URL', async () => {
    const { _setDispatchForTests, rearmAfterResponse } = await import('../enrichmentDispatch');
    const callbacks: Array<() => void | Promise<void>> = [];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 })
    );
    _setDispatchForTests({
      schedule: (callback) => {
        callbacks.push(callback);
      },
      fetch: fetchMock,
    });

    rearmAfterResponse(new Request('https://app.test/enrich/start'), 'job-1');
    expect({ scheduled: callbacks.length, callsBeforeSchedule: fetchMock.mock.calls }).toEqual({
      scheduled: 1,
      callsBeforeSchedule: [],
    });
    await callbacks[0]?.();

    expect(
      fetchMock.mock.calls.map(([input, init]) => ({
        url: String(input),
        method: init?.method,
        body: init?.body,
        authorization: new Headers(init?.headers).get('authorization') ? 'present' : null,
      }))
    ).toEqual([
      {
        url: 'https://app.test/api/enrich/tick',
        method: 'POST',
        body: JSON.stringify({ job_id: 'job-1' }),
        authorization: 'present',
      },
    ]);
  });
});
