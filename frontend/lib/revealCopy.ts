// Static reveal copy (verbatim from wrapped-reveal-copy.md). No logic beyond selection.

/** One line per winning axis pole (Beat 6). Keys are `${axisKey}:${letter}`. */
export const POLE_LINES: Record<string, string> = {
  'lens:I': 'You read to leave. A book that can’t transport you isn’t doing its job.',
  'lens:R': 'You read to think. The book is a conversation, and you talk back.',
  'engine:P': 'Momentum is non-negotiable. A story owes you forward motion.',
  'engine:C': 'People are the plot. Everything else is scenery.',
  'range:B': 'Your shelf refuses a genre. Range isn’t indecision — it’s appetite.',
  'range:D': 'You go deep, not wide. Loyalty is your love language — to genres, to series, to authors.',
  'resonance:H': 'A book earns its keep in feeling. If it didn’t move you, it didn’t happen.',
  'resonance:M': 'Structure is beautiful to you. You admire the how as much as the what.',
};

/** Beat 2 rating quip, chosen by average rating. */
export function ratingQuip(avg: number | null): string {
  if (avg === null) return '';
  if (avg >= 4.2)
    return 'You rate high. Either you’re generous, or you’re very good at picking your next book. We suspect the second.';
  if (avg >= 3.4) return 'You rate like a critic — the stars have to be earned.';
  return 'You are not an easy audience. Good. That makes the five-stars mean something.';
}

/** Beat 5 format line, chosen by dominant format. */
export const FORMAT_LINES: Record<'novel' | 'novella' | 'collection' | 'series', string> = {
  series: 'Mostly series. You don’t want a story — you want a residence.',
  novel: 'Standalones, mostly. One book, one world, done right.',
  novella:
    'You like them short and sharp. Length is not depth, and you know it.',
  collection:
    'Story collections keep showing up. You read like a taster, not a tourist.',
};
