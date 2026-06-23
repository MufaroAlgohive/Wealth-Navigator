"use client";

import { ResponsiveContainer, Treemap } from "recharts";

/**
 * Sector treemap — box size = sector weight (allocation), colour = day move
 * (green up / red down, intensity by magnitude). Replaces the flat sector list
 * on the Cockpit per Lonwabo: "similar to a JHB heat map where you see which
 * sector is big… and you can see the big sector performed green or red."
 *
 * Labels are PURE SVG (no foreignObject — that double-renders/clamps oddly in
 * the production build). A tile is labelled only when it's big enough to read;
 * the name word-wraps to at most two lines and is clipped to the tile, so it
 * can never bleed into a neighbour. Tiles too small to label stay colour-only
 * with the full name + day-move on hover.
 */
export interface SectorDatum {
  name: string;
  /** Relative size of the box (sector weight / market cap). */
  weight: number;
  /** Day change %, drives the colour. */
  change: number;
}

interface CellProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
  change?: number;
  /** recharts tree depth — 0 is the synthetic root node, 1 are the sector leaves. */
  depth?: number;
}

/** Greedy word-wrap into at most `maxLines` lines of ~`maxChars`, ellipsising
 *  the last line if the name doesn't fit. */
function wrapLabel(name: string, maxChars: number, maxLines: number): string[] {
  const clean = name.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars || maxLines <= 1) {
    return [clean.length > maxChars ? clean.slice(0, Math.max(1, maxChars - 1)) + "…" : clean];
  }
  const words = clean.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    const cand = cur ? `${cur} ${w}` : w;
    if (cand.length <= maxChars) {
      cur = cand;
    } else {
      if (cur) lines.push(cur);
      cur = w;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const placed = lines.join(" ").length;
  if (placed < clean.length) {
    const li = lines.length - 1;
    const l = lines[li]!;
    lines[li] = (l.length > maxChars - 1 ? l.slice(0, maxChars - 1) : l) + "…";
  }
  return lines;
}

function SectorCell({ x = 0, y = 0, width = 0, height = 0, name = "", change = 0, depth }: CellProps) {
  // recharts also renders the synthetic ROOT node (depth 0, empty name) that
  // spans the whole area — skip it so its placeholder rect/label doesn't paint
  // a duplicate "+0.00%" + blank label under the real sector tiles.
  if (depth === 0 || !name) return <g />;
  const up = change > 0;
  const down = change < 0;
  const mag = Math.min(1, Math.abs(change) / 3); // 3% move ≈ full intensity
  const op = 0.18 + mag * 0.55;
  const fill = up
    ? `hsl(var(--up) / ${op})`
    : down
      ? `hsl(var(--down) / ${op})`
      : "hsl(var(--muted-foreground) / 0.25)";
  const titleText = `${name}${Number.isFinite(change) ? ` · ${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : ""}`;

  const showLabel = width >= 64 && height >= 30;
  const fontSize = Math.max(9, Math.min(12, Math.floor(Math.min(width / 8, height / 3.4))));
  const nameMaxLines = height >= 46 ? 2 : 1;
  const showPct = showLabel && height >= 54 && width >= 70;
  const maxChars = Math.max(3, Math.floor((width - 12) / (fontSize * 0.58)));
  const lines = showLabel ? wrapLabel(name, maxChars, nameMaxLines) : [];
  const lineH = fontSize * 1.18;
  const clipId = `sc-${Math.round(x)}-${Math.round(y)}-${Math.round(width)}`;

  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill} stroke="hsl(var(--canvas))" strokeWidth={2} rx={4}>
        <title>{titleText}</title>
      </rect>
      {showLabel && (
        <>
          <defs>
            <clipPath id={clipId}>
              <rect x={x} y={y} width={width} height={height} rx={4} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${clipId})`} className="pointer-events-none select-none">
            {lines.map((ln, i) => (
              <text
                key={i}
                x={x + 7}
                y={y + 14 + i * lineH}
                fill="hsl(var(--foreground))"
                fontSize={fontSize}
                fontWeight={600}
              >
                {ln}
              </text>
            ))}
            {showPct && (
              <text
                x={x + 7}
                y={y + 14 + lines.length * lineH + 1}
                fill="hsl(var(--foreground) / 0.75)"
                fontSize={Math.max(8, fontSize - 1)}
                style={{ fontFamily: "var(--font-mono, monospace)" }}
              >
                {change >= 0 ? "+" : ""}{change.toFixed(2)}%
              </text>
            )}
          </g>
        </>
      )}
    </g>
  );
}

export function SectorTreemap({ data }: { data: SectorDatum[] }) {
  const rows = data.filter((d) => d.weight > 0);
  if (rows.length === 0) return null;
  return (
    <ResponsiveContainer width="100%" height="100%">
      {/* `change` is spread onto each node by recharts and read in SectorCell. */}
      <Treemap data={rows} dataKey="weight" nameKey="name" isAnimationActive={false} content={<SectorCell />} />
    </ResponsiveContainer>
  );
}
