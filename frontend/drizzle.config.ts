import { defineConfig } from 'drizzle-kit';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';

// Introspection-only config. Alembic owns migrations until cutover — never run
// drizzle-kit generate/migrate/push with this config, only `drizzle-kit pull`.
loadEnv({ path: path.resolve(__dirname, '..', '.env') });

export default defineConfig({
  dialect: 'postgresql',
  out: './lib/server/drizzle-pull',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
