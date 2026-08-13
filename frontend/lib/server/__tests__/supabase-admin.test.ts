import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SupabaseAdminError, deleteUser, inviteUser, listUsers } from '../supabaseAdmin';

/**
 * Port checks for mylibrary/supabase_admin.py. The transport is injected, so
 * nothing here touches the network. The security assertions (no key, no raw
 * body in error text) are the point of this module, not incidental.
 */
const SERVICE_KEY = 'service-role-secret-value';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('supabaseAdmin', () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {
      SUPABASE_URL: process.env.SUPABASE_URL,
      // Restored too: baseAndHeaders falls back to it, so a test that sets it would otherwise
      // leak into the cases that assert the bare SUPABASE_URL is what gets used.
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
      FRONTEND_URL: process.env.FRONTEND_URL,
    };
    process.env.SUPABASE_URL = 'https://proj.supabase.co/';
    process.env.SUPABASE_SECRET_KEY = SERVICE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.FRONTEND_URL;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('throws when not configured, naming the variable that is actually missing', async () => {
    delete process.env.SUPABASE_SECRET_KEY;
    const err = await inviteUser('a@example.com', async () => jsonResponse(200, {})).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(SupabaseAdminError);
    const text = String((err as Error).message);
    expect(text).toContain('Supabase admin not configured');
    // The URL is present here, so only the key may be named. Listing both regardless is what
    // made a real 502 undiagnosable during live verification.
    expect(text).toContain('SUPABASE_SECRET_KEY');
    expect(text).not.toContain('SUPABASE_URL');
  });

  it('accepts NEXT_PUBLIC_SUPABASE_URL when the bare SUPABASE_URL is absent', async () => {
    // auth.ts::jwksUrl already falls back this way; without the same precedence here a
    // deployment authenticates fine and then fails every admin write.
    delete process.env.SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://proj.supabase.co';
    let seenUrl = '';
    await inviteUser('reader@example.com', async (url) => {
      seenUrl = url;
      return jsonResponse(200, { id: 'sb-1', email: 'reader@example.com' });
    });
    expect(seenUrl).toBe('https://proj.supabase.co/auth/v1/invite');
  });

  it('sends the key on apikey ONLY, never on Authorization', async () => {
    let seenUrl = '';
    let seenInit: RequestInit = {};
    await inviteUser('reader@example.com', async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return jsonResponse(200, { id: 'sb-1', email: 'reader@example.com' });
    });
    // trailing slash on SUPABASE_URL is stripped, /auth/v1 appended
    expect(seenUrl).toBe('https://proj.supabase.co/auth/v1/invite');
    expect(seenInit.method).toBe('POST');
    const headers = seenInit.headers as Record<string, string>;
    expect(headers.apikey).toBe(SERVICE_KEY);
    // Load-bearing, and the reason this diverges from Python: Supabase's opaque
    // `sb_secret_...` keys are not JWTs, so sending one on Authorization makes the
    // platform try to parse it as a JWT and reject the request. The gateway
    // synthesizes Authorization from apikey for us, for legacy and new keys alike.
    expect(headers.Authorization).toBeUndefined();
    expect(Object.keys(headers)).not.toContain('authorization');
    expect(JSON.parse(String(seenInit.body))).toEqual({ email: 'reader@example.com' });
  });

  it('appends a percent-encoded redirect_to when FRONTEND_URL is set', async () => {
    process.env.FRONTEND_URL = 'https://app.example.com';
    let seenUrl = '';
    await inviteUser('reader@example.com', async (url) => {
      seenUrl = url;
      return jsonResponse(200, { id: 'sb-1', email: 'reader@example.com' });
    });
    expect(seenUrl).toBe(
      'https://proj.supabase.co/auth/v1/invite?redirect_to=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback'
    );
  });

  it('falls back to the requested email when GoTrue omits one', async () => {
    const out = await inviteUser('reader@example.com', async () =>
      jsonResponse(200, { id: 'sb-1' })
    );
    expect(out).toEqual({ id: 'sb-1', email: 'reader@example.com' });
  });

  it('surfaces GoTrue msg but never the key or the raw body', async () => {
    const err = await inviteUser('reader@example.com', async () =>
      jsonResponse(422, { msg: 'User already registered', secret_field: SERVICE_KEY })
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupabaseAdminError);
    const text = String((err as Error).message);
    expect(text).toContain('422');
    expect(text).toContain('User already registered');
    expect(text).not.toContain(SERVICE_KEY);
    expect(text).not.toContain('secret_field');
  });

  it('reports a network failure by error type only', async () => {
    const err = await deleteUser('sb-1', async () => {
      throw new TypeError('fetch failed: 10.0.0.1 refused');
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SupabaseAdminError);
    expect(String((err as Error).message)).toContain('TypeError');
    expect(String((err as Error).message)).not.toContain('10.0.0.1');
  });

  it('deletes by id against the admin path', async () => {
    let seenUrl = '';
    let seenMethod = '';
    await deleteUser('sb-abc', async (url, init) => {
      seenUrl = url;
      seenMethod = String(init.method);
      return new Response(null, { status: 204 });
    });
    expect(seenUrl).toBe('https://proj.supabase.co/auth/v1/admin/users/sb-abc');
    expect(seenMethod).toBe('DELETE');
  });

  it('pages listUsers until a short page arrives', async () => {
    const seen: string[] = [];
    const page1 = Array.from({ length: 200 }, (_, i) => ({
      id: `sb-${i}`,
      email: `u${i}@example.com`,
    }));
    const out = await listUsers(async (url) => {
      seen.push(url);
      return jsonResponse(200, {
        users: seen.length === 1 ? page1 : [{ id: 'sb-last', email: 'last@example.com' }],
      });
    });
    expect(seen).toEqual([
      'https://proj.supabase.co/auth/v1/admin/users?page=1&per_page=200',
      'https://proj.supabase.co/auth/v1/admin/users?page=2&per_page=200',
    ]);
    expect(out).toHaveLength(201);
    expect(out[200]).toEqual({ id: 'sb-last', email: 'last@example.com' });
  });
});
