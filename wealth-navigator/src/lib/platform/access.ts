/**
 * Per-user access policy for restricted EXTERNAL accounts.
 *
 * Some external collaborators (e.g. IRESS staff working the integration) have
 * app access but must NOT see Mint's business data (strategies, factsheets,
 * client/investor books, return insights, client-view studio). The nav hides
 * these items for them AND middleware blocks the routes, so a restricted user
 * can neither see nor open them (a hidden link alone would not stop a direct URL).
 *
 * Stopgap until the RBAC `page_access` phase lands (see platform-nav.tsx). To
 * restrict another external account, add its lowercased email below.
 */

/** Lowercased emails restricted from the sensitive business surfaces. */
export const RESTRICTED_EXTERNAL_EMAILS: ReadonlySet<string> = new Set([
  "andre.pietersen@iress.com", // IRESS: integration access only, no business data
]);

/** Route prefixes / nav hrefs considered sensitive business data. */
export const SENSITIVE_PATHS: readonly string[] = [
  "/strategies", // Strategies
  "/admin/factsheets", // Factsheets
  "/admin/dashboard", // Return Insights
  "/admin/clients", // Clients
  "/admin/investors", // Investors
  "/admin/studio", // Client View Studio
];

export function isRestrictedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return RESTRICTED_EXTERNAL_EMAILS.has(email.trim().toLowerCase());
}

/** True when `pathname` is, or is nested under, a sensitive route. */
export function isSensitivePath(pathname: string): boolean {
  return SENSITIVE_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** True when a restricted user must NOT see or open this href/path. */
export function isBlockedForEmail(email: string | null | undefined, pathOrHref: string): boolean {
  return isRestrictedEmail(email) && isSensitivePath(pathOrHref);
}
