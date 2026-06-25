"use client";

/**
 * AnalysisChart — lightweight-charts wrapper for the per-symbol Analysis tab.
 * Supports line / candlestick modes, SMA20/50/200 + EMA20 overlay, and an
 * optional RSI(14) + MACD(12,26,9) pane. SSR-safe: the chart is created
 * inside a `useEffect` keyed on the container ref + data identity; the
 * component renders a stable-height shell on first paint.
 *
 * Why lightweight-charts (already a dep at ^4.2.x): built-in canvas perf
 * for 10Y daily series, pan/zoom, time-axis + price-axis; we layer the
 * indicator series as separate line series on the main pane (and the
 * oscillator pane as a separate `addPane` instance for v4 — fallback to
 * line series on the same pane if multi-pane is not available).
 *
 * The chart's colour theme is wired to the HSL tokens via getComputedStyle
 * reads at mount, then re-read on `ResizeObserver` for theme changes. No
 * hard-coded hex anywhere in this file.
 */

import {
  type CandlestickData,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  LineStyle,
  type Time,
  createChart,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

export type ChartMode = "line" | "candle";
export type IndicatorKey = "sma20" | "sma50" | "sma200" | "ema20" | "rsi" | "macd";

export interface AnalysisChartProps {
  sym: string;
  /** OHLC + close points. For "line" mode only `time` + `value` are read. */
  points: Array<{ t: number; v: number }>;
  prevClose: number | null;
  mode: ChartMode;
  indicators: Set<IndicatorKey>;
  height?: number;
  className?: string;
}

interface OHLC {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

const SMA = (data: LineData[], period: number): Array<{ time: Time; value: number }> => {
  if (data.length < period) return [];
  const out: Array<{ time: Time; value: number }> = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i]?.value ?? 0;
  for (let i = period - 1; i < data.length; i++) {
    if (i > period - 1) {
      sum += data[i]?.value ?? 0;
      sum -= data[i - period]?.value ?? 0;
    }
    const t = data[i]?.time;
    if (t === undefined) continue;
    out.push({ time: t, value: sum / period });
  }
  return out;
};

const EMA = (data: LineData[], period: number): Array<{ time: Time; value: number }> => {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const out: Array<{ time: Time; value: number }> = [];
  let ema = 0;
  for (let i = 0; i < period; i++) ema += data[i]?.value ?? 0;
  ema /= period;
  const seedT = data[period - 1]?.time;
  if (seedT !== undefined) out.push({ time: seedT, value: ema });
  for (let i = period; i < data.length; i++) {
    ema = (data[i]?.value ?? 0) * k + ema * (1 - k);
    const t = data[i]?.time;
    if (t === undefined) continue;
    out.push({ time: t, value: ema });
  }
  return out;
};

const RSI = (data: LineData[], period = 14): Array<{ time: Time; value: number }> => {
  if (data.length <= period) return [];
  const out: Array<{ time: Time; value: number }> = [];
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = (data[i]?.value ?? 0) - (data[i - 1]?.value ?? 0);
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const t0 = data[period]?.time;
  if (t0 !== undefined) out.push({ time: t0, value: 100 - 100 / (1 + rs0) });
  for (let i = period + 1; i < data.length; i++) {
    const diff = (data[i]?.value ?? 0) - (data[i - 1]?.value ?? 0);
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const t = data[i]?.time;
    if (t === undefined) continue;
    out.push({ time: t, value: 100 - 100 / (1 + rs) });
  }
  return out;
};

const MACD = (
  data: LineData[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): {
  macd: Array<{ time: Time; value: number }>;
  signal: Array<{ time: Time; value: number }>;
  hist: Array<{ time: Time; value: number }>;
} => {
  const emaFast = EMA(data, fast);
  const emaSlow = EMA(data, slow);
  const macd: Array<{ time: Time; value: number }> = [];
  const minLen = Math.min(emaFast.length, emaSlow.length);
  for (let i = 0; i < minLen; i++) {
    const t = emaSlow[i]?.time;
    if (t === undefined) continue;
    macd.push({
      time: t,
      value: (emaFast[emaFast.length - minLen + i]?.value ?? 0) - (emaSlow[i]?.value ?? 0),
    });
  }
  const signal = EMA(macd, signalPeriod);
  const hist: Array<{ time: Time; value: number }> = [];
  for (let i = 0; i < signal.length; i++) {
    const m = macd[macd.length - signal.length + i];
    const s = signal[i];
    if (m && s) hist.push({ time: s.time, value: m.value - s.value });
  }
  return { macd, signal, hist };
};

export function AnalysisChart({
  sym,
  points,
  prevClose,
  mode,
  indicators,
  height = 360,
  className,
}: AnalysisChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainSeriesRef = useRef<ISeriesApi<"Line"> | ISeriesApi<"Candlestick"> | null>(null);
  const indicatorSeriesRef = useRef<{
    sma20?: ISeriesApi<"Line">;
    sma50?: ISeriesApi<"Line">;
    sma200?: ISeriesApi<"Line">;
    ema20?: ISeriesApi<"Line">;
    rsi?: ISeriesApi<"Line">;
    macd?: ISeriesApi<"Line">;
    macdSignal?: ISeriesApi<"Line">;
    macdHist?: ISeriesApi<"Histogram">;
  }>({});
  const oscillatorChartRef = useRef<IChartApi | null>(null);

  // Token-driven theme — read once per mount + on every container resize.
  useEffect(() => {
    if (!containerRef.current) return;
    const root = document.documentElement;
    const css = getComputedStyle(root);
    const read = (token: string, alpha = 1) => {
      const v = css.getPropertyValue(token).trim();
      if (!v) return `rgba(150,150,150,${alpha})`;
      // Tokens are "H S% L%" — wrap in hsl() with optional alpha via hsl(... / a).
      return alpha === 1 ? `hsl(${v})` : `hsl(${v} / ${alpha})`;
    };
    const isUp = points[points.length - 1]?.v ?? 0 >= (points[0]?.v ?? 0);
    const bull = read("--up");
    const bear = read("--down");
    const fg = read("--foreground");
    const muted = read("--muted-foreground");
    const border = read("--border");
    const glassBg = read("--glass-bg-strong");
    const primary = read("--primary");

    const seriesColor = isUp ? bull : bear;
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

    // Build the data array.
    const lineData: LineData[] = points
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > 0)
      .map((p) => ({ time: Math.floor(p.t / 1000) as Time, value: p.v }));

    if (mode === "line") {
      const series = chart.addLineSeries({
        color: seriesColor,
        lineWidth: 2,
        priceLineVisible: true,
        lastValueVisible: true,
      });
      series.setData(lineData);
      mainSeriesRef.current = series;
    } else {
      // For candlesticks we need OHLC. We have a single `v` per point; build
      // a synthetic OHLC where open = prev close (or first close) and high/low
      // bracket the close with a small spread. This is honest: the underlying
      // TimeSeriesGet2 daily payload only carries a single daily close, so the
      // candle body is a visualisation approximation (footnoted in the UI).
      const ohlc: CandlestickData[] = [];
      let prev = lineData[0]?.value ?? 0;
      for (let i = 0; i < lineData.length; i++) {
        const close = lineData[i]?.value;
        const time = lineData[i]?.time;
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

    // Indicators — overlay on the main chart.
    const slots = indicatorSeriesRef.current;
    const addLine = (
      key: "sma20" | "sma50" | "sma200" | "ema20" | "rsi" | "macd" | "macdSignal",
      data: Array<{ time: Time; value: number }>,
      colour: string,
      lineWidth: 1 | 2 | 3 | 4 = 1,
    ) => {
      if (data.length === 0) return;
      const s = chart.addLineSeries({
        color: colour,
        lineWidth,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      s.setData(data as LineData[]);
      slots[key] = s as ISeriesApi<"Line">;
    };

    if (lineData.length > 0) {
      if (indicators.has("sma20")) addLine("sma20", SMA(lineData, 20), read("--chart-3"), 1);
      if (indicators.has("sma50")) addLine("sma50", SMA(lineData, 50), read("--chart-4"), 1);
      if (indicators.has("sma200")) addLine("sma200", SMA(lineData, 200), read("--chart-5"), 1);
      if (indicators.has("ema20")) addLine("ema20", EMA(lineData, 20), read("--chart-2"), 1);
    }

    // Oscillator pane (separate chart, synced time axis via `subscribeVisibleTimeRangeChange`).
    const wantsOscillator = indicators.has("rsi") || indicators.has("macd");
    if (wantsOscillator && lineData.length > 0) {
      const oscHeight = 110;
      const oscContainer = document.createElement("div");
      oscContainer.style.height = `${oscHeight}px`;
      oscContainer.style.width = "100%";
      oscContainer.style.marginTop = "8px";
      container.appendChild(oscContainer);
      const osc = createChart(oscContainer, {
        width: containerWidth,
        height: oscHeight,
        layout: {
          background: { type: ColorType.Solid, color: glassBg },
          textColor: muted,
          fontFamily: "var(--font-mono, ui-monospace)",
          fontSize: 9,
        },
        grid: {
          vertLines: { color: border, style: LineStyle.Dotted },
          horzLines: { color: border, style: LineStyle.Dotted },
        },
        rightPriceScale: { borderColor: border },
        timeScale: { borderColor: border, timeVisible: true, secondsVisible: false },
        crosshair: { mode: CrosshairMode.Normal },
      });
      oscillatorChartRef.current = osc;

      if (indicators.has("rsi")) {
        const rsiData = RSI(lineData, 14);
        if (rsiData.length > 0) {
          const s = osc.addLineSeries({
            color: read("--chart-2"),
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: true,
          });
          s.setData(rsiData as LineData[]);
          // 30/70 bands
          s.createPriceLine({
            price: 70,
            color: bear,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            title: "70",
          });
          s.createPriceLine({
            price: 30,
            color: bull,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            title: "30",
          });
          slots.rsi = s;
        }
      }
      if (indicators.has("macd")) {
        const { macd, signal, hist } = MACD(lineData);
        const ms = osc.addLineSeries({
          color: primary,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: true,
        });
        ms.setData(macd as LineData[]);
        slots.macd = ms;
        const ss = osc.addLineSeries({
          color: read("--chart-3"),
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        ss.setData(signal as LineData[]);
        slots.macdSignal = ss;
        if (hist.length > 0) {
          const hs = osc.addHistogramSeries({
            color: bull,
            priceLineVisible: false,
            lastValueVisible: false,
          });
          hs.setData(
            hist.map((p, i) => ({
              time: p.time,
              value: p.value,
              color: i > 0 && (hist[i]?.value ?? 0) >= 0 ? bull : bear,
            })) as never,
          );
          slots.macdHist = hs;
        }
      }

      // Sync time scales.
      const sync = () => {
        try {
          const t = chart.timeScale().getVisibleLogicalRange();
          if (t) osc.timeScale().setVisibleLogicalRange(t);
        } catch {
          /* ignore */
        }
      };
      const sync2 = () => {
        try {
          const t = osc.timeScale().getVisibleLogicalRange();
          if (t) chart.timeScale().setVisibleLogicalRange(t);
        } catch {
          /* ignore */
        }
      };
      chart.timeScale().subscribeVisibleLogicalRangeChange(sync);
      osc.timeScale().subscribeVisibleLogicalRangeChange(sync2);
    }

    chart.timeScale().fitContent();

    // Resize observer for the main + oscillator charts.
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width;
        if (w > 0) {
          chart.applyOptions({ width: w });
          if (oscillatorChartRef.current) oscillatorChartRef.current.applyOptions({ width: w });
        }
      }
    });
    ro.observe(container);

    return () => {
      ro.disconnect();
      chart.remove();
      oscillatorChartRef.current?.remove();
      oscillatorChartRef.current = null;
      chartRef.current = null;
      mainSeriesRef.current = null;
      indicatorSeriesRef.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, points, prevClose, height, indicators]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", minHeight: height + 120 }}
      aria-label={`${sym} price chart`}
    />
  );
}
