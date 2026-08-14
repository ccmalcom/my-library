import { describe, test, expect } from 'vitest';
import { makeTestDb, loadSeed } from './helpers/pglite';
import seedJson from './fixtures/seed.json';
import { setupTestEnv } from './helpers/testEnv';
import { _setDbForTests } from '../db';
import { schema } from '../db';
import { POST } from '@/app/api/recommend/route';

const req = (body?: unknown) =>
  new Request('http://test/api/recommend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('POST /api/recommend', () => {
  setupTestEnv();

  test('422s on a missing body and on a non-integer n, like FastAPI', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      expect((await POST(req())).status).toBe(422);
      expect((await POST(req({ n: 'x' }))).status).toBe(422);
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('400s (not 422) on an empty body, because every field has a default', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      const res = await POST(req({}));
      expect(res.status).toBe(400);
      expect((await res.json()).detail).toContain('No loved books found');
    } finally {
      _setDbForTests(null);
      await close();
    }
  });

  test('400s with the no-key message when no API key is configured', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, seedJson as any);
      await db.update(schema.profileMeta).set({ lastProfiledAt: '2026-08-01 00:00:00' });
      // setupTestEnv clears the env key, but the SEED stores an encrypted per-user
      // key for 'local'. Without clearing it too, resolveAnthropicKey succeeds, a real
      // Anthropic client is built, and the run 500s on a live network call.
      await db.update(schema.userSettings).set({ anthropicApiKeyEncrypted: null });
      _setDbForTests(db);
      // use_metadata:false skips catalog retrieval, so this reaches the Claude stage
      // (and its key check) without a single HTTP request. Hermetic and fast.
      const res = await POST(req({ n: 3, use_metadata: false }));
      expect(res.status).toBe(400);
      expect((await res.json()).detail).toContain('No Anthropic API key configured');
    } finally {
      _setDbForTests(null);
      await close();
    }
  });
});
