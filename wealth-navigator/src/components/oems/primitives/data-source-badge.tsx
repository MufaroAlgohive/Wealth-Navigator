"use client";

import { cn } from "@/lib/cn";

export type DataSourceKind = "live" | "mock" | "seed" | "hybrid" | "supabase";

const STYLES: Record<DataSourceKind, string> = {
  live: "border-success/40 bg-success/10 text-success",
  mock: "border-border bg-muted/40 text-muted-foreground",
  seed: "border-warning/40 bg-warning/10 text-warning",
  hybrid: "border-primary/40 bg-primary/10 text-primary",
  supabase: "border-info/40 bg-info/10 text-info",
};

const LABELS: Record<DataSourceKind, string> = {
  live: "LIVE",
  mock: "MOCK",
  seed: "SEED",
  hybrid: "HYBRID",
  supabase: "SUPABASE",
};

interface DataSourceBadgeProps {
  source: DataSourceKind;
  className?: string;
}

/** Tiny pill indicating whether panel data is live, seed, mock, hybrid, or DB-first. */
export function DataSourceBadge({ source, className }: DataSourceBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1 py-px font-mono text-[8px] font-semibold uppercase tracking-wider border",
        STYLES[source],
        className,
      )}
      title={`Data source: ${LABELS[source]}`}
    >
      {LABELS[source]}
    </span>
  );
}
