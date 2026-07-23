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
export function isUatEnv(): boolean {
  const baseUrl = (process.env.IRESS_BASE_URL ?? "").trim();
  const uatMode = ["1", "true"].includes((process.env.IRESS_UAT_MODE ?? "").trim().toLowerCase());
  if (uatMode) return true;
  // No IRESS_BASE_URL set → trust the canonical production default in
  // `lib/iress/index.ts` (which now defaults to `webservices.iress.co.za/v4`).
  if (!baseUrl) return false;
  // Explicit CT host override.
  return /webservices-ct\.iress\.co\.za/i.test(baseUrl);
}
