/**
 * Per-symbol IRESS(PROD)-vs-Yahoo validation policy (pure, client-safe).
 *
 * Deciding "IRESS is accurate & at least as good as Yahoo for symbol X" needs
 * more than one tick: divergence is symmetric and a single sample can agree by
 * luck. A symbol becomes AUTO-`validated` only after IRESS has covered it and
 * stayed within the fact-check tolerance for a STABLE STREAK of samples. Actual
 * cutover is still gated on a separate MANUAL `approved` flag (human in the
 * loop) — this module only computes the auto verdict + the display bucket.
 */

export type ValidationSeverity = "ok" | "watch" | "breach" | "no-data";

export interface ValidationRow {
  symbol: string;
  last_iress_cents: number | null;
  last_yahoo_cents: number | null;
  last_divergence_pct: number | null;
  last_severity: ValidationSeverity | null;
  samples_total: number;
  samples_ok: number;
  consecutive_ok: number;
  max_consecutive_ok: number;
  covered: boolean;
  validated: boolean;
  validated_at: string | null;
  approved: boolean;
  approved_by: string | null;
  approved_at: string | null;
  first_seen: string;
  last_checked: string;
  updated_at: string;
}

/**
 * How many consecutive in-tolerance samples before a symbol auto-validates.
 * With a ~30-min cron over market hours that's a few sessions of stability.
 * Override with IRESS_VALIDATION_MIN_STREAK; default 12.
 */
export function validationMinStreak(): number {
  const n = Number(process.env.IRESS_VALIDATION_MIN_STREAK);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 12;
}

/**
 * The AUTO verdict for a symbol given its (already-updated) counters. A symbol
 * is validated when IRESS currently covers it, the last comparison was within
 * tolerance, and it has held an in-tolerance streak at/above the threshold.
 * This is necessary-but-not-sufficient for cutover — `approved` is the gate.
 */
export function isAutoValidated(row: {
  covered: boolean;
  last_severity: ValidationSeverity | null;
  consecutive_ok: number;
}): boolean {
  return row.covered && row.last_severity === "ok" && row.consecutive_ok >= validationMinStreak();
}

/** UI bucket for a symbol's readiness. */
export function validationBucket(row: Pick<ValidationRow, "covered" | "validated" | "approved" | "last_severity">):
  | "approved"
  | "validated"
  | "watch"
  | "breach"
  | "no-data" {
  if (!row.covered) return "no-data";
  if (row.approved) return "approved";
  if (row.validated) return "validated";
  if (row.last_severity === "breach") return "breach";
  return "watch";
}
