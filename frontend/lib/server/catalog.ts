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

interface HostCatalogStats {
  requests: number;
  rate_limited: number;
}

interface CatalogStats {
  requests: number;
  rate_limited: number;
  server_errors: number;
  network_errors: number;
  retries: number;
  by_host: Record<string, HostCatalogStats>;
}

let catalogStats: CatalogStats;

export function resetCatalogStats(): void {
  catalogStats = {
    requests: 0,
    rate_limited: 0,
    server_errors: 0,
    network_errors: 0,
    retries: 0,
    by_host: {},
  };
}

export function getCatalogStats(): CatalogStats {
  return {
    requests: catalogStats.requests,
    rate_limited: catalogStats.rate_limited,
    server_errors: catalogStats.server_errors,
    network_errors: catalogStats.network_errors,
    retries: catalogStats.retries,
    by_host: Object.fromEntries(
      Object.entries(catalogStats.by_host).map(([host, stats]) => [host, { ...stats }])
    ),
  };
}

resetCatalogStats();

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

  const host = new URL(url).host;
  const hostStats = (catalogStats.by_host[host] ??= { requests: 0, rate_limited: 0 });
  let backoff = 1000;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    catalogStats.requests += 1;
    hostStats.requests += 1;
    if (attempt > 1) catalogStats.retries += 1;
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // A test's httpReplay stub (helpers/httpReplay.ts) throws a distinctively-named
      // error for a URL with no fixture — that's a broken/incomplete test, not a
      // network failure, and retrying it into a silently degraded `null` would defeat
      // the harness's "any unfixtured URL fails loudly" guarantee. Duck-typed on
      // `.name` (not imported) so this file never depends on a test helper.
      if (err instanceof Error && err.name === 'HttpReplayMissError') throw err;
      catalogStats.network_errors += 1;
      if (attempt === MAX_RETRIES) return null;
      await sleep(backoff);
      backoff *= 2;
      continue;
    }
    if (resp.status === 404) {
      await cachePut(db, url, source, null); // negative caching, same as Python
      return null;
    }
    if (RETRYABLE.has(resp.status)) {
      if (resp.status === 429) {
        catalogStats.rate_limited += 1;
        hostStats.rate_limited += 1;
      } else {
        catalogStats.server_errors += 1;
      }
      if (attempt === MAX_RETRIES) return null;
      const ra = resp.headers.get('Retry-After');
      const wait = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : backoff;
      await sleep(wait);
      backoff *= 2;
      continue;
    }
    let data: unknown;
    try {
      data = await resp.json();
    } catch {
      return null;
    }
    await cachePut(db, url, source, data);
    return data;
  }
  return null;
}

