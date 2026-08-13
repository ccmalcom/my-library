/**
 * Catalog HTTP response cache on Postgres (catalog_cache, from wave 0's migration).
 * Replaces mylibrary/catalog.py's {data_dir}/cache/{sha1(url)}.json disk cache.
 * Key stays sha1(url) so entries are cross-checkable with the Python cache
 * during migration. Entries never expire — book metadata is stable (per spec).
 */
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from './db';

export function cacheKeyFor(url: string): string {
  return createHash('sha1').update(url, 'utf8').digest('hex');
}

export interface CacheLookup {
  /** True when a row exists — including a negatively-cached 404 (payload null). */
  hit: boolean;
  payload: unknown;
}

export async function cacheGet(db: Db, url: string): Promise<CacheLookup> {
  const rows = await db
    .select({ payload: schema.catalogCache.payload })
    .from(schema.catalogCache)
    .where(eq(schema.catalogCache.cacheKey, cacheKeyFor(url)));
  if (!rows.length) return { hit: false, payload: null };
  return { hit: true, payload: rows[0].payload ?? null };
}

export async function cachePut(
  db: Db,
  url: string,
  source: string,
  payload: unknown
): Promise<void> {
  const key = cacheKeyFor(url);
  // jsonb cannot store a bare SQL NULL and still mean "JSON null" — store the
  // JSON null literal so a 404 round-trips as {hit:true, payload:null}.
  await db.execute(sql`
    insert into catalog_cache (cache_key, source, payload, fetched_at)
    values (${key}, ${source}, ${JSON.stringify(payload ?? null)}::jsonb, now())
    on conflict (cache_key) do update
      set payload = excluded.payload, source = excluded.source, fetched_at = now()
  `);
}
