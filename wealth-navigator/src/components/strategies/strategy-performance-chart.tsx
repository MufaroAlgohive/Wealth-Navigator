"use client";

/**
 * StrategyPerformanceChart — lightweight-charts performance chart for the
 * strategy detail page (replaces the old hand-rolled SVG line).
 *
 * Built on lightweight-charts v4 (already a dependency, ^4.2.x — the same
 * engine as the per-symbol AnalysisChart). Design decisions:
 *
 * - **Baseline series**: returns are rebased to 100 at the window start, so a
 *   `Baseline` series (baseValue = 100) is the semantically correct series
 *   type — the area fills green above 100 and red below it, which is exactly
 *   "vs the window-start index".
 * - **Magnifier tooltip**: a custom HTML overlay follows the crosshair and
 *   shows the date, the indexed value, and the benchmark value (when
 *   provided) — the "magnifier" feel users get in dedicated charting apps.
 * - **Theme responsive**: every colour is read from the CSS HSL tokens at
 *   mount AND re-read whenever `next-themes` toggles the `.dark` / `.light`
 *   class on `<html>`, so the chart follows the app theme without a reload.
 * - **Animation**: last-price pulse on data updates + entrance fade-in.
 *
 * SSR-safe: the chart is created inside a `useEffect` keyed on the container
 * ref; the component paints a stable-height shell first.
 */

import {
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  LineStyle,
  type MouseEventParams,
  type Time,
  createChart,
} from "lightweight-charts";
import * as React from "react";

import { ChartsBrandBadge } from "@/components/analysis/charts-brand-badge";
import { cn } from "@/lib/cn";
import { hslToRgba } from "@/lib/color";
import { formatDate } from "@/lib/format";

const RANGES = ["1M", "3M", "YTD", "ALL"] as const;
export type Range = (typeof RANGES)[number];

/** Minimal canonical return row (the page's ReturnRow satisfies this). */
export interface StrategyReturnRow {
  as_of_date: string;
  ytd_pct?: number | null;
  all_pct?: number | null;
  "1d_pct": number | null;
}

/** A single indexed point (asOfDate "YYYY-MM-DD" → value, rebased to 100). */
export interface IndexedPoint {
  asOfDate: string;
  value: number;
}

export interface StrategyPerformanceChartProps {
  /** Raw canonical return rows — indexed to 100 internally. */
  rows: StrategyReturnRow[];
  /** Optional benchmark series (e.g. JSE All Share, already rebased). */
  benchmark?: IndexedPoint[];
  /** Benchmark display name (defaults to "Benchmark"). */
  benchmarkName?: string;
  height?: number;
  className?: string;
}

/** Build an index from canonical return rows the same way the detail page
 *  used to (chain 1d_pct → 100-based wealth index). */
function indexFromRows(rows: StrategyReturnRow[]): IndexedPoint[] {
  const ordered = [...rows]
    .filter((row) => row.as_of_date && row["1d_pct"] != null && Number.isFinite(Number(row["1d_pct"])))
    .sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
  if (!ordered.length) return [];
  let value = 100;
  return ordered.map((row, index) => {
    if (index > 0) value *= 1 + Number(row["1d_pct"]) / 100;
    return { asOfDate: row.as_of_date, value };
  });
}

/** Rebase a series to 100 at the first point inside the window. */
function rebase(points: IndexedPoint[], startDate: string): IndexedPoint[] {
  const visible = points.filter((p) => p.asOfDate >= startDate);
  const base = visible[0]?.value;
  if (!base || base <= 0) return visible.map((p) => ({ ...p, value: 100 }));
  return visible.map((p) => ({ ...p, value: (p.value / base) * 100 }));
}

