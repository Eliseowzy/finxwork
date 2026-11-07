// Quick styles: twelve fill + outline + text colour combinations derived from the deck's theme,
// in the spirit of PowerPoint's shape-style gallery. Pure; applying is a command's job.
import type { ThemeColors } from "./theme.ts";

export type QuickStyle = { id: string; fill: string | null; stroke: string | null; strokeWidthPt: number | null; text: string };

const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

/** `amount` > 0 mixes towards white, < 0 towards black, as DrawingML tint/shade roughly do. */
export function mix(color: string, amount: number): string {
  const [r, g, b] = [0, 1, 2].map((i) => channel(color, i));
  const target = amount > 0 ? 255 : 0, t = Math.abs(amount);
  return hex(r + (target - r) * t, g + (target - g) * t, b + (target - b) * t);
}

/** WCAG relative luminance, to choose readable text on a fill. */
export function luminance(color: string): number {
  const linear = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [0, 1, 2].map((i) => linear(channel(color, i)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function readableOn(fill: string, dark: string, light: string): string {
  const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  return contrast(fill, light) >= contrast(fill, dark) ? light : dark;
}

/** Six accents × two intensities: an intense solid fill and a light tinted fill with an accent outline. */
export function quickStyles(theme: ThemeColors): QuickStyle[] {
  const accents = [theme.accent1, theme.accent2, theme.accent3, theme.accent4, theme.accent5, theme.accent6];
  const intense = accents.map((accent, i): QuickStyle => ({
    id: `intense-${i + 1}`, fill: accent, stroke: mix(accent, -0.25), strokeWidthPt: 1, text: readableOn(accent, theme.dk1, theme.lt1),
  }));
  const light = accents.map((accent, i): QuickStyle => {
    const fill = mix(accent, 0.8);
    return { id: `light-${i + 1}`, fill, stroke: accent, strokeWidthPt: 1, text: readableOn(fill, theme.dk1, theme.lt1) };
  });
  return [...intense, ...light];
}
