/**
 * AES-256-GCM encryption for per-user Anthropic API keys at rest.
 * Byte-for-byte compatible with mylibrary/crypto.py: the stored token is
 * base64(nonce[12] || ciphertext || tag[16]) under the same ENCRYPTION_KEY,
 * so either backend can decrypt what the other wrote.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function loadKey(): Buffer {
  const b64 = process.env.ENCRYPTION_KEY;
  if (!b64) {
    throw new Error('ENCRYPTION_KEY is not set — required to encrypt/decrypt user API keys');
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256)');
  }
  return key;
}

function checkKey(key: Buffer): Buffer {
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256)');
  }
  return key;
}

export function encrypt(plaintext: string, key?: Buffer): string {
  const k = key ? checkKey(key) : loadKey();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', k, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString('base64');
}

export function decrypt(token: string, key?: Buffer): string {
  const k = key ? checkKey(key) : loadKey();
  const blob = Buffer.from(token, 'base64');
  const nonce = blob.subarray(0, NONCE_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ct = blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', k, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
