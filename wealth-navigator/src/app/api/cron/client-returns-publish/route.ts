import { NextResponse } from "next/server";

import { getAdminContext, isAdminRole } from "@/lib/admin/rbac";
import { publishClientEodReturns } from "@/lib/returns/publish-client-eod-returns";

/**
 * GET /api/cron/client-returns-publish
 *
 * Publishes one guarded EOD return row per (client, family member, strategy)
 * owner, chaining each owner's own cash-neutral return and carrying the chain
 * across settled rebalance boundaries — see
 * src/lib/returns/publish-client-eod-returns.ts.
 *
 * Port of the CRM's client publisher, which runs from MyMintAdmin's
 * `/api/orderbook/cron-daily`. Unlike the strategy publisher, the CRM's is
 * still live at the time of writing, so this one stays OPT-IN
 * (CLIENT_RETURNS_PUBLISH_APPLY=1) rather than defaulting to write: two
 * publishers on the same (owner, as_of_date) row would race, and the losing
 * one's chain would fork. Turn the CRM's off in the same change that sets
 * this flag.
 *
 * Runs after the strategy publisher so an owner's boundary batch is already
 * settled when their composition change is evaluated.
 *
 * Query flags mirror the CRM's env switches, for an admin verifying a run:
 *   ?apply=1        force a real write (admin session only)
 *   ?includeUat=1   include UAT strategies (default: LIVE only)
 *   ?includeTest=1  include test accounts (default: excluded)
 *   ?asOf=          run for a specific date
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
  const apply =
    process.env.CLIENT_RETURNS_PUBLISH_APPLY === "1" || (viaAdmin && url.searchParams.get("apply") === "1");
  const includeUat =
    process.env.CLIENT_RETURNS_INCLUDE_UAT === "1" || url.searchParams.get("includeUat") === "1";
  const includeTestUsers =
    process.env.CLIENT_RETURNS_INCLUDE_TEST === "1" || url.searchParams.get("includeTest") === "1";

  const result = await publishClientEodReturns({ asOfDate, apply, includeUat, includeTestUsers });
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
