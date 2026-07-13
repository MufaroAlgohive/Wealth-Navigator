"use client";

/**
 * Shared presentation kit for the Research & IC tabs: money/percent formatters,
 * rating/status/ESG/action badges, live-quote hooks (via /api/quotes and
 * /api/intraday), and two dependency-free inline-SVG charts (price-with-triggers
 * and peer P/E). Kept theme-aware by leaning on the existing text-up / text-down
 * / text-primary utilities and glass CSS variables.
 */

import { useQuery } from "@tanstack/react-query";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/cn";
import type { CompAction, Esg, NoteStatus, Peer, Quote, Rating } from "./types";

// ── formatters ─────────────────────────────────────────────────────────────
export function moneyR(v: number | null | undefined, dp = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `R${v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}
/** Compact millions, e.g. R55.80m. */
export function moneyM(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `R${(v / 1_000_000).toFixed(2)}m`;
}
export function signedPct(v: number | null | undefined, dp = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;
}
export function weightPct(v: number | null | undefined, dp = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v.toFixed(dp)}%`;
}
/** Stable REB-YYYY-NNN codes for a set of rebalance requests (sequential by created_at).
 *  Shared so the Rebalance Builder and the IC agenda show the same code per request. */
export function rebalanceCodeMap(reqs: { id: string; created_at: string }[]): Map<string, string> {
  const asc = [...reqs].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const map = new Map<string, string>();
  asc.forEach((r, i) => {
    const year = new Date(r.created_at).getFullYear() || 2026;
    map.set(r.id, `REB-${year}-${String(i + 1).padStart(3, "0")}`);
  });
  return map;
}
export function initialsOf(name: string | null | undefined): string {
  if (!name) return "—";
  const parts = name
    .replace(/@.*/, "")
    .split(/[\s.]+/)
    .filter(Boolean);
  if (parts.length === 0) return name.slice(0, 2).toUpperCase();
  const first = parts[0] ?? "";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? "";
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
}

// ── badges ───────────────────────────────────────────────────────────────
const PILL =
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide";

export function RatingBadge({ rating }: { rating?: Rating | null }) {
  if (!rating) return null;
  const tone =
    rating === "BUY" || rating === "ACCUMULATE"
      ? "border-[hsl(var(--up)/0.35)] bg-[hsl(var(--up)/0.12)] text-up"
      : rating === "SELL"
        ? "border-[hsl(var(--down)/0.35)] bg-[hsl(var(--down)/0.12)] text-down"
        : "border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.05)] text-muted-foreground";
  return <span className={cn(PILL, tone)}>{rating}</span>;
}

const STATUS_META: Record<NoteStatus, { label: string; cls: string }> = {
  approved: { label: "APPROVED", cls: "border-[hsl(var(--up)/0.35)] bg-[hsl(var(--up)/0.12)] text-up" },
  ic_pending: { label: "IC PENDING", cls: "border-primary/35 bg-primary/12 text-primary" },
  in_review: { label: "IN REVIEW", cls: "border-amber-400/40 bg-amber-400/12 text-amber-500" },
  draft: {
    label: "DRAFT",
    cls: "border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.05)] text-muted-foreground",
  },
  rejected: { label: "REJECTED", cls: "border-[hsl(var(--down)/0.35)] bg-[hsl(var(--down)/0.12)] text-down" },
};
export function StatusChip({ status }: { status: NoteStatus }) {
  const m = STATUS_META[status] ?? STATUS_META.draft;
  return <span className={cn(PILL, m.cls)}>{m.label}</span>;
}
export const STATUS_FILTERS: { id: "all" | NoteStatus; label: string }[] = [
  { id: "all", label: "ALL" },
  { id: "approved", label: "APPROVED" },
  { id: "ic_pending", label: "IC PENDING" },
  { id: "in_review", label: "IN REVIEW" },
  { id: "draft", label: "DRAFT" },
  { id: "rejected", label: "REJECTED" },
];

