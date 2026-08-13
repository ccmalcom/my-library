import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { checkRateLimit, RATE_LIMITS, rateLimitExceededResponse } from '@/lib/server/ratelimit';
import { runDiscover } from '@/lib/server/recDiscoverRun';

// Two Claude calls (a Haiku interpretation pass and a Sonnet rerank) plus two
// catalog fetches per interpreted query. 300s is Vercel Hobby's maximum and the
// default on every tier.
export const maxDuration = 300;

/** Twin of schemas.DiscoverRequest: query (1..500 chars, required), n: int = 10 (1..20). */
const Body = z.object({
  query: z.string().min(1).max(500),
  n: z.number().int().min(1).max(20).default(10),
});

/**
 * Port of api.py::discover_books (963-978). Ephemeral natural-language discovery;
 * nothing is persisted.
 *
 * Order of checks matches FastAPI: the body is validated during dependency
 * resolution (422), THEN slowapi's decorator runs (429), THEN the handler body.
 * Note that a whitespace-only query passes Pydantic's min_length=1 and is rejected
 * later, by runDiscover, as a 400 — not a 422.
 */
export const POST = withApi('/api/discover', async (req, ctx) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(422, 'validation error: body is required');
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    // DEVIATION: FastAPI returns a structured detail ARRAY; every Node route in this
    // migration returns a string detail instead. Established in wave 2, kept here.
    throw new ApiError(
      422,
      `validation error: ${parsed.error.issues[0]?.message ?? 'invalid body'}`
    );
  }

  const db = getDb();
  const rl = await checkRateLimit(db, {
    key: `discover:${ctx.user.userId}`,
    ...RATE_LIMITS.discover,
  });
  if (!rl.allowed) {
    // Corrected 429 shape (not the usual {"detail": ...}) -- see
    // rateLimitExceededResponse's doc comment in ratelimit.ts.
    return rateLimitExceededResponse(
      RATE_LIMITS.discover.limit,
      RATE_LIMITS.discover.windowSeconds
    );
  }

  // Resolve the key once and hand it down. NOT raised here: Python checks the key at
  // point of use, inside the interpretation stage.
  const apiKey = await resolveAnthropicKey(db, ctx.user.userId);
  const client = apiKey ? makeAnthropicClient(apiKey) : null;

  const out = await runDiscover(db, client, ctx.user.userId, parsed.data.query, parsed.data.n);
  ctx.timer.mark('claude');
  return Response.json(out);
});
