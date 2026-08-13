/**
 * One-shot: record already-applied migrations in drizzle's ledger WITHOUT
 * executing their SQL. Used once, to adopt drizzle-kit on a database that
 * Alembic built (production is at alembic head 0019_add_enrich_job_leases).
 *
 * Running this against a database that does NOT already have the schema
 * leaves you with an empty DB that drizzle believes is fully migrated.
 * Guard: it refuses to stamp unless `books` already exists.
 */
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import postgres from 'postgres';

loadEnv({ path: path.resolve(__dirname, '..', '..', '.env') });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const sql = postgres(url, { max: 1 });
  try {
    const [{ exists }] = await sql<{ exists: boolean }[]>`
      select exists (
        select 1 from information_schema.tables
        where table_schema = 'public' and table_name = 'books'
      ) as exists
    `;
    if (!exists) {
      throw new Error(
        'refusing to stamp: public.books does not exist. This script is for ' +
          'adopting drizzle on an EXISTING database, not for provisioning one.'
      );
    }

    const migrations = readMigrationFiles({
      migrationsFolder: path.join(__dirname, '..', 'drizzle'),
    });

    await sql`create schema if not exists drizzle`;
    await sql`
      create table if not exists drizzle."__drizzle_migrations" (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `;

    for (const m of migrations) {
      const [row] = await sql<{ id: number }[]>`
        select id from drizzle."__drizzle_migrations" where hash = ${m.hash}
      `;
      if (row) {
        console.log(`already stamped: ${m.hash.slice(0, 12)}`);
        continue;
      }
      await sql`
        insert into drizzle."__drizzle_migrations" ("hash", "created_at")
        values (${m.hash}, ${m.folderMillis})
      `;
      console.log(`stamped: ${m.hash.slice(0, 12)} (${m.folderMillis})`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
