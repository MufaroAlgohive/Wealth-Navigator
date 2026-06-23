"use client";

import { ResponsiveContainer, Treemap } from "recharts";

/**
 * Sector treemap — box size = sector weight (allocation), colour = day move
 * (green up / red down, intensity by magnitude). Replaces the flat sector list
 * on the Cockpit per Lonwabo: "similar to a JHB heat map where you see which
 * sector is big… and you can see the big sector performed green or red."
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
}

function SectorCell({ x = 0, y = 0, width = 0, height = 0, name = "", change = 0 }: CellProps) {
  const up = change > 0;
  const down = change < 0;
  const mag = Math.min(1, Math.abs(change) / 3); // 3% move ≈ full intensity
  const op = 0.18 + mag * 0.55;
  const fill = up
    ? `hsl(var(--up) / ${op})`
    : down
      ? `hsl(var(--down) / ${op})`
      : "hsl(var(--muted-foreground) / 0.25)";
  // Flexible label: an HTML foreignObject bounded to the tile, so text wraps,
  // the font scales with the tile, the % shows when there's room, and it only
  // ellipsises as a last resort — and can never overflow into the next tile
  // (overflow:hidden + the fixed bounds do the clipping).
  const pad = 6;
  const innerW = Math.max(0, width - pad * 2);
  const innerH = Math.max(0, height - pad * 2);
  // Only label tiles big enough to read; tiny ones stay colour-only with the
  // name on hover (cramming text into a ~40px sliver is what looked broken).
  const showLabel = width >= 60 && height >= 26;
  const fontSize = Math.max(9, Math.min(13, Math.floor(Math.min(width / 7.5, height / 3.2))));
  const showPct = height >= 40 && width >= 54;
  const nameLines = Math.max(1, Math.min(3, Math.floor((innerH - (showPct ? fontSize + 4 : 0)) / (fontSize * 1.25)) || 1));
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill} stroke="hsl(var(--canvas))" strokeWidth={2} rx={4}>
        <title>{name}{Number.isFinite(change) ? ` · ${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : ""}</title>
      </rect>
      {showLabel && (
        <foreignObject x={x + pad} y={y + pad} width={innerW} height={innerH} style={{ pointerEvents: "none" }}>
          <div
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              gap: 1,
              overflow: "hidden",
              userSelect: "none",
            }}
          >
            <span
              style={{
                fontSize,
                fontWeight: 600,
                lineHeight: 1.2,
                color: "hsl(var(--foreground))",
                display: "-webkit-box",
                WebkitLineClamp: nameLines,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                wordBreak: "break-word",
              }}
            >
              {name}
            </span>
            {showPct && (
              <span
                style={{
                  fontSize: Math.max(8, fontSize - 2),
                  fontFamily: "var(--font-mono, monospace)",
                  color: "hsl(var(--foreground) / 0.75)",
                  lineHeight: 1,
                }}
              >
                {change >= 0 ? "+" : ""}{change.toFixed(2)}%
              </span>
            )}
          </div>
        </foreignObject>
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