const LANG_MAP: Record<string, string> = {
  eng: 'en',
  spa: 'es',
  fre: 'fr',
  fra: 'fr',
  ger: 'de',
  deu: 'de',
  ita: 'it',
  por: 'pt',
  rus: 'ru',
  jpn: 'ja',
  chi: 'zh',
  zho: 'zh',
  dut: 'nl',
  nld: 'nl',
  swe: 'sv',
  nor: 'no',
  dan: 'da',
  pol: 'pl',
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

// --- search_books: user-facing book search (add-a-book flow) --------------
// Ports of catalog.py:254-300, 336-363, 436-506, 512-614.

export interface Candidate {
  source: string;
  resolved_id: string | null;
  title: string | null;
  author: string | null;
  subjects: string[];
  description?: string | null;
  cover_url: string | null;
  year: number | null;
  isbn13?: string | null;
  language: string | null;
  raw: unknown;
}

export interface OpenLibraryIsbnCandidate {
  source: 'openlibrary';
  resolved_id: string | null;
  title: string | null;
  subjects: string[];
  cover_url: string | null;
  description: string | null;
  raw: { isbn: string; record: OpenLibraryBookRecord };
}

interface OpenLibraryBookRecord {
  key?: string;
  title?: string;
  subjects?: Array<{ name?: string }>;
  cover?: { medium?: string };
  description?: string | { value?: string };
  notes?: string | { value?: string };
}

interface OpenLibraryBooksResponse {
  [bibkey: string]: OpenLibraryBookRecord | undefined;
}

interface OpenLibraryEditionResponse {
  works?: Array<{ key?: string } | null>;
}

interface OpenLibrarySearchResponse {
  docs?: OpenLibraryDoc[];
}

interface OpenLibraryDoc {
  key?: string;
  title?: string;
  author_name?: string[];
  subject?: string[];
  cover_i?: number;
  first_publish_year?: number;
  language?: string[];
}

const SEARCH_FETCH = 25;

export async function googleBooksQuery(db: Db, q: string, maxResults = 5): Promise<Candidate[]> {
  const capped = Math.max(1, Math.min(maxResults, 40)); // Google caps at 40
  const params = new URLSearchParams({ q, maxResults: String(capped) });
  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (key) params.set('key', key);
  const url = `https://www.googleapis.com/books/v1/volumes?${params}`;
  const data = (await getJson(db, url, 'googlebooks')) as any;
  if (!data) return [];
  return (data.items ?? []).slice(0, capped).map((item: any) => {
    const info = item.volumeInfo ?? {};
    return {
      source: 'googlebooks',
      resolved_id: item.id ?? null,
      title: info.title ?? null,
      author: (info.authors ?? [null])[0] ?? null,
      subjects: info.categories ?? [],
      description: info.description ?? null,
      cover_url: (info.imageLinks ?? {}).thumbnail ?? null,
      year: yearFromGoogle(info.publishedDate),
      language: normLang(info.language),
      raw: item,
    };
  });
}

const OL_FIELDS = 'key,title,author_name,first_publish_year,cover_i,isbn,subject,language';

function olDocToCandidate(doc: any): Candidate {
  const coverId = doc.cover_i;
  const isbns: string[] = doc.isbn ?? [];
  return {
    source: 'openlibrary',
    resolved_id: doc.key ?? null,
    title: doc.title ?? null,
    author: (doc.author_name ?? [null])[0] ?? null,
    subjects: (doc.subject ?? []).slice(0, 25),
    cover_url: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : null,
    year: doc.first_publish_year ?? null,
    isbn13: isbns.find((i) => i.length === 13 && /^\d+$/.test(i)) ?? null,
    language: normLang(doc.language),
    raw: doc,
  };
}

export async function openlibraryQuery(
  db: Db,
  query: string,
  maxResults = 8
): Promise<Candidate[]> {
  const q = (query ?? '').trim();
  if (!q) return [];
  const params = new URLSearchParams({ q, limit: String(maxResults), fields: OL_FIELDS });
  const data = (await getJson(
    db,
    `https://openlibrary.org/search.json?${params}`,
    'openlibrary'
  )) as any;
  if (!data) return [];
  return (data.docs ?? []).slice(0, maxResults).map(olDocToCandidate);
}

export async function openlibraryTitle(
  db: Db,
  title: string,
  maxResults = 20
): Promise<Candidate[]> {
  const t = (title ?? '').trim();
  if (!t) return [];
  const params = new URLSearchParams({ title: t, limit: String(maxResults), fields: OL_FIELDS });
  const data = (await getJson(
    db,
    `https://openlibrary.org/search.json?${params}`,
    'openlibrary'
  )) as any;
  if (!data) return [];
  return (data.docs ?? []).slice(0, maxResults).map(olDocToCandidate);
}

export async function openlibraryByIsbn(
  db: Db,
  isbn: string
): Promise<OpenLibraryIsbnCandidate | null> {
  // Python builds this URL with an f-string, not httpx.QueryParams, so the colon
  // stays RAW: `bibkeys=ISBN:123`. URLSearchParams would emit `ISBN%3A123`, which
  // misses the recorded-HTTP fixture and splits the catalog_cache key. Keep it literal.
  const data = (await getJson(
    db,
    `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&jscmd=data&format=json`,
    'openlibrary'
  )) as OpenLibraryBooksResponse | null;
  const record = data?.[`ISBN:${isbn}`];
  if (!record) return null;
  const editionKey = record.key ?? null;
  let description = olDescription(record);
  if (!description && editionKey) {
    const workKey = await openlibraryEditionWorkKey(db, editionKey);
    if (workKey) description = await openlibraryWorkDescription(db, workKey);
  }
  return {
    source: 'openlibrary',
    resolved_id: editionKey,
    title: record.title ?? null,
    subjects: (record.subjects ?? []).flatMap((subject) => (subject.name ? [subject.name] : [])),
    cover_url: record.cover?.medium ?? null,
    description,
    raw: { isbn, record },
  };
}

async function openlibraryEditionWorkKey(db: Db, editionKey: string): Promise<string | null> {
  if (!editionKey) return null;
  const key = editionKey.replace(/^\/+/, '');
  const data = (await getJson(
    db,
    `https://openlibrary.org/${key}.json`,
    'openlibrary'
  )) as OpenLibraryEditionResponse | null;
  return data?.works?.[0]?.key ?? null;
}

export async function openlibraryEnrichmentSearch(
  db: Db,
  title: string,
  author: string | null
): Promise<Candidate[]> {
  const params = new URLSearchParams({ title, limit: '5' });
  if (author) params.set('author', author);
  const data = (await getJson(
    db,
    `https://openlibrary.org/search.json?${params}`,
    'openlibrary'
  )) as OpenLibrarySearchResponse | null;
  if (!data) return [];
  return (data.docs ?? []).slice(0, 5).map((doc) => {
    const coverId = doc.cover_i;
    return {
      source: 'openlibrary',
      resolved_id: doc.key ?? null,
      title: doc.title ?? null,
      author: (doc.author_name ?? [null])[0] ?? null,
      subjects: (doc.subject ?? []).slice(0, 25),
      cover_url: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : null,
      year: doc.first_publish_year ?? null,
      language: normLang(doc.language),
      raw: doc,
    };
  });
}

export async function googleBooksByIsbn(db: Db, isbn: string): Promise<Candidate | null> {
  return (await googleBooksQuery(db, `isbn:${isbn}`))[0] ?? null;
}

export async function googleBooksEnrichmentSearch(
  db: Db,
  title: string,
  author: string | null
): Promise<Candidate[]> {
  let query = `intitle:"${title}"`;
  if (author) query += ` inauthor:"${author}"`;
  return googleBooksQuery(db, query);
}

function normFull(s: string | null | undefined): string {
  return (
    (s ?? '')
      .toLowerCase()
      // Apostrophes elide to NOTHING, before the pass below turns punctuation into
      // spaces. Mapping them to a space splits a possessive into a stray one-letter
      // token -- "The Android's Dream" became `the android s dream`, so the natural
      // query `the androids dream` matched no band at all and scored 0. Readers
      // routinely omit the apostrophe; that must not change the ranking.
      .replace(/['’ʼ‘]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function searchDedupKey(title: string | null, author: string | null): string {
  const surname = author ? normFull(author).split(' ').slice(-1)[0] : '';
  return `${normFull(title)} ${surname}`;
}

function matchScore(query: string, cand: Candidate): number {
  const q = normFull(query);
  const title = normFull(cand.title);
  const author = normFull(cand.author);
  if (!q || !title) return 0;
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  const qTokens = new Set(q.split(' ').filter(Boolean));
  const tTokens = new Set(title.split(' ').filter(Boolean));

  // A query may name the title AND the author -- "lock in scalzi". Scoring the whole
  // query against one field at a time can never match such a query, so *Lock In* by
  // John Scalzi scored 0 while the study guide "Trivia-On-Books Lock in by John
  // Scalzi" scored 60 on the band below, every token being in its own title. Naming
  // the author made results strictly worse. So: peel the tokens the author accounts
  // for, then score what remains against the title. Banded above the title-only
  // bands, because matching both fields is a stronger signal than matching one.
  // Graded the same way as the title-only bands below, so that among the candidates
  // an author-bearing query matches, the tightest title still wins: "lock in scalzi"
  // must surface *Lock In* over *The Lock In Series*, which otherwise ties it and
  // takes first place on the year tiebreaker.
  if (author) {
    const aTokens = new Set(author.split(' ').filter(Boolean));
    // qTokens is built from q.split, and JS Sets iterate in insertion order, so the
    // remainder stays in the order the reader typed it.
    const rest = [...qTokens].filter((t) => !aTokens.has(t));
    const usedAuthor = rest.length < qTokens.size;
    if (usedAuthor && rest.length) {
      const restText = rest.join(' ');
      if (title === restText) return 95;
      if (title.startsWith(restText)) return 92;
      if (rest.every((t) => tTokens.has(t))) return 90;
    }
  }

  if (qTokens.size && [...qTokens].every((t) => tTokens.has(t))) return 60;
  if (title.includes(q)) return 40;
  if (author && author.includes(q)) return 20;
  return 0;
}

function volumeNumber(title: string | null): number | null {
  if (!title) return null;
  const m = title.toLowerCase().match(/(?:#|book|vol\.?|volume)\s*(\d{1,3})/);
  return m ? parseInt(m[1], 10) : null;
}

function applySeriesGrouping(query: string, ranked: Candidate[]): Candidate[] {
  const q = normFull(query);
  if (!q) return ranked;
  const idx = ranked
    .map((c, i) => [i, c] as const)
    .filter(([, c]) => normFull(c.title).startsWith(q))
    .map(([i]) => i);
  if (idx.length < 3) return ranked;
  const cluster = idx.map((i) => ranked[i]);
  cluster.sort((a, b) => {
    const va = volumeNumber(a.title) ?? 1e6,
      vb = volumeNumber(b.title) ?? 1e6;
    if (va !== vb) return va - vb;
    return normFull(a.title) < normFull(b.title)
      ? -1
      : normFull(a.title) > normFull(b.title)
        ? 1
        : 0;
  });
  const anchor = idx[0];
  const inCluster = new Set(idx);
  const rest = ranked.filter((_, i) => !inCluster.has(i));
  return [...rest.slice(0, anchor), ...cluster, ...rest.slice(anchor)];
}

function mergeInto(keep: Candidate, extra: Candidate): void {
  for (const f of ['cover_url', 'isbn13', 'author', 'description', 'year'] as const) {
    if (!(keep as any)[f] && (extra as any)[f]) (keep as any)[f] = (extra as any)[f];
  }
  if (!keep.subjects?.length && extra.subjects?.length) keep.subjects = extra.subjects;
}

export async function searchBooks(db: Db, query: string, maxResults = 8): Promise<Candidate[]> {
  const q = (query ?? '').trim();
  if (!q) return [];

  const results: Candidate[] = [];
  for (const c of await googleBooksQuery(db, q, SEARCH_FETCH)) {
    c.isbn13 = isbn13FromGoogleItem(c.raw as any);
    results.push(c);
  }
  results.push(...(await openlibraryQuery(db, q, SEARCH_FETCH)));
  for (const c of await googleBooksQuery(db, `intitle:"${q}"`, SEARCH_FETCH)) {
    c.isbn13 = isbn13FromGoogleItem(c.raw as any);
    results.push(c);
  }
  results.push(...(await openlibraryTitle(db, q, SEARCH_FETCH)));

  const byKey = new Map<string, Candidate>();
  const byIsbn = new Map<string, Candidate>();
  const deduped: Candidate[] = [];
  for (const cand of results) {
    if (!cand.title) continue;
    const isbn = cand.isbn13;
    if (isbn && byIsbn.has(isbn)) {
      mergeInto(byIsbn.get(isbn)!, cand);
      continue;
    }
    const key = searchDedupKey(cand.title, cand.author);
    if (byKey.has(key)) {
      mergeInto(byKey.get(key)!, cand);
      continue;
    }
    byKey.set(key, cand);
    if (isbn) byIsbn.set(isbn, cand);
    deduped.push(cand);
  }

  // Python sorts by the tuple (match, hasCover, hasIsbn, year) DESCENDING.
  // Python's sort is STABLE, so equal keys keep insertion order — Array.sort is
  // also stable in modern V8, so returning 0 for ties reproduces it exactly.
  deduped.sort((a, b) => {
    const ka = [matchScore(query, a), a.cover_url ? 1 : 0, a.isbn13 ? 1 : 0, a.year ?? 0];
    const kb = [matchScore(query, b), b.cover_url ? 1 : 0, b.isbn13 ? 1 : 0, b.year ?? 0];
    for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return 0;
  });
  return applySeriesGrouping(query, deduped).slice(0, maxResults);
}

// --- Discovery retrieval (the two-stage recommender) -----------------------
// Ports of catalog.py:215-236, 403-419, 617-649. Unlike the enrichment helpers
// above (which resolve a KNOWN book), these surface NEW candidates and return the
// same normalized Candidate shape, so recommendRun.ts treats every source uniformly.
// catalog.py::googlebooks_query needs no wrapper here — googleBooksQuery already is it.

export async function googleBooksSubject(
  db: Db,
  subject: string,
  maxResults = 10
): Promise<Candidate[]> {
  return googleBooksQuery(db, `subject:"${subject}"`, maxResults);
}

export async function googleBooksAuthor(
  db: Db,
  author: string,
  maxResults = 10
): Promise<Candidate[]> {
  return googleBooksQuery(db, `inauthor:"${author}"`, maxResults);
}

/** catalog.py::_ol_subject_slug — Open Library's subjects API keys on lowercase,
 *  underscore-joined slugs. Python's `.strip("_")` removes leading AND trailing runs. */
function olSubjectSlug(subject: string): string {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export async function openlibrarySubject(
  db: Db,
  subject: string,
  maxResults = 10
): Promise<Candidate[]> {
  const slug = olSubjectSlug(subject);
  if (!slug) return [];
  const url = `https://openlibrary.org/subjects/${slug}.json?limit=${maxResults}`;
  const data = (await getJson(db, url, 'openlibrary')) as any;
  if (!data) return [];
  return (data.works ?? []).slice(0, maxResults).map((work: any): Candidate => {
    const coverId = work.cover_id;
    return {
      source: 'openlibrary',
      resolved_id: work.key ?? null,
      title: work.title ?? null,
      // Python: ((work.get("authors") or [{}])[0].get("name") if work.get("authors") else None)
      // -> an empty or missing authors list yields None, as does a first entry with no name.
      author: work.authors?.length ? (work.authors[0]?.name ?? null) : null,
      // Python echoes the CALLER's subject string, not the slug.
      subjects: [subject],
      cover_url: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : null,
      year: work.first_publish_year ?? null,
      // Python's dict has no "language" key at all, so cand.get("language") is None
      // and _language_ok always passes these through. null reproduces that.
      language: null,
      raw: work,
    };
  });
}

/** catalog.py::_ol_description — description wins over notes; a typed dict unwraps to .value. */
function olDescription(record: any): string | null {
  const desc = record?.description || record?.notes;
  if (desc && typeof desc === 'object' && !Array.isArray(desc)) return desc.value ?? null;
  return typeof desc === 'string' ? desc : null;
}

/**
 * Fetch a description from an OL Work record (e.g. '/works/OL82584W').
 * OL Edition/ISBN records rarely carry descriptions; the Work record is the
 * authoritative place. Cached in catalog_cache, so repeat calls are free.
 */
export async function openlibraryWorkDescription(db: Db, workKey: string): Promise<string | null> {
  if (!workKey) return null;
  const key = workKey.replace(/^\/+/, ''); // Python's lstrip("/")
  const data = await getJson(db, `https://openlibrary.org/${key}.json`, 'openlibrary');
  if (!data) return null;
  return olDescription(data);
}
