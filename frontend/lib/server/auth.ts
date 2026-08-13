/**
 * Verify Supabase-issued ES256 JWTs and resolve the per-request user.
 * Mirrors mylibrary/auth.py + admin.py: audience "authenticated", 10s clock
 * tolerance, sub -> userId; with no Supabase configured the request is the
 * local single-user admin. The Python HS256 legacy fallback is not ported.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export const LOCAL_USER_ID = 'local';

export class AuthError extends Error {}

export interface AuthUser {
  userId: string;
  email: string | null;
  isAdmin: boolean;
}

/** Anything jwtVerify accepts as a key resolver (remote or local JWKS). */
export type JwksResolver = Parameters<typeof jwtVerify>[1];

function jwksUrl(): string | null {
  if (process.env.SUPABASE_JWKS_URL) return process.env.SUPABASE_JWKS_URL;
  const base = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  return base ? `${base.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json` : null;
}

export function authEnabled(): boolean {
  return jwksUrl() !== null;
}

function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isAdminEmail(email: string | null): boolean {
  return email !== null && adminEmails().has(email.trim().toLowerCase());
}

let remoteJwks: JwksResolver | null = null;
function defaultJwks(): JwksResolver {
  if (!remoteJwks) remoteJwks = createRemoteJWKSet(new URL(jwksUrl()!));
  return remoteJwks;
}

export async function verifyRequestUser(
  authorizationHeader: string | null,
  jwks?: JwksResolver
): Promise<AuthUser> {
  if (!authEnabled() && !jwks) {
    // Local single-user mode: same sentinel + implicit admin as the Python backend.
    return { userId: LOCAL_USER_ID, email: null, isAdmin: true };
  }

  if (!authorizationHeader || !authorizationHeader.toLowerCase().startsWith('bearer ')) {
    throw new AuthError('missing bearer token');
  }
  const token = authorizationHeader.slice('bearer '.length).trim();

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwks ?? defaultJwks(), {
      audience: 'authenticated',
      algorithms: ['ES256'],
      clockTolerance: 10,
    }));
  } catch (err) {
    throw new AuthError(`invalid token: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!payload.sub) throw new AuthError('token has no sub claim');
  const email = typeof payload.email === 'string' ? payload.email : null;
  return { userId: String(payload.sub), email, isAdmin: isAdminEmail(email) };
}
