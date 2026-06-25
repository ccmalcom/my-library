import { createBrowserClient } from "@supabase/ssr";

// Supabase is used for AUTH ONLY in this app: it provides the session + access token, which
// lib/api.ts forwards to the FastAPI backend as `Authorization: Bearer`. We never query
// Supabase tables from the browser (the backend owns the data).

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/**
 * Whether Supabase auth is configured. False in local dev (no env vars) — in that case the
 * app runs unauthenticated and the backend serves the single "local" user, exactly as before.
 */
export const authEnabled = Boolean(url && key);

let _client: ReturnType<typeof createBrowserClient> | null = null;

/** Singleton browser Supabase client. Returns null when auth isn't configured (local mode). */
export function getSupabaseClient() {
  if (!authEnabled) return null;
  if (!_client) _client = createBrowserClient(url!, key!);
  return _client;
}
