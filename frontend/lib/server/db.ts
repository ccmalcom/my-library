/**
 * Drizzle + postgres-js client for the shared Supabase Postgres.
 * Schema is INTROSPECTED from the Alembic-owned database (drizzle-kit pull)
 * and checked in — this side never migrates. `prepare: false` is required:
 * Supabase's transaction-mode pooler (pgbouncer) does not support prepared
 * statements.
 */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export { schema };
export type Db = PostgresJsDatabase<typeof schema>;
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

let db: Db | null = null;
let testDb: Db | null = null;

/** Test seam: makes getDb() return this instance (null restores normal behavior). */
export function _setDbForTests(override: Db | null): void {
  testDb = override;
}

export function getDb(): Db {
  if (testDb) return testDb;
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set — the Node backend requires Postgres');
    const client = postgres(url, { prepare: false, max: 1 });
    db = drizzle(client, { schema });
  }
  return db;
}
