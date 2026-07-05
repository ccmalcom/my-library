import type { Trait, ArchetypeOut, ProfileHighlights, Stats, Book } from './api';
import { POLE_LINES, ratingQuip, FORMAT_LINES } from './revealCopy';

const AXIS_ORDER = ['lens', 'engine', 'range', 'resonance'] as const;
export type AxisKey = (typeof AXIS_ORDER)[number];

const REWARD_CAP = 5;
const REWARD_CAP_THIN = 2;
const LOW_CONFIDENCE_MAX = 0.45; // bottom band -> softened frame
const NEAR_CENTER_MAX = 0.25;

export interface GenreHighlight {
  subject: string;
  share: number;
}

export interface AversionItem {
  trait: Trait;
  evidence: string; // parenthetical, already assembled from the evidence book
}

export type Beat =
  | { kind: 'cold-open'; nBooks: number; thin: boolean }
  | {
      kind: 'numbers';
      nRated: number;
      nAuthors: number;
      topGenre: string | null;
      avg: number | null;
      quip: string;
    }
  | {
      kind: 'reward-trait';
      trait: Trait;
      lowConfidence: boolean;
      exhibitTitles: string[];
      contrastTitles: string[];
    }
  | { kind: 'aversions'; items: AversionItem[] }
  | { kind: 'shelves'; genres: GenreHighlight[]; authors: string[]; formatLine: string | null }
  | {
      kind: 'axis';
      axisKey: AxisKey;
      letter: string;
      poleLine: string;
      rationale: string | null;
      nearCenter: boolean;
      codeSoFar: string;
    }
  | { kind: 'finale'; archetype: ArchetypeOut; nBooks: number; thin: boolean }
  | { kind: 'handoff' }
  // summary counts are computed live in the component from verdict state; this beat
  // only marks position + carries the thin flag for copy selection.
  | { kind: 'summary'; thin: boolean };

export interface BuildBeatsInput {
  stats: Stats;
  traits: Trait[];
  archetype: ArchetypeOut;
  highlights: ProfileHighlights;
  books: Book[];
}

function aversionEvidence(trait: Trait, byId: Map<number, Book>): string {
  const bookId = (trait.exhibits ?? [])[0];
  const book = bookId != null ? byId.get(bookId) : undefined;
  if (!book) return '';
  const title = book.title;
  if (book.exclusive_shelf === 'did-not-finish') {
    return `You never finished ${title}. We noticed.`;
  }
  if (book.app_review) {
    return `${title} — your review was brief.`;
  }
  const stars = book.effective_rating ?? 1;
  return `${title}, ${stars} star${stars === 1 ? '' : 's'}, no review. The silence said plenty.`;
}

export function buildBeats(input: BuildBeatsInput): Beat[] {
  const { stats, traits, archetype, highlights, books } = input;
  const byId = new Map(books.map((b) => [b.id, b]));
  const title = (id: number) => byId.get(id)?.title;

  const thin = highlights.thin;
  const beats: Beat[] = [];

  // Beat 1
  beats.push({ kind: 'cold-open', nBooks: stats.total, thin });

  // Beat 2
  beats.push({
    kind: 'numbers',
    nRated: stats.rated,
    nAuthors: highlights.n_authors,
    topGenre: highlights.top_genres[0]?.subject ?? null,
    avg: stats.mean_rating,
    quip: ratingQuip(stats.mean_rating),
  });

  // Beats 3 (rewards) — strongest confidence first, capped.
  const rewards = traits
    .filter((t) => t.polarity === 'reward' && t.status !== 'rejected')
    .slice()
    .sort((a, b) => b.inference_confidence - a.inference_confidence)
    .slice(0, thin ? REWARD_CAP_THIN : REWARD_CAP);
  for (const t of rewards) {
    beats.push({
      kind: 'reward-trait',
      trait: t,
      lowConfidence: t.inference_confidence <= LOW_CONFIDENCE_MAX,
      exhibitTitles: (t.exhibits ?? []).map(title).filter(Boolean).slice(0, 4) as string[],
      contrastTitles: (t.contrasts ?? []).map(title).filter(Boolean).slice(0, 1) as string[],
    });
  }

  // Beat 4 (aversions grouped) — skipped in thin mode (spec: beats 3-6 compress).
  if (!thin) {
    const aversions = traits.filter((t) => t.polarity === 'aversion' && t.status !== 'rejected');
    if (aversions.length > 0) {
      beats.push({
        kind: 'aversions',
        items: aversions.map((t) => ({ trait: t, evidence: aversionEvidence(t, byId) })),
      });
    }
  }

  // Beat 5 (shelves) — skipped in thin mode.
  if (!thin) {
    const dom = highlights.format_mix.dominant;
    beats.push({
      kind: 'shelves',
      genres: highlights.top_genres,
      authors: highlights.top_authors,
      formatLine: dom ? FORMAT_LINES[dom] : null,
    });
  }

  // Beat 6 (four axes) — skipped in thin mode; builds the code letter-by-letter.
  if (!thin) {
    let code = '';
    for (const axisKey of AXIS_ORDER) {
      const axis = archetype[axisKey];
      code += axis.letter;
      beats.push({
        kind: 'axis',
        axisKey,
        letter: axis.letter,
        poleLine: POLE_LINES[`${axisKey}:${axis.letter}`] ?? '',
        rationale: axis.rationale,
        nearCenter: Math.abs(axis.score) < NEAR_CENTER_MAX,
        codeSoFar: code,
      });
    }
  }

  // Beat 7 (finale)
  beats.push({ kind: 'finale', archetype, nBooks: stats.rated, thin });

  // Beat 8 (summary) — full library only; thin has nothing to summarize verdict-wise.
  if (!thin) beats.push({ kind: 'summary', thin });

  // Beat 9 (handoff)
  beats.push({ kind: 'handoff' });

  return beats;
}
