import { eq, inArray } from 'drizzle-orm';
import { schema, type DbTx } from './db';

export type ProfilePurgeResult = {
  traits_removed: number;
  recommendations_removed: number;
};

export type AccountPurgeResult = ProfilePurgeResult & {
  books_removed: number;
  settings_removed: number;
  signals_removed: number;
  jobs_removed: number;
  usage_events_removed: number;
  directive_removed: number;
  account_deleted: true;
};

export async function deleteProfileRows(tx: DbTx, userId: string): Promise<ProfilePurgeResult> {
  const traits = await tx
    .delete(schema.tasteTraits)
    .where(eq(schema.tasteTraits.userId, userId))
    .returning({ id: schema.tasteTraits.id });
  const recommendations = await tx
    .delete(schema.recommendations)
    .where(eq(schema.recommendations.userId, userId))
    .returning({ id: schema.recommendations.id });
  await tx.delete(schema.profileMeta).where(eq(schema.profileMeta.userId, userId));
  await tx.delete(schema.readerArchetypes).where(eq(schema.readerArchetypes.userId, userId));

  return {
    traits_removed: traits.length,
    recommendations_removed: recommendations.length,
  };
}

export async function deleteLibraryRows(tx: DbTx, userId: string): Promise<number> {
  const owned = await tx
    .select({ id: schema.books.id })
    .from(schema.books)
    .where(eq(schema.books.userId, userId));
  const bookIds = owned.map(({ id }) => id);

  // LOAD-BEARING: bulk deletes do not cascade; enrichment.book_id is an FK.
  if (bookIds.length > 0) {
    await tx.delete(schema.enrichment).where(inArray(schema.enrichment.bookId, bookIds));
  }
  const books = await tx
    .delete(schema.books)
    .where(eq(schema.books.userId, userId))
    .returning({ id: schema.books.id });

  return books.length;
}

export async function deleteAccountRows(tx: DbTx, userId: string): Promise<AccountPurgeResult> {
  const profile = await deleteProfileRows(tx, userId);
  const books_removed = await deleteLibraryRows(tx, userId);
  const settings = await tx
    .delete(schema.userSettings)
    .where(eq(schema.userSettings.userId, userId))
    .returning({ id: schema.userSettings.id });
  const signals = await tx
    .delete(schema.tasteSignal)
    .where(eq(schema.tasteSignal.userId, userId))
    .returning({ id: schema.tasteSignal.id });
  const jobs = await tx
    .delete(schema.enrichJobs)
    .where(eq(schema.enrichJobs.userId, userId))
    .returning({ id: schema.enrichJobs.id });
  const usage = await tx
    .delete(schema.usageEvents)
    .where(eq(schema.usageEvents.userId, userId))
    .returning({ id: schema.usageEvents.id });
  const directive = await tx
    .delete(schema.userDirective)
    .where(eq(schema.userDirective.userId, userId))
    .returning({ id: schema.userDirective.id });

  return {
    books_removed,
    ...profile,
    settings_removed: settings.length,
    signals_removed: signals.length,
    jobs_removed: jobs.length,
    usage_events_removed: usage.length,
    directive_removed: directive.length,
    account_deleted: true,
  };
}
