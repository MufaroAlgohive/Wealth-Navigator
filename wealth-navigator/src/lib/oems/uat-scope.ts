/**
 * Single source of truth for "is this deployment on the UAT lane?".
 *
 * The OEMS has no environment column on its order tables; UAT vs LIVE is decided
 * by env flags that were, historically, read inconsistently in a dozen places.
 * This centralises the rule so the release lane, the dispatch lane, and the
 * confirmation lane all agree.
 *
 * Default is UAT-safe: a deployment is only treated as LIVE when we are
 * confidently on the IRESS production endpoint AND not in UAT mode. During the
 * whole UAT phase (the CT sandbox endpoint, `webservices-ct`) this returns true,
 * so nothing can be mistaken for a live order and no real client can be touched.
 */
export function isUatEnv(): boolean {
  // Mirror the session's own default: an UNSET IRESS_BASE_URL resolves to the CT
  // (UAT) endpoint, so treat unset as UAT — never as prod. Only a positively
  // matched prod host counts as prod.
  const baseUrl = (process.env.IRESS_BASE_URL ?? "").trim();
  // Prod endpoint is `webservices.iress.co.za`; UAT is `webservices-ct.iress…`.
  // The literal-dot after `webservices` matches prod only (the `-ct` breaks it).
  const onProdEndpoint = /webservices\.iress\.co\.za/i.test(baseUrl);
  const uatMode = ["1", "true"].includes((process.env.IRESS_UAT_MODE ?? "").trim().toLowerCase());
  return uatMode || !onProdEndpoint;
}
