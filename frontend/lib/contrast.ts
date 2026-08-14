// Dependency-free color math. Client code imports this (via tasteAccent), so it
// must never gain a runtime dependency — same rule as lib/server/rating.ts.

export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;
}

function clamp01(c: number): number {
  return Math.min(1, Math.max(0, c));
}

export function rgbToHex(rgb: Rgb): string {
  return (
    '#' +
    rgb
      .map((c) =>
        Math.round(clamp01(c) * 255)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  );
}

function linearize(c: number): number {
  const v = clamp01(c);
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(linearize) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(hexToRgb(a));
  const lb = relativeLuminance(hexToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Oklch -> linear-light sRGB -> gamma-encoded sRGB (Björn Ottosson). */
export function oklchToRgb(L: number, C: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  const encode = (c: number) =>
    c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;

  return [encode(r), encode(g), encode(bb)];
}

function inGamut(rgb: Rgb): boolean {
  return rgb.every((c) => c >= -0.0005 && c <= 1.0005);
}

/** Reduce chroma until the color fits inside sRGB, preserving L and hue. */
export function fitToSrgb(L: number, C: number, hDeg: number): string {
  let c = C;
  for (let i = 0; i < 120 && !inGamut(oklchToRgb(L, c, hDeg)); i++) c -= 0.002;
  return rgbToHex(oklchToRgb(L, Math.max(c, 0), hDeg));
}

/**
 * Raise lightness from a mid starting point until the color clears `target`
 * contrast against `againstHex`. Lightness — not chroma — is what carries
 * contrast, which is exactly what the old HSL-pinned tasteAccent got wrong.
 */
export function solveLightnessForContrast(
  C: number,
  hDeg: number,
  againstHex: string,
  target: number
): string {
  let L = 0.5;
  for (let i = 0; i < 200; i++) {
    const hex = fitToSrgb(L, C, hDeg);
    if (contrastRatio(hex, againstHex) >= target) return hex;
    L += 0.005;
    if (L > 0.995) break;
  }
  return fitToSrgb(Math.min(L, 0.995), C, hDeg);
}
