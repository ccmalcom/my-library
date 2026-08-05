/**
 * Catalog client — port of mylibrary/catalog.py's fetch layer.
 * Differences from Python, both deliberate:
 *  - the disk cache becomes catalog_cache (Postgres), see catalogCache.ts;
 *  - throttling is per-invocation. Python's module-global monotonic gate is
 *    per-process; on Vercel each invocation is its own isolate, so cross-request
 *    spacing is not attempted. At invite-only single-user scale this matches
 *    Python's practical behavior (one process, one user at a time).
 */
import { cacheGet, cachePut } from './catalogCache';
import type { Db } from './db';

const USER_AGENT = 'MyLibrary/0.1 (personal book-analysis project)';
const MAX_RETRIES = 2;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const DEFAULT_REQ_PER_SEC = 8.0;

let lastCallAt = 0;
let throttleOverride: number | null = null;

/** Twin of catalog.set_rate — recommend() calls this in wave 3c. */
export function setRate(requestsPerSecond: number): void {
  throttleOverride = requestsPerSecond > 0 ? 1 / requestsPerSecond : 0;
}

function currentThrottle(): number {
  if (throttleOverride !== null) return throttleOverride;
  const rps = Number(process.env.MYLIBRARY_REQ_PER_SEC || '') || DEFAULT_REQ_PER_SEC;
  return rps > 0 ? 1 / rps : 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function throttle(): Promise<void> {
  const gap = currentThrottle() * 1000;
  const elapsed = Date.now() - lastCallAt;
  if (elapsed < gap) await sleep(gap - elapsed);
  lastCallAt = Date.now();
}

/** GET a JSON URL with Postgres cache + retry/backoff. Null on 404/failure. */
export async function getJson(db: Db, url: string, source: string): Promise<unknown | null> {
  const cached = await cacheGet(db, url);
  if (cached.hit) return cached.payload;

  let backoff = 1000;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    let resp: Response;
    try {
      resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    } catch {
      if (attempt === MAX_RETRIES) return null;
      await sleep(backoff); backoff *= 2;
      continue;
    }
    if (resp.status === 404) {
      await cachePut(db, url, source, null); // negative caching, same as Python
      return null;
    }
    if (RETRYABLE.has(resp.status)) {
      if (attempt === MAX_RETRIES) return null;
      const ra = resp.headers.get('Retry-After');
      const wait = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : backoff;
      await sleep(wait); backoff *= 2;
      continue;
    }
    let data: unknown;
    try { data = await resp.json(); } catch { return null; }
    await cachePut(db, url, source, data);
    return data;
  }
  return null;
}

const LANG_MAP: Record<string, string> = {
  eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de',
  ita: 'it', por: 'pt', rus: 'ru', jpn: 'ja', chi: 'zh', zho: 'zh',
  dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', pol: 'pl',
};

export function normLang(code: string | string[] | null | undefined): string | null {
  const raw = Array.isArray(code) ? (code.length ? code[0] : null) : code;
  if (!raw) return null;
  const c = String(raw).trim().toLowerCase();
  if (!c) return null;
  return LANG_MAP[c] ?? c.slice(0, 2);
}

export function yearFromGoogle(published: string | null | undefined): number | null {
  if (!published) return null;
  const n = parseInt(published.slice(0, 4), 10);
  return Number.isNaN(n) ? null : n;
}

export function isbn13FromGoogleItem(item: Record<string, any> | null): string | null {
  const ids = item?.volumeInfo?.industryIdentifiers ?? [];
  for (const id of ids) {
    if (id?.type === 'ISBN_13' && id?.identifier) return id.identifier;
  }
  return null;
}
