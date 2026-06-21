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
  const showName = width > 52 && height > 26;
  const showPct = width > 52 && height > 42;
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill} stroke="hsl(var(--canvas))" strokeWidth={2} rx={4} />
      {showName && (
        <text x={x + 7} y={y + 16} fill="hsl(var(--foreground))" fontSize={11} fontWeight={600} className="pointer-events-none select-none">
          {name}
        </text>
      )}
      {showPct && (
        <text x={x + 7} y={y + 31} fill="hsl(var(--foreground) / 0.75)" fontSize={10} className="pointer-events-none select-none" style={{ fontFamily: "var(--font-mono, monospace)" }}>
          {change >= 0 ? "+" : ""}{change.toFixed(2)}%
        </text>
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
