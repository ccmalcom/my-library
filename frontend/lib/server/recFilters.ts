/**
 * Pure candidate predicates ported from mylibrary/recommend.py. No database, no
 * network. Shared by /recommend (wave 3c-1), /books/{id}/similar (3c-2) and
 * /discover (3c-3), which is why they live apart from the orchestrators.
 */
import { normalizeTitle, surname } from './dedup';
import { titleSim, STRONG_SIM } from './similarity';

/** recommend.py:59-60 tuning knobs. */
export const MAX_PER_AUTHOR = 2;
export const MAX_LIBRARY_AUTHOR_SHARE = 0.4;

/**
 * recommend._dedup_key. Python returns a (normalized title, surname) TUPLE and uses
 * it as a set/dict key; JS has no tuple keys, so it is flattened with a NUL
 * separator. Safe because normalizeTitle and surname emit only [a-z0-9 ], so no
 * title/author pair can forge a different pair's key.
 */
export function dedupKey(title: string | null, author: string | null): string {
  return `${normalizeTitle(title)}\u0000${surname(author)}`;
}

/** Python's `key == ("", "")` guard in _assemble. */
export const EMPTY_DEDUP_KEY = dedupKey(null, null);

/** recommend._allowed_languages: an empty library language set means English only. */
export function allowedLanguages(libraryLanguages: Set<string>): Set<string> {
  return libraryLanguages.size ? new Set(libraryLanguages) : new Set(['en']);
}

/** recommend._language_ok: unknown language always passes; a known one must be allowed. */
export function languageOk(lang: string | null | undefined, allowed: Set<string>): boolean {
  if (!lang) return true;
  return allowed.has(lang);
}

