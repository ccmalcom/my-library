import { eq } from 'drizzle-orm';
import { withApi } from '@/lib/server/http';
import { getDb, schema } from '@/lib/server/db';
import { decrypt } from '@/lib/server/crypto';

/**
 * Port of user_settings.py::anthropic_key_status / resolve_anthropic_key.
 * configured = stored key decrypts, else env ANTHROPIC_API_KEY is SET (Python's
 * `is not None` — even an empty string counts). Decrypt failure propagates → 500,
 * matching Python.
 */
export const GET = withApi('/api/settings/api-key/status', async (_req, ctx) => {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.userSettings)
    .where(eq(schema.userSettings.userId, ctx.user.userId));
  ctx.timer.mark('db');
  const row = rows[0];
  let configured: boolean;
  if (row?.anthropicApiKeyEncrypted) {
    decrypt(row.anthropicApiKeyEncrypted);
    configured = true;
  } else {
    configured = process.env.ANTHROPIC_API_KEY !== undefined;
  }
  return Response.json({ configured });
});