export function EsgBadge({ esg }: { esg?: Esg | null }) {
  if (!esg) return null;
  const tone =
    esg === "GREEN"
      ? "border-[hsl(var(--up)/0.35)] bg-[hsl(var(--up)/0.12)] text-up"
      : esg === "RED"
        ? "border-[hsl(var(--down)/0.35)] bg-[hsl(var(--down)/0.12)] text-down"
        : "border-amber-400/40 bg-amber-400/12 text-amber-500";
  return <span className={cn(PILL, tone)}>ESG · {esg}</span>;
}

export function ConvictionBadge({ conviction }: { conviction?: string | null }) {
  if (!conviction) return null;
  return <span className={cn(PILL, "border-primary/35 bg-primary/10 text-primary")}>{conviction}</span>;
}

const ACTION_META: Record<CompAction, { label: string; cls: string }> = {
  remove: { label: "REMOVE", cls: "text-down" },
  decrease: { label: "DECREASE", cls: "text-down" },
  increase: { label: "INCREASE", cls: "text-up" },
  add: { label: "ADD", cls: "text-up" },
  hold: { label: "HOLD", cls: "text-muted-foreground" },
};
export function ActionBadge({ action }: { action?: CompAction }) {
  const m = ACTION_META[action ?? "hold"];
  return <span className={cn("font-mono text-[11px] font-semibold uppercase", m.cls)}>{m.label}</span>;
}

export function TrendArrow({ trend }: { trend?: "up" | "down" | "flat" }) {
  if (trend === "up") return <TrendingUp className="h-3.5 w-3.5 text-up" />;
  if (trend === "down") return <TrendingDown className="h-3.5 w-3.5 text-down" />;
  return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
}

// ── live data hooks ────────────────────────────────────────────────────────
/** Batch live quotes keyed by uppercased symbol. Falls back to an empty map. */
export function useQuotes(symbols: string[]) {
  const key = Array.from(new Set(symbols.map((s) => s.toUpperCase()).filter(Boolean)))
    .sort()
    .join(",");
  return useQuery<Record<string, Quote>>({
    queryKey: ["ric-quotes", key],
    enabled: key.length > 0,
    refetchInterval: 30_000,
    queryFn: async () => {
      const res = await fetch(`/api/quotes?symbols=${encodeURIComponent(key)}&exchange=JSE`, {
        cache: "no-store",
      });
      const json = (await res.json().catch(() => ({}))) as { quotes?: Array<Record<string, unknown>> };
      const map: Record<string, Quote> = {};
      for (const q of json.quotes ?? []) {
        const sym = String(q.symbol ?? "").toUpperCase();
        if (!sym) continue;
        map[sym] = {
          symbol: sym,
          last: typeof q.last_price === "number" ? q.last_price : null,
          changePct: typeof q.change_pct === "number" ? q.change_pct : null,
          source: typeof q.source === "string" ? q.source : null,
        };
      }
      return map;
    },
  });
}

export interface IntradaySeries {
  points: { t: number; v: number }[];
  prevClose: number | null;
  source: string | null;
}
export function useIntradaySeries(symbol: string | null) {
  return useQuery<IntradaySeries>({
    queryKey: ["ric-intraday", symbol],
    enabled: !!symbol,
    queryFn: async () => {
      const res = await fetch(`/api/intraday/${encodeURIComponent(symbol ?? "")}?limit=90`, {
        cache: "no-store",
      });
      const json = (await res.json().catch(() => ({}))) as {
        points?: { t: number; v: number }[];
        prevClose?: number | null;
        source?: string;
      };
      return {
        points: Array.isArray(json.points) ? json.points : [],
        prevClose: json.prevClose ?? null,
        source: json.source ?? null,
      };
    },
  });
}

