import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decrypt, encrypt } from '../crypto';

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures', 'crypto.json'), 'utf8')
) as { key_b64: string; plaintext: string; token: string };
const key = Buffer.from(fixture.key_b64, 'base64');

describe('crypto', () => {
  it('decrypts a token produced by the Python implementation', () => {
    expect(decrypt(fixture.token, key)).toBe(fixture.plaintext);
  });

  it('round-trips encrypt -> decrypt', () => {
    const token = encrypt('another-secret', key);
    expect(decrypt(token, key)).toBe('another-secret');
    expect(token).not.toBe(encrypt('another-secret', key)); // fresh nonce each call
  });

  it('throws on a tampered token', () => {
    const blob = Buffer.from(fixture.token, 'base64');
    blob[blob.length - 1] ^= 0xff; // flip a tag bit
    expect(() => decrypt(blob.toString('base64'), key)).toThrow();
  });

  it('throws when ENCRYPTION_KEY is missing and no key is passed', () => {
    const saved = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      expect(() => decrypt(fixture.token)).toThrow(/ENCRYPTION_KEY/);
    } finally {
      if (saved !== undefined) process.env.ENCRYPTION_KEY = saved;
    }
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => encrypt('x', Buffer.from('too-short'))).toThrow(/32 bytes/);
  });
});
