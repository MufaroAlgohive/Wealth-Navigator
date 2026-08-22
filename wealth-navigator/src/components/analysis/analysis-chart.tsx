"use client";

/**
 * AnalysisChart — lightweight-charts wrapper for the per-symbol Analysis tab.
 * Supports line / candlestick modes with a prev-close baseline, a magnifier
 * tooltip that follows the crosshair, and last-price animation. SSR-safe: the
 * chart is created inside a `useEffect` keyed on the container ref + data
 * identity; the component renders a stable-height shell on first paint.
 *
 * Why lightweight-charts (already a dep at ^4.2.x): built-in canvas perf for
 * long daily series, pan/zoom, time-axis + price-axis.
 *
 * The chart's colour theme is wired to the HSL tokens via getComputedStyle
 * reads at mount. No hard-coded hex anywhere in this file.
 */

import {
  type CandlestickData,
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
import { useEffect, useRef } from "react";

import { ChartsBrandBadge } from "@/components/analysis/charts-brand-badge";
import { cn } from "@/lib/cn";
import { tokenToRgba } from "@/lib/color";

export type ChartMode = "line" | "candle";

export interface AnalysisChartProps {
  sym: string;
  /** OHLC + close points. For "line" mode only `time` + `value` are read. */
  points: Array<{ t: number; v: number }>;
  prevClose: number | null;
  mode: ChartMode;
  height?: number;
  className?: string;
}

export function AnalysisChart({ sym, points, prevClose, mode, height = 360, className }: AnalysisChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<ISeriesApi<"Line"> | ISeriesApi<"Candlestick"> | null>(null);
  // Auto-fit control: the chart should frame the data nicely on first load /
  // when a NEW range arrives, but once the user has panned/zoomed it must stay
  // put (no fighting the analyst). `fitKey` remembers which data identity was
  // last auto-fitted; `userAdjusted` flips when the user actually interacts.
  const fitKeyRef = useRef<unknown>(null);
  const userAdjustedRef = useRef(false);
  const pointerDownRef = useRef(false);

  // Token-driven theme — read once per mount.
  useEffect(() => {
    if (!containerRef.current) return;
    // Tokens are "H S% L%" — convert to rgba() because lightweight-charts'
    // parser rejects hsl() strings (it only understands hex/rgb/rgba).
    const read = (token: string, alpha = 1) => tokenToRgba(token, alpha);
    const bull = read("--up");
    const bear = read("--down");
    const fg = read("--foreground");
    const muted = read("--muted-foreground");
    const border = read("--border");
    const glassBg = read("--glass-bg-strong");

    const seriesColor = (points[points.length - 1]?.v ?? 0) >= (points[0]?.v ?? 0) ? bull : bear;
    const container = containerRef.current;
    const containerWidth = container.clientWidth || 800;

    const chart = createChart(container, {
      width: containerWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: glassBg },
        textColor: fg,
        fontFamily: "var(--font-mono, ui-monospace)",
        fontSize: 10,
        // Custom brand badge replaces the built-in TradingView watermark
        // (see ChartsBrandBadge for the licence-required attribution link).
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: border, style: LineStyle.Dotted },
        horzLines: { color: border, style: LineStyle.Dotted },
      },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
    });
    chartRef.current = chart;

    // Build the data array. lightweight-charts requires ascending-unique
    // time values: the intraday tick stream can emit multiple ticks within
    // the same epoch second, so we collapse duplicates here (last-write-wins)
    // before setData — otherwise `series.setData` throws an assertion.
    const lineData: LineData[] = points
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0)
      .map((p) => ({ time: Math.floor(p.t / 1000) as Time, value: p.v }))
      .sort((a, b) => (a.time as number) - (b.time as number));
    const dedupedByTime = new Map<Time, LineData>();
    for (const point of lineData) dedupedByTime.set(point.time, point);
    const data: LineData[] = [...dedupedByTime.values()].sort(
      (a, b) => (a.time as number) - (b.time as number),
    );

    if (mode === "line") {
      const series = chart.addLineSeries({
        color: seriesColor,
        lineWidth: 2,
        priceLineVisible: true,
        lastValueVisible: true,
        lastPriceAnimation: 2,
      });
      series.setData(data);
      mainSeriesRef.current = series;
    } else {
      // For candlesticks we need OHLC. We have a single `v` per point; build
      // a synthetic OHLC where open = prev close (or first close) and high/low
      // bracket the close with a small spread. This is honest: the underlying
      // TimeSeriesGet2 daily payload only carries a single daily close, so the
      // candle body is a visualisation approximation (footnoted in the UI).
      const ohlc: CandlestickData[] = [];
      let prev = data[0]?.value ?? 0;
      for (let i = 0; i < data.length; i++) {
        const close = data[i]?.value;
        const time = data[i]?.time;
        if (close === undefined || time === undefined) continue;
        const open = i === 0 ? close : prev;
        const high = Math.max(open, close) * 1.0015;
        const low = Math.min(open, close) * 0.9985;
        ohlc.push({
          time,
          open,
          high,
          low,
          close,
        });
        prev = close;
      }
      const series = chart.addCandlestickSeries({
        upColor: bull,
        downColor: bear,
        wickUpColor: bull,
        wickDownColor: bear,
        borderVisible: false,
      });
      series.setData(ohlc);
      mainSeriesRef.current = series;
    }

    // Prev-close baseline (when intraday-equivalent) — visual reference.
    if (prevClose != null && prevClose > 0 && mainSeriesRef.current) {
      try {
        mainSeriesRef.current.createPriceLine({
          price: prevClose,
          color: muted,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          title: "Prev close",
        });
      } catch {
        /* candle series: createPriceLine may not be available in v4 — safe to skip */
      }
    }

    // ── Auto-fit policy ─────────────────────────────────────────────────
    // New data identity (range switch, fresh fetch) → reframe + reset user
    // control. Same data with a mode toggle → keep whatever the user had
    // (or the last frame if untouched).
    const newData = fitKeyRef.current !== points;
    if (newData) {
      fitKeyRef.current = points;
      userAdjustedRef.current = false;
      chart.timeScale().fitContent();
    } else if (!userAdjustedRef.current) {
      chart.timeScale().fitContent();
    }
    // Once the user drags the chart (pan) or scrolls (zoom), stop
    // auto-fitting so the analyst keeps exactly the window they chose.
    const onWheel = () => {
      userAdjustedRef.current = true;
    };
    const onPointerDown = () => {
      pointerDownRef.current = true;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (pointerDownRef.current) userAdjustedRef.current = true;
      void e;
    };
    const onPointerUp = () => {
      pointerDownRef.current = false;
    };
    container.addEventListener("wheel", onWheel, { passive: true });
    container.addEventListener("pointerdown", onPointerDown);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerup", onPointerUp);

    // ── Magnifier tooltip — follow the crosshair with a floating card ──────
    const tooltip = tooltipRef.current;
    // Prev-bar lookup for the tooltip's up/down colour (works for both the 1D
    // prevClose overlay and daily history ranges where prevClose is null).
    const prevByTime = new Map<Time, number>();
    for (let i = 1; i < data.length; i++) {
      const t = data[i]?.time;
      const pv = data[i - 1]?.value;
      if (t !== undefined && pv !== undefined) prevByTime.set(t, pv);
    }
    const showTooltip = (param: MouseEventParams<Time>) => {
      if (!tooltip) return;
      if (!param.point || param.time === undefined) {
        tooltip.style.opacity = "0";
        return;
      }
      const main = mainSeriesRef.current;
      const seriesData = main
        ? (param.seriesData.get(main) as LineData<Time> | CandlestickData<Time> | undefined)
        : undefined;
      const dateStr = new Date(Number(param.time) * 1000).toLocaleDateString("en-ZA", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
      const close =
        seriesData && "close" in seriesData
          ? seriesData.close
          : (seriesData as LineData<Time> | undefined)?.value;
      const prevBar = prevByTime.get(param.time) ?? prevClose;
      const isUp = close != null && prevBar != null ? close >= prevBar : true;
      tooltip.innerHTML = `
        <div class="flex min-w-[124px] flex-col gap-0.5">
          <span class="text-[9px] font-bold uppercase tracking-wider text-muted-foreground">${dateStr}</span>
          <span class="font-mono text-sm font-bold tabular-nums" style="color:${isUp ? "hsl(var(--up))" : "hsl(var(--down))"}">
            ${close != null ? close.toFixed(2) : "—"}
          </span>
          ${
            seriesData && "open" in seriesData
              ? `<span class="font-mono text-[10px] tabular-nums text-muted-foreground">O ${seriesData.open.toFixed(2)} · H ${seriesData.high.toFixed(2)} · L ${seriesData.low.toFixed(2)}</span>`
              : ""
          }
        </div>`;
      const rect = container.getBoundingClientRect();
      tooltip.style.opacity = "1";
      tooltip.style.left = `${Math.min(param.point.x + 14, Math.max(0, rect.width - 170))}px`;
      tooltip.style.top = `${Math.max(0, param.point.y - 10)}px`;
    };
    chart.subscribeCrosshairMove(showTooltip);

    // Resize observer for the main chart.
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width;
        if (w > 0) chart.applyOptions({ width: w });
      }
    });
    ro.observe(container);

    return () => {
      chart.unsubscribeCrosshairMove(showTooltip);
      container.removeEventListener("wheel", onWheel);
      container.removeEventListener("pointerdown", onPointerDown);
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerup", onPointerUp);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      mainSeriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, points, prevClose, height]);

  return (
    <div className={cn("relative", className)} style={{ width: "100%" }}>
      <div
        ref={containerRef}
        style={{ width: "100%", minHeight: height + 120 }}
        aria-label={`${sym} price chart`}
      />
      <ChartsBrandBadge />
      <div
        ref={tooltipRef}
        className="pointer-events-none absolute z-20 min-w-[124px] rounded-xl border border-border bg-card/95 px-3 py-2 opacity-0 shadow-xl shadow-black/20 backdrop-blur-sm"
      />
    </div>
  );
}
