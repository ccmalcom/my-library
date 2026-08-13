/** Port of directive._clean_directive_constraints — keep only supported,
 *  catalog-filterable constraints; normalize types. */
export function cleanDirectiveConstraints(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;

  const langs = (Array.isArray(r.languages) ? r.languages : [])
    .filter((x) => String(x).trim())
    .map((x) => String(x).trim().toLowerCase().slice(0, 2));
  if (langs.length) out.languages = langs;

  for (const key of ['min_year', 'max_year'] as const) {
    const val = r[key];
    if (typeof val === 'boolean') continue;
    if (typeof val === 'number' && Number.isInteger(val)) out[key] = val;
    else if (typeof val === 'string' && /^\d+$/.test(val.trim()))
      out[key] = parseInt(val.trim(), 10);
  }

  const excl = (Array.isArray(r.exclude_subjects) ? r.exclude_subjects : [])
    .filter((x) => String(x).trim())
    .map((x) => String(x).trim().toLowerCase());
  if (excl.length) out.exclude_subjects = excl;

  const authors = (Array.isArray(r.exclude_authors) ? r.exclude_authors : [])
    .filter((x) => String(x).trim())
    .map((x) => String(x).trim().toLowerCase());
  if (authors.length) out.exclude_authors = authors;

  return out;
}
