import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { searchBooks } from '@/lib/server/catalog';
import { checkRateLimit, RATE_LIMITS, rateLimitExceededResponse } from '@/lib/server/ratelimit';

const Query = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

// Parity note: Python's `search_catalog` (mylibrary/api.py:675-696) has no `user_id:
// UserId` dependency at all -- it's genuinely unauthenticated (confirmed by a passing
// Python test, tests/test_enrichment_correction.py:83-92, calling it with no
// Authorization header and getting 200). Node deliberately does NOT mirror that: this
// withApi(...) call requires auth (no `{ requireAuth: false }`), a permanent, intentional
// divergence -- Chase's call, not a bug. The app is invite-only, and an unauthenticated
// OpenLibrary/Google Books search proxy is a real surface nobody wants exposed, even
// though Python's omission looks unintentional. A second reason IP-based Node parity
// isn't worth chasing here: Python's rate-limit key (`_rate_limit_key`, api.py:141-148)
// falls back to per-client-IP for exactly this route when unauthenticated, which is a
// weaker limit than the per-user key Node uses below. Do not "fix" this back to match
// Python by adding `{ requireAuth: false }`.
export const GET = withApi('/api/catalog/search', async (req, ctx) => {
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid query'}`
    );
  }
  const db = getDb();
  const rl = await checkRateLimit(db, {
    key: `catalog_search:${ctx.user.userId}`,
    ...RATE_LIMITS.catalogSearch,
  });
  if (!rl.allowed) {
    // Corrected 429 shape (not the usual {"detail": ...}) -- see rateLimitExceededResponse's
    // doc comment in ratelimit.ts for the full parity note against slowapi's behavior.
    return rateLimitExceededResponse(
      RATE_LIMITS.catalogSearch.limit,
      RATE_LIMITS.catalogSearch.windowSeconds
    );
  }
  const hits = await searchBooks(db, parsed.data.q, parsed.data.limit);
  ctx.timer.mark('catalog');
  return Response.json(
    hits
      .filter((h) => h.title)
      .map((h) => ({
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
