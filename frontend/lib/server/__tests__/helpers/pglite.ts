import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '../../schema';
import type { Db } from '../../db';

/**
 * In-memory Postgres for server unit tests. Creates the wave-0 tables
 * (SQL mirrors alembic/versions/0018_node_wave0_tables.py) plus usage_events
 * (mirrors 0014) for the anthropic tests, plus the wave-1 tables (books,
 * enrichment, taste_traits, recommendations, profile_meta, user_settings,
 * reader_archetypes, user_directive — mirroring mylibrary/db.py) that the
 * wave-1 route-port tests seed via `loadSeed`. Extend as later waves need more.
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
      input_tokens integer not null,
      output_tokens integer not null,
      cache_creation_input_tokens integer not null,
      cache_read_input_tokens integer not null,
      cost_usd double precision not null,
      created_at timestamp not null default current_timestamp
    );
    create table books (
      id serial primary key,
      user_id text not null default 'local',
      goodreads_book_id text,
      title text not null,
      author text,
      additional_authors text,
      isbn13 text,
      exclusive_shelf text,
      goodreads_rating numeric(2,1) not null,
      app_rating numeric(2,1),
      app_review text,
      feedback_updated_at timestamp,
      date_read date,
      date_added date,
      page_count integer,
      year_published integer,
      source text not null,
      exclude_from_profile boolean not null default false,
      is_favorite boolean not null default false,
      constraint ck_books_app_rating_half_step check (
        app_rating is null or (app_rating >= 0.5 and app_rating <= 5.0 and (app_rating * 2) % 1 = 0)
      ),
      constraint ck_books_goodreads_rating_half_step check (
        goodreads_rating = 0 or (goodreads_rating >= 0.5 and goodreads_rating <= 5.0 and (goodreads_rating * 2) % 1 = 0)
      ),
      constraint uq_book_user_goodreads unique (user_id, goodreads_book_id)
    );
    create table enrichment (
      id serial primary key,
      book_id integer not null unique references books(id),
      resolved_source text,
      resolved_id text,
      subjects json,
      series text,
      series_position text,
      description text,
      cover_url text,
      resolution_confidence double precision not null,
      confidence_label text,
      match_method text,
      raw_response json,
      resolved_at timestamp not null default current_timestamp,
      language text
    );
    create table taste_traits (
      id serial primary key,
      user_id text not null default 'local',
      claim text not null,
      polarity text not null,
      exhibits json,
      contrasts json,
      inference_confidence double precision not null,
      status text not null,
      user_note text,
      created_at timestamp not null default current_timestamp,
      user_weight double precision not null default 1,
      verdict_updated_at timestamp,
      reveal_line text
    );
    create table recommendations (
      id serial primary key,
      user_id text not null default 'local',
      run_id text not null,
      rank integer not null,
      title text not null,
      author text,
      year integer,
      isbn13 text,
      cover_url text,
      subjects json,
      catalog_source text,
      catalog_id text,
      retrieval_pool text,
      seed_reason text,
      score double precision not null,
      rationale text,
      grounded_trait_ids json,
      grounded_book_ids json,
      status text not null,
      user_note text,
      created_at timestamp not null default current_timestamp,
      description text,
      reject_reasons json
    );
    create table profile_meta (
      id serial primary key,
      user_id text not null default 'local' unique,
      last_profiled_at timestamp,
      last_profile_kind text,
      rec_feedback_updated_at timestamp,
      enrichment_corrected_at timestamp
    );
    create table user_settings (
      id serial primary key,
      user_id text not null default 'local' unique,
      anthropic_api_key_encrypted text,
      created_at timestamp not null default current_timestamp,
      updated_at timestamp,
      display_name text
    );
    create table reader_archetypes (
      id serial primary key,
      user_id text not null default 'local' unique,
      code text not null,
      archetype_name text not null,
      archetype_tagline text not null,
      axis_lens double precision not null,
      axis_engine double precision not null,
      axis_range double precision not null,
      axis_resonance double precision not null,
      lens_rationale text,
      engine_rationale text,
      range_rationale text,
      resonance_rationale text,
      derived_at timestamp not null
    );
    create table user_directive (
      id serial primary key,
      user_id text not null default 'local' unique,
      nl_text text,
      constraints json,
      created_at timestamp not null default current_timestamp,
      updated_at timestamp
    );
    create table taste_signal (
      id serial primary key,
      user_id text not null default 'local',
      direction text not null,
      target_kind text not null,
      target_book_id integer,
      snapshot json,
      created_at timestamp not null default current_timestamp
    );
    create table enrich_jobs (
      id serial primary key,
      job_id text not null unique,
      user_id text not null default 'local',
      -- Deliberately NO default on status: the Alembic-owned table has none
      -- (Python sets it from an ORM-level default). Adding one here hides
      -- insert bugs that only appear against the real database.
      -- progress/total DO carry "default 0", because production really has it
      -- (the 0003 lineage, verified 2026-08-13). The mirror's job is to match
      -- production, not to be uniformly strict. The inserts still pass both
      -- values explicitly -- see the note in schema.ts and the guard in
      -- __tests__/enrich-job-insert.test.ts.
      status text not null,
      progress integer not null default 0,
      total integer not null default 0,
      started_at timestamp,
      finished_at timestamp,
      error text,
      lease_expires_at timestamp,
      attempts integer not null default 0,
      force boolean not null default false,
      run_limit integer,
      created_at timestamp not null default current_timestamp
    );
    create unique index uq_enrich_jobs_active_user
    on enrich_jobs (user_id)
    where status in ('pending', 'running');
    create table feedback (
      id serial primary key,
      user_id text not null default 'local',
      category text not null,
      body text not null,
      trigger text,
      run_id text,
      page text,
      app_version text,
      status text not null default 'open',
      github_issue_number integer,
      github_issue_url text,
      created_at timestamp not null default current_timestamp
    );
    create table feedback_prompt_state (
      id serial primary key,
      user_id text not null default 'local',
      trigger text not null,
      run_id text not null default '',
      status text not null,
      snooze_until timestamp,
      updated_at timestamp not null default current_timestamp,
      constraint uq_feedback_prompt_state unique (user_id, trigger, run_id)
    );
    create table invites (
      id serial primary key,
      email text not null,
      invited_by text not null,
      supabase_user_id text,
      status text not null,
      created_at timestamp not null default current_timestamp,
      accepted_at timestamp,
      revoked_at timestamp
    );
  `);
  const db = drizzle(pg, { schema }) as unknown as Db;
  return { db, close: () => pg.close() };
}

type SeedTimestamp = string | { $hoursAgo: number } | null;

export interface Seed {
  catalog_cache?: Record<string, unknown>[];
  books?: Record<string, unknown>[];
  invites?: Record<string, unknown>[];
  enrichment?: Record<string, unknown>[];
  taste_traits?: Record<string, unknown>[];
  recommendations?: Record<string, unknown>[];
  profile_meta?: Record<string, unknown>[];
  user_settings?: Record<string, unknown>[];
  reader_archetypes?: Record<string, unknown>[];
  user_directive?: Record<string, unknown>[];
  usage_events?: Record<string, unknown>[];
  taste_signals?: Record<string, unknown>[];
  feedback?: Record<string, unknown>[];
  feedback_prompt_state?: Record<string, unknown>[];
}

function resolveTs(v: SeedTimestamp): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.replace('T', ' ');
  const d = new Date(Date.now() - v.$hoursAgo * 3_600_000);
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Inserts seed rows via raw SQL (snake_case keys straight from seed.json —
 * same names Python uses, so the two loaders can't drift on column mapping).
 * JSON columns are stringified; sentinel timestamps resolved at load time.
 */
