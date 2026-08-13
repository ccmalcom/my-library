import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestDb, loadSeed } from './helpers/pglite';
import { resolveAnthropicKey } from '../claude';
import { encrypt } from '../crypto';

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.ANTHROPIC_API_KEY;
  process.env.ENCRYPTION_KEY = KEY;
});
afterEach(() => {
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
});

describe('resolveAnthropicKey', () => {
  it('prefers the stored decrypted key', async () => {
    const { db, close } = await makeTestDb();
    try {
      await loadSeed(db, {
        user_settings: [
          { id: 1, user_id: 'local', anthropic_api_key_encrypted: encrypt('sk-ant-stored') },
        ],
      });
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
      expect(await resolveAnthropicKey(db, 'local')).toBe('sk-ant-stored');
    } finally {
      await close();
    }
  });

  it('falls back to the env key when no row is stored', async () => {
    const { db, close } = await makeTestDb();
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
      expect(await resolveAnthropicKey(db, 'local')).toBe('sk-ant-env');
    } finally {
      await close();
    }
  });

  it('returns null for an empty env key (Python `if not api_key` semantics)', async () => {
    const { db, close } = await makeTestDb();
    try {
      process.env.ANTHROPIC_API_KEY = '';
      expect(await resolveAnthropicKey(db, 'local')).toBe(null);
    } finally {
      await close();
    }
  });

  it('falls back to env key when stored key fails to decrypt', async () => {
    const { db, close } = await makeTestDb();
    try {
      // Seed an invalid encrypted value (garbage that will fail to decrypt)
      await loadSeed(db, {
        user_settings: [
          { id: 1, user_id: 'local', anthropic_api_key_encrypted: 'not-valid-base64!!!invalid' },
        ],
      });
      process.env.ANTHROPIC_API_KEY = 'sk-ant-fallback';
      // Should catch the decrypt error and fall through to env var
      expect(await resolveAnthropicKey(db, 'local')).toBe('sk-ant-fallback');
    } finally {
      await close();
    }
  });
});