function windowStart(range: Range, points: IndexedPoint[]): string {
  const last = points.at(-1)?.asOfDate ?? new Date().toISOString().slice(0, 10);
  if (range === "ALL") return "";
  const d = new Date(`${last}T00:00:00Z`);
  if (range === "YTD") return `${d.getUTCFullYear()}-01-01`;
  const months = range === "1M" ? 1 : 3;
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

const toLwTime = (asOfDate: string): Time =>
  Math.floor(new Date(`${asOfDate}T00:00:00Z`).getTime() / 1000) as Time;

interface ThemeTokens {
  up: string;
  down: string;
  fg: string;
  muted: string;
  border: string;
}

function readTheme(): ThemeTokens {
  const css = getComputedStyle(document.documentElement);
  const read = (token: string) => {
    const v = css.getPropertyValue(token).trim();
    if (!v) return "0 0% 60%";
    return v;
  };
  return {
    up: read("--up"),
    down: read("--down"),
    fg: read("--foreground"),
    muted: read("--muted-foreground"),
    border: read("--border"),
  };
}

interface TooltipState {
  x: number;
  y: number;
  date: string;
  value: number | null;
  benchValue: number | null;
}

export function StrategyPerformanceChart({
  rows,
  benchmark,
  benchmarkName = "Benchmark",
  height = 240,
  className,
}: StrategyPerformanceChartProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const tooltipRef = React.useRef<HTMLDivElement | null>(null);
  const seriesRef = React.useRef<ISeriesApi<"Baseline"> | null>(null);
  const benchSeriesRef = React.useRef<ISeriesApi<"Line"> | null>(null);
  const [range, setRange] = React.useState<Range>("YTD");
  const [tooltip, setTooltip] = React.useState<TooltipState | null>(null);

  const all = React.useMemo(() => indexFromRows(rows), [rows]);
  const benchAll = React.useMemo(
    () => (benchmark?.length ? [...benchmark].sort((a, b) => a.asOfDate.localeCompare(b.asOfDate)) : []),
    [benchmark],
  );

  const points = React.useMemo(() => rebase(all, windowStart(range, all)), [all, range]);
  const benchPoints = React.useMemo(
    () => (benchAll.length ? rebase(benchAll, windowStart(range, benchAll)) : []),
    [benchAll, range],
  );

  const first = points[0]?.value ?? 100;
  const latest = points.at(-1)?.value;
  const movePct = latest != null ? latest - 100 : null;
  const latestDate = points.at(-1)?.asOfDate;

  React.useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const width = container.clientWidth || 800;
    const theme = readTheme();

    const chart: IChartApi = createChart(container, {
      width,
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: hslToRgba(theme.fg),
        fontFamily: "var(--font-jetbrains-mono, ui-monospace, monospace)",
        fontSize: 10,
        // Custom brand badge replaces the built-in TradingView watermark
        // (see ChartsBrandBadge for the licence-required attribution link).
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: hslToRgba(theme.border), style: LineStyle.Dotted },
        horzLines: { color: hslToRgba(theme.border), style: LineStyle.Dotted },
      },
      rightPriceScale: {
        borderColor: hslToRgba(theme.border),
        scaleMargins: { top: 0.12, bottom: 0.1 },
      },
      timeScale: {
        borderColor: hslToRgba(theme.border),
        timeVisible: false,
        secondsVisible: false,
        rightOffset: 4,
        barSpacing: 8,
        minBarSpacing: 4,
      },
      crosshair: { mode: CrosshairMode.Magnet },
      handleScroll: { vertTouchDrag: false, pressedMouseMove: true, horzTouchDrag: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      localization: {
        timeFormatter: (time: Time) => formatDate(Number(time) * 1000),
      },
    });

    const baselineSeries = chart.addBaselineSeries({
      baseValue: { type: "price", price: first },
      topLineColor: hslToRgba(theme.up),
      topFillColor1: hslToRgba(theme.up, 0.28),
      topFillColor2: hslToRgba(theme.up, 0.02),
      bottomLineColor: hslToRgba(theme.down),
      bottomFillColor1: hslToRgba(theme.down, 0.22),
      bottomFillColor2: hslToRgba(theme.down, 0.02),
      lineWidth: 2,
      priceLineVisible: true,
      lastValueVisible: true,
      priceLineColor: hslToRgba(theme.muted),
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      lastPriceAnimation: 2,
    });
    seriesRef.current = baselineSeries;

    let benchSeries: ISeriesApi<"Line"> | null = null;
    if (benchPoints.length > 0) {
      benchSeries = chart.addLineSeries({
        color: hslToRgba(theme.muted),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      benchSeriesRef.current = benchSeries;
    }

    baselineSeries.setData(
      points.map((p) => ({ time: toLwTime(p.asOfDate), value: Number(p.value.toFixed(4)) })),
    );
    if (benchSeries) {
      benchSeries.setData(
        benchPoints.map((p) => ({ time: toLwTime(p.asOfDate), value: Number(p.value.toFixed(4)) })),
      );
    }

    chart.timeScale().fitContent();

    // ── Magnifier tooltip — follow the crosshair with a floating card. ──────
    const showTooltip = (param: MouseEventParams<Time>) => {
      if (!param.point || param.time === undefined) {
        setTooltip(null);
        return;
      }
      const seriesData = param.seriesData.get(baselineSeries) as LineData<Time> | undefined;
      const benchData = benchSeries
        ? (param.seriesData.get(benchSeries) as LineData<Time> | undefined)
        : undefined;
      setTooltip({
        x: param.point.x,
        y: param.point.y,
        date: formatDate(Number(param.time) * 1000),
        value: seriesData?.value ?? null,
        benchValue: benchData?.value ?? null,
      });
    };

    chart.subscribeCrosshairMove(showTooltip);

    // Resize observer keeps the canvas sharp across window/panel resizes.
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width;
        if (w > 0) chart.applyOptions({ width: w });
      }
    });
    ro.observe(container);

    // Re-theme when next-themes flips the `.dark` class on <html>.
    const mo = new MutationObserver(() => {
      const t = readTheme();
      chart.applyOptions({
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: hslToRgba(t.fg),
        },
        grid: {
          vertLines: { color: hslToRgba(t.border), style: LineStyle.Dotted },
          horzLines: { color: hslToRgba(t.border), style: LineStyle.Dotted },
        },
        rightPriceScale: { borderColor: hslToRgba(t.border) },
        timeScale: { borderColor: hslToRgba(t.border) },
      });
      seriesRef.current?.applyOptions({
        topLineColor: hslToRgba(t.up),
        topFillColor1: hslToRgba(t.up, 0.28),
        topFillColor2: hslToRgba(t.up, 0.02),
        bottomLineColor: hslToRgba(t.down),
        bottomFillColor1: hslToRgba(t.down, 0.22),
        bottomFillColor2: hslToRgba(t.down, 0.02),
        priceLineColor: hslToRgba(t.muted),
      });
      benchSeriesRef.current?.applyOptions({ color: hslToRgba(t.muted) });
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      chart.unsubscribeCrosshairMove(showTooltip);
      ro.disconnect();
      mo.disconnect();
      chart.remove();
      seriesRef.current = null;
      benchSeriesRef.current = null;
    };
    // Rebuild when the range window changes (points identity changes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, benchPoints, height, first]);

  const tooltipValueColor =
    tooltip?.value != null && tooltip.value >= 100 ? "hsl(var(--up))" : "hsl(var(--down))";

  return (
    <div className={cn("relative", className)}>
      {/* Range selector */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2 font-mono text-[10px] text-muted-foreground">
          <span className="font-bold text-foreground">100</span>
          <span>index</span>
          {latestDate && <span className="hidden sm:inline">· {formatDate(latestDate)}</span>}
          {movePct != null && (
            <span
              className={cn("font-bold", movePct >= 0 ? "text-[hsl(var(--up))]" : "text-[hsl(var(--down))]")}
            >
              {movePct >= 0 ? "+" : ""}
              {movePct.toFixed(2)}%
            </span>
          )}
        </div>
        <div className="flex gap-1">
          {RANGES.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setRange(item)}
              className={cn(
                "rounded-md px-2 py-1 text-[9px] font-bold transition-colors",
                range === item
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted/50 text-muted-foreground hover:bg-muted",
              )}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      <div ref={containerRef} style={{ width: "100%", height }} aria-label="Strategy performance chart" />
      <ChartsBrandBadge />

      {/* Magnifier tooltip */}
      {tooltip && (
        <div
          ref={tooltipRef}
          className="pointer-events-none absolute z-20 min-w-[118px] rounded-xl border border-border bg-card/95 px-3 py-2 shadow-xl shadow-black/20 backdrop-blur-sm"
          style={{
            left: Math.min(tooltip.x + 14, Math.max(0, (containerRef.current?.clientWidth ?? 0) - 160)),
            top: Math.max(0, tooltip.y - 10),
          }}
        >
          <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
            {tooltip.date}
          </p>
          <p className="font-mono text-sm font-bold tabular-nums" style={{ color: tooltipValueColor }}>
            {tooltip.value != null ? tooltip.value.toFixed(2) : "—"}{" "}
            <span className="text-[10px] font-semibold text-muted-foreground">idx</span>
          </p>
          {tooltip.benchValue != null && (
            <p className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {benchmarkName} {tooltip.benchValue.toFixed(2)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
