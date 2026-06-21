"use client";

import { cn } from "@/lib/cn";

/**
 * The full source taxonomy the production UI uses. LIVE/MOCK/SEED/SUPABASE/
 * UNCONFIGURED/UNAVAILABLE are the common case; IRESS / YAHOO / EXTERNAL name
 * the upstream feed explicitly (so the dashboard shows whether a number is
 * IRESS-sourced, a Yahoo fallback, or an external API like SARB/ECB/RSS).
 * STREAM marks a Path B SSE/passthrough feed, WORKER a heartbeat-style read
 * straight from the Railway `iress-ingest` worker, BLOCKED-EXTERNAL /
 * BLOCKED-VENDOR mark entitlements/vendor contracts that need to flip on, and
 * CODE-GAP marks a panel that needs implementation work.
 */
export type DataSourceKind =
  | "live"
  | "iress"
  | "yahoo"
  | "external"
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
  iress: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  yahoo: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  external: "border-sky-400/40 bg-sky-400/10 text-sky-300",
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
  iress: "IRESS",
  yahoo: "YAHOO",
  external: "EXTERNAL",
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

/**
 * Which Supabase database a panel's data lives in. RETAIL = mfxng (LIVE retail
 * customer platform + the shared price tables); INSTITUTIONAL = nnwz (OEMS desk
 * trading book + desk analytics). Shown as a small chip beside the source so the
 * full map (which DB · which source) is visible on every module header.
 */
export type DbName = "retail" | "institutional";

const DB_STYLES: Record<DbName, string> = {
  retail: "border-pink-400/40 bg-pink-400/10 text-pink-300",
  institutional: "border-cyan-400/40 bg-cyan-400/10 text-cyan-300",
};
const DB_LABELS: Record<DbName, string> = {
  retail: "MFXNG",
  institutional: "NNWZ",
};
const DB_TITLES: Record<DbName, string> = {
  retail: "Retail DB (mfxng · LIVE retail platform)",
  institutional: "Institutional DB (nnwz · OEMS desk)",
};

const PILL =
  "inline-flex items-center rounded px-1 py-px font-mono text-[8px] font-semibold uppercase tracking-wider border";

interface DataSourceBadgeProps {
  source: DataSourceKind;
  /** Optional database chip (mfxng/nnwz) rendered before the source pill. */
  db?: DbName;
  className?: string;
}

/**
 * Tiny pill(s) indicating where a panel's data comes from: an optional database
 * chip (mfxng / nnwz) followed by the source kind (IRESS / YAHOO / SUPABASE /
 * SEED / …). For live tick-routed panels the source label still derives from
 * `deriveDataSource()` in `src/lib/hooks/quote-routing.ts`; static panels pass
 * an explicit kind (see `mapSource()` in `src/lib/data-source.ts`).
 */
export function DataSourceBadge({ source, db, className }: DataSourceBadgeProps) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {db && (
        <span className={cn(PILL, DB_STYLES[db])} title={DB_TITLES[db]}>
          {DB_LABELS[db]}
        </span>
      )}
      <span className={cn(PILL, STYLES[source])} title={`Data source: ${LABELS[source]}`}>
        {LABELS[source]}
      </span>
    </span>
  );
}
