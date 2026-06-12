"use client";

import { cn } from "@/lib/cn";
import { useThrottledTickSeries, useTick } from "@/lib/store/tick-stream-provider";

interface SparklineProps {
  sym: string;
  fallback: number;
  height?: number;
  width?: number;
  color?: string;
  className?: string;
  /** Number of points to retain. */
  points?: number;
  /** Sampling interval in ms. Defaults to 1 s — the SSE stream ticks at
   *  ~3 Hz but humans can't read a 36-point chart faster than that. */
  intervalMs?: number;
}

/**
 * A live-updating sparkline. Subscribes to the tick stream through
 * `useThrottledTickSeries` so it only re-renders at the throttled cadence
 * (default 1 Hz) instead of the full ~3 Hz stream. The buffer and the
 * "is there a new sample?" check live in the provider's hook, so this
 * component is a pure renderer of whatever buffer it receives.
 */
export function Sparkline({ sym, fallback, height = 28, width = 80, color, className, points = 36, intervalMs }: SparklineProps) {
  const tick = useTick(sym);
  const hasLive = tick.ts > 0 && tick.last > 0;
  const data = useThrottledTickSeries(sym, hasLive ? tick.last : 0, points, intervalMs);

  if (!hasLive || data.length < 2 || data.every((v) => v === 0)) {
    return <svg className={cn("inline-block", className)} width={width} height={height} aria-hidden />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const dx = width / (points - 1);
  const up = data[data.length - 1]! >= data[0]!;
  const stroke = color ?? (up ? "hsl(var(--up))" : "hsl(var(--down))");
  const path = data
    .map((v, i) => {
      const x = i * dx;
      const y = height - ((v - min) / range) * (height - 2) - 1;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  // Area under the curve
  const area = `${path} L${(data.length - 1) * dx},${height} L0,${height} Z`;
  return (
    <svg className={cn("inline-block overflow-visible", className)} width={width} height={height} aria-hidden>
      <path d={area} fill={stroke} fillOpacity={0.12} />
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
