import { eq } from 'drizzle-orm';
import { schema, type Db } from './db';

export type ProfileMetaRow = typeof schema.profileMeta.$inferSelect;

/** Port of profile.get_profile_meta: fetch-or-create the singleton row. */
export async function ensureProfileMeta(db: Db, userId: string): Promise<ProfileMetaRow> {
  const rows = await db.select().from(schema.profileMeta)
    .where(eq(schema.profileMeta.userId, userId));
  if (rows[0]) return rows[0];
  const [created] = await db.insert(schema.profileMeta)
    .values({ userId }).returning();
  return created;
}
