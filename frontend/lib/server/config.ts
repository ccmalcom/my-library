/**
 * Key/value app config stored in Postgres (app_config table).
 * First consumer: the admin-toggleable debug_mode flag, cached for 30s so the
 * per-request debug check costs one query every 30s, not one per request.
 */
import { sql } from 'drizzle-orm';
import type { Db } from './db';

export const DEBUG_MODE_KEY = 'debug_mode';
const DEBUG_CACHE_TTL_MS = 30_000;

let debugCache: { value: boolean; atMs: number } | null = null;

export async function getConfigValue(db: Db, key: string): Promise<unknown | null> {
  const rows = await db.execute(sql`select value from app_config where key = ${key}`);
  const list = Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows;
  const first = list[0] as { value: unknown } | undefined;
  return first === undefined ? null : first.value;
}

export async function setConfigValue(db: Db, key: string, value: unknown): Promise<void> {
  await db.execute(sql`
    insert into app_config (key, value, updated_at)
    values (${key}, ${JSON.stringify(value)}::jsonb, current_timestamp)
    on conflict (key) do update
      set value = excluded.value, updated_at = current_timestamp
  `);
  if (key === DEBUG_MODE_KEY) _resetDebugCache();
}

export async function isDebugMode(db: Db, nowMs: number = Date.now()): Promise<boolean> {
  if (debugCache && nowMs - debugCache.atMs < DEBUG_CACHE_TTL_MS) return debugCache.value;
  const value = (await getConfigValue(db, DEBUG_MODE_KEY)) === true;
  debugCache = { value, atMs: nowMs };
  return value;
}

export function _resetDebugCache(): void {
  debugCache = null;
}
