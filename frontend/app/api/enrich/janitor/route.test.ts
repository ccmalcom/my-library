import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { INTERRUPTED_MESSAGE } from '@/lib/server/enrichmentJobs';
import { enrichJobs } from '@/lib/server/schema';

const { dispatchMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
}));

vi.mock('@/lib/server/enrichmentDispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/enrichmentDispatch')>()),
  rearmAfterResponse: dispatchMock,
}));

import { GET } from './route';

let db: Db;
let close: () => Promise<void>;

function janitorRequest(authorization?: string): Request {
  return new Request('http://test/api/enrich/janitor', {
    headers: authorization ? { authorization } : undefined,
  });
}

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  vi.stubEnv('CRON_SECRET', 'test-cron-secret');
  dispatchMock.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  _setDbForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await close();
});

describe('GET /api/enrich/janitor', () => {
  it('returns 401 without the secret and performs no query', async () => {
    const selectSpy = vi.spyOn(db, 'select');
    const response = await GET(janitorRequest());
    expect({
      status: response.status,
      body: await response.json(),
      selectCalls: selectSpy.mock.calls,
      dispatched: dispatchMock.mock.calls,
    }).toEqual({
      status: 401,
      body: { detail: 'Unauthorized' },
      selectCalls: [],
      dispatched: [],
    });
  });

  it('returns 200 with the secret and re-arms each expired non-stale active job', async () => {
    const now = Date.now();
    await db.insert(enrichJobs).values([
      {
        jobId: 'expired-pending-job',
        progress: 0,
        total: 0,
        userId: 'owner-a',
        status: 'pending',
        leaseExpiresAt: new Date(now - 60_000).toISOString(),
      },
      {
        jobId: 'expired-running-job',
        progress: 0,
        total: 0,
        userId: 'owner-b',
        status: 'running',
        startedAt: new Date(now - 60_000).toISOString(),
        leaseExpiresAt: null,
      },
      {
        jobId: 'fresh-job',
        progress: 0,
        total: 0,
        userId: 'owner-c',
        status: 'running',
        startedAt: new Date(now - 60_000).toISOString(),
        leaseExpiresAt: new Date(now + 60_000).toISOString(),
      },
    ]);

    const response = await GET(janitorRequest('Bearer test-cron-secret'));
    expect({
      status: response.status,
      body: await response.json(),
      dispatched: dispatchMock.mock.calls.map(([, id]) => id),
    }).toEqual({
      status: 200,
      body: { examined: 3, rearmed: 2, failed: 0 },
      dispatched: ['expired-pending-job', 'expired-running-job'],
    });
  });

  it('fails stale active jobs instead of re-arming them', async () => {
    const now = Date.now();
    await db.insert(enrichJobs).values([
      {
        jobId: 'fresh-job',
        progress: 0,
        total: 0,
        userId: 'owner-fresh',
        status: 'running',
        startedAt: new Date(now - 60_000).toISOString(),
        leaseExpiresAt: new Date(now + 60_000).toISOString(),
      },
      {
        jobId: 'expired-job',
        progress: 0,
        total: 0,
        userId: 'owner-expired',
        status: 'running',
        startedAt: new Date(now - 60_000).toISOString(),
        leaseExpiresAt: new Date(now - 60_000).toISOString(),
      },
      {
        jobId: 'stale-job',
        progress: 0,
        total: 0,
        userId: 'owner-stale',
        status: 'running',
        startedAt: new Date(now - 1_801_000).toISOString(),
        leaseExpiresAt: new Date(now - 60_000).toISOString(),
      },
      { jobId: 'done-job', progress: 0, total: 0, userId: 'owner-done', status: 'done' },
      { jobId: 'error-job', progress: 0, total: 0, userId: 'owner-error', status: 'error' },
    ]);

    const response = await GET(janitorRequest('Bearer test-cron-secret'));
    const rows = await db.select().from(enrichJobs).orderBy(enrichJobs.id);
    expect({
      status: response.status,
      body: await response.json(),
      dispatched: dispatchMock.mock.calls.map(([, id]) => id),
    }).toEqual({
      status: 200,
      body: { examined: 3, rearmed: 1, failed: 1 },
      dispatched: ['expired-job'],
    });
    expect(rows.map((row) => ({ jobId: row.jobId, status: row.status, error: row.error }))).toEqual(
      [
        { jobId: 'fresh-job', status: 'running', error: null },
        { jobId: 'expired-job', status: 'running', error: null },
        { jobId: 'stale-job', status: 'error', error: INTERRUPTED_MESSAGE },
        { jobId: 'done-job', status: 'done', error: null },
        { jobId: 'error-job', status: 'error', error: null },
      ]
    );
  });
});
