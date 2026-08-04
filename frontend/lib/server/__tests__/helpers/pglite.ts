import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../schema';
import type { Db } from '../../db';

/**
 * In-memory Postgres for server unit tests. Creates only the wave-0 tables
 * (SQL mirrors alembic/versions/0018_node_wave0_tables.py) plus usage_events
 * (mirrors 0014) for the anthropic tests. Extend as later waves need more.
 */
export async function makeTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const pg = new PGlite();
  await pg.exec(`
    create table catalog_cache (
      cache_key text primary key,
      source text not null,
      payload jsonb not null,
      fetched_at timestamp default current_timestamp
    );
    create table app_config (
      key text primary key,
      value jsonb not null,
      updated_at timestamp default current_timestamp
    );
    create table rate_limits (
      bucket_key text not null,
      window_start integer not null,
      count integer not null default 0,
      primary key (bucket_key, window_start)
    );
    create table usage_events (
      id serial primary key,
      user_id text not null default 'local',
      model text not null,
      operation text not null,
      input_tokens integer default 0,
      output_tokens integer default 0,
      cache_creation_input_tokens integer default 0,
      cache_read_input_tokens integer default 0,
      cost_usd double precision default 0,
      created_at timestamp default current_timestamp
    );
  `);
  const db = drizzle(pg, { schema }) as unknown as Db;
  return { db, close: () => pg.close() };
}
