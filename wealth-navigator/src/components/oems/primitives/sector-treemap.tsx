"use client";

import * as React from "react";

/**
 * Sector heatmap.
 *
 * A weighted grid — each sector's cell spans more columns the bigger its
 * share of total market cap, so the block sizes read as a real treemap
 * (banks/mining dominate visually) instead of every sector looking equally
 * important. Colour is a solid, saturated green/red scaled by day move
 * intensity (matching the original Lovable design), with a neutral slate
 * band for tiny moves so a flat tape doesn't read as muddy maroon.
 */

export interface SectorDatum {
  name: string;
  /** Relative weight (market cap) — drives cell SIZE (grid column span). */
  weight: number;
  /** Day change %, drives the colour. */
  change: number;
  /** Optional: number of constituents (shown as the secondary metric). */
  count?: number;
  /** Optional: absolute market cap, used for the tooltip if present. */
  marketCap?: number;
  /** Optional: pre-computed weight percentage (seed path). */
  weightPct?: number;
}

// NEUTRAL_EPS is the neutral deadband in percent: moves smaller than this paint
// slate, not colour. REF_MIN / REF_MAX bound the per-day adaptive reference.
const NEUTRAL_EPS = 0.06;
const REF_MIN = 0.5;
const REF_MAX = 3;

// Grid is 6 columns wide; a cell spans 1..GRID_MAX_SPAN columns based on its
// share of total weight, so no single sector can swallow the whole board.
const GRID_COLS = 6;
const GRID_MAX_SPAN = 3;

/** sqrt-scaled magnitude past the deadband, 0..1, against the per-day ref. */
function intensityOf(change: number, ref: number): number {
  const a = Math.abs(change);
  if (a < NEUTRAL_EPS) return 0;
  const span = Math.max(0.0001, ref - NEUTRAL_EPS);
  const t = Math.min(1, Math.max(0, (a - NEUTRAL_EPS) / span));
  return Math.sqrt(t);
}

/** Solid cell fill: saturated green/red scaled by intensity, slate when flat. */
function cellBackground(change: number, ref: number): string {
  const intensity = intensityOf(change, ref);
  if (intensity === 0) return "hsl(var(--muted-foreground) / 0.14)";
  return change > 0
    ? `hsl(142, 71%, ${(50 - intensity * 25).toFixed(1)}%)`
    : `hsl(0, 84%, ${(60 - intensity * 20).toFixed(1)}%)`;
}

/** Cell text colour: white on a saturated fill, foreground on the neutral slate. */
function cellTextColor(change: number, ref: number): string {
  return intensityOf(change, ref) === 0 ? "hsl(var(--foreground) / 0.85)" : "#fff";
}

