import { desc, eq } from 'drizzle-orm';
import { withApi } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { traitOut } from '@/lib/server/traits';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { generateRevealLines } from '@/lib/server/revealLines';

// Single Haiku call — parity twin has no timeout of its own, but Vercel's default
// function duration is too short for a live model round trip (see directive/draft/route.ts).
export const maxDuration = 60;

/**
 * Port of api.py::post_reveal_lines (1132-1153). Resolves the key optimistically (cheap, no
 * network call) and passes `null` through when unconfigured — generateRevealLines only
 * requires a key when there is actually pending work (see revealLines.ts's module doc), so
 * this must NOT throw here the way directive/draft's and archetype's routes do. The
 * generation's return value is discarded, same as Python's; the response is built by
 * re-querying ALL of the user's traits ordered by inference_confidence DESC (the same
 * pattern GET /api/profile uses), never the internal {generated, traits, model} summary.
 */
export const POST = withApi('/api/profile/reveal-lines', async (_req, ctx) => {
  const db = getDb();
  const apiKey = await resolveAnthropicKey(db, ctx.user.userId);
  const client = apiKey ? makeAnthropicClient(apiKey) : null;

  await generateRevealLines(db, client, ctx.user.userId);
  ctx.timer.mark('claude');

  const rows = await db
    .select()
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, ctx.user.userId))
    .orderBy(desc(schema.tasteTraits.inferenceConfidence));
  ctx.timer.mark('db');
  return Response.json(rows.map(traitOut));
});
