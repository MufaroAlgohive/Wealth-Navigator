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
 * Port of the CRM's returns publisher, which currently runs from
 * MyMintAdmin's `/api/orderbook/cron-daily`. Exactly one of the two may be
 * scheduled: both writing the same (strategy, as_of_date) row disagree on
 * `composition_effective_from` and manufacture spurious boundary bridges.
 * Turn the CRM's off before setting RETURNS_PUBLISH_APPLY=1 here.
 *
 * Writes only when RETURNS_PUBLISH_APPLY === "1" (or `?apply=1` from an admin
 * session), so it can be deployed and observed read-only first. `?asOf=` runs
 * it for a specific date.
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
  // An admin can force a real run to verify the cutover; the cron itself only
  // writes once the environment explicitly opts in.
  const apply =
    process.env.RETURNS_PUBLISH_APPLY === "1" || (viaAdmin && url.searchParams.get("apply") === "1");

  const result = await publishEodReturns({ asOfDate, apply });
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
