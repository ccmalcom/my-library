/**
 * Port of mylibrary/supabase_admin.py — the GoTrue admin client.
 *
 * Reads `SUPABASE_SECRET_KEY` — named for Supabase's current terminology, pairing with the
 * client-side `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. It accepts EITHER an opaque secret key
 * (`sb_secret_...`) or a legacy `service_role` JWT; see the header comment in baseAndHeaders
 * for why both work. NOTE: Python still reads the OLD `SUPABASE_SERVICE_ROLE_KEY` name from its
 * own env file. The two are independent and both can be set; Python's admin routes are dead now
 * that the switcher points /admin/* at Node, and wave 5b deletes them.
 *
 * It must never reach the browser (a secret key is rejected with 401 there anyway, matched on
 * User-Agent) and is only present in Vercel's Production environment. Network failures and
 * non-2xx responses raise SupabaseAdminError; the secret never appears in error text, and
 * arbitrary response bodies are never echoed (they may contain PII).
 *
 * The transport is injected so tests never touch the network.
 */

export class SupabaseAdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupabaseAdminError';
  }
}

export type GoTrueFetch = (url: string, init: RequestInit) => Promise<Response>;

interface BaseAndHeaders {
  base: string;
  headers: Record<string, string>;
}

function baseAndHeaders(): BaseAndHeaders {
  // Same precedence as auth.ts::jwksUrl, which resolves
  // `SUPABASE_URL ?? NEXT_PUBLIC_SUPABASE_URL`. Without the fallback this module is the only
  // one that insists on the bare name, so a deployment carrying just the NEXT_PUBLIC_ variant
  // authenticates fine and then fails every admin write — which is exactly what happened on
  // first live use. The project URL is not a secret; only the key is.
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    // Name the variable that is actually missing. The old message listed both regardless,
    // so a misconfiguration could not be diagnosed from the 502 alone.
    const missing = [
      !url ? 'SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)' : null,
      !key ? 'SUPABASE_SECRET_KEY' : null,
    ]
      .filter(Boolean)
      .join(' + ');
    throw new SupabaseAdminError(`Supabase admin not configured (missing ${missing}).`);
  }
  return {
    base: `${url.replace(/\/+$/, '')}/auth/v1`,
    headers: {
      // DELIBERATE DIVERGENCE FROM PYTHON. `supabase_admin.py::_base_and_headers` sends the key
      // on BOTH `Authorization: Bearer <key>` and `apikey`. That only works for the legacy
      // `service_role` key, which is a JWT. Supabase's newer secret keys (`sb_secret_...`) are
      // opaque, not JWTs, and Supabase documents that passing them on Authorization makes the
      // platform try to parse them as a JWT and reject the request.
      //
      // Sending `apikey` alone is correct for BOTH key types: the gateway translates an opaque
      // key to its internal JWT and then synthesizes `Authorization: Bearer <apikey>` itself
      // whenever the client did not supply a real JWT. A legacy key passes through the same path
      // unchanged. So this is strictly more compatible than Python, not a behavior loss, and it
      // is why the header is omitted rather than made conditional on the key's shape.
      //
      // Python is intentionally NOT updated to match: wave 5a's Global Constraint 1 makes
      // `mylibrary/` read-only, the switcher now routes /admin/* to Node, and wave 5b deletes
      // the Python HTTP layer. Should Python ever serve these routes again, it needs this fix.
      apikey: key,
      'Content-Type': 'application/json',
    },
  };
}

async function request(
  method: string,
  path: string,
  body: unknown,
  fetchImpl: GoTrueFetch
): Promise<Response> {
  const { base, headers } = baseAndHeaders();
  const url = base + path;
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method,
      headers,
      body: body === null || body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // Type name only -- the message can carry hostnames and request detail.
    const name = err instanceof Error ? err.constructor.name : 'Error';
    throw new SupabaseAdminError(`Supabase admin request failed: ${name}`);
  }
  if (resp.status >= 300) {
    let msg: string | null = null;
    try {
      const data = (await resp.json()) as Record<string, unknown>;
      // Python uses `or`, so `||` deliberately preserves its falsy fallthrough; do not modernise to `??`.
      const m = data.msg || data.message;
      // Python renders non-string msg values; deliberately do not, because that would echo arbitrary JSON.
      msg = typeof m === 'string' ? m : null;
    } catch {
      msg = null;
    }
    const detail = msg ? `: ${msg}` : '';
    throw new SupabaseAdminError(`Supabase admin ${method} ${path} -> ${resp.status}${detail}`);
  }
  return resp;
}

/**
 * Port of invite_user. Points the invite link at our own /auth/callback rather
 * than the project's dashboard-configured Site URL, so an invited user lands
 * somewhere that establishes a session and prompts for a password.
 */
export async function inviteUser(
  email: string,
  fetchImpl: GoTrueFetch = fetch
): Promise<{ id: string | null; email: string }> {
  let path = '/invite';
  const frontendUrl = process.env.FRONTEND_URL;
  if (frontendUrl) {
    // Python uses quote(..., safe='') -- encodeURIComponent matches it for this input.
    path += `?redirect_to=${encodeURIComponent(`${frontendUrl}/auth/callback`)}`;
  }
  const resp = await request('POST', path, { email }, fetchImpl);
  const data = (await resp.json()) as { id?: string | null; email?: string };
  // Python's .get("email", email) returns None for present-but-null; real GoTrue never does,
  // and keeping string avoids propagating an unreachable null into createInvite.
  return { id: data.id ?? null, email: data.email ?? email };
}

/** Port of delete_user — permanently deletes a GoTrue user. Irreversible. */
export async function deleteUser(
  supabaseUserId: string,
  fetchImpl: GoTrueFetch = fetch
): Promise<void> {
  await request('DELETE', `/admin/users/${supabaseUserId}`, null, fetchImpl);
}

/** Port of list_users — every GoTrue user, paged 200 at a time. */
export async function listUsers(
  fetchImpl: GoTrueFetch = fetch
): Promise<Array<{ id: string | null; email: string | null }>> {
  const users: Array<{ id: string | null; email: string | null }> = [];
  const perPage = 200;
  let page = 1;
  for (;;) {
    const resp = await request(
      'GET',
      `/admin/users?page=${page}&per_page=${perPage}`,
      null,
      fetchImpl
    );
    const data = (await resp.json()) as { users?: Array<{ id?: string; email?: string }> };
    const batch = data.users ?? [];
    for (const u of batch) users.push({ id: u.id ?? null, email: u.email ?? null });
    if (batch.length < perPage) break;
    page += 1;
  }
  return users;
}
