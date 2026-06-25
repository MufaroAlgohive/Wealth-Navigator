"use client";

import { KeyRound } from "lucide-react";
import { Pill } from "@/components/oems/primitives/pill";
import { cn } from "@/lib/cn";

interface EntitlementRequiredProps {
  /** IRESS V4 method name (e.g. "TimeSeriesGet2"). */
  method: string;
  /** IRESS code strings the method would be called on (e.g. "J200", "R2030"). */
  codes?: string[];
  /** Single-line note shown below the title. */
  note?: string;
  className?: string;
}

/**
 * Audit #16 — single shared primitive for the "TimeSeriesGet2
 * entitlement required" message. Three pages (Cockpit, Fixed Income,
 * Curves) used to render the same story in three different tones;
 * this collapses them into one block. The shape mirrors the other
 * "blocked-external" / "unconfigured" empty states but uses a Key
 * icon and an amber tone so it doesn't get confused with a
 * migration / vendor problem.
 *
 * The IRESS V4 method names are intentionally human-readable
 * (`TimeSeriesGet2`, not `T2` / `IX.S.2`) — the operator email
 * to Charles should match the literal method strings in the
 * entitlement list.
 */
export function EntitlementRequired({ method, codes, note, className }: EntitlementRequiredProps) {
  return (
    <div
      className={cn(
        "flex h-full min-h-[120px] flex-col items-center justify-center gap-2 rounded-md border border-warning/40 bg-warning/5 px-4 py-8 text-center",
        className,
      )}
    >
      <KeyRound className="h-5 w-5 text-warning" aria-hidden />
      <p className="text-xs font-medium text-foreground/90">
        <span className="font-mono">{method}</span> entitlement required
      </p>
      {codes && codes.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-1">
          {codes.map((c) => (
            <Pill key={c} tone="warning" size="xs">
              {c}
            </Pill>
          ))}
        </div>
      ) : null}
      <p className="max-w-xs text-[11px] text-muted-foreground">
        {note ?? `This data source is not yet enabled. Contact your administrator.`}
      </p>
    </div>
  );
}
