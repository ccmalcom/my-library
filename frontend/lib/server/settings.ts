import { eq } from 'drizzle-orm';
import { schema, type Db } from './db';
import { utcnowTs } from './serialize';
import { decrypt } from './crypto';

/**
 * Port of user_settings.py::anthropic_key_status / resolve_anthropic_key.
 * configured = stored key decrypts, else env ANTHROPIC_API_KEY is SET (Python's
 * `is not None` — even an empty string counts). Decrypt failure propagates → 500,
 * matching Python.
 */
export async function keyConfigured(db: Db, userId: string): Promise<boolean> {
  const rows = await db.select().from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId));
  const row = rows[0];
  let configured: boolean;
  if (row?.anthropicApiKeyEncrypted) {
    decrypt(row.anthropicApiKeyEncrypted);
    configured = true;
  } else {
    configured = process.env.ANTHROPIC_API_KEY !== undefined;
  }
  return configured;
}

export async function upsertUserSettings(
  db: Db, userId: string,
  patch: Partial<{ anthropicApiKeyEncrypted: string | null; displayName: string }>
): Promise<void> {
  const rows = await db.select().from(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId));
  if (rows[0]) {
    await db.update(schema.userSettings).set({ ...patch, updatedAt: utcnowTs() })
      .where(eq(schema.userSettings.id, rows[0].id));
  } else {
    await db.insert(schema.userSettings).values({ userId, ...patch });
  }
}
