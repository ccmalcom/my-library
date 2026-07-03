// Supabase invite / password-recovery links are supposed to land on /auth/callback, which
// consumes the session tokens from the URL hash and prompts for a password. But if GoTrue
// falls back to the project Site URL (bare app root) — because the backend's redirect_to was
// unset or not on the Redirect-URLs allowlist — the tokens arrive in the hash at `/`, which
// middleware bounces to /login (the fragment survives the 302). /login can't consume them.
//
// This detects such an auth hash and returns the /auth/callback URL (hash preserved) to
// forward to, so onboarding completes regardless of the Supabase redirect config.

/**
 * Given a URL hash (with or without the leading '#'), return the /auth/callback URL to forward
 * to when it carries Supabase invite/recovery session tokens or an auth error, else null.
 */
export function inviteCallbackRedirect(hash: string): string | null {
  const clean = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!clean) return null;
  const params = new URLSearchParams(clean);
  const type = params.get('type');
  const isAuthHash =
    params.has('access_token') ||
    type === 'invite' ||
    type === 'recovery' ||
    params.has('error_description'); // expired/invalid link — let the callback page render it
  return isAuthHash ? `/auth/callback#${clean}` : null;
}
