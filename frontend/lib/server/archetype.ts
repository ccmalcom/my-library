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

/** The 4-char code assembly order — twin of archetype.py::scores_to_code's concatenation order. */
export const AXIS_ORDER = ['lens', 'engine', 'range', 'resonance'] as const;

/** Port of archetype.py::scores_to_code (105-112). */
export function scoresToCode(scores: {
  lens: number;
  engine: number;
  range: number;
  resonance: number;
}): string {
  return AXIS_ORDER.map((axis) => scoreToLetter(axis, scores[axis])).join('');
}

/** Port of archetype.py:54-71's ARCHETYPES dict — code → {name, tagline}. */
export const ARCHETYPES: Record<string, { name: string; tagline: string }> = {
  IPBH: { name: 'The Wandering Escapist', tagline: 'Give me a new world every week.' },
  IPBM: { name: 'The Plot Mechanic', tagline: 'A perfect engine of a story.' },
  IPDH: { name: 'The Serial Thrill-Seeker', tagline: 'One more chapter. Always one more.' },
  IPDM: { name: 'The Genre Architect', tagline: 'The rules of the genre exist to be mastered.' },
  ICBH: { name: 'The Empathic Rover', tagline: 'Show me how different people feel.' },
  ICBM: { name: 'The Character Analyst', tagline: 'Tell me who they are, not what happens.' },
  ICDH: { name: 'The Devoted Fan', tagline: 'I live in this world now.' },
  ICDM: { name: 'The Deep Empath', tagline: 'I only finish books that feel true.' },
  RPBH: { name: 'The Conscious Adventurer', tagline: 'Beautiful prose AND a great story.' },
  RPBM: { name: 'The Eclectic Critic', tagline: "I'll read anything once, and have opinions." },
  RPDH: { name: 'The Committed Purist', tagline: 'I know exactly what I like, and why.' },
  RPDM: { name: 'The Structural Connoisseur', tagline: 'Architecture and execution, above all.' },
  RCBH: { name: 'The Literary Wanderer', tagline: 'Voice and feeling, across every genre.' },
  RCBM: {
    name: 'The Cerebral Explorer',
    tagline: 'Minds first -- give me complex characters and ideas.',
  },
  RCDH: { name: 'The Canon Keeper', tagline: 'A few authors, read completely and deeply.' },
  RCDM: {
    name: 'The Cerebral Architect',
    tagline: "A well-constructed mind on the page -- that's everything.",
  },
};

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
