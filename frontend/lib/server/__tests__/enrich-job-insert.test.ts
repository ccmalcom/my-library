import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Wave 4c-2 regression guard. `enrich_jobs.progress`/`total` are NOT NULL.
 * Production carries DEFAULT 0, but a create_all-lineage DB and the PGlite
 * mirror do not -- drizzle omitting these columns from the INSERT is what
 * 500'd POST /enrich/start. schema.ts declares .default(0) for baseline
 * fidelity ONLY; the explicit values must stay.
 */
describe('enrich job insert', () => {
  it('passes progress and total explicitly', () => {
    const src = readFileSync(path.join(__dirname, '..', 'enrichmentJobs.ts'), 'utf8');
    expect(src).toMatch(/progress:\s*0/);
    expect(src).toMatch(/total:\s*0/);
  });
});
