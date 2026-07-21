import { Badge } from "@/components/ui/badge";
import { R } from "./format";

/**
 * Reuses the exact 11-state IRESS Hermes lifecycle + Badge-variant mapping
 * already proven in execution-view.tsx's STATE_VARIANT (2026-07-14 desk
 * walkthrough) so the vocabulary is identical whether you're looking at the
 * UAT execution view or this basket drill-down. Two extra pseudo-states are
 * added here, both client-side only (never come from the audit table):
 *   NOT_SENT — no oems_order_audit row exists yet for this holding/security
 *              (the common case — most baskets have never been dispatched).
 *   MIXED    — an aggregate (no investor selected) row where the holdings
 *              under one security have different execution states.
 */
const STATE_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "success" | "warning" | "outline"
> = {
  NOT_SENT: "outline",
  MIXED: "outline",
  PENDING_ACK: "outline",
  ACKNOWLEDGED: "outline",
  CANCEL_PENDING: "outline",
  AMEND_PENDING: "outline",
  WORKING: "warning",
  PARTIAL: "warning",
  FILLED: "success",
  CANCELLED: "secondary",
  EXPIRED: "secondary",
  REJECTED: "destructive",
  FAILED: "destructive",
};

const STATE_LABEL: Record<string, string> = {
  NOT_SENT: "Not sent",
  MIXED: "Mixed",
  PENDING_ACK: "Pending ack",
  ACKNOWLEDGED: "Acknowledged",
  CANCEL_PENDING: "Cancel pending",
  AMEND_PENDING: "Amend pending",
  WORKING: "Working",
  PARTIAL: "Partial",
  FILLED: "Filled",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  REJECTED: "Rejected",
  FAILED: "Failed",
};

export function IressStatusPill({
  state,
  filledPct,
  avgFillPrice,
}: {
  state: string;
  filledPct?: number | null;
  avgFillPrice?: number | null;
}) {
  const label =
    state === "PARTIAL" && filledPct != null
      ? `Partial ${filledPct.toFixed(0)}%`
      : (STATE_LABEL[state] ?? state);
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant={STATE_VARIANT[state] ?? "outline"}>{label}</Badge>
      {(state === "PARTIAL" || state === "FILLED") && avgFillPrice != null && (
        <span className="text-[10px] text-muted-foreground">{R(avgFillPrice)}</span>
      )}
    </span>
  );
}
