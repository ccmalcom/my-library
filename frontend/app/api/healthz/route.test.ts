import { describe, it, expect, vi } from 'vitest';
import { GET } from './route';

describe('GET /api/healthz', () => {
  it('returns ok without auth or a database', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await GET(new Request('http://x/api/healthz'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', backend: 'node' });
  });
});
