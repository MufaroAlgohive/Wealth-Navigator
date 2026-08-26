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
 * Port of the CRM's client publisher, which used to run from MyMintAdmin's
 * `/api/orderbook/cron-daily`. That call was removed there on 2026-08-24 (see
 * "Hand client return publication to the OEM") the same way the strategy-level
 * handoff was done on 2026-08-10: no flag left behind, because two publishers
 * on the same (owner, as_of_date) row would race and fork the loser's chain.
 * This route is now the sole live writer of
 * client_strategy_return_publication_audit_c — the scheduled cron below
 * always applies, no env flag required. A plain unauthenticated-admin GET
 * (no ?apply=1) still dry-runs, so browsing this endpoint to sanity-check a
 * date never accidentally writes.
 *
 * Runs after the strategy publisher so an owner's boundary batch is already
 * settled when their composition change is evaluated.
 *
 * Query flags, for an admin verifying/forcing a run (see the "Publish Now"
 * button on /admin/dev-tools):
 *   ?apply=1        force a real write (admin session only; the real cron
 *                    always applies regardless of this flag)
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
  // The scheduled cron is the sole live writer now (CRM handoff complete,
  // 2026-08-24) — it always applies. An admin browsing this route directly
  // still needs an explicit ?apply=1 to write, so a sanity-check GET can
  // never accidentally publish.
  const apply = viaCron || (viaAdmin && url.searchParams.get("apply") === "1");
  const includeUat =
    process.env.CLIENT_RETURNS_INCLUDE_UAT === "1" || url.searchParams.get("includeUat") === "1";
  const includeTestUsers =
    process.env.CLIENT_RETURNS_INCLUDE_TEST === "1" || url.searchParams.get("includeTest") === "1";

  const result = await publishClientEodReturns({ asOfDate, apply, includeUat, includeTestUsers });
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
