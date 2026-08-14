import { describe, test, expect } from 'vitest';
import seedJson from './fixtures/seed.json';
import httpFixtures from './fixtures/claude/recommend-http.json';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { setupTestEnv } from './helpers/testEnv';
import { installHttpReplay } from './helpers/httpReplay';
import { _setDbForTests, schema } from '../db';
import { POST } from '@/app/api/books/[id]/similar/route';

const req = (id: string, body?: unknown) =>
  new Request(`http://test/api/books/${id}/similar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const call = (id: string, body?: unknown) =>
  POST(req(id, body), { params: Promise.resolve({ id }) });

describe('POST /api/books/[id]/similar', () => {
  setupTestEnv();

  test('mirrors FastAPI’s validation: 422 on a missing body and on n out of range', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      _setDbForTests(db);
      expect((await call('1')).status).toBe(422); // missing body
      expect((await call('1', { n: 0 })).status).toBe(422); // ge=1
      expect((await call('1', { n: 21 })).status).toBe(422); // le=20
      expect((await call('1', { n: 'x' })).status).toBe(422);
      expect((await call('abc', { n: 8 })).status).toBe(422); // non-integer path id
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('404s for a missing book and for another tenant’s book', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      _setDbForTests(db);
      const missing = await call('999', {});
      expect(missing.status).toBe(404);
      // No trailing period -- this is api.py's HTTPException detail, not
      // recommend_similar's RuntimeError text.
      expect((await missing.json()).detail).toBe('Book 999 not found');
      expect((await call('101', {})).status).toBe(404);
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('400s with the no-key message, after the metadata sweep', async () => {
    const { db, close } = await makeTestDb();
    // Book 1's metadata sweep issues 7 catalog requests before the key check (V8),
    // so the recorded fixture must be replayed or the test would hit the network.
    // seedPool never runs — requireClient() throws first.
    const restore = installHttpReplay(httpFixtures as any);
    try {
      await loadSeed(db, seedJson as any);
      // setupTestEnv clears the env key, but the SEED stores an encrypted per-user
      // key for 'local'. Without clearing it too, a real Anthropic client is built
      // and the run 500s on a live network call.
      await db.update(schema.userSettings).set({ anthropicApiKeyEncrypted: null });
      _setDbForTests(db);
      const res = await call('1', { n: 3 });
      expect(res.status).toBe(400);
      expect((await res.json()).detail).toContain('No Anthropic API key configured');
    } finally {
      restore();
      _setDbForTests(null);
      await close();
    }
  });
});
