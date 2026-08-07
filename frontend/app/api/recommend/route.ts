import { z } from 'zod';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { runRecommend } from '@/lib/server/recommendRun';

// Two Claude calls (a Haiku seed pass and a Sonnet rerank) plus ~80 catalog fetches.
// 300s is Vercel Hobby's maximum and the default on every tier (verified 2026-08-06).
export const maxDuration = 300;

/** Twin of schemas.RecommendRequest — every field defaulted. */
const Body = z.object({
  n: z.number().int().default(10),
  use_metadata: z.boolean().default(true),
  use_claude_seeds: z.boolean().default(true),
});

/** Port of api.py::make_recommendations (918-929): RuntimeError -> 400. */
export const POST = withApi('/api/recommend', async (req, ctx) => {
  // FastAPI 422s on a MISSING body for a Pydantic-model parameter even when every
  // field is defaulted, but accepts `{}` and fills the defaults in (verified against
  // the real app). A failed parse is the missing-body case.
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
  // Resolve the key once and hand it down. NOT raised here: Python checks the key at
  // point of use, so a run that never reaches a Claude stage still succeeds.
  const apiKey = await resolveAnthropicKey(db, ctx.user.userId);
  const client = apiKey ? makeAnthropicClient(apiKey) : null;

  const out = await runRecommend(db, client, ctx.user.userId, {
    n: parsed.data.n,
    useMetadata: parsed.data.use_metadata,
    useClaudeSeeds: parsed.data.use_claude_seeds,
  });
  ctx.timer.mark('claude');
  return Response.json(out);
});