// ── charts (inline SVG, theme-aware) ─────────────────────────────────────────
export interface ChartTrigger {
  label: string;
  price: number;
  tone: "buy" | "sell" | "neutral";
}
export function PriceTriggerChart({
  points,
  triggers,
  current,
}: {
  points: { t: number; v: number }[];
  triggers: ChartTrigger[];
  current?: number | null;
}) {
  const W = 640;
  const H = 220;
  const padL = 6;
  const padR = 92;
  const padT = 12;
  const padB = 10;

  const trigPrices = triggers.map((t) => t.price).filter((n) => Number.isFinite(n));
  const pricePts = points.map((p) => p.v).filter((n) => Number.isFinite(n) && n > 0);
  const allV = [...pricePts, ...trigPrices, ...(current != null ? [current] : [])].filter((n) =>
    Number.isFinite(n),
  );
  if (allV.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center text-caption">
        No price or trigger data.
      </div>
    );
  }
  const lo = Math.min(...allV);
  const hi = Math.max(...allV);
  const min = lo - (hi - lo || lo * 0.02) * 0.08;
  const max = hi + (hi - lo || lo * 0.02) * 0.08;
  const span = max - min || 1;
  const x = (i: number) => padL + (points.length > 1 ? (i / (points.length - 1)) * (W - padL - padR) : 0);
  const y = (v: number) => padT + (1 - (v - min) / span) * (H - padT - padB);
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join(" ");
  const toneClass = (t: ChartTrigger["tone"]) =>
    t === "buy" ? "text-up" : t === "sell" ? "text-down" : "text-muted-foreground";

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-full w-full"
      role="img"
      aria-label="Price history with trigger levels"
    >
      <title>Price history with trigger levels</title>
      {/* trigger levels */}
      {triggers.map((t) => {
        const yy = y(t.price);
        if (!Number.isFinite(yy)) return null;
        return (
          <g key={t.label} className={toneClass(t.tone)}>
            <line
              x1={padL}
              x2={W - padR}
              y1={yy}
              y2={yy}
              stroke="currentColor"
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.5}
            />
            <text x={W - padR + 6} y={yy + 3} fill="currentColor" fontSize={10} className="font-mono">
              {t.label}
            </text>
          </g>
        );
      })}
      {/* current price marker */}
      {current != null && Number.isFinite(y(current)) && (
        <g className="text-foreground">
          <line
            x1={padL}
            x2={W - padR}
            y1={y(current)}
            y2={y(current)}
            stroke="currentColor"
            strokeWidth={1}
            opacity={0.25}
          />
        </g>
      )}
      {/* price line */}
      {points.length > 1 && (
        <path d={path} fill="none" stroke="currentColor" strokeWidth={1.75} className="text-primary" />
      )}
    </svg>
  );
}

