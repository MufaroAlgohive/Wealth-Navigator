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
 * This is now the ONLY strategy return publisher. It replaced the CRM's
 * (MyMintAdmin `/api/orderbook/cron-daily`), whose call site was removed at
 * cutover: two publishers writing the same (strategy, as_of_date) row
 * disagree on `composition_effective_from` and manufacture spurious boundary
 * bridges — see the 5–7 Aug 2026 rows. Never re-enable the CRM's.
 *
 * Publishes by default. The port was verified byte-identical to the
 * implementation it replaced before cutover — 8/8 active strategies agreeing
 * to the cent on securities, continuity cash and complete value, and to 1e-9
 * on YTD (2026-08-10) — so a blanket opt-in flag would now only risk leaving
 * the chain silently unpublished, which is its own kind of bad data.
 * RETURNS_PUBLISH_APPLY=0 is the kill switch; an admin can force a read-only
 * plan with `?apply=0`. `?asOf=` runs it for a specific date.
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
  // Publishes unless explicitly switched off. An admin can still ask for a
  // read-only plan to inspect the numbers without writing them.
  const killed = process.env.RETURNS_PUBLISH_APPLY === "0";
  const planOnly = viaAdmin && url.searchParams.get("apply") === "0";
  const apply = !killed && !planOnly;

  const result = await publishEodReturns({ asOfDate, apply });
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