// Not global: a /g regex carries lastIndex between .exec calls and would return
// null on every other invocation.
const SERIES_PAREN_RE = /\(([^()]+?),\s*(?:#|book\s+|vol\.?\s+|volume\s+)(\d{1,3})\)/i;

/**
 * recommend._series_info: pull (series name, position) out of a Goodreads/OL-style
 * trailing parenthetical like '(Mistborn, #6)' or '(The Stormlight Archive, Book 2)'.
 * Most books carry no such marker; null just means we cannot tell from the title.
 */
export function seriesInfo(title: string | null): [string, number] | null {
  if (!title) return null;
  const m = SERIES_PAREN_RE.exec(title);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, ' ').trim().toLowerCase();
  if (!name) return null;
  return [name, parseInt(m[2], 10)];
}

/**
 * recommend._series_ok: block book N (N > 1) of a series the reader has not started.
 * Titles with no detectable marker always pass -- dropping candidates on a guess would
 * silently remove unrelated standalones too.
 */
export function seriesOk(title: string | null, librarySeries: Map<string, Set<number>>): boolean {
  const info = seriesInfo(title);
  if (info === null) return true;
  const [name, position] = info;
  if (position <= 1) return true;
  const owned = librarySeries.get(name);
  if (!owned) return false;
  for (const p of owned) if (p < position) return true;
  return false;
}

/**
 * recommend._fuzzy_duplicate: catches same-work editions that survive the exact
 * (title, author) dedup key -- an abridged or reissued edition credited to a
 * different "author". Author agreement is deliberately NOT required.
 *
 * Python iterates `set(library_titles)`, whose order is arbitrary; irrelevant here
 * because the result is a short-circuiting `any()`.
 */
export function fuzzyDuplicate(title: string | null, libraryTitles: string[]): boolean {
  if (!title) return false;
  for (const lt of new Set(libraryTitles)) {
    if (titleSim(title, lt) >= STRONG_SIM) return true;
  }
  return false;
}

const LEARNER_EDITION_MARKERS = [
  'graded reader',
  'for foreign speakers',
  'for esl',
  'for efl',
  'esl reader',
  'efl reader',
  'english language learners',
  'simplified english edition',
  "learner's edition",
  'students of english',
];

/** recommend._is_learner_edition: graded-reader / ESL reissues are dropped outright. */
export function isLearnerEdition(cand: {
  title?: string | null;
  subjects?: string[] | null;
}): boolean {
  const haystack = [cand.title || '', ...(cand.subjects ?? [])].join(' | ').toLowerCase();
  return LEARNER_EDITION_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * recommend._apply_author_caps: cap per-author candidates and the overall share from
 * authors already in the library, so small libraries do not return same-author clones.
 *
 * The library-author trim REORDERS (new authors first). Python notes that capPool
 * re-sorts by retrieval_pool downstream, so the ordering is absorbed -- but it is
 * still observable when the pool is already under the cap, so it is reproduced exactly.
 */
export function applyAuthorCaps<T extends { author?: string | null }>(
  candidates: T[],
  libraryAuthors: Set<string>
): T[] {
  const perAuthor = new Map<string, number>();
  const kept: T[] = [];
  for (const c of candidates) {
    const a = surname(c.author ?? null);
    if (a) {
      const n = perAuthor.get(a) ?? 0;
      if (n >= MAX_PER_AUTHOR) continue;
      perAuthor.set(a, n + 1);
    }
    kept.push(c);
  }

  const total = kept.length;
  if (!total) return kept;
  const lib = kept.filter((c) => libraryAuthors.has(surname(c.author ?? null)));
  const non = kept.filter((c) => !libraryAuthors.has(surname(c.author ?? null)));
  // Python's int() truncates toward zero, unlike Math.round.
  const maxLib = Math.max(1, Math.trunc(total * MAX_LIBRARY_AUTHOR_SHARE));
  if (lib.length > maxLib) return [...non, ...lib.slice(0, maxLib)];
  return kept;
}

/**
 * Python's `re.escape` escapes every character outside [A-Za-z0-9_]; this escapes
 * only JS regex metacharacters. The two produce equivalent patterns -- Python's extra
 * escapes (space, '-', '#') are semantic no-ops -- and this form stays valid under a
 * future /u flag, which blanket backslash-escaping would not.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * recommend._subject_hits: true when `term` appears as a whole word inside `subject`
 * (both already lowercased). Whole-word so excluding 'war' does not trip 'warmth'.
 *
 * DEVIATION: Python's `\b` is Unicode-aware for str patterns; JS's is ASCII-only.
 * Both operands here are lowercased English subject headings, where the two agree.
 */
export function subjectHits(term: string, subject: string): boolean {
  return new RegExp(`\\b${escapeRegExp(term)}\\b`).test(subject);
}

export interface ConstrainableCandidate {
  author?: string | null;
  year?: number | null;
  subjects?: string[] | null;
}

/**
 * recommend._apply_directive_constraints: filter assembled candidates by the standing
 * directive's hard constraints (year range, exclude_subjects, exclude_authors).
 * Language is handled upstream by overriding the signal's allowed-language set.
 * Unknown/missing fields always PASS -- never drop a candidate for lacking metadata.
 */
export function applyDirectiveConstraints<T extends ConstrainableCandidate>(
  candidates: T[],
  constraints: Record<string, unknown>
): T[] {
  // Python's `if not constraints` -- an EMPTY object is falsy there but truthy in JS.
  if (!constraints || Object.keys(constraints).length === 0) return candidates;

  const minYear = constraints.min_year as number | null | undefined;
  const maxYear = constraints.max_year as number | null | undefined;
  const excludeSubjects = ((constraints.exclude_subjects as string[] | null) ?? []).map((s) =>
    s.toLowerCase()
  );
  const excludeAuthors = new Set(
    ((constraints.exclude_authors as string[] | null) ?? []).map((a) => a.toLowerCase())
  );

  return candidates.filter((cand) => {
    const year = cand.year;
    // Python's isinstance(year, int): a float year fails the check and passes the filter.
    if (typeof year === 'number' && Number.isInteger(year)) {
      if (minYear != null && year < minYear) return false;
      if (maxYear != null && year > maxYear) return false;
    }
    if (excludeSubjects.length) {
      const subjects = (cand.subjects ?? []).map((s) => String(s).toLowerCase());
      for (const term of excludeSubjects) {
        if (subjects.some((s) => subjectHits(term, s))) return false;
      }
    }
    // PYTHON QUIRK: a candidate's SURNAME is compared against the constraint's full
    // lowercased author string, so `exclude_authors: ["John Ringo"]` never matches.
    // Reproduced on purpose.
    if (excludeAuthors.size && excludeAuthors.has(surname(cand.author ?? null).toLowerCase())) {
      return false;
    }
    return true;
  });
}
