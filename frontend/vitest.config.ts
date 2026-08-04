import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['lib/server/**/*.test.ts', 'app/api/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: { '@': path.resolve(__dirname) },
  },
});
