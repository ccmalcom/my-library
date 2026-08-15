import { contrastRatio, fitToSrgb, solveLightnessForContrast } from '@/lib/contrast';

describe('contrastRatio', () => {
  it('returns 21 for black on white', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('returns 1 for a color against itself', () => {
    expect(contrastRatio('#1f1b18', '#1f1b18')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#948b81', '#1f1b18')).toBeCloseTo(contrastRatio('#1f1b18', '#948b81'), 5);
  });

  it('matches the known ShelfSprite token ratios', () => {
    // --text on --bg, and the old --faint on --surface that this plan replaces.
    expect(contrastRatio('#f5f0e8', '#161412')).toBeCloseTo(16.2, 1);
    expect(contrastRatio('#6e665c', '#1f1b18')).toBeCloseTo(3.03, 1);
  });
});

describe('fitToSrgb', () => {
  it('returns an in-gamut hex for a chroma that would otherwise clip', () => {
    const hex = fitToSrgb(0.45, 0.4, 143);
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('keeps --text readable on every drenched panel hue', () => {
    for (let h = 0; h < 360; h++) {
      expect(contrastRatio('#f5f0e8', fitToSrgb(0.45, 0.15, h))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('solveLightnessForContrast', () => {
  it('raises lightness until the target ratio is met, for every hue', () => {
    for (let h = 0; h < 360; h++) {
      const hex = solveLightnessForContrast(0.16, h, '#1f1b18', 4.5);
      expect(contrastRatio(hex, '#1f1b18')).toBeGreaterThanOrEqual(4.5);
    }
  });
});
