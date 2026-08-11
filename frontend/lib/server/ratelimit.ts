/**
 * Fixed-window rate limiting on Postgres (rate_limits table) — the Node twin
 * of the Python SlowAPI per-user limits. One upsert per check; windows are
 * aligned to epoch multiples of windowSeconds. Old windows are deleted
 * opportunistically on each call (single-user scale — this is cheap).
 */
import { sql } from 'drizzle-orm';
import type { Db } from './db';

/** Parity with mylibrary/api.py decorators: 30/minute catalog search, 5/minute enrich
 *  start, 30/minute directive draft, 15/minute similar books, 30/minute discover. Each
 *  route uses its own bucket key — these limits are independent, not shared. */
export const RATE_LIMITS = {
  catalogSearch: { limit: 30, windowSeconds: 60 },
  enrichStart: { limit: 5, windowSeconds: 60 },
  directiveDraft: { limit: 30, windowSeconds: 60 },
  booksSimilar: { limit: 15, windowSeconds: 60 },
  discover: { limit: 30, windowSeconds: 60 },
} as const;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Builds the 429 response for a blocked request. Parity note: this is NOT the usual
 * {"detail": ...} shape every other route uses (see errors.ts). SlowAPI's default
 * `_rate_limit_exceeded_handler` (wired up unmodified at mylibrary/api.py:182)
 * hardcodes {"error": f"Rate limit exceeded: {exc.detail}"} with status 429 -- a
 * separate FastAPI exception-handler path with its own shape that was never
 * overridden. Also: mylibrary/api.py:148 constructs Limiter(key_func=_rate_limit_key)
 * with no headers_enabled=True, and slowapi.Limiter defaults headers_enabled=False, so
 * the real response carries NO extra headers -- no Retry-After, no X-RateLimit-*.
 * Verified by reading the installed slowapi package and mylibrary/api.py directly. Do
 * not "fix" this back to {"detail": ...} or add a Retry-After header; that would be a
 * fabricated deviation from Python, not parity. The "N per M minute(s)" phrasing below
 * is exc.detail for a `@limiter.limit("N/minute")` decorator (confirmed via
 * `limits.parse("30/minute")` -> "30 per 1 minute"); every current call site uses a
 * 60-second window, so this only needs to handle the minute-granularity case.
 */
export function rateLimitExceededResponse(limit: number, windowSeconds: number): Response {
  const minutes = windowSeconds / 60;
  const unit = minutes === 1 ? 'minute' : 'minutes';
  return new Response(
    JSON.stringify({ error: `Rate limit exceeded: ${limit} per ${minutes} ${unit}` }),
    { status: 429, headers: { 'content-type': 'application/json' } }
  );
}

export async function checkRateLimit(
  db: Db,
  opts: { key: string; limit: number; windowSeconds: number; nowMs?: number }
): Promise<RateLimitResult> {
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  const windowStart = nowSec - (nowSec % opts.windowSeconds);

  const result = await db.execute(sql`
    insert into rate_limits (bucket_key, window_start, count)
    values (${opts.key}, ${windowStart}, 1)
    on conflict (bucket_key, window_start)
      do update set count = rate_limits.count + 1
    returning count
  `);
  const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows;
  const count = Number((rows[0] as { count: number | string }).count);

  // Opportunistic cleanup of expired windows for this key.
  await db.execute(
    sql`delete from rate_limits where bucket_key = ${opts.key} and window_start < ${windowStart}`
  );

  return {
    allowed: count <= opts.limit,
    remaining: Math.max(0, opts.limit - count),
    retryAfterSeconds: windowStart + opts.windowSeconds - nowSec,
  };
}
