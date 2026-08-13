import { describe, it, expect, vi, afterEach } from 'vitest';
import { withApi, ApiError, errorResponse } from '../http';

// Local mode in tests: no SUPABASE_* env vars are set (vitest env is clean of
// them unless the shell leaks them — the beforeEach in auth.test.ts pattern is
// unnecessary here because withApi only calls verifyRequestUser).

afterEach(() => vi.restoreAllMocks());

function silenceLogs() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
}

describe('errorResponse', () => {
  it('shapes the body like FastAPI', async () => {
    const res = errorResponse(409, 'already in your library');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: 'already in your library' });
  });
});

describe('withApi', () => {
  it('passes the local user to the handler and returns its response', async () => {
    silenceLogs();
    const handler = withApi('echo', async (_req, ctx) =>
      Response.json({ user: ctx.user.userId })
    );
    const res = await handler(new Request('http://x/api/echo'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: 'local' });
  });

  it('maps ApiError to its status and detail body', async () => {
    silenceLogs();
    const handler = withApi('boom', async () => {
      throw new ApiError(409, 'duplicate');
    });
    const res = await handler(new Request('http://x/api/boom'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: 'duplicate' });
  });

  it('maps unknown errors to a 500 with a generic body (no stack leak)', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = withApi('crash', async () => {
      throw new Error('secret internal detail');
    });
    const res = await handler(new Request('http://x/api/crash'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ detail: 'Internal Server Error' });
    const logged = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('secret internal detail'); // in logs...
  });

  it('logs one request line with route, status and userId', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const handler = withApi('ping', async () => Response.json({ ok: true }));
    await handler(new Request('http://x/api/ping', { method: 'GET' }));
    const lines = spy.mock.calls.map((c) => JSON.parse(String(c[0])));
    const reqLine = lines.find((l) => l.route === 'ping');
    expect(reqLine).toMatchObject({ level: 'info', method: 'GET', status: 200, userId: 'local' });
    expect(reqLine.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('requireAdmin passes for the local admin user', async () => {
    silenceLogs();
    const handler = withApi('adm', async () => Response.json({ ok: true }), {
      requireAdmin: true,
    });
    const res = await handler(new Request('http://x/api/adm'));
    expect(res.status).toBe(200);
  });
});
