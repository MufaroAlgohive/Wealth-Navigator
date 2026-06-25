"use client";

import { DatabaseZap } from "lucide-react";
import { cn } from "@/lib/cn";
import { FEED_NOT_CONFIGURED } from "@/lib/data-policy";
import { DataSourceBadge, type DataSourceKind } from "@/components/oems/primitives/data-source-badge";
import type { BffUnavailableReason } from "@/lib/bff-reasons";

interface EmptyDataStateProps {
  title?: string;
  message?: string;
  hint?: string;
  badgeLabel?: DataSourceKind;
  className?: string;
  /**
   * Audit #5 — BFF `reason` taxonomy. When the BFF returns
   * `source: "unavailable"` with a reason, the UI maps that to a
   * specific migration / entitlement / worker hint. The mapping lives
   * in `reasonCopy` below. New reasons must be added there + in
   * `src/lib/bff-reasons.ts` — keep both lists in sync.
   */
  reason?: BffUnavailableReason;
  /**
   * Migration filename surfaced in the body when the reason is
   * `supabase_query_failed` and the schema is missing. Provided by
   * the BFF (`migration` field); defaults to nothing.
   */
  migration?: string;
  /** Raw error class from the BFF (`error` field). Used as a tail message. */
  errorDetail?: string;
}

const reasonCopy: Record<
  BffUnavailableReason,
  { title: string; body: string; badge: DataSourceKind }
> = {
  supabase_not_configured: {
    title: "Vercel env missing",
    body: "Contact your administrator to complete platform configuration.",
    badge: "unconfigured",
  },
  supabase_query_failed: {
    title: "Migration pending",
    body: "Run the Supabase migration listed below in the MyMint SQL editor, then refresh.",
    badge: "blocked-external",
  },
  empty: {
    title: "No rows yet",
    body: "Supabase query succeeded but the table is empty. The worker has not yet ingested data for this view.",
    badge: "unconfigured",
  },
  entitlement_blocked: {
    title: "Data source entitlement required",
    body: "Contact your administrator to enable the required data entitlement on the production system.",
    badge: "blocked-external",
  },
  worker_not_running: {
    title: "Data ingestion service offline",
    body: "The data ingestion service is not responding. Please contact your administrator.",
    badge: "unavailable",
  },
};

/**
 * Honest empty state when no live feed is wired for a panel.
 *
 * `hint` is a secondary line (e.g. the BFF's `message` payload); `badgeLabel`
 * lets the caller surface a specific data-source kind (e.g. `BLOCKED-EXTERNAL`,
 * `MOCK`) right inside the empty state so the data provenance is obvious
 * without needing to read the parent panel's badge.
 *
 * `reason` (audit #5) maps the BFF's typed reason to a specific title +
 * body. When a panel needs a custom empty state for `entitlement_blocked`
 * (e.g. "TimeSeriesGet2 entitlement required") it should pass
 * `message="..."` to override the default body.
 */
export function EmptyDataState({
  title,
  message,
  hint,
  badgeLabel,
  className,
  reason,
  migration,
  errorDetail,
}: EmptyDataStateProps) {
  const copy = reason ? reasonCopy[reason] : null;
  const resolvedTitle = title ?? copy?.title ?? "No live data";
  const resolvedBadge = badgeLabel ?? copy?.badge ?? "unconfigured";
  const resolvedMessage = message ?? copy?.body ?? FEED_NOT_CONFIGURED;
  return (
    <div
      className={cn(
        "flex h-full min-h-[120px] flex-col items-center justify-center gap-2 px-4 py-8 text-center",
        className,
      )}
    >
      <DatabaseZap className="h-5 w-5 text-muted-foreground/60" aria-hidden />
      <p className="text-xs font-medium text-foreground/90">{resolvedTitle}</p>
      <p className="max-w-xs text-[11px] text-muted-foreground">{resolvedMessage}</p>
      {reason === "supabase_query_failed" && migration ? (
        <p className="max-w-xs font-mono text-[10.5px] text-foreground/80">{migration}</p>
      ) : null}
      {reason === "supabase_query_failed" && errorDetail ? (
        <p className="max-w-xs font-mono text-[10px] text-destructive/80">Error: {errorDetail}</p>
      ) : null}
      {hint ? (
        <p className="max-w-xs text-[10.5px] italic text-muted-foreground/80">{hint}</p>
      ) : null}
      {resolvedBadge ? <DataSourceBadge source={resolvedBadge} /> : null}
    </div>
  );
}
