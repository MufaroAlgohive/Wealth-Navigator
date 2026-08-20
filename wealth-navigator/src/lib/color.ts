/**
 * Colour helpers shared by the lightweight-charts components.
 *
 * The app's design tokens in globals.css are stored as modern space-separated
 * HSL triplets (e.g. `252 28% 12%`, optionally `/ alpha`). CSS accepts that
 * syntax, but lightweight-charts v4's internal colour parser only understands
 * hex / rgb() / rgba() — it throws `Cannot parse color` on `hsl(...)`. Every
 * chart component must convert tokens to rgba() before handing them to the
 * charting engine.
 */

/** Convert an "H S% L%" (optionally " / a") CSS triplet to rgba() — the only
 *  colour syntax lightweight-charts v4 can parse (it has no hsl() parser). */
export function hslToRgba(triplet: string, alpha = 1): string {
  const match = /^\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.]+))?\s*$/.exec(triplet);
  if (!match) return `rgba(150,150,150,${alpha})`;
  const h = Number(match[1]) % 360;
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  const a = match[4] != null ? Number(match[4]) : alpha;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return `rgba(${Math.round((r + m) * 255)},${Math.round((g + m) * 255)},${Math.round((b + m) * 255)},${Math.min(1, Math.max(0, a))})`;
}

/** Read a design token from :root/.light and return it as a rgba() string that
 *  lightweight-charts can parse. Falls back to a neutral grey on a missing
 *  token (never throws). */
export function tokenToRgba(token: string, alpha = 1): string {
  if (typeof document === "undefined") return `rgba(150,150,150,${alpha})`;
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  if (!v) return `rgba(150,150,150,${alpha})`;
  return hslToRgba(v, alpha);
}

/** Read a set of design tokens in one getComputedStyle pass (cheap enough to
 *  call on every theme toggle). */
export function readTokens(tokens: string[]): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const token of tokens) {
    const v = css.getPropertyValue(token).trim();
    out[token] = v ? hslToRgba(v) : "rgba(150,150,150,1)";
  }
  return out;
}
