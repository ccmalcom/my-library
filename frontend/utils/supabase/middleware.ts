import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Routes reachable without a session.
const PUBLIC_PREFIXES = ['/login', '/auth'];

/**
 * Refresh the Supabase session cookie on each request and gate page routes:
 * unauthenticated users are redirected to /login. No-op in local mode (no Supabase env),
 * so local dev runs unauthenticated exactly as before.
 *
 * This middleware gates pages only. API routes do their own bearer authentication via
 * withApi and must stay excluded from the proxy matcher.
 */
export async function updateSession(request: NextRequest) {
  if (!url || !key) return NextResponse.next({ request }); // local mode: auth disabled

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  // Touch getUser() to refresh an expired token (writes new cookies via setAll above).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PREFIXES.some((p) => path.startsWith(p));

  if (!user && !isPublic) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    return NextResponse.redirect(loginUrl);
  }
  if (user && path.startsWith('/login')) {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = '/';
    return NextResponse.redirect(homeUrl);
  }

  return supabaseResponse;
}
