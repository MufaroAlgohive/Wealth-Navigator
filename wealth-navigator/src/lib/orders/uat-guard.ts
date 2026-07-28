/**
 * UAT orders must NEVER reach the broker (LONGMARK / IRESS). UAT is self-fill
 * only — the desk fills it in the OEM via POST /api/admin/orderbook/fills, the
 * same "fill from us" model the CRM has always used. No UAT order ever calls
 * OrderCreate3.
 *
 * This is the single predicate every broker-dispatch path checks, so the
 * guarantee lives in code — not in the temporary Send-to-Market lock, and not
 * in env config that could be flipped. A UAT order is one whose source is
 * UAT_ADHOC_ORDER, or one explicitly tagged payload.uat_test === true.
 */
export function isUatBrokerBlocked(row: {
  source?: string | null;
  payload?: Record<string, unknown> | null;
}): boolean {
  if (String(row.source ?? "").toUpperCase() === "UAT_ADHOC_ORDER") return true;
  const payload = row.payload ?? {};
  return payload?.uat_test === true;
}

export const UAT_BROKER_BLOCKED_MESSAGE =
  "UAT orders never go to the broker. They self-fill in the OEM (Fill (UAT) → /api/admin/orderbook/fills) — nothing on the UAT lane can reach LONGMARK.";
