import { describe, expect, it } from 'vitest';
import type { NewJobValues } from '../enrichmentJobs';

/**
 * Wave 4c-2 regression guard. `enrich_jobs.progress`/`total` are NOT NULL.
 * Production carries DEFAULT 0 (the 0003 lineage) and so do the baseline and
 * the PGlite mirror, but a create_all-lineage database does NOT -- and drizzle
 * omitting these columns from the INSERT is what 500'd POST /enrich/start.
 *
 * The guard is `NewJobValues`, which declares both as REQUIRED. That is why
 * schema.ts can carry .default(0) for baseline fidelity (without it,
 * drizzle-kit generate emits a spurious DROP DEFAULT) without reopening the
 * bug: createOrGetActiveJob types its insert payload against this interface,
 * not against drizzle's `$inferInsert` -- and `$inferInsert` IS what .default()
 * would loosen. Verified by deleting `progress: 0` from the call site:
 * tsc fails with "missing the following properties ... progress, total".
 *
 * So the real check below is the @ts-expect-error, enforced by `npm run
 * type-check`. Make either field optional and this file stops compiling,
 * because the suppressed error disappears.
 */
describe('enrich job insert', () => {
  it('requires progress and total on NewJobValues', () => {
    // @ts-expect-error progress and total must stay required -- see above.
    const missing: NewJobValues = {
      jobId: 'job-1',
      userId: 'local',
      status: 'pending',
      force: false,
      runLimit: null,
    };
    expect(missing.jobId).toBe('job-1');

    const complete: NewJobValues = {
      jobId: 'job-2',
      userId: 'local',
      status: 'pending',
      progress: 0,
      total: 0,
      force: false,
      runLimit: null,
    };
    expect(complete.progress).toBe(0);
    expect(complete.total).toBe(0);
  });
});
