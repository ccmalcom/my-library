import { describe, test, expect } from 'vitest';
import { AXIS_LETTERS, AXIS_ORDER, scoreToLetter, scoresToCode, ARCHETYPES } from './archetype';

describe('scoresToCode', () => {
  test('exactly 0.0 on every axis yields the LEFT letter (score > 0 is the only right case)', () => {
    expect(scoresToCode({ lens: 0, engine: 0, range: 0, resonance: 0 })).toBe('IPBH');
  });

  test('assembles the code in lens, engine, range, resonance order', () => {
    expect(scoresToCode({ lens: 1, engine: -1, range: 1, resonance: -1 })).toBe('RPDH');
    expect(scoresToCode({ lens: -1, engine: 1, range: -1, resonance: 1 })).toBe('ICBM');
  });

  test('agrees with scoreToLetter for each individual axis', () => {
    const scores = { lens: 0.4, engine: -0.2, range: 0, resonance: 0.1 };
    const code = scoresToCode(scores);
    AXIS_ORDER.forEach((axis, i) => {
      expect(code[i]).toBe(scoreToLetter(axis, scores[axis]));
    });
  });
});

describe('ARCHETYPES', () => {
  test('has exactly 16 entries — every combination of the 4 axes left/right letters', () => {
    const codes = new Set<string>();
    for (const lens of ['left', 'right'] as const) {
      for (const engine of ['left', 'right'] as const) {
        for (const range of ['left', 'right'] as const) {
          for (const resonance of ['left', 'right'] as const) {
            codes.add(
              AXIS_LETTERS.lens[lens] +
                AXIS_LETTERS.engine[engine] +
                AXIS_LETTERS.range[range] +
                AXIS_LETTERS.resonance[resonance]
            );
          }
        }
      }
    }
    expect(codes.size).toBe(16);
    expect(Object.keys(ARCHETYPES).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      expect(ARCHETYPES[code].name).toBeTruthy();
      expect(ARCHETYPES[code].tagline).toBeTruthy();
    }
  });
});
