import { withApi } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { keyConfigured } from '@/lib/server/settings';

/**
 * Port of user_settings.py::anthropic_key_status / resolve_anthropic_key.
 * configured = stored key decrypts, else env ANTHROPIC_API_KEY is SET (Python's
 * `is not None` — even an empty string counts). Decrypt failure propagates → 500,
 * matching Python.
 */
export const GET = withApi('/api/settings/api-key/status', async (_req, ctx) => {
  const db = getDb();
  const configured = await keyConfigured(db, ctx.user.userId);
  ctx.timer.mark('db');
  return Response.json({ configured });
});
