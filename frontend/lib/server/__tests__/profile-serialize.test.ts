import { describe, it, expect } from 'vitest';
import { pyFloat, pyFloatStr, pyRepr, pyJsonDumps } from '../serialize';

describe('pyFloatStr', () => {
  it('appends .0 to integral values the way Python repr does', () => {
    expect(pyFloatStr(1)).toBe('1.0');
    expect(pyFloatStr(0)).toBe('0.0');
    expect(pyFloatStr(-0)).toBe('-0.0');
  });

  it('leaves non-integral values as the shortest round-trip form', () => {
    expect(pyFloatStr(0.95)).toBe('0.95');
    expect(pyFloatStr(0.6)).toBe('0.6');
    expect(pyFloatStr(0.30000000000000004)).toBe('0.30000000000000004');
  });
});

describe('pyRepr', () => {
  it('renders a mapping the way Python str(dict) does', () => {
    const counts = new Map<string, number>([
      ['5', 3],
      ['4', 2],
      ['3', 0],
      ['<=2', 1],
      ['dnf', 1],
      ['rejected', 1],
    ]);
    // Insertion order preserved, single-quoted keys, ": " and ", " separators.
    expect(pyRepr(counts)).toBe("{'5': 3, '4': 2, '3': 0, '<=2': 1, 'dnf': 1, 'rejected': 1}");
  });

  it('renders a list the way Python str(list) does', () => {
    expect(pyRepr([2, 3, 9])).toBe('[2, 3, 9]');
    expect(pyRepr([])).toBe('[]');
  });

  it('renders None/True/False, not null/true/false', () => {
    expect(pyRepr(null)).toBe('None');
    expect(pyRepr(true)).toBe('True');
    expect(pyRepr(false)).toBe('False');
  });

  it('renders a PyFloat as a Python float', () => {
    expect(pyRepr(pyFloat(1))).toBe('1.0');
  });
});

describe('pyJsonDumps (wave-3b extensions)', () => {
  it('serializes a Map in insertion order, not V8 numeric-key order', () => {
    const tiers = new Map<string, unknown[]>([
      ['5', [{ id: 1 }]],
      ['4', []],
      ['3', []],
      ['<=2', []],
      ['dnf', []],
      ['rejected', []],
    ]);
    expect(pyJsonDumps(tiers)).toBe(
      '{"5": [{"id": 1}], "4": [], "3": [], "<=2": [], "dnf": [], "rejected": []}'
    );
  });

  it('proves the plain-object equivalent WOULD have been reordered', () => {
    // Guard rail: documents exactly why Map is mandatory here.
    expect(Object.keys({ '5': 1, '4': 1, '3': 1, '<=2': 1 })).toEqual(['3', '4', '5', '<=2']);
  });

  it('serializes a PyFloat with a decimal point', () => {
    expect(pyJsonDumps({ inference_confidence: pyFloat(1) })).toBe(
      '{"inference_confidence": 1.0}'
    );
    expect(pyJsonDumps({ inference_confidence: pyFloat(0.8) })).toBe(
      '{"inference_confidence": 0.8}'
    );
  });
});
