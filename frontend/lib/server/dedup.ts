/** Ports of mylibrary/enrich.py dedup helpers. Keep byte-identical semantics. */

export function normalizeTitle(t: string | null): string {
  if (!t) return '';
  let s = t.toLowerCase();
  s = s.split(':')[0]; // drop subtitle
  s = s.replace(/\(.*?\)/g, ''); // drop parentheticals (editions, etc.)
  s = s.replace(/[^a-z0-9 ]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

export function surname(author: string | null): string {
  if (!author) return '';
  const parts = normalizeTitle(author).split(' ');
  return parts[parts.length - 1];
}

/** Like normalizeTitle but keeps the subtitle, for same-work equality checks. */
export function normalizeFullTitle(t: string | null): string {
  if (!t) return '';
  let s = t.toLowerCase();
  s = s.replace(/\(.*?\)/g, '');
  s = s.replace(/[^a-z0-9 ]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Same work: equal full titles, or one is the other's bare pre-colon base
 *  (edition variant). Two different subtitles on a shared base are different works. */
export function sameWork(
  titleA: string | null, authorA: string | null,
  titleB: string | null, authorB: string | null
): boolean {
  if (surname(authorA) !== surname(authorB)) return false;
  const fullA = normalizeFullTitle(titleA);
  const fullB = normalizeFullTitle(titleB);
  if (fullA === fullB) return true;
  return fullA === normalizeTitle(titleB) || fullB === normalizeTitle(titleA);
}
