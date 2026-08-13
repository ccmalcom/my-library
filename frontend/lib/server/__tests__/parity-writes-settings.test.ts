import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupParityEnv } from './helpers/parity';
import { runScenario } from './helpers/write-parity';
import { makeTestDb } from './helpers/pglite';
import { _setDbForTests } from '../db';
import { schema } from '../db';
import { decrypt } from '../crypto';
import { PUT as apiKeyPut } from '../../../app/api/settings/api-key/route';

describe('write parity: settings', () => {
  setupParityEnv();
  it('api-key', () => runScenario('api-key'));
  it('display-name', () => runScenario('display-name'));

  // The parity fixture can't assert the exact stored ciphertext (AES-256-GCM uses a
  // fresh random nonce per encryption, so two encryptions of the same plaintext never
  // match byte-for-byte) — this direct unit test proves the round trip instead: PUT a
  // key, read what actually landed in the DB, and confirm it decrypts back to the
  // plaintext we sent.
  it('encrypts on PUT such that the stored value decrypts back to the plaintext', async () => {
    const { db, close } = await makeTestDb();
    try {
      _setDbForTests(db);
      const res = await apiKeyPut(
        new Request('http://test/api/settings/api-key', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ api_key: 'sk-ant-roundtrip' }),
        })
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ configured: true });

      const rows = await db
        .select()
        .from(schema.userSettings)
        .where(eq(schema.userSettings.userId, 'local'));
      const stored = rows[0]?.anthropicApiKeyEncrypted;
      expect(stored).toBeTruthy();
      expect(decrypt(stored as string)).toBe('sk-ant-roundtrip');
    } finally {
      _setDbForTests(null);
      await close();
    }
  });
});
