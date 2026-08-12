import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { eq } from 'drizzle-orm';
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
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function post(body: string | undefined, userId = 'user-a'): Promise<Response> {
  return POST(
    new Request('http://test/api/enrich/start', {
      method: 'POST',
      headers: await authHeaders(userId),
      body,
    })
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
  runClaimedChunkMock.mockReset();
  runClaimedChunkMock.mockImplementation(async (chunkDb: Db, job) => {
    await chunkDb
      .update(enrichJobs)
      .set({ status: 'running', progress: 1, total: 2 })
      .where(eq(enrichJobs.jobId, job.jobId));
    return {
      outcome: 'continued',
      progressBefore: 0,
      progressAfter: 1,
      remaining: 1,
      rearmed: true,
    };
  });
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

describe('POST /api/enrich/start', () => {
  it('creates one pending job, runs the first chunk inline, and returns the exact seven-field 200 response', async () => {
    const response = await post(JSON.stringify({ force: true, limit: 2 }));
    const rows = await db
      .select({
        jobId: enrichJobs.jobId,
        userId: enrichJobs.userId,
        status: enrichJobs.status,
        progress: enrichJobs.progress,
        total: enrichJobs.total,
        attempts: enrichJobs.attempts,
        leaseExpiresAt: enrichJobs.leaseExpiresAt,
        force: enrichJobs.force,
        runLimit: enrichJobs.runLimit,
      })
      .from(enrichJobs);

    expect({
      status: response.status,
      body: await response.json(),
      rows,
      chunkCalls: runClaimedChunkMock.mock.calls,
    }).toEqual({
      status: 200,
      body: {
        job_id: expect.any(String),
        status: 'running',
        progress: 1,
        total: 2,
        error: null,
        started_at: expect.any(String),
        finished_at: null,
      },
      rows: [
        {
          jobId: expect.any(String),
          userId: 'user-a',
          status: 'running',
          progress: 1,
          total: 2,
          attempts: 1,
          leaseExpiresAt: expect.any(String),
          force: true,
          runLimit: 2,
        },
      ],
      chunkCalls: [
        [expect.anything(), expect.objectContaining({ userId: 'user-a' }), expect.anything()],
      ],
    });
  });

  it('returns the existing active job with 200 and does not run another first chunk', async () => {
    await db.insert(enrichJobs).values({
      jobId: 'existing-job',
      userId: 'user-a',
      status: 'running',
      progress: 3,
      total: 7,
      startedAt: '2026-08-11 12:00:00',
      force: true,
      runLimit: 7,
    });
    const response = await post(JSON.stringify({ force: false, limit: null }));
    expect({
      status: response.status,
      body: await response.json(),
      calls: runClaimedChunkMock.mock.calls,
    }).toEqual({
      status: 200,
      body: {
        job_id: 'existing-job',
        status: 'running',
        progress: 3,
        total: 7,
        error: null,
        started_at: '2026-08-11T12:00:00',
        finished_at: null,
      },
      calls: [],
    });
  });

  it('returns the unique-race winner with 200', async () => {
    const [first, second] = await Promise.all([
      post(JSON.stringify({ force: false, limit: 2 })),
      post(JSON.stringify({ force: true, limit: 9 })),
    ]);
    const bodies = await Promise.all([first.json(), second.json()]);
    const rows = await db.select().from(enrichJobs);
    expect({
      statuses: [first.status, second.status],
      ids: bodies.map((body) => body.job_id),
      rowCount: rows.length,
      calls: runClaimedChunkMock.mock.calls.length,
    }).toEqual({
      statuses: [200, 200],
      ids: [expect.any(String), expect.any(String)],
      rowCount: 1,
      calls: 1,
    });
    expect(bodies[0].job_id).toBe(bodies[1].job_id);
  });

  it('requires a JSON body and validates force and nullable integer limit', async () => {
    const missing = await post(undefined);
    const force = await post(JSON.stringify({ force: 'yes' }));
    const limit = await post(JSON.stringify({ limit: 1.5 }));
    const nullable = await post(JSON.stringify({ limit: null, unknown: true }));
    expect({
      missing: { status: missing.status, body: await missing.json() },
      force: { status: force.status, body: await force.json() },
      limit: { status: limit.status, body: await limit.json() },
      nullable: { status: nullable.status, body: await nullable.json() },
    }).toEqual({
      missing: { status: 422, body: { detail: 'request body must be JSON' } },
      force: {
        status: 422,
        body: { detail: 'validation error: Invalid input: expected boolean, received string' },
      },
      limit: {
        status: 422,
        body: { detail: 'validation error: Invalid input: expected int, received number' },
      },
      nullable: {
        status: 200,
        body: {
          job_id: expect.any(String),
          status: 'running',
          progress: 1,
          total: 2,
          error: null,
          started_at: expect.any(String),
          finished_at: null,
        },
      },
    });
  });

  it('returns 401 without user authentication', async () => {
    const response = await POST(
      new Request('http://test/api/enrich/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect({
      status: response.status,
      body: await response.json(),
      rows: await db.select().from(enrichJobs),
      calls: runClaimedChunkMock.mock.calls,
    }).toEqual({
      status: 401,
      body: { detail: 'missing bearer token' },
      rows: [],
      calls: [],
    });
  });

  it('enforces RATE_LIMITS.enrichStart as five per minute per authenticated user', async () => {
    const responses: Response[] = [];
    for (let i = 0; i < 6; i++) responses.push(await post(JSON.stringify({})));
    expect({
      statuses: responses.map((response) => response.status),
      body: await responses[5].json(),
    }).toEqual({
      statuses: [200, 200, 200, 200, 200, 429],
      body: { error: 'Rate limit exceeded: 5 per 1 minute' },
    });
  });
});

import { POST } from './route';
