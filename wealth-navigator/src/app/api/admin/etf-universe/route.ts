/**
 * GET /api/admin/etf-universe
 *
 * Phase C2 — JSE-listed ETF universe seed list.
 *
 * The desk references ETFs by their bare root (`STXNDQ`, `SYG`, etc.);
 * the Yahoo provider maps these to `SYMBOL.JO` automatically. This route
 * exposes the curated universe (see `lib/data/providers/jse-etfs.ts`) so
 * the Cockpit Top Movers + Equities page filters can pre-populate from a
 * known-good list instead of free-text entry.
 *
 * Auth: signed-in admin team member. Read-only — there is no POST/DELETE
 * because the universe lives in code (it is rebuilt on every deploy). A
 * future `watchlist_c` route is the per-user escape hatch (see
 * `/api/admin/watchlist`).
 *
 * Response shape:
 *   {
 *     ok: true,
 *     count: number,
 *     source: "seed-list",
 *     issuers: Array<{ issuer, count, etfs: Array<...> }>,
 *     roots: string[]   // convenience for the equities filter
 *   }
 */
import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { JSE_ETF_UNIVERSE, groupJseEtfsByIssuer } from "@/lib/data/providers/jse-etfs";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  return NextResponse.json({
    ok: true,
    count: JSE_ETF_UNIVERSE.length,
    source: "seed-list",
    issuers: groupJseEtfsByIssuer(),
    roots: JSE_ETF_UNIVERSE.map((e) => e.root).sort(),
    note: "Seed list — the full ingest lands via the IRESS worker's SecuritySearchGet (Phase C worker ingest). Until then, this is the curated universe the provider uses to map bare codes to Yahoo's .JO listings.",
  });
}
