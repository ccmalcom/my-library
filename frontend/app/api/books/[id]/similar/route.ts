import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { parseIdParam } from '@/lib/server/serialize';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { checkRateLimit, RATE_LIMITS, rateLimitExceededResponse } from '@/lib/server/ratelimit';
import { runSimilar } from '@/lib/server/recSimilarRun';

// Two Claude calls (a Haiku facet pass and a Sonnet rerank) plus up to ~35 catalog
// fetches. 300s is Vercel Hobby's maximum and the default on every tier.
export const maxDuration = 300;

/** Twin of schemas.SimilarRequest: n: int = 8, ge=1, le=20. */
const Body = z.object({
  n: z.number().int().min(1).max(20).default(8),
});

/**
 * Port of api.py::similar_books (940-961). Ephemeral "more books like this" for one
 * owned library book; nothing is persisted.
 *
 * Order of checks matches FastAPI: the body is validated during dependency
 * resolution (422), THEN slowapi's decorator runs (429), THEN the handler body's
 * ownership query (404). Verified against the real app with TestClient.
 */
export const POST = withApi('/api/books/[id]/similar', async (req, ctx) => {
  const bookId = parseIdParam(ctx.params.id);

  // FastAPI 422s on a MISSING body for a Pydantic-model parameter even when every
  // field is defaulted, but accepts `{}` and fills the defaults in. A failed parse
  // is the missing-body case.
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
    key: `books_similar:${ctx.user.userId}`,
    ...RATE_LIMITS.booksSimilar,
  });
  if (!rl.allowed) {
    // Corrected 429 shape (not the usual {"detail": ...}) -- see
    // rateLimitExceededResponse's doc comment in ratelimit.ts.
    return rateLimitExceededResponse(
      RATE_LIMITS.booksSimilar.limit,
      RATE_LIMITS.booksSimilar.windowSeconds
    );
  }

  const owned = await db
    .select({ id: schema.books.id })
    .from(schema.books)
    .where(and(eq(schema.books.id, bookId), eq(schema.books.userId, ctx.user.userId)));
  // api.py's HTTPException detail has NO trailing period, unlike
  // recommend_similar's own RuntimeError text. Keep them distinct.
  if (owned.length === 0) throw new ApiError(404, `Book ${bookId} not found`);

  // Resolve the key once and hand it down. NOT raised here: Python checks the key
  // at point of use, inside the facet-query stage, which runs after the metadata
  // catalog sweep.
  const apiKey = await resolveAnthropicKey(db, ctx.user.userId);
  const client = apiKey ? makeAnthropicClient(apiKey) : null;

  const out = await runSimilar(db, client, ctx.user.userId, bookId, parsed.data.n);
  ctx.timer.mark('claude');
  return Response.json(out);
});
