"use client";

/**
 * FactsheetPerformanceChart — Yahoo-style lightweight-charts area chart for
 * the admin Factsheets detail view (replaces the old hand-rolled SVG line).
 *
 * Built on lightweight-charts v4 (already a dependency, ^4.2.x):
 * - **Area series with a vertical gradient fill** (Yahoo's classic "filled
 *   area" view): the line is the theme's up/down colour and the fill fades
 *   from a translucent top colour to fully transparent at the baseline.
 * - **Draw-in animation**: the series is revealed progressively (a few
 *   points per animation frame) so the chart "draws itself" on first
 *   render / every range switch — like a live chart loading, never blocking.
 * - **Magnifier tooltip**: an HTML overlay follows the crosshair and shows
 *   the date + indexed value.
 * - **Theme responsive**: every colour is read from the CSS HSL tokens at
 *   mount AND re-read whenever `next-themes` toggles the `.dark` / `.light`
 *   class on `<html>`.
 * - **Last-price pulse** on data updates + auto-fit once the draw-in ends.
 *
 * SSR-safe: the chart is created inside a `useEffect` keyed on the
 * container ref; the component paints a stable-height shell first.
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
import type { CanonicalChartRange } from "@/lib/returns/canonical-index";

/** A single indexed point (asOfDate "YYYY-MM-DD" → value, rebased to 100). */
export interface IndexedPoint {
  asOfDate: string;
  value: number;
}

export interface FactsheetPerformanceChartProps {
  /** Indexed points for the ACTIVE range window (already rebased to 100). */
  series: IndexedPoint[];
  range: CanonicalChartRange;
  onRangeChange: (range: CanonicalChartRange) => void;
  height?: number;
  className?: string;
}

const RANGES: CanonicalChartRange[] = ["YTD", "3M", "6M", "1Y", "ALL"];

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
}

export function FactsheetPerformanceChart({
  series,
  range,
  onRangeChange,
  height = 260,
  className,
}: FactsheetPerformanceChartProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const seriesRef = React.useRef<ISeriesApi<"Area"> | null>(null);
  const [tooltip, setTooltip] = React.useState<TooltipState | null>(null);

  const latest = series.at(-1);
  const movePct = latest != null ? latest.value - 100 : null;
  const up = movePct == null || movePct >= 0;

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

    const areaSeries = chart.addAreaSeries({
      lineColor: hslToRgba(theme.up),
      topColor: hslToRgba(theme.up, 0.32),
      bottomColor: hslToRgba(theme.up, 0.01),
      lineWidth: 2,
      priceLineVisible: true,
      lastValueVisible: true,
      priceLineColor: hslToRgba(theme.muted),
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      lastPriceAnimation: 2,
    });
    seriesRef.current = areaSeries;

    const points = series
      .filter((p) => p.asOfDate && Number.isFinite(Number(p.value)))
      .map((p) => ({
        time: Math.floor(new Date(`${p.asOfDate}T00:00:00Z`).getTime() / 1000) as Time,
        value: Number(Number(p.value).toFixed(4)),
      }));
    const isUp = (points.at(-1)?.value ?? 0) >= (points[0]?.value ?? 0);

    if (!isUp) {
      areaSeries.applyOptions({
        lineColor: hslToRgba(theme.down),
        topColor: hslToRgba(theme.down, 0.28),
        bottomColor: hslToRgba(theme.down, 0.01),
      });
    }

    // ── Draw-in animation — reveal the series progressively, Yahoo-style. ──
    let animationFrame = 0;
    let reveal = 0;
    let disposed = false;
    const drawIn = () => {
      if (disposed) return;
      if (points.length === 0) return;
      // 10 points per frame → a ~600-point series draws in under a second.
      const target = Math.min(reveal + 10, points.length);
      areaSeries.setData(points.slice(0, target));
      reveal = target;
      if (reveal < points.length) {
        animationFrame = requestAnimationFrame(drawIn);
      } else {
        chart.timeScale().fitContent();
      }
    };
    if (points.length >= 2) {
      areaSeries.setData(points.slice(0, 2));
      animationFrame = requestAnimationFrame(drawIn);
    }

    // ── Magnifier tooltip — follow the crosshair with a floating card. ──────
    const showTooltip = (param: MouseEventParams<Time>) => {
      if (!param.point || param.time === undefined) {
        setTooltip(null);
        return;
      }
      const seriesData = param.seriesData.get(areaSeries) as LineData<Time> | undefined;
      setTooltip({
        x: param.point.x,
        y: param.point.y,
        date: formatDate(Number(param.time) * 1000),
        value: seriesData?.value ?? null,
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
        lineColor: hslToRgba(t.up),
        topColor: hslToRgba(t.up, 0.32),
        bottomColor: hslToRgba(t.up, 0.01),
        priceLineColor: hslToRgba(t.muted),
      });
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      chart.unsubscribeCrosshairMove(showTooltip);
      ro.disconnect();
      mo.disconnect();
      chart.remove();
      seriesRef.current = null;
    };
  }, [series, height]);

  const tooltipValueColor = tooltip?.value != null && tooltip.value >= 100 ? "var(--up)" : "var(--down)";

  return (
    <div className={cn("rounded-2xl border border-border bg-card p-5", className)}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-foreground">Performance</h3>
          <p className="text-xs text-muted-foreground">
            Canonical {range} return chain, indexed to 100 · rebalance neutral
          </p>
        </div>
        <div
          className={cn(
            "text-sm font-bold",
            movePct == null ? "text-muted-foreground" : up ? "text-up" : "text-down",
          )}
        >
          {movePct == null ? "—" : `${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}%`}
        </div>
      </div>
      <div className="mb-3 flex flex-wrap gap-1">
        {RANGES.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onRangeChange(option)}
            className={cn(
              "rounded-md px-2.5 py-1 text-[11px] font-semibold",
              range === option
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {option}
          </button>
        ))}
      </div>
      <div className="relative">
        {series.length < 2 ? (
          <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
            Performance history is not yet available for {range}.
          </div>
        ) : (
          <>
            <div
              ref={containerRef}
              style={{ width: "100%", height }}
              aria-label="Canonical strategy performance chart"
            />
            <ChartsBrandBadge />
            {tooltip && (
              <div
                className="pointer-events-none absolute z-20 min-w-[118px] rounded-xl border border-border bg-card/95 px-3 py-2 shadow-xl shadow-black/20 backdrop-blur-sm"
                style={{
                  left: Math.min(tooltip.x + 14, Math.max(0, (containerRef.current?.clientWidth ?? 0) - 150)),
                  top: Math.max(0, tooltip.y - 10),
                }}
              >
                <p className="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
                  {tooltip.date}
                </p>
                <p
                  className="font-mono text-sm font-bold tabular-nums"
                  style={{ color: `hsl(${tooltipValueColor})` }}
                >
                  {tooltip.value != null ? tooltip.value.toFixed(2) : "—"}{" "}
                  <span className="text-[10px] font-semibold text-muted-foreground">idx</span>
                </p>
              </div>
            )}
          </>
        )}
      </div>
      {series.length >= 2 && (
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>{series[0]?.asOfDate}</span>
          <span>{latest?.asOfDate}</span>
        </div>
      )}
    </div>
  );
}