export function PeerPeBars({
  peers,
  subjectPe,
  subjectName = "This",
}: {
  peers: Peer[];
  subjectPe?: number | null;
  subjectName?: string;
}) {
  const bars: { name: string; pe: number; me: boolean }[] = [
    ...(subjectPe != null && Number.isFinite(subjectPe)
      ? [{ name: subjectName, pe: subjectPe, me: true }]
      : []),
    ...peers.filter((p) => Number.isFinite(p.pe)).map((p) => ({ name: p.name, pe: p.pe, me: false })),
  ];
  if (bars.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-caption">No peer valuation data.</div>
    );
  }
  const max = Math.max(...bars.map((b) => b.pe)) * 1.1 || 1;
  return (
    <div className="flex h-full items-end gap-4 px-2 pb-6 pt-2">
      {bars.map((b) => (
        <div key={b.name} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1">
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{b.pe.toFixed(1)}</span>
          <div
            className={cn(
              "w-full max-w-[46px] rounded-t-md",
              b.me ? "bg-primary" : "bg-[hsl(var(--foreground)/0.18)]",
            )}
            style={{ height: `${Math.max((b.pe / max) * 100, 3)}%` }}
          />
          <span className="truncate text-center text-[10px] text-muted-foreground" title={b.name}>
            {b.name}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Median of an array of finite numbers (sorted copy). Returns null if empty.
 * Used by the peer scorecard to bucket the subject's metric vs the peer group.
 */
export function medianOf(xs: Array<number | undefined | null>): number | null {
  const ys = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (ys.length === 0) return null;
  const sorted = [...ys].sort((a, b) => a - b);
  const m = sorted.length / 2;
  return sorted.length % 2 === 1
    ? sorted[Math.floor(m)] ?? null
    : ((sorted[m - 1] ?? 0) + (sorted[m] ?? 0)) / 2;
}

/**
 * Bucket a subject metric against the peer median into a green/amber/red
 * signal. For `lowerIsBetter` metrics (P/E, EV/EBITDA), a subject value below
 * the median is green; for `higherIsBetter` metrics (ROE, div yield), above
 * the median is green. The 10% band around the median is amber; outside is
 * red. Mirrors the Lovable spec's "PE green/amber/red vs median" rule.
 */
export function peerTone(
  subject: number | null | undefined,
  median: number | null | undefined,
  kind: "lowerIsBetter" | "higherIsBetter",
): "up" | "amber" | "down" | "muted" {
  if (subject == null || !Number.isFinite(subject) || median == null || !Number.isFinite(median) || median === 0)
    return "muted";
  const ratio = subject / median;
  const inside = kind === "lowerIsBetter" ? ratio <= 1 && ratio >= 0.9 : ratio >= 1 && ratio <= 1.1;
  const better = kind === "lowerIsBetter" ? ratio < 0.9 : ratio > 1.1;
  if (better) return "up";
  if (inside) return "amber";
  return "down";
}

const TONE_CLS = {
  up: "border-[hsl(var(--up)/0.45)] bg-[hsl(var(--up)/0.12)] text-up",
  amber: "border-amber-400/45 bg-amber-400/12 text-amber-500",
  down: "border-[hsl(var(--down)/0.45)] bg-[hsl(var(--down)/0.12)] text-down",
  muted: "border-[hsl(var(--glass-border))] bg-[hsl(var(--foreground)/0.05)] text-muted-foreground",
} as const;

export interface PeerScorecardMetric {
  /** Display label, e.g. "P/E". */
  label: string;
  /** Subject's value. */
  subject: number | null | undefined;
  /** Median of the peer group for this metric. */
  median: number | null;
  /** True for P/E / EV/EBITDA, false for ROE / div yield. */
  kind: "lowerIsBetter" | "higherIsBetter";
  /** Suffix to render, e.g. "x" or "%". */
  unit?: string;
}

export function PeerScorecard({
  metrics,
  subjectName = "This",
}: {
  metrics: PeerScorecardMetric[];
  subjectName?: string;
}) {
  const usable = metrics.filter((m) => m.subject != null && Number.isFinite(m.subject));
  if (usable.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-caption">
        No peer comparison data.
      </div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-[hsl(var(--glass-border))] text-left text-[10px] uppercase tracking-wide text-muted-foreground">
          <th className="px-4 py-2 font-medium">Metric</th>
          <th className="px-3 py-2 text-right font-medium">{subjectName}</th>
          <th className="px-3 py-2 text-right font-medium">Peer median</th>
          <th className="px-5 py-2 text-right font-medium">Signal</th>
        </tr>
      </thead>
      <tbody>
        {usable.map((m) => {
          const tone = peerTone(m.subject, m.median, m.kind);
          const fmt = (v: number | null | undefined) =>
            v == null || !Number.isFinite(v) ? "—" : v.toFixed(m.unit === "%" ? 1 : 1);
          const u = m.unit ?? "";
          return (
            <tr key={m.label} className="border-b border-[hsl(var(--glass-border))] last:border-0">
              <td className="px-4 py-2 font-medium">{m.label}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {fmt(m.subject)}
                {u}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                {fmt(m.median)}
                {u}
              </td>
              <td className="px-5 py-2 text-right">
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                    TONE_CLS[tone],
                  )}
                  title={
                    tone === "up"
                      ? "Better than median"
                      : tone === "amber"
                        ? "In line with median"
                        : tone === "down"
                          ? "Worse than median"
                          : "n/a"
                  }
                >
                  {tone === "up" ? "GREEN" : tone === "amber" ? "AMBER" : tone === "down" ? "RED" : "—"}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
