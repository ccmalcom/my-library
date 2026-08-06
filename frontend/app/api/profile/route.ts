import { desc, eq } from 'drizzle-orm';
import { withApi, ApiError } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { traitOut } from '@/lib/server/traits';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { PROFILE_NO_KEY_MESSAGE } from '@/lib/server/claudeErrors';
import { extractTasteProfile } from '@/lib/server/profileBuild';

export const GET = withApi('/api/profile', async (_req, ctx) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, ctx.user.userId))
    .orderBy(desc(schema.tasteTraits.inferenceConfidence));
  ctx.timer.mark('db');
  return Response.json(rows.map(traitOut));
});

// A full Sonnet build over a whole library is the longest Claude call in the app.
// 300s is Vercel Hobby's maximum and the default on every tier (verified 2026-08-06).
export const maxDuration = 300;

/** Port of api.py::profile (642-645): RuntimeError -> 400. */
export const POST = withApi('/api/profile', async (_req, ctx) => {
  const db = getDb();
  const apiKey = await resolveAnthropicKey(db, ctx.user.userId);
  if (!apiKey) throw new ApiError(400, PROFILE_NO_KEY_MESSAGE);
  const client = makeAnthropicClient(apiKey);

  const out = await extractTasteProfile(db, client, ctx.user.userId);
  ctx.timer.mark('claude');
  return Response.json(out);
});