export async function loadSeed(db: Db, seed: Seed): Promise<void> {
  const TS_COLS = new Set([
    'feedback_updated_at',
    'created_at',
    'updated_at',
    'verdict_updated_at',
    'last_profiled_at',
    'rec_feedback_updated_at',
    'enrichment_corrected_at',
    'derived_at',
    'resolved_at',
    'snooze_until',
    'revoked_at',
    'accepted_at',
  ]);
  const JSON_COLS = new Set([
    'subjects',
    'exhibits',
    'contrasts',
    'grounded_trait_ids',
    'grounded_book_ids',
    'reject_reasons',
    'raw_response',
    'constraints',
    'snapshot',
  ]);
  const order = [
    'catalog_cache',
    'books',
    'invites',
    'enrichment',
    'taste_traits',
    'recommendations',
    'profile_meta',
    'user_settings',
    'reader_archetypes',
    'user_directive',
    'usage_events',
    'taste_signals',
    'feedback',
    'feedback_prompt_state',
  ] as const;
  const TABLE_FOR_KEY: Record<string, string> = { taste_signals: 'taste_signal' };
  for (const key of order) {
    const table = TABLE_FOR_KEY[key] ?? key;
    for (const row of seed[key] ?? []) {
      const cols = Object.keys(row);
      const vals = cols.map((c) => {
        const v = (row as Record<string, unknown>)[c];
        if (v === null || v === undefined) return null;
        if (TS_COLS.has(c)) return resolveTs(v as SeedTimestamp);
        if (JSON_COLS.has(c)) return JSON.stringify(v);
        return v;
      });
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      // db.$client is the PGlite instance handed to drizzle in makeTestDb.
      await (db as any).$client.query(
        `insert into ${table} (${cols.join(', ')}) values (${placeholders})`,
        vals
      );
    }
  }
  const SEQ_TABLES = [
    'books',
    // Load-bearing: the seed inserts invites with explicit ids 1-3, which does not
    // advance the serial. Without this setval, createInvite's first INSERT gets id=1
    // and fails on the primary key.
    'invites',
    'enrichment',
    'taste_traits',
    'recommendations',
    'profile_meta',
    'user_settings',
    'reader_archetypes',
    'user_directive',
    'usage_events',
    'taste_signal',
    'feedback',
    'feedback_prompt_state',
  ];
  for (const t of SEQ_TABLES) {
    // is_called=false + (max+1) — NOT the two-arg setval(seq, greatest(max,1)) idiom,
    // which is off-by-one for empty tables: with is_called defaulting to true, the
    // first insert into an unseeded table would get id=2 instead of id=1.
    await (db as any).$client.query(
      `select setval(pg_get_serial_sequence('${t}', 'id'), (select coalesce(max(id), 0) from ${t}) + 1, false)`
    );
  }
}
