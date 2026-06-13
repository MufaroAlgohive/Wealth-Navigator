"use client";

import { cn } from "@/lib/cn";

/**
 * The full source taxonomy the production UI uses. The legacy
 * LIVE/MOCK/SEED/SUPABASE/UNCONFIGURED/UNAVAILABLE labels are the
 * common case; STREAM marks a Path B SSE/passthrough feed, WORKER
 * marks a heartbeat-style read straight from the Railway `iress-ingest`
 * worker, BLOCKED-EXTERNAL / BLOCKED-VENDOR mark entitlements or
 * vendor contracts that need to flip on, and CODE-GAP marks a panel
 * that needs implementation work.
 */
export type DataSourceKind =
  | "live"
  | "mock"
  | "seed"
  | "hybrid"
  | "supabase"
  | "stream"
  | "worker"
  | "unconfigured"
  | "unavailable"
  | "blocked-external"
  | "blocked-vendor"
  | "code-gap";

const STYLES: Record<DataSourceKind, string> = {
  live: "border-success/40 bg-success/10 text-success",
  mock: "border-border bg-muted/40 text-muted-foreground",
  seed: "border-warning/40 bg-warning/10 text-warning",
  hybrid: "border-primary/40 bg-primary/10 text-primary",
  supabase: "border-info/40 bg-info/10 text-info",
  stream: "border-primary/40 bg-primary/10 text-primary",
  worker: "border-primary/40 bg-primary/10 text-primary",
  unconfigured: "border-border bg-muted/30 text-muted-foreground",
  unavailable: "border-destructive/40 bg-destructive/10 text-destructive",
  "blocked-external": "border-warning/40 bg-warning/10 text-warning",
  "blocked-vendor": "border-warning/40 bg-warning/10 text-warning",
  "code-gap": "border-warning/40 bg-warning/10 text-warning",
};

const LABELS: Record<DataSourceKind, string> = {
  live: "LIVE",
  mock: "MOCK",
  seed: "SEED",
  hybrid: "HYBRID",
  supabase: "SUPABASE",
  stream: "STREAM",
  worker: "WORKER",
  unconfigured: "UNCONFIGURED",
  unavailable: "UNAVAILABLE",
  "blocked-external": "BLOCKED-EXTERNAL",
  "blocked-vendor": "BLOCKED-VENDOR",
  "code-gap": "CODE-GAP",
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
