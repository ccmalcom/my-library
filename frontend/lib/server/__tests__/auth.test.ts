import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import { verifyRequestUser, AuthError, LOCAL_USER_ID, isAdminEmail } from '../auth';

const ENV_KEYS = ['SUPABASE_JWKS_URL', 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'ADMIN_EMAILS'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function makeJwksAndToken(claims: Record<string, unknown>, opts: { expired?: boolean } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuedAt(opts.expired ? now - 7200 : now)
    .setExpirationTime(opts.expired ? now - 3600 : now + 3600)
    .setAudience('authenticated')
    .sign(privateKey);
  return { jwks, token };
}

describe('auth', () => {
  it('local mode: no Supabase configured -> local admin user', async () => {
    const user = await verifyRequestUser(null);
    expect(user).toEqual({ userId: LOCAL_USER_ID, email: null, isAdmin: true });
  });

  it('verifies a valid ES256 token and extracts sub + email', async () => {
    process.env.ADMIN_EMAILS = 'chase@example.com';
    const { jwks, token } = await makeJwksAndToken({ sub: 'user-123', email: 'reader@example.com' });
    const user = await verifyRequestUser(`Bearer ${token}`, jwks);
    expect(user).toEqual({ userId: 'user-123', email: 'reader@example.com', isAdmin: false });
  });

  it('flags admin emails case-insensitively', async () => {
    process.env.ADMIN_EMAILS = 'Chase@Example.com, other@example.com';
    const { jwks, token } = await makeJwksAndToken({ sub: 'u1', email: 'chase@example.com' });
    const user = await verifyRequestUser(`Bearer ${token}`, jwks);
    expect(user.isAdmin).toBe(true);
    expect(isAdminEmail('OTHER@example.com')).toBe(true);
    expect(isAdminEmail(null)).toBe(false);
  });

  it('rejects a missing bearer header when a jwks is in play', async () => {
    const { jwks } = await makeJwksAndToken({ sub: 'u1' });
    await expect(verifyRequestUser(null, jwks)).rejects.toBeInstanceOf(AuthError);
    await expect(verifyRequestUser('Token abc', jwks)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects an expired token', async () => {
    const { jwks, token } = await makeJwksAndToken({ sub: 'u1' }, { expired: true });
    await expect(verifyRequestUser(`Bearer ${token}`, jwks)).rejects.toThrow(/invalid token/);
  });

  it('rejects a token with the wrong audience', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'k';
    const jwks = createLocalJWKSet({ keys: [jwk] });
    const token = await new SignJWT({ sub: 'u1' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setAudience('somewhere-else')
      .sign(privateKey);
    await expect(verifyRequestUser(`Bearer ${token}`, jwks)).rejects.toThrow(/invalid token/);
  });

  it('rejects a token without sub', async () => {
    const { jwks, token } = await makeJwksAndToken({ email: 'x@example.com' });
    await expect(verifyRequestUser(`Bearer ${token}`, jwks)).rejects.toThrow(/no sub claim/);
  });
});
