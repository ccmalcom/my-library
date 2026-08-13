import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { _setDbForTests, type Db } from '@/lib/server/db';

const { enrichLibraryMock } = vi.hoisted(() => ({
  enrichLibraryMock: vi.fn(),
}));

vi.mock('@/lib/server/enrichment', () => ({
  enrichLibrary: enrichLibraryMock,
}));

import { POST } from './route';

const summaryFixture = {
  total: 2,
  processed: 1,
  HIGH: 1,
  MEDIUM: 0,
  LOW: 0,
  unresolved: 0,
  skipped_existing: 1,
  http: {
    requests: 1,
    rate_limited: 0,
    server_errors: 0,
    network_errors: 0,
    retries: 0,
    by_host: { 'openlibrary.org': { requests: 1, rate_limited: 0 } },
  },
};

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
  enrichLibraryMock.mockReset();
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

describe('POST /api/enrich', () => {
  it('passes defaults and the authenticated user to synchronous enrichment', async () => {
    enrichLibraryMock.mockResolvedValue(summaryFixture);
    const response = await POST(
      new Request('http://test/api/enrich', {
        method: 'POST',
        headers: await authHeaders('user-a'),
        body: JSON.stringify({}),
      })
    );
    expect({
      status: response.status,
      body: await response.json(),
      calls: enrichLibraryMock.mock.calls,
    }).toEqual({
      status: 200,
      body: summaryFixture,
      calls: [
        [expect.anything(), { force: false, limit: null, includeUnrated: false, userId: 'user-a' }],
      ],
    });
  });

  it('passes force, nullable integer limit, and include_unrated with exact name mapping', async () => {
    enrichLibraryMock.mockResolvedValue(summaryFixture);
    const response = await POST(
      new Request('http://test/api/enrich', {
        method: 'POST',
        headers: await authHeaders('user-b'),
        body: JSON.stringify({ force: true, limit: -1, include_unrated: true }),
      })
    );
    expect({
      status: response.status,
      body: await response.json(),
      calls: enrichLibraryMock.mock.calls,
    }).toEqual({
      status: 200,
      body: summaryFixture,
      calls: [
        [expect.anything(), { force: true, limit: -1, includeUnrated: true, userId: 'user-b' }],
      ],
    });
  });

  it('rejects a missing JSON body with 422', async () => {
    const response = await POST(
      new Request('http://test/api/enrich', {
        method: 'POST',
        headers: await authHeaders('user-a'),
      })
    );
    expect({
      status: response.status,
      body: await response.json(),
      calls: enrichLibraryMock.mock.calls,
    }).toEqual({
      status: 422,
      body: { detail: 'request body must be JSON' },
      calls: [],
    });
  });

  it('rejects a fractional limit with 422', async () => {
    const response = await POST(
      new Request('http://test/api/enrich', {
        method: 'POST',
        headers: await authHeaders('user-a'),
        body: JSON.stringify({ limit: 1.5 }),
      })
    );
    expect({
      status: response.status,
      body: await response.json(),
      calls: enrichLibraryMock.mock.calls,
    }).toEqual({
      status: 422,
      body: { detail: 'validation error: Invalid input: expected int, received number' },
      calls: [],
    });
  });

  it('rejects Pydantic-coercible strings under the existing Node body convention', async () => {
    const limitResponse = await POST(
      new Request('http://test/api/enrich', {
        method: 'POST',
        headers: await authHeaders('user-a'),
        body: JSON.stringify({ limit: '3' }),
      })
    );
    const forceResponse = await POST(
      new Request('http://test/api/enrich', {
        method: 'POST',
        headers: await authHeaders('user-a'),
        body: JSON.stringify({ force: 'yes' }),
      })
    );
    expect({
      limit: { status: limitResponse.status, body: await limitResponse.json() },
      force: { status: forceResponse.status, body: await forceResponse.json() },
      calls: enrichLibraryMock.mock.calls,
    }).toEqual({
      limit: {
        status: 422,
        body: { detail: 'validation error: Invalid input: expected number, received string' },
      },
      force: {
        status: 422,
        body: { detail: 'validation error: Invalid input: expected boolean, received string' },
      },
      calls: [],
    });
  });

  it('ignores unknown request keys for Pydantic parity', async () => {
    enrichLibraryMock.mockResolvedValue(summaryFixture);
    const response = await POST(
      new Request('http://test/api/enrich', {
        method: 'POST',
        headers: await authHeaders('user-a'),
        body: JSON.stringify({ force: true, bogus: 1 }),
      })
    );
    expect({
      status: response.status,
      body: await response.json(),
      calls: enrichLibraryMock.mock.calls,
    }).toEqual({
      status: 200,
      body: summaryFixture,
      calls: [
        [expect.anything(), { force: true, limit: null, includeUnrated: false, userId: 'user-a' }],
      ],
    });
  });

  it('rejects an unauthenticated request with 401 without calling enrichment', async () => {
    const response = await POST(
      new Request('http://test/api/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    );
    expect({
      status: response.status,
      body: await response.json(),
      calls: enrichLibraryMock.mock.calls,
    }).toEqual({
      status: 401,
      body: { detail: 'missing bearer token' },
      calls: [],
    });
  });
});
