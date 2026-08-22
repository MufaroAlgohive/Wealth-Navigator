import { NextResponse } from "next/server";

import { getAdminContext, isAdminRole } from "@/lib/admin/rbac";

/**
 * GET /api/cron/returns-publish — RETIRED, kept as a documented no-op.
 *
 * This used to invoke src/lib/returns/publish-eod-returns.ts, one of (at
 * least) two independent writers of the guarded `strategy_returns_effective_c`
 * chain via `publish_guarded_strategy_return` (the other being the MINT app's
 * own server, `computeAndSaveStrategyReturns` in mintdev/main
 * server/index.cjs, which this repo does not control and does not touch).
 * Two independently-computed writers of the same public read contract were
 * confirmed live to disagree — "Yield Basket" YTD climbing to 17.23% on this
 * guarded chain while the certified canonical ledger oscillated 4-7% over the
 * same window; "MyGrowthFund" carrying guarded rows dated 2023-04-21 for a
 * strategy created 2026-04-19.
 *
 * The fix (see supabase/migrations/20260821000001_mirror_effective_returns_from_canonical_ledger.sql)
 * makes `certify_strategy_canonical_daily_ledger_c` — the sole write point for
 * a CERTIFIED canonical-ledger row — mirror that certified row directly into
 * `strategy_returns_effective_c`, overwriting whatever either guarded-chain
 * writer put there for that (strategy_id, as_of_date). A certified date can
 * therefore never disagree with itself again, which removes the reason this
 * repo's own copy of the guarded publisher needed to exist: any date it could
 * write gets overwritten by the certified mirror as soon as that date is
 * certified anyway, and an uncertified date is better left to the MINT app's
 * writer (which this route was never the primary source for — see the prior
 * version of this file's history for the "opt-in, not default-on" reasoning).
 *
 * publish-eod-returns.ts itself is left in place (not deleted) as it is still
 * directly unit-testable/inspectable evidence of the retired write path and
 * may be useful for a future manual recovery tool — it is simply no longer
 * invoked from anywhere in this repo. `git grep publishEodReturns` should
 * show only its own definition after this change.
 *
 * Auth is still checked and a 200 is still returned (rather than 404/410) so
 * an existing Vercel cron schedule or external caller does not start failing
 * loudly; the response body makes the retirement explicit instead.
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

  return NextResponse.json({
    ok: true,
    retired: true,
    note:
      "publishEodReturns() is retired — strategy_returns_effective_c is now mirrored from " +
      "strategy_canonical_daily_ledger_c at certification time. See " +
      "supabase/migrations/20260821000001_mirror_effective_returns_from_canonical_ledger.sql.",
  });
}
