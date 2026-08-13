import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FUNCTION_CEILING_SECONDS } from '@/lib/server/enrichmentJobs';

// Next.js reads route segment config with a static analyzer, so `maxDuration` must be a literal.
// Wave 4c-2 shipped `export const maxDuration = FUNCTION_CEILING_SECONDS` on these two routes.
// That type-checks, lints, and unit-tests clean, but fails `next build` during "Collecting page
// data" with "Invalid segment configuration export detected" — and Next prints no detail line
// naming the offending file. Every Vercel preview deployment from commit 107b5c8 onward was red
// because of it, while all five local gates stayed green: none of them runs `next build`.
//
// These assertions deliberately read the SOURCE TEXT rather than importing the route's value.
// Importing would still observe 300 if someone reintroduced the imported binding, so only a
// source-level check catches the shape that actually breaks the build.

const ROUTES = ['./start/route.ts', './tick/route.ts'] as const;

describe('enrich route maxDuration segment config', () => {
  it.each(ROUTES)('%s exports maxDuration as a numeric literal', (rel) => {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');

    const match = src.match(/^export const maxDuration = (.+);$/m);
    expect(match, `no top-level maxDuration export found in ${rel}`).not.toBeNull();

    const value = match![1];
    expect(
      value,
      `maxDuration in ${rel} must be a numeric literal, not an identifier — ` +
        `an imported binding fails next build`
    ).toMatch(/^\d+$/);

    expect(Number(value), `maxDuration in ${rel} has drifted from FUNCTION_CEILING_SECONDS`).toBe(
      FUNCTION_CEILING_SECONDS
    );
  });
});
