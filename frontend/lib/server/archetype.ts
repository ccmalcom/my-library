/** Static archetype data, verbatim from mylibrary/archetype.py. */

export const AXIS_LETTERS: Record<string, { left: string; right: string }> = {
  lens: { left: 'I', right: 'R' },
  engine: { left: 'P', right: 'C' },
  range: { left: 'B', right: 'D' },
  resonance: { left: 'H', right: 'M' },
};

/** Negative or zero → left letter; positive → right letter. */
export function scoreToLetter(axis: keyof typeof AXIS_LETTERS, score: number): string {
  const a = AXIS_LETTERS[axis];
  return score > 0 ? a.right : a.left;
}

export const ARCHETYPE_HOOKS: Record<string, string> = {
  IPBH: 'wants the portal, not the postcard',
  IPBM: 'can hear a plot click into place',
  IPDH: 'has said "one more chapter" and meant it, at 3 a.m., seven times',
  IPDM: 'reads a genre the way an engineer reads a blueprint',
  ICBH: "collects other people's inner lives",
  ICBM: 'would rather understand a character than like one',
  ICDH: 'reread the whole series to get ready for the new one',
  ICDM: "can't be fooled by a false note in a character",
  RPBH: 'refuses to choose between a page-turner and a poem',
  RPBM: "has never met a genre they wouldn't cross-examine",
  RPDH: 'ordered the same thing twice because it was perfect',
  RPDM: 'sees the load-bearing walls in every story',
  RCBH: 'follows voices across any border',
  RCBM: 'reads minds for sport',
  RCDH: 'keeps a canon and tends it like a garden',
  RCDM: 'admires a well-built mind above all fireworks',
};
