/**
 * Wire-format helpers for FastAPI parity.
 * Drizzle timestamps (mode: 'string') come back as '2026-07-01 12:00:00[.ffffff]';
 * Pydantic serializes the same stored value as '2026-07-01T12:00:00[.ffffff]'.
 */

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
export function effectiveRating(
  appRating: number | null,
  goodreadsRating: number
): number | null {
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
