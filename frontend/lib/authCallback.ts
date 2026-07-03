// Decision logic for the /auth/callback landing page, extracted as a pure function so it can be
// unit-tested without a DOM or a live Supabase client.
//
// Supabase invite/recovery links deliver the session via the IMPLICIT grant: GoTrue's /verify
// endpoint redirects with the tokens in the URL hash (#access_token=...&refresh_token=...).
// @supabase/ssr hardcodes flowType: 'pkce', and auth-js's _getSessionFromURL throws
// "Not a valid PKCE flow url" on an implicit hash under PKCE — so the client will NOT auto-consume
// these tokens. The callback page parses them here and hands them to supabase.auth.setSession()
// itself (setSession ignores flowType). See app/auth/callback/page.tsx.

export type AuthCallbackHash =
  | { kind: 'error'; message: string }
  | { kind: 'tokens'; accessToken: string; refreshToken: string }
  | { kind: 'none' };

/**
 * Classify a URL hash fragment from a Supabase auth redirect.
 * - `error`  — the link was reused/expired (carries `error_description`); takes precedence.
 * - `tokens` — a usable implicit-grant session (needs BOTH access_token and refresh_token).
 * - `none`   — nothing actionable in the hash (fall back to any existing session).
 */
export function parseAuthCallbackHash(hash: string): AuthCallbackHash {
  const clean = hash.startsWith('#') ? hash.slice(1) : hash;
  const params = new URLSearchParams(clean);

  const errorDescription = params.get('error_description');
  if (errorDescription) {
    // URLSearchParams already turns '+' into spaces; the replace is belt-and-suspenders.
    return { kind: 'error', message: errorDescription.replace(/\+/g, ' ') };
  }

  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (accessToken && refreshToken) {
    return { kind: 'tokens', accessToken, refreshToken };
  }

  return { kind: 'none' };
}
