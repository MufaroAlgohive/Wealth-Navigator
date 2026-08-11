import { NextResponse } from "next/server";

import { getAdminContext, isAdminRole } from "@/lib/admin/rbac";
import { publishEodReturns } from "@/lib/returns/publish-eod-returns";

/**
 * GET /api/cron/returns-publish
 *
 * Publishes one EOD return row per active strategy through the guarded RPC,
 * chaining YTD from each strategy's own prior publication and treating
 * rebalances as composition events rather than performance (see
 * src/lib/returns/publish-eod-returns.ts).
 *
 * NOT the sole strategy publisher — correction from an earlier version of
 * this comment. The CRM's copy (MyMintAdmin `/api/orderbook/cron-daily`) was
 * correctly retired: this port replaced it, byte-identical, and two
 * publishers on the same (strategy, as_of_date) row do genuinely fight — see
 * the 5-7 Aug 2026 rows for what that looks like.
 *
 * But there is a THIRD, pre-existing writer this port never accounted for:
 * `computeAndSaveStrategyReturns` in the MINT client app's own server
 * (mintdev/main `server/index.cjs`, tag `mint-server-strategy-returns-v2`),
 * scheduled 07:00 and 15:30 UTC — both before this cron's 17:00. It resolves
 * the composition boundary from `strategy_composition_log_c` (trigger-
 * maintained off `strategies_c.holdings`, so it sees a rebalance the moment
 * it lands, including one raised through this OEM), carries a 15pp cross-day
 * spike guard this port does not have, and computes calendar-year YTD from
 * real Dec-31 anchor prices rather than a chain seeded arbitrarily. It is the
 * more complete implementation, not a duplicate to be silenced.
 *
 * So this stays opt-in (RETURNS_PUBLISH_APPLY=1), the same posture as the
 * client publisher, rather than the publish-by-default this comment used to
 * describe. Left at default-on, the only time this would actually write is
 * when the MINT app's own run was blocked for a strategy — and this port's
 * boundary source (`strategy_valuation_rules_c.effective_from`) is not
 * guaranteed to always agree with the app's (`strategy_composition_log_c`),
 * which is exactly the disagreement that produces a spurious bridge.
 *
 * sealRebalanceBoundary / recordRebalanceSettlement (called from
 * maybeCompleteRebalance) are NOT part of this and stay exactly as they are:
 * they seal immediately at rebalance completion rather than waiting for the
 * app's next scheduled run, and they are the only thing that records the
 * CLIENT-level boundary — the MINT app publishes strategy returns only, never
 * `client_strategy_return_publication_audit_c`.
 *
 * `?asOf=` runs it for a specific date. An admin can force a real write with
 * `?apply=1` for debugging without touching the env var.
 *
 * Auth: Vercel cron `Authorization: Bearer ${CRON_SECRET}`, OR an admin session.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const bearer = req.headers.get("authorization")?.replace("Bearer ", "");
  const viaCron = Boolean(secret) && bearer === secret;

  let viaAdmin = false;
  if (!viaCron) {
    const auth = await getAdminContext();
    viaAdmin = auth.status === "ok" && isAdminRole(auth.ctx);
  }
  if (!viaCron && !viaAdmin) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const asOfDate = url.searchParams.get("asOf") ?? undefined;
  // Opt-in, not default-on — see the doc comment above. The MINT app's own
  // publisher normally gets there first; this only writes when told to.
  const apply =
    process.env.RETURNS_PUBLISH_APPLY === "1" || (viaAdmin && url.searchParams.get("apply") === "1");

  const result = await publishEodReturns({ asOfDate, apply });
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
