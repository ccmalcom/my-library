import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { resolveAnthropicKey, makeAnthropicClient } from '@/lib/server/claude';
import { PROFILE_NO_KEY_MESSAGE } from '@/lib/server/claudeErrors';
import { updateTasteProfile } from '@/lib/server/profileUpdate';

// May delegate to the full builder, so it inherits that flow's ceiling.
export const maxDuration = 300;

/** Port of api.py::update_profile (909-916): RuntimeError -> 400. */
export const POST = withApi('/api/profile/update', async (_req, ctx) => {
  const db = getDb();
  const apiKey = await resolveAnthropicKey(db, ctx.user.userId);
  if (!apiKey) throw new ApiError(400, PROFILE_NO_KEY_MESSAGE);
  const client = makeAnthropicClient(apiKey);

  const out = await updateTasteProfile(db, client, ctx.user.userId);
  ctx.timer.mark('claude');
  return Response.json(out);
});
