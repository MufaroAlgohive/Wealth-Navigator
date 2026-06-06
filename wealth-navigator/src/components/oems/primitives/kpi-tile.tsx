"use client";

import { cn } from "@/lib/cn";
import { NumberCell } from "./number-cell";

interface KpiTileProps {
  icon?: React.ReactNode;
  label: string;
  value: string;
  sub?: React.ReactNode;
  /** A live number to render in place of `value`. */
  live?: { sym: string; fallback: number; decimals?: number; prefix?: boolean; suffix?: string; showChange?: boolean };
  tone?: "default" | "positive" | "negative" | "warning";
  className?: string;
}

export function KpiTile({ icon, label, value, sub, live, tone = "default", className }: KpiTileProps) {
  return (
    <div
      className={cn(
        "rounded-md border border-border bg-card p-3 transition-colors",
        "shadow-[inset_0_1px_0_0_hsl(var(--border)/0.3)]",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon && (
          <div
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded",
              tone === "positive" && "bg-up/10 text-up",
              tone === "negative" && "bg-down/10 text-down",
              tone === "warning" && "bg-warning/10 text-warning",
              tone === "default" && "bg-primary/10 text-primary",
            )}
          >
            {icon}
          </div>
        )}
        <p className="text-[10px] font-semibold uppercase tracking-wider">{label}</p>
      </div>
      <div className="mt-1.5 font-mono text-base font-semibold leading-none">
        {live ? (
          <NumberCell
            sym={live.sym}
            fallback={live.fallback}
            decimals={live.decimals ?? 2}
            prefix={live.prefix}
            suffix={live.suffix}
            showChange={live.showChange}
            size="md"
          />
        ) : (
          <span
            data-num
            className={cn(
              tone === "positive" && "text-up",
              tone === "negative" && "text-down",
              tone === "warning" && "text-warning",
            )}
          >
            {value}
          </span>
        )}
      </div>
      {sub && (
        <div
          className={cn(
            "mt-1 font-mono text-[10px]",
            tone === "positive" && "text-up",
            tone === "negative" && "text-down",
            tone === "warning" && "text-warning",
            tone === "default" && "text-muted-foreground",
          )}
        >
          {sub}
        </div>
      )}
    </div>
  );
}
