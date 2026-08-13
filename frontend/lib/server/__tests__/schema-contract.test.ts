import { getTableColumns, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '../schema';
import contract from './fixtures/schema-contract.json';
import { makeTestDb } from './helpers/pglite';

/**
 * Every table Node writes in production, plus `invites` (Task 6 adds the first
 * Node write) and `usage_events` (wave 5b's cutover gives Node the INSERT).
 * Derived from: grep -rnoE "\.(insert|update)\(([a-zA-Z]+\.)?[a-zA-Z]+\)" \
 *   frontend/lib frontend/app --include=*.ts | grep -v "__tests__"
 * Keep filenames in that grep -- `grep -h` strips them, which silently lets
 * test-only writes count as production ones.
 */
const WRITTEN_TABLES = [
  'books',
  'enrichment',
  'enrich_jobs',
  'feedback',
  'feedback_prompt_state',
  'invites',
  'profile_meta',
  'reader_archetypes',
  'recommendations',
  'taste_signal',
  'taste_traits',
  'usage_events',
  'user_directive',
  'user_settings',
] as const;

type ColumnContract = { nullable: boolean; serverDefault: string | null };
type Contract = Record<string, Record<string, ColumnContract>>;

describe('PGlite mirror matches the Alembic-owned schema', () => {
  for (const table of WRITTEN_TABLES) {
    it(`${table}: every NOT NULL column without a server default is NOT NULL without a default`, async () => {
      const { db, close } = await makeTestDb();
      try {
        // sql`` tag, not a bare string — this is how claimJob() in
        // enrichmentJobs.ts issues raw SQL through drizzle in this codebase.
        const rows = (await db.execute(sql`
          select column_name, is_nullable, column_default
            from information_schema.columns
           where table_name = ${table}
        `)) as unknown as Array<{
          column_name: string;
          is_nullable: string;
          column_default: string | null;
        }>;
        const actual = Array.isArray(rows) ? rows : (rows as { rows: typeof rows }).rows;
        expect(actual.length).toBeGreaterThan(0);

        const expected = (contract as Contract)[table];
        expect(expected, `${table} missing from schema-contract.json`).toBeTruthy();

        // Compare the column SETS first. Checking only the columns the mirror happens to
        // declare means a column missing from the mirror — the exact shape of a migration
        // the Node side never mirrored — passes silently, and an insert against the real
        // table then fails on a column no test ever knew about.
        expect(
          actual.map((row) => row.column_name).sort(),
          `${table}: PGlite mirror column set differs from the models`
        ).toEqual(Object.keys(expected).sort());

        for (const row of actual) {
          const spec = expected[row.column_name];
          expect(
            { column: row.column_name, nullable: row.is_nullable === 'YES' },
            `${table}.${row.column_name} nullability`
          ).toEqual({ column: row.column_name, nullable: spec.nullable });

          // Serial primary keys legitimately carry a nextval() default on both sides.
          const isSerial = (row.column_default ?? '').startsWith('nextval(');
          if (spec.serverDefault === null && !isSerial) {
            expect(
              row.column_default,
              `${table}.${row.column_name} has a default the real schema does not`
            ).toBeNull();
          }
        }
      } finally {
        await close();
      }
    });
  }
});

/**
 * The PGlite check above only covers the test mirror. The Drizzle table declaration is a
 * SECOND stand-in for the same Alembic-owned schema, and it is the one that decides what
 * SQL an insert actually emits: a column carrying `.default()` that the real table does
 * not have makes drizzle emit `default` for an omitted value, which Postgres rejects.
 * That is exactly how POST /enrich/start shipped broken, and `usage_events` still had the
 * identical shape after that fix because nothing asserted this half.
 *
 * `tsc` cannot substitute for this: a notNull()-less column is optional in $inferInsert,
 * so an insert omitting a NOT NULL column type-checks cleanly.
 */
const DRIZZLE_TABLES: Record<string, unknown> = {
  books: schema.books,
  enrichment: schema.enrichment,
  enrich_jobs: schema.enrichJobs,
  feedback: schema.feedback,
  feedback_prompt_state: schema.feedbackPromptState,
  invites: schema.invites,
  profile_meta: schema.profileMeta,
  reader_archetypes: schema.readerArchetypes,
  recommendations: schema.recommendations,
  taste_signal: schema.tasteSignal,
  taste_traits: schema.tasteTraits,
  usage_events: schema.usageEvents,
  user_directive: schema.userDirective,
  user_settings: schema.userSettings,
};

describe('Drizzle schema matches the Alembic-owned schema', () => {
  for (const table of WRITTEN_TABLES) {
    it(`${table}: declares no default the real table lacks, and matches nullability`, () => {
      const expected = (contract as Contract)[table];
      expect(expected, `${table} missing from schema-contract.json`).toBeTruthy();

      const columns = getTableColumns(
        DRIZZLE_TABLES[table] as Parameters<typeof getTableColumns>[0]
      );

      // Same reasoning as the PGlite block: iterating only declared columns lets a
      // missing, renamed, or extra column pass. Compare the sets before the per-column
      // checks so drift in the column list fails here rather than at runtime.
      expect(
        Object.values(columns)
          .map((column) => column.name)
          .sort(),
        `${table}: Drizzle column set differs from the models`
      ).toEqual(Object.keys(expected).sort());

      for (const column of Object.values(columns)) {
        const spec = expected[column.name];

        // Serial primary keys legitimately carry a nextval() default on both sides.
        if (column.primary && column.hasDefault) continue;

        expect(
          { column: column.name, nullable: !column.notNull },
          `${table}.${column.name} nullability disagrees with the models`
        ).toEqual({ column: column.name, nullable: spec.nullable });

        if (spec.serverDefault === null) {
          expect(
            { column: column.name, hasDefault: column.hasDefault },
            `${table}.${column.name} declares a default the real table does not have`
          ).toEqual({ column: column.name, hasDefault: false });
        }
      }
    });
  }
});
