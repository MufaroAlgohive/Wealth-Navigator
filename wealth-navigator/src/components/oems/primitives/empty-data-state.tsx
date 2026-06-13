"use client";

import { DatabaseZap } from "lucide-react";
import { cn } from "@/lib/cn";
import { FEED_NOT_CONFIGURED } from "@/lib/data-policy";
import { DataSourceBadge, type DataSourceKind } from "@/components/oems/primitives/data-source-badge";

interface EmptyDataStateProps {
  title?: string;
  message?: string;
  hint?: string;
  badgeLabel?: DataSourceKind;
  className?: string;
}

/**
 * Honest empty state when no live feed is wired for a panel.
 *
 * `hint` is a secondary line (e.g. the BFF's `message` payload); `badgeLabel`
 * lets the caller surface a specific data-source kind (e.g. `BLOCKED-EXTERNAL`,
 * `MOCK`) right inside the empty state so the data provenance is obvious
 * without needing to read the parent panel's badge.
 */
export function EmptyDataState({
  title = "No live data",
  message = FEED_NOT_CONFIGURED,
  hint,
  badgeLabel,
  className,
}: EmptyDataStateProps) {
  return (
    <div
      className={cn(
        "flex h-full min-h-[120px] flex-col items-center justify-center gap-2 px-4 py-8 text-center",
        className,
      )}
    >
      <DatabaseZap className="h-5 w-5 text-muted-foreground/60" aria-hidden />
      <p className="text-xs font-medium text-foreground/90">{title}</p>
      <p className="max-w-xs text-[11px] text-muted-foreground">{message}</p>
      {hint ? (
        <p className="max-w-xs text-[10.5px] italic text-muted-foreground/80">{hint}</p>
      ) : null}
      {badgeLabel ? <DataSourceBadge kind={badgeLabel} /> : null}
    </div>
  );
}