function changeText(change: number): string {
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(2)}%`;
}

const clampStyle: React.CSSProperties = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};

export function SectorTreemap({ data }: { data: SectorDatum[] }) {
  const rows = React.useMemo(() => data.filter((d) => d.name && d.name.trim().length > 0), [data]);

  // Per-day adaptive reference: the biggest absolute move sets the top of the
  // colour ramp, floored at REF_MIN so a flat tape still separates and capped
  // at REF_MAX so a wild day does not clip.
  const ref = React.useMemo(() => {
    const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(r.change || 0)), 0);
    return Math.min(REF_MAX, Math.max(REF_MIN, maxAbs));
  }, [rows]);
  // Market breadth + net bias. Cap-weighted (equal-weighted when caps are
  // absent) so the bar reads bullish vs bearish at a glance: how much of the
  // market is green vs red, the net move, and the advance/decline split. A
  // min/max scale hides this: a symmetric +1.85/-1.85 day still looks balanced
  // even when 8 of 11 sectors are red.
  const breadth = React.useMemo(() => {
    let capSum = 0;
    for (const r of rows) capSum += Math.max(0, r.weight);
    const equal = capSum <= 0;
    let upW = 0;
    let downW = 0;
    let flatW = 0;
    let adv = 0;
    let dec = 0;
    let wChg = 0;
    let denom = 0;
    for (const r of rows) {
      const w = equal ? 1 : Math.max(0, r.weight);
      const c = r.change || 0;
      denom += w;
      wChg += w * c;
      if (c > NEUTRAL_EPS) {
        upW += w;
        adv += 1;
      } else if (c < -NEUTRAL_EPS) {
        downW += w;
        dec += 1;
      } else {
        flatW += w;
      }
    }
    const net = denom > 0 ? wChg / denom : 0;
    const toPct = (x: number) => (denom > 0 ? (x / denom) * 100 : 0);
    return { upPct: toPct(upW), downPct: toPct(downW), flatPct: toPct(flatW), net, adv, dec };
  }, [rows]);
  const sentiment =
    breadth.net > NEUTRAL_EPS ? "Bullish" : breadth.net < -NEUTRAL_EPS ? "Bearish" : "Mixed";

  const totalWeight = React.useMemo(() => rows.reduce((s, r) => s + Math.max(0, r.weight), 0), [rows]);

  // Sort best to worst so the grid reads as a performance heatmap; tie-break by
  // the larger sector first.
  const ordered = React.useMemo(
    () => [...rows].sort((a, b) => b.change - a.change || b.weight - a.weight),
    [rows],
  );

  if (rows.length === 0) return null;

  return (
    <div className="flex h-full w-full select-none flex-col gap-2">
      <div
        className="grid min-h-0 flex-1 auto-rows-[minmax(0,1fr)] grid-flow-row-dense gap-1.5"
        style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))` }}
      >
        {ordered.map((s) => {
          const capPct = totalWeight > 0 ? (Math.max(0, s.weight) / totalWeight) * 100 : 0;
          const meta =
            typeof s.count === "number" ? `${s.count} stk` : `${(s.weightPct ?? capPct).toFixed(1)}%`;
          // Cell size = share of total weight, spread across an 8-unit scale
          // and clamped to [1, GRID_MAX_SPAN] columns so the biggest sector
          // doesn't swallow the whole grid and the smallest stays legible.
          const span = totalWeight > 0
            ? Math.min(GRID_MAX_SPAN, Math.max(1, Math.round((Math.max(0, s.weight) / totalWeight) * 8)))
            : 1;
          return (
            <div
              key={s.name}
              title={`${s.name} · ${changeText(s.change)}${typeof s.count === "number" ? ` · ${s.count} constituents` : ""} · ${capPct.toFixed(1)}% cap`}
              className="relative flex min-h-0 cursor-default flex-col justify-between overflow-hidden rounded-sm p-2 transition-transform duration-150 hover:-translate-y-px"
              style={{ gridColumn: `span ${span}`, background: cellBackground(s.change, ref) }}
            >
              <span
                className="text-[11px] font-medium leading-tight tracking-tight"
                style={{ ...clampStyle, color: cellTextColor(s.change, ref) }}
              >
                {s.name}
              </span>
              <span className="flex items-baseline justify-between gap-1">
                <span
                  className="font-mono text-[12px] font-semibold tabular-nums"
                  style={{ color: cellTextColor(s.change, ref) }}
                >
                  {changeText(s.change)}
                </span>
                <span
                  className="shrink-0 font-mono text-[9px] tabular-nums opacity-80"
                  style={{ color: cellTextColor(s.change, ref) }}
                >
                  {meta}
                </span>
              </span>
            </div>
          );
        })}
      </div>

      {/* Market breadth + net bias: cap-weighted share up vs down, the net move,
          and the advance/decline split. Reads bullish vs bearish at a glance. */}
      <div className="shrink-0 space-y-1 px-0.5">
        <div className="flex items-center justify-between text-[10px] font-medium">
          <span className="tabular-nums" style={{ color: sentiment === "Mixed" ? "hsl(var(--muted-foreground))" : sentiment === "Bullish" ? "hsl(var(--up))" : "hsl(var(--down))" }}>
            {sentiment} · {changeText(breadth.net)} avg
          </span>
          <span className="font-mono text-[9px] tabular-nums">
            <span style={{ color: "hsl(var(--up))" }}>{breadth.adv}▲</span>{" "}
            <span style={{ color: "hsl(var(--down))" }}>{breadth.dec}▼</span>
          </span>
        </div>
        <div
          className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted-foreground/10"
          title={`${breadth.upPct.toFixed(0)}% of market cap up · ${breadth.flatPct.toFixed(0)}% flat · ${breadth.downPct.toFixed(0)}% down`}
        >
          <div style={{ width: `${breadth.upPct}%`, background: "hsl(var(--up) / 0.8)" }} />
          <div style={{ width: `${breadth.flatPct}%`, background: "hsl(var(--muted-foreground) / 0.3)" }} />
          <div style={{ width: `${breadth.downPct}%`, background: "hsl(var(--down) / 0.8)" }} />
        </div>
      </div>
    </div>
  );
}
