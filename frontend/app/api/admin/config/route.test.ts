import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTestDb } from '@/lib/server/__tests__/helpers/pglite';
import { _resetDebugCache } from '@/lib/server/config';
import { GET, PUT } from './route';
import { _setDbForTests, type Db } from '@/lib/server/db';

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await makeTestDb());
  _setDbForTests(db);
  _resetDebugCache();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  _setDbForTests(null);
  vi.restoreAllMocks();
  await close();
});

describe('/api/admin/config', () => {
  it('GET returns debug_mode false by default (local admin)', async () => {
    const res = await GET(new Request('http://x/api/admin/config'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ debug_mode: false });
  });

  it('PUT flips the flag and GET reflects it', async () => {
    const put = await PUT(
      new Request('http://x/api/admin/config', {
        method: 'PUT',
        body: JSON.stringify({ debug_mode: true }),
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ debug_mode: true });

    const get = await GET(new Request('http://x/api/admin/config'));
    expect(await get.json()).toEqual({ debug_mode: true });
  });

  it('PUT rejects a malformed body with 422', async () => {
    const res = await PUT(
      new Request('http://x/api/admin/config', {
        method: 'PUT',
        body: JSON.stringify({ debug_mode: 'yes please' }),
        headers: { 'Content-Type': 'application/json' },
      })
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(typeof body.detail).toBe('string');
  });
});
