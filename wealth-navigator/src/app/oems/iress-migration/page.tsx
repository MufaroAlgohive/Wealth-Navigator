import { IressMigrationClient } from "./iress-migration-client";

export const dynamic = "force-dynamic";

/**
 * /oems/iress-migration : the Yahoo -> IRESS(PROD) cutover console.
 *
 * Shows the per-symbol accuracy scoreboard (iress_price_validation_c) built by
 * the backend validation cron, and lets the desk APPROVE a symbol for cutover
 * once it has proven accurate. Approving only flips a symbol once the backend
 * has auto-validated it; nothing overwrites Yahoo without that. Auth is enforced
 * by the OEMS middleware + BFF.
 */
export default function Page() {
  return <IressMigrationClient />;
}
