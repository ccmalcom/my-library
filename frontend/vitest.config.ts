import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['lib/server/**/*.test.ts', 'app/api/**/*.test.ts'],
    environment: 'node',
    // Many test files spin up an in-memory PGlite (WASM Postgres) instance
    // per test. Under full-suite parallel load, enough of these running at
    // once causes contention that can push individual tests past vitest's
    // 5000ms default — not a logic bug (isolated runs are always clean).
    // Generous timeout + a capped worker pool keeps that headroom without
    // giving up file-level parallelism (fileParallelism stays on).
    testTimeout: 30000,
    // Default pool is 'forks' as of Vitest 4; `maxWorkers` is the top-level
    // replacement for the old `poolOptions.forks.maxForks` /
    // `poolOptions.threads.maxThreads` (removed in the Vitest 4 pool rework).
    maxWorkers: 4,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname) },
  },
});
