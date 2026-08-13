import { withApi, ApiError } from '@/lib/server/http';
import { getDb } from '@/lib/server/db';
import { encrypt } from '@/lib/server/crypto';
import { keyConfigured, upsertUserSettings } from '@/lib/server/settings';

export const PUT = withApi('/api/settings/api-key', async (req, ctx) => {
  const raw = await req.json().catch(() => null);
  const key = typeof raw?.api_key === 'string' ? raw.api_key.trim() : '';
  if (!key) throw new ApiError(422, 'API key must not be empty.');
  const db = getDb();
  await db.transaction((tx) =>
    upsertUserSettings(tx, ctx.user.userId, { anthropicApiKeyEncrypted: encrypt(key) })
  );
  ctx.timer.mark('db');
  return Response.json({ configured: true });
});

export const DELETE = withApi('/api/settings/api-key', async (_req, ctx) => {
  const db = getDb();
  const configured = await db.transaction(async (tx) => {
    await upsertUserSettings(tx, ctx.user.userId, { anthropicApiKeyEncrypted: null });
    return keyConfigured(tx, ctx.user.userId);
  });
  ctx.timer.mark('db');
  return Response.json({ configured });
});
