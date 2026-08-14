import { defineConfig } from 'drizzle-kit';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';

// Migration mode (wave: half-star ratings). Alembic is frozen -- it owned
// migrations while Python was live, and `start.sh` applied them on Railway
// boot. Railway is paused, so nothing auto-applies anything: `npm run
// db:migrate` is run by hand. The Vercel build must NEVER run migrations
// (builds run per-deploy and would race).
loadEnv({ path: path.resolve(__dirname, '..', '.env') });

export default defineConfig({
  dialect: 'postgresql',
  schema: './lib/server/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
