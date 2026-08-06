/**
 * Wire-format helpers for FastAPI parity.
 * Drizzle timestamps (mode: 'string') come back as '2026-07-01 12:00:00[.ffffff]';
 * Pydantic serializes the same stored value as '2026-07-01T12:00:00[.ffffff]'.
 */
import { ApiError } from './errors';

export function tsToIso(ts: string | null): string | null {
  return ts === null ? null : ts.replace(' ', 'T');
}

/**
 * Python str.title() port: an alphabetic char is uppercased when the previous
 * char is non-alphabetic, lowercased otherwise. Reproduces quirks like
 * "Children'S" on purpose — parity beats prettiness.
 */
export function pyTitle(s: string): string {
  let out = '';
  let prevAlpha = false;
  for (const ch of s) {
    const isAlpha = ch.toLowerCase() !== ch.toUpperCase();
    out += isAlpha ? (prevAlpha ? ch.toLowerCase() : ch.toUpperCase()) : ch;
    prevAlpha = isAlpha;
  }
  return out;
}

/** Mirror of Book.effective_rating: app_rating wins; goodreads_rating 0 = unrated. */
export function effectiveRating(appRating: number | null, goodreadsRating: number): number | null {
  if (appRating !== null && appRating !== undefined) return appRating;
  return goodreadsRating || null;
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

/** FastAPI bool query-param coercion (subset actually seen from our frontend). */
export function parseBoolParam(v: string | undefined): boolean {
  if (!v) return false;
  return ['true', '1', 'yes', 'on'].includes(v.toLowerCase());
}

/** Naive-UTC storage format matching drizzle timestamp mode 'string' reads.
 *  Python stores microseconds; ms precision is a documented invisible deviation. */
export function utcnowTs(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

/** Python date.today() twin (server runs UTC). */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Python repr of a list of strings: ['a', 'b'] — for 422 detail parity. */
export function pyList(xs: string[]): string {
  return '[' + xs.map((x) => `'${x}'`).join(', ') + ']';
}

/**
 * A number Python would render as a float. JS has one numeric type, so an
 * integral `double precision` value (1.0) is indistinguishable from an int (1)
 * and `JSON.stringify` drops the decimal point — which breaks byte-exact prompt
 * parity for `inference_confidence` and `user_weight`. Wrap those with pyFloat().
 */
export interface PyFloat {
  __pyFloat__: number;
}

export function pyFloat(n: number): PyFloat {
  return { __pyFloat__: n };
}

export function isPyFloat(v: unknown): v is PyFloat {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as PyFloat).__pyFloat__ === 'number'
  );
}

/**
 * Python `repr()` of a float. Both languages emit the shortest round-tripping
 * decimal, so the only routine difference is the trailing `.0` on integral
 * values. Exponent-form values (|x| >= 1e21 or very small) are returned as JS
 * renders them — Python writes `1e+21`/`1e-07` where JS writes `1e+21`/`1e-7`.
 * No column in this codebase carries such a value; if one ever does, extend here.
 */
export function pyFloatStr(n: number): string {
  if (Object.is(n, -0)) return '-0.0';
  const s = String(n);
  if (s.includes('e') || s.includes('.') || !Number.isFinite(n)) return s;
  return `${s}.0`;
}

/** Python repr() of a str: single-quoted unless that would need escaping. */
function pyStrRepr(s: string): string {
  const esc = s.replace(/\\/g, '\\\\');
  if (esc.includes("'") && !esc.includes('"')) return `"${esc}"`;
  return `'${esc.replace(/'/g, "\\'")}'`;
}

/**
 * Python `str()` of a value, for prompts that f-string-interpolate a container
 * (`f"Tier sizes: {counts}"`, `f"CHANGED BOOK IDS ...: {changed_ids}"`). This is
 * repr, NOT JSON: single-quoted strings, None/True/False, `', '` separators.
 * Mappings must be a Map so insertion order survives (see pyJsonDumps).
 */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (isPyFloat(v)) return pyFloatStr(v.__pyFloat__);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return pyStrRepr(v);
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  if (v instanceof Map) {
    return (
      '{' +
      [...v.entries()].map(([k, val]) => `${pyRepr(k)}: ${pyRepr(val)}`).join(', ') +
      '}'
    );
  }
  if (typeof v === 'object') {
    return (
      '{' +
      Object.entries(v as Record<string, unknown>)
        .map(([k, val]) => `${pyStrRepr(k)}: ${pyRepr(val)}`)
        .join(', ') +
      '}'
    );
  }
  return 'None';
}

/**
 * Twin of Python's `json.dumps(v, ensure_ascii=False)`: a space after `:` and
 * after `,`, unlike `JSON.stringify`'s compact separators. Recursive rather than
 * a regex patch over `JSON.stringify` output, since a regex would also rewrite
 * `:`/`,` characters that happen to appear inside string values.
 */
export function pyJsonDumps(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (isPyFloat(v)) return pyFloatStr(v.__pyFloat__);
  if (typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(pyJsonDumps).join(', ') + ']';
  // A Map is the only mapping whose key order is trustworthy: V8 enumerates
  // integer-like object keys ('5', '4', '3') in ascending numeric order, which
  // would silently reorder json.dumps(tiers) away from Python's insertion order.
  if (v instanceof Map) {
    const entries = [...v.entries()].map(
      ([k, val]) => `${JSON.stringify(String(k))}: ${pyJsonDumps(val)}`
    );
    return '{' + entries.join(', ') + '}';
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).map(
      ([k, val]) => `${JSON.stringify(k)}: ${pyJsonDumps(val)}`
    );
    return '{' + entries.join(', ') + '}';
  }
  return 'null';
}

/**
 * Validates a route `[id]` param the way FastAPI's `id: int` path converter would:
 * a non-numeric id gets a clean 422 instead of reaching Postgres as `Number(id)`
 * NaN, which the driver rejects with an uncaught "invalid input syntax for type
 * integer" error that withApi can only surface as a generic 500.
 */
export function parseIdParam(id: string): number {
  const n = Number(id);
  if (!Number.isInteger(n)) {
    throw new ApiError(422, 'validation error: id must be an integer');
  }
  return n;
}
