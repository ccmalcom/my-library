import { buildBeats, type Beat } from '../revealBeats';
import type { Stats, Trait, ArchetypeOut, ProfileHighlights, Book } from '../api';

function trait(over: Partial<Trait>): Trait {
  return {
    id: 1,
    claim: 'c',
    reveal_line: 'You do a thing.',
    polarity: 'reward',
    exhibits: [],
    contrasts: [],
    inference_confidence: 0.8,
    status: 'proposed',
    user_weight: 1,
    user_note: null,
    created_at: '',
    ...over,
  };
}

function axis(score: number, letter: string) {
  return { score, letter, rationale: 'because' };
}

const archetype: ArchetypeOut = {
  code: 'ICDH',
  name: 'The Devoted Fan',
  tagline: 'I live in this world now.',
  hook: 'reread the whole series to get ready for the new one',
  lens: axis(-0.6, 'I'),
  engine: axis(0.7, 'C'),
  range: axis(0.5, 'D'),
  resonance: axis(-0.4, 'H'),
  derived_at: '',
  is_stale: false,
};

const highlights: ProfileHighlights = {
  thin: false,
  n_authors: 40,
  top_genres: [
    { subject: 'Fantasy', share: 0.5 },
    { subject: 'Sci-Fi', share: 0.3 },
  ],
  top_authors: ['Le Guin', 'Mitchell', 'Chekhov'],
  format_mix: {
    novel: 3,
    novella: 1,
    collection: 0,
    series: 6,
    dominant: 'series',
    low_confidence: false,
  },
  era_split: { pre_2000: 10, post_2000: 30 },
};

const stats: Stats = {
  total: 120,
  rated: 100,
  unrated: 20,
  shelves: {},
  mean_rating: 4.3,
  by_star: { '5': 40, '4': 30, '3': 20, '2': 7, '1': 3 },
};

const books: Book[] = [];

function kinds(beats: Beat[]) {
  return beats.map((b) => b.kind);
}

describe('buildBeats', () => {
  it('emits the nine-beat spine in order for a full library', () => {
    const beats = buildBeats({ stats, traits: [trait({})], archetype, highlights, books });
    const k = kinds(beats);
    expect(k[0]).toBe('cold-open');
    expect(k[1]).toBe('numbers');
    expect(k).toContain('reward-trait');
    expect(k).toContain('shelves');
    expect(k.filter((x) => x === 'axis')).toHaveLength(4);
    expect(k).toContain('finale');
    expect(k).toContain('summary');
    expect(k[k.length - 1]).toBe('handoff');
  });

  it('caps reward-trait beats at 5 for a full library', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      trait({ id: i + 1, polarity: 'reward', inference_confidence: 1 - i * 0.05 })
    );
    const beats = buildBeats({ stats, traits: many, archetype, highlights, books });
    expect(kinds(beats).filter((x) => x === 'reward-trait')).toHaveLength(5);
  });

  it('caps reward-trait beats at 2 and drops axes for a thin library', () => {
    const many = Array.from({ length: 6 }, (_, i) => trait({ id: i + 1, polarity: 'reward' }));
    const beats = buildBeats({
      stats,
      traits: many,
      archetype,
      highlights: { ...highlights, thin: true },
      books,
    });
    expect(kinds(beats).filter((x) => x === 'reward-trait')).toHaveLength(2);
    expect(kinds(beats).filter((x) => x === 'axis')).toHaveLength(0);
    expect(kinds(beats)).toContain('finale');
  });

  it('groups aversions into a single beat', () => {
    const beats = buildBeats({
      stats,
      traits: [
        trait({ id: 1, polarity: 'reward' }),
        trait({ id: 2, polarity: 'aversion' }),
        trait({ id: 3, polarity: 'aversion' }),
      ],
      archetype,
      highlights,
      books,
    });
    expect(kinds(beats).filter((x) => x === 'aversions')).toHaveLength(1);
  });

  it('marks low-confidence reward traits', () => {
    const beats = buildBeats({
      stats,
      traits: [trait({ id: 1, inference_confidence: 0.2 })],
      archetype,
      highlights,
      books,
    });
    const rt = beats.find((b) => b.kind === 'reward-trait');
    expect(rt && rt.kind === 'reward-trait' && rt.lowConfidence).toBe(true);
  });

  it('builds the code letter-by-letter across axis beats', () => {
    const beats = buildBeats({ stats, traits: [trait({})], archetype, highlights, books });
    const axes = beats.filter((b) => b.kind === 'axis') as Extract<Beat, { kind: 'axis' }>[];
    expect(axes.map((a) => a.codeSoFar)).toEqual(['I', 'IC', 'ICD', 'ICDH']);
  });
});
