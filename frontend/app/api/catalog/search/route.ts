import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { searchBooks } from '@/lib/server/catalog';
import { checkRateLimit, RATE_LIMITS } from '@/lib/server/ratelimit';

const Query = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

export const GET = withApi('/api/catalog/search', async (req, ctx) => {
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    throw new ApiError(422, `validation error: ${parsed.error.issues[0]?.message ?? 'invalid query'}`);
  }
  const db = getDb();
  const rl = await checkRateLimit(db, {
    key: `catalog_search:${ctx.user.userId}`, ...RATE_LIMITS.catalogSearch,
  });
  if (!rl.allowed) {
    // Parity note: this is NOT the usual {"detail": ...} shape every other route
    // uses (see errors.ts). SlowAPI's default `_rate_limit_exceeded_handler` (wired
    // up unmodified at mylibrary/api.py:182) hardcodes {"error": f"Rate limit
    // exceeded: {exc.detail}"} with status 429 -- a separate FastAPI exception-handler
    // path with its own shape that was never overridden. Also: mylibrary/api.py:148
    // constructs Limiter(key_func=_rate_limit_key) with no headers_enabled=True, and
    // slowapi.Limiter defaults headers_enabled=False, so the real response carries
    // NO extra headers -- no Retry-After, no X-RateLimit-*. Verified by reading the
    // installed slowapi package and mylibrary/api.py directly. Do not "fix" this back
    // to {"detail": ...} or add a Retry-After header; that would be a fabricated
    // deviation from Python, not parity. The literal string below is exc.detail for
    // this route's specific @limiter.limit("30/minute") decorator (confirmed via
    // `limits.parse("30/minute")` -> "30 per 1 minute"); it's hardcoded rather than
    // built generically because this route only ever uses this one limit.
    return new Response(JSON.stringify({ error: 'Rate limit exceeded: 30 per 1 minute' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  }
  const hits = await searchBooks(db, parsed.data.q, parsed.data.limit);
  ctx.timer.mark('catalog');
  return Response.json(
    hits.filter((h) => h.title).map((h) => ({
      source: h.source ?? 'unknown',
      catalog_id: h.resolved_id ?? null,
      title: h.title ?? '',
      author: h.author ?? null,
      year: h.year ?? null,
      isbn13: h.isbn13 ?? null,
      cover_url: h.cover_url ?? null,
      subjects: h.subjects ?? null,
      description: h.description ?? null,
    }))
  );
});
