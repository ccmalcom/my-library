import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { eq } from 'drizzle-orm';
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
let privateKey: KeyLike;
let jwksBody: string;
const oldJwksUrl = process.env.SUPABASE_JWKS_URL;

async function authHeaders(userId: string): Promise<HeadersInit> {
  const token = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'ES256', kid: 'route-test-key' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .setAudience('authenticated')
    .sign(privateKey);
  return { Authorization: `Bearer ${token}` };
}

async function get(jobId: string, userId = 'user-a'): Promise<Response> {
  return GET(
    new Request(`http://test/api/enrich/status/${jobId}`, { headers: await authHeaders(userId) }),
    {
      params: Promise.resolve({ job_id: jobId }),
    }
  );
}

beforeAll(async () => {
  const keys = await generateKeyPair('ES256');
  privateKey = keys.privateKey;
  const publicJwk = await exportJWK(keys.publicKey);
  publicJwk.kid = 'route-test-key';
  jwksBody = JSON.stringify({ keys: [publicJwk] });
  process.env.SUPABASE_JWKS_URL = 'https://auth.test/.well-known/jwks.json';
});

afterAll(() => {
  if (oldJwksUrl === undefined) delete process.env.SUPABASE_JWKS_URL;
  else process.env.SUPABASE_JWKS_URL = oldJwksUrl;
});

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  dispatchMock.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(jwksBody, { headers: { 'Content-Type': 'application/json' } })
  );
});

afterEach(async () => {
  _setDbForTests(null);
  vi.restoreAllMocks();
  await close();
});

describe('GET /api/enrich/status/[job_id]', () => {
  it('returns the exact seven-field job for its authenticated owner', async () => {
    await db.insert(enrichJobs).values({
      jobId: 'owned',
      userId: 'user-a',
      status: 'done',
      progress: 3,
      total: 3,
      startedAt: '2026-08-11 12:00:00',
      finishedAt: '2026-08-11 12:01:00',
      leaseExpiresAt: '2026-08-11 12:05:00',
      attempts: 2,
      force: true,
      runLimit: 3,
    });
    const response = await get('owned');
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: {
        job_id: 'owned',
        status: 'done',
        progress: 3,
        total: 3,
        error: null,
        started_at: '2026-08-11T12:00:00',
        finished_at: '2026-08-11T12:01:00',
      },
    });
  });

  it('returns the same quoted-id 404 for missing and foreign jobs', async () => {
    await db
      .insert(enrichJobs)
      .values({ jobId: 'hidden', progress: 0, total: 0, userId: 'user-b', status: 'done' });
    const foreign = await get('hidden');
    const foreignResult = { status: foreign.status, body: await foreign.json() };
    await db.delete(enrichJobs).where(eq(enrichJobs.jobId, 'hidden'));
    const missing = await get('hidden');
    const missingResult = { status: missing.status, body: await missing.json() };
    expect({ foreign: foreignResult, missing: missingResult }).toEqual({
      foreign: { status: 404, body: { detail: "Job 'hidden' not found" } },
      missing: { status: 404, body: { detail: "Job 'hidden' not found" } },
    });
    expect(foreignResult).toEqual(missingResult);
  });

  it('fails a running job older than STALE_JOB_SECONDS', async () => {
    await db.insert(enrichJobs).values({
      jobId: 'stale',
      userId: 'user-a',
      status: 'running',
      progress: 1,
      total: 3,
      startedAt: '2000-01-01 00:00:00',
      leaseExpiresAt: '2999-01-01 00:00:00',
    });
    const response = await get('stale');
    const [persisted] = await db.select().from(enrichJobs).where(eq(enrichJobs.jobId, 'stale'));
    expect({
      status: response.status,
      body: await response.json(),
      persisted: {
        status: persisted?.status,
        error: persisted?.error,
        finishedAt: persisted?.finishedAt,
        leaseExpiresAt: persisted?.leaseExpiresAt,
      },
      dispatches: dispatchMock.mock.calls,
    }).toEqual({
      status: 200,
      body: {
        job_id: 'stale',
        status: 'error',
        progress: 1,
        total: 3,
        error: INTERRUPTED_MESSAGE,
        started_at: '2000-01-01T00:00:00',
        finished_at: expect.any(String),
      },
      persisted: {
        status: 'error',
        error: INTERRUPTED_MESSAGE,
        finishedAt: expect.any(String),
        leaseExpiresAt: null,
      },
      dispatches: [],
    });
  });

  it('re-arms a running job whose lease expired', async () => {
    await db.insert(enrichJobs).values({
      jobId: 'expired',
      userId: 'user-a',
      status: 'running',
      progress: 1,
      total: 3,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const response = await get('expired');
    expect({
      status: response.status,
      body: await response.json(),
      dispatches: dispatchMock.mock.calls,
    }).toEqual({
      status: 200,
      body: {
        job_id: 'expired',
        status: 'running',
        progress: 1,
        total: 3,
        error: null,
        started_at: expect.any(String),
        finished_at: null,
      },
      dispatches: [[expect.any(Request), 'expired']],
    });
  });

  it('does not re-arm a running job whose lease is still fresh', async () => {
    await db.insert(enrichJobs).values({
      jobId: 'fresh',
      userId: 'user-a',
      status: 'running',
      progress: 1,
      total: 3,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const response = await get('fresh');
    expect({
      status: response.status,
      body: await response.json(),
      dispatches: dispatchMock.mock.calls,
    }).toEqual({
      status: 200,
      body: {
        job_id: 'fresh',
        status: 'running',
        progress: 1,
        total: 3,
        error: null,
        started_at: expect.any(String),
        finished_at: null,
      },
      dispatches: [],
    });
  });

  it('does not re-arm or fail a terminal job', async () => {
    await db.insert(enrichJobs).values([
      {
        jobId: 'done',
        progress: 0,
        total: 0,
        userId: 'user-a',
        status: 'done',
        startedAt: '2000-01-01 00:00:00',
      },
      {
        jobId: 'error',
        progress: 0,
        total: 0,
        userId: 'user-a',
        status: 'error',
        error: 'original',
        startedAt: '2000-01-01 00:00:00',
      },
    ]);
    const doneResponse = await get('done');
    const errorResponse = await get('error');
    const rows = await db.select().from(enrichJobs);
    expect({
      responses: [
        { status: doneResponse.status, body: await doneResponse.json() },
        { status: errorResponse.status, body: await errorResponse.json() },
      ],
      rows: rows.map((row) => ({
        jobId: row.jobId,
        status: row.status,
        error: row.error,
        finishedAt: row.finishedAt,
      })),
      dispatches: dispatchMock.mock.calls,
    }).toEqual({
      responses: [
        {
          status: 200,
          body: {
            job_id: 'done',
            status: 'done',
            progress: 0,
            total: 0,
            error: null,
            started_at: '2000-01-01T00:00:00',
            finished_at: null,
          },
        },
        {
          status: 200,
          body: {
            job_id: 'error',
            status: 'error',
            progress: 0,
            total: 0,
            error: 'original',
            started_at: '2000-01-01T00:00:00',
            finished_at: null,
          },
        },
      ],
      rows: [
        { jobId: 'done', status: 'done', error: null, finishedAt: null },
        { jobId: 'error', status: 'error', error: 'original', finishedAt: null },
      ],
      dispatches: [],
    });
  });
});
