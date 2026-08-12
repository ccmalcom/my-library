import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, type Db } from '@/lib/server/db';
import { enrichJobs } from '@/lib/server/schema';

const { runClaimedChunkMock } = vi.hoisted(() => ({
  runClaimedChunkMock: vi.fn(),
}));

vi.mock('@/lib/server/enrichmentJobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/enrichmentJobs')>()),
  runClaimedChunk: runClaimedChunkMock,
}));

import { POST } from './route';

let db: Db;
let close: () => Promise<void>;

function secretRequest(path: string, body: unknown): Request {
  return new Request(`http://test${path}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-cron-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  vi.stubEnv('CRON_SECRET', 'test-cron-secret');
  runClaimedChunkMock.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  _setDbForTests(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await close();
});

describe('POST /api/enrich/tick', () => {
  it.each([
    ['missing', undefined],
    ['wrong', 'Bearer wrong-secret'],
  ])('returns 401 for %s secret without claiming work', async (_label, authorization) => {
    const headers = authorization
      ? { authorization, 'content-type': 'application/json' }
      : { 'content-type': 'application/json' };
    const response = await POST(
      new Request('http://test/api/enrich/tick', {
        method: 'POST',
        headers,
        body: JSON.stringify({ job_id: 'job-1' }),
      })
    );
    expect({
      status: response.status,
      body: await response.json(),
      calls: runClaimedChunkMock.mock.calls,
    }).toEqual({
      status: 401,
      body: { detail: 'Unauthorized' },
      calls: [],
    });
  });

  it('returns 200 with the secret, claims by job_id, and resolves ownership from the row', async () => {
    await db.insert(enrichJobs).values({
      jobId: 'job-1',
      progress: 0,
      total: 0,
      userId: 'owner-from-row',
      status: 'pending',
    });
    runClaimedChunkMock.mockResolvedValue({
      outcome: 'done',
      progressBefore: 0,
      progressAfter: 1,
      remaining: 0,
      rearmed: false,
    });
    const response = await POST(secretRequest('/api/enrich/tick', { job_id: 'job-1' }));
    expect({
      status: response.status,
      body: await response.json(),
      calls: runClaimedChunkMock.mock.calls,
    }).toEqual({
      status: 200,
      body: { claimed: true, outcome: 'done' },
      calls: [
        [
          expect.anything(),
          expect.objectContaining({ jobId: 'job-1', userId: 'owner-from-row' }),
          expect.anything(),
        ],
      ],
    });
  });

  it('returns 200 claimed false when the conditional claim returns no row', async () => {
    const response = await POST(secretRequest('/api/enrich/tick', { job_id: 'missing-job' }));
    expect({
      status: response.status,
      body: await response.json(),
      calls: runClaimedChunkMock.mock.calls,
    }).toEqual({
      status: 200,
      body: { claimed: false },
      calls: [],
    });
  });

  it('rejects a caller-supplied user_id with 422', async () => {
    await db
      .insert(enrichJobs)
      .values({ jobId: 'job-1', progress: 0, total: 0, userId: 'owner', status: 'pending' });
    const response = await POST(
      secretRequest('/api/enrich/tick', { job_id: 'job-1', user_id: 'caller-supplied' })
    );
    const rows = await db.select().from(enrichJobs);
    expect({
      status: response.status,
      body: await response.json(),
      rows: rows.map((row) => ({
        jobId: row.jobId,
        userId: row.userId,
        status: row.status,
        attempts: row.attempts,
      })),
      calls: runClaimedChunkMock.mock.calls,
    }).toEqual({
      status: 422,
      body: { detail: 'validation error: Unrecognized key: "user_id"' },
      rows: [{ jobId: 'job-1', userId: 'owner', status: 'pending', attempts: 0 }],
      calls: [],
    });
  });
});
