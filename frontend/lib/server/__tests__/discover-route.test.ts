import { describe, test, expect } from 'vitest';
import seedJson from './fixtures/parity/seed.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupParityEnv } from './helpers/parity';
import { installHttpReplay } from './helpers/httpReplay';
import { _setDbForTests, schema } from '../db';
import { POST } from '@/app/api/discover/route';

const req = (body?: unknown) =>
  new Request('http://test/api/discover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('POST /api/discover', () => {
  setupParityEnv();

  test('mirrors FastAPI’s validation on query and n', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      _setDbForTests(db);
      expect((await POST(req())).status).toBe(422); // missing body
      expect((await POST(req({}))).status).toBe(422); // query is required
      expect((await POST(req({ query: '' }))).status).toBe(422); // min_length 1
      expect((await POST(req({ query: 'x'.repeat(501) }))).status).toBe(422); // max_length 500
      expect((await POST(req({ query: 'q', n: 0 }))).status).toBe(422); // ge 1
      expect((await POST(req({ query: 'q', n: 21 }))).status).toBe(422); // le 20
      expect((await POST(req({ query: 'q', n: 'x' }))).status).toBe(422);
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('400s (not 422) on a whitespace-only query, like Python', async () => {
    // Pydantic's min_length=1 is satisfied by "   "; discover() then strips it and
    // raises RuntimeError, which api.py maps to a 400.
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      await db.update(schema.userSettings).set({ anthropicApiKeyEncrypted: null });
      _setDbForTests(db);
      const res = await POST(req({ query: '   ' }));
      expect(res.status).toBe(400);
      expect((await res.json()).detail).toBe('Enter something to search for.');
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('400s with the no-key message, without touching the catalog', async () => {
    const { db, close } = await makeTestDb();
    const seen: string[] = [];
    const restore = installHttpReplay({}, (u) => seen.push(u));
    try {
      await loadSeed(db, seedJson as any);
      // setupParityEnv clears the env key, but the SEED stores an encrypted per-user
      // key for 'local'. Without clearing it too, a real Anthropic client is built
      // and the run 500s on a live network call.
      await db.update(schema.userSettings).set({ anthropicApiKeyEncrypted: null });
      _setDbForTests(db);
      const res = await POST(req({ query: 'gentle fantasy', n: 5 }));
      expect(res.status).toBe(400);
      expect((await res.json()).detail).toContain('No Anthropic API key configured');
      expect(seen).toEqual([]);
    } finally {
      restore();
      _setDbForTests(null);
      await close();
    }
  });
});
