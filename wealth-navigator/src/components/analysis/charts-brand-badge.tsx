"use client";

/**
 * ChartsBrandBadge — replaces lightweight-charts' built-in TradingView
 * attribution watermark with our own brand mark, and ships the licence's
 * required "Charts by TradingView" attribution link alongside it.
 *
 * lightweight-charts is Apache-2.0 + the TradingView attribution requirement
 * (link to https://www.tradingview.com/ visible to users). Setting
 * `attributionLogo: false` is permitted by the library as long as we fulfil
 * the linking requirement ourselves — this badge does that.
 *
 * Positioned absolutely bottom-left of the chart container, mirroring the
 * spot the built-in watermark occupied, so it never overlaps the price scale.
 */
import * as React from "react";

import { cn } from "@/lib/cn";

export interface ChartsBrandBadgeProps {
  className?: string;
  /** Pixel size of the brand icon. */
  size?: number;
}

export function ChartsBrandBadge({ className, size = 24 }: ChartsBrandBadgeProps) {
  return (
    <div
      className={cn(
        "pointer-events-auto absolute bottom-1 left-1 z-10 flex items-center gap-1.5 rounded-md bg-card/70 px-1.5 py-1 text-[9px] font-semibold text-muted-foreground shadow-sm backdrop-blur-sm",
        className,
      )}
      aria-label="Chart brand and attribution"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/icon.png"
        alt=""
        width={size}
        height={size}
        className="h-6 w-6 shrink-0 rounded-sm object-contain"
        draggable={false}
      />
      <a
        href="https://www.tradingview.com/"
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        title="Charts by TradingView"
      >
        Charts by TradingView
      </a>
    </div>
  );
}
