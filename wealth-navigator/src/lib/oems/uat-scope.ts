/**
 * Single source of truth for "is this deployment on the UAT lane?".
 *
 * The OEMS has no environment column on its order tables; UAT vs LIVE is decided
 * by env flags that were, historically, read inconsistently in a dozen places.
 * This centralises the rule so the release lane, the dispatch lane, and the
 * confirmation lane all agree.
 *
 * Rule:
 *  - `IRESS_UAT_MODE=1` (or `true`) explicitly forces UAT lane.
 *  - If `IRESS_BASE_URL` is set and points at the CT/UAT host, UAT lane.
 *  - Anything else is production.
 *
 * Production-only deployment: leave `IRESS_UAT_MODE` unset and `IRESS_BASE_URL`
 * unset (or pointing at `webservices.iress.co.za`); this returns false.
 */
/**
 * Is `IRESS_UAT_MODE` switched on?
 *
 * Accepts `1` / `true` / `TRUE` / ` True ` — the SAME grammar as the Railway
 * worker's `parseBool`, which is the authority because the worker's own 403 tells
 * the operator to "set IRESS_UAT_MODE=1".
 *
 * WHY THIS EXISTS. Six Vercel routes previously tested
 * `process.env.IRESS_UAT_MODE === "true"` while the worker (and `isUatEnv` two
 * lines below, in this very file) accepted `"1"` as well. Set `IRESS_UAT_MODE=1`
 * on both platforms — exactly what the worker's error message instructs — and the
 * worker enables UAT while every Vercel route silently drops into audit-only
 * mode. Orders then look accepted in the UI and never reach a market, with no
 * error anywhere. Read the flag through this helper, never inline.
 */
export function uatModeEnabled(): boolean {
  return ["1", "true"].includes((process.env.IRESS_UAT_MODE ?? "").trim().toLowerCase());
}

export function isUatEnv(): boolean {
  const baseUrl = (process.env.IRESS_BASE_URL ?? "").trim();
  if (uatModeEnabled()) return true;
  // No IRESS_BASE_URL set → trust the canonical production default in
  // `lib/iress/index.ts` (which now defaults to `webservices.iress.co.za/v4`).
  if (!baseUrl) return false;
  // Explicit CT host override.
  return /webservices-ct\.iress\.co\.za/i.test(baseUrl);
}
