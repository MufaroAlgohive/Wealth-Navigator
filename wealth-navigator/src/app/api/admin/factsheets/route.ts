import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { buildCanonicalYtdSeries } from "@/lib/returns/canonical-index";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import { strategyCashAssetFromCanonicalReturns } from "@/lib/strategy-cash-asset";

/**
 * Factsheets (read-only). Gallery + single-strategy detail over strategies_c,
 * strategy_returns_effective_c, securities_c, client_strategy_returns_effective_latest_c
 * (RETAIL). Daily returns are derived from the basket_value series (the
 * per-period pct columns are digit-prefixed and awkward in PostgREST).
 *
 * 2026-07-21: was reading the raw legacy strategies_returns_c /
 * client_strategy_returns_c tables directly — pre-repair, pre-guarded-
 * publication data. Confirmed live for Yield Basket: legacy YTD was
 * -12.57% on the same date the canonical effective view (shadow-table
 * repair + guarded daily publisher, same single read contract the CRM and
 * /api/strategies already use) shows +12.55% — opposite sign. Switched to
 * the effective views; also added the dual test-exclusion (profiles.is_test
 * OR wallets.status='test') the investor list never had.
 */

export const dynamic = "force-dynamic";

interface ReturnRow {
  strategy_id: string;
  as_of_date: string;
  ytd_pct: number | null;
  all_pct: number | null;
  "1d_pct": number | null;
  basket_value: number | null;
  continuity_cash_cents: number | null;
  securities_value_cents: number | null;
}

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status === "not-member")
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "list";

  let db;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({
      ok: true,
      strategies: [],
      returns: {},
      securities: {},
      investors: {},
      notice: "RETAIL database not configured.",
    });
  }

  const securitiesFor = async (strategies: Array<{ holdings: unknown }>) => {
    const symbols = new Set<string>();
    for (const s of strategies) {
      const hs = Array.isArray(s.holdings) ? (s.holdings as Array<Record<string, unknown>>) : [];
      for (const h of hs) {
        const sym = (h.ticker || h.symbol) as string | undefined;
        if (sym) symbols.add(String(sym));
      }
    }
    const out: Record<string, unknown> = {};
    if (symbols.size) {
      const { data } = await db!
        .from("securities_c")
        .select("symbol, name, logo_url, last_price, change_percent")
        .in("symbol", [...symbols]);
      for (const sec of data ?? []) out[sec.symbol as string] = sec;
    }
    return out;
  };

  // Dual test-exclusion (profiles.is_test OR wallets.status='test') — a
  // single is_test-only check has previously let internal team test-wallets
  // leak real-looking data into client-facing figures.
  const testUserIds = async (): Promise<Set<string>> => {
    const [{ data: testProfiles }, { data: testWallets }] = await Promise.all([
      db!.from("profiles").select("id").eq("is_test", true),
      db!.from("wallets").select("user_id").eq("status", "test"),
    ]);
    return new Set<string>([
      ...((testProfiles ?? []) as Array<{ id: string }>).map((r) => r.id),
      ...((testWallets ?? []) as Array<{ user_id: string }>).map((r) => r.user_id),
    ]);
  };

  if (action === "detail") {
    const id = url.searchParams.get("id") || "";
    if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
    const { data: strategy } = await db.from("strategies_c").select("*").eq("id", id).maybeSingle();
    if (!strategy) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    const { data: returns } = await db
      .from("strategy_returns_effective_c")
      .select(
        'strategy_id, as_of_date, ytd_pct, all_pct, "1d_pct", basket_value,continuity_cash_cents,securities_value_cents',
      )
      .eq("strategy_id", id)
      .order("as_of_date", { ascending: true })
      .limit(800);
    const securities = await securitiesFor([strategy]);
    const testIds = await testUserIds();
    const { data: clientRows } = await db
      .from("client_strategy_returns_effective_latest_c")
      .select(
        "user_id,family_member_id,basket_value_cents,securities_value_cents,residual_cash_cents,unused_reserve_cents,inception_pct,inception_pnl_cents,ytd_pct,as_of_date",
      )
      .eq("strategy_id", id)
      .limit(2000);
    const realRows = ((clientRows ?? []) as Array<Record<string, unknown>>).filter(
      (row) => row.user_id && !testIds.has(String(row.user_id)),
    );
    const userIds = [...new Set(realRows.map((row) => String(row.user_id)))];
    const famIds = [
      ...new Set(
        realRows.map((row) => (row.family_member_id ? String(row.family_member_id) : "")).filter(Boolean),
      ),
    ];
    const [{ data: profiles }, { data: famRows }] = await Promise.all([
      userIds.length
        ? db.from("profiles").select("id,first_name,last_name,email,computershare_number").in("id", userIds)
        : Promise.resolve({ data: [] }),
      famIds.length
        ? db.from("family_members").select("id,first_name,last_name,computershare_number").in("id", famIds)
        : Promise.resolve({ data: [] }),
    ]);
    const profileMap = new Map((profiles ?? []).map((profile) => [String(profile.id), profile]));
    const famMap = new Map((famRows ?? []).map((member) => [String(member.id), member]));
    const investors = realRows.map((row) => {
      const userId = String(row.user_id);
      const familyMemberId = row.family_member_id ? String(row.family_member_id) : null;
      const profile = profileMap.get(userId);
      const parentName =
        [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") || profile?.email || userId;
      const familyMember = familyMemberId ? famMap.get(familyMemberId) : null;
      const childName = familyMember
        ? [familyMember.first_name, familyMember.last_name].filter(Boolean).join(" ") ||
          familyMemberId!.slice(0, 8)
        : null;
      const value = Number(row.basket_value_cents || 0) / 100;
      const pnl = Number(row.inception_pnl_cents || 0) / 100;
      return {
        userId,
        familyMemberId,
        name: childName ? `${childName} (${parentName})` : parentName,
        email: profile?.email || "",
        computershare: (familyMember?.computershare_number || profile?.computershare_number) ?? null,
        value,
        // Complete-value breakdown, same convention as MyMintAdmin's
        // investors.html card: positions + residual + held reserve.
        holdingsValue: Number(row.securities_value_cents || 0) / 100,
        residual: Number(row.residual_cash_cents || 0) / 100,
        reserve: Number(row.unused_reserve_cents || 0) / 100,
        pnl,
        invested: value - pnl,
        inceptionPct: row.inception_pct == null ? null : Number(row.inception_pct),
        // The view's own chain-preserved YTD — not re-derived from
        // value-minus-pnl (that math broke the moment a rebalance changed
        // the basket's composition mid-period).
        ytd: row.ytd_pct == null ? null : Number(row.ytd_pct),
        asOf: row.as_of_date,
      };
    });
    // CA is a model/strategy asset, not an investor aggregate. Summing client
    // residuals duplicated the same per-strategy CA once per owner (for
    // example R148.47 became R296.94 with two investors).
    const cashAsset = strategyCashAssetFromCanonicalReturns((returns ?? []) as ReturnRow[]);
    return NextResponse.json({
      ok: true,
      strategy,
      returns: returns ?? [],
      securities,
      investors,
      cashAsset,
    });
  }

  if (action === "list") {
    const { data: strategies, error } = await db
      .from("strategies_c")
      .select("*")
      .order("created_at", { ascending: false });
    if (error)
      return NextResponse.json({
        ok: true,
        strategies: [],
        returns: {},
        securities: {},
        investors: {},
        notice: error.message,
      });
    const rows = strategies ?? [];

    // Recent returns series grouped by strategy (newest-first fetch → ascending series).
    const { data: ret } = await db
      .from("strategy_returns_effective_c")
      .select(
        'strategy_id, as_of_date, ytd_pct, all_pct, "1d_pct", basket_value,continuity_cash_cents,securities_value_cents',
      )
      .order("as_of_date", { ascending: false })
      .limit(4000);
    const groupedReturns: Record<string, ReturnRow[]> = {};
    for (const r of (ret ?? []) as ReturnRow[]) {
      const rowsForStrategy = groupedReturns[r.strategy_id] ?? [];
      rowsForStrategy.push(r);
      groupedReturns[r.strategy_id] = rowsForStrategy;
    }
    const returns: Record<string, { latest: ReturnRow | null; series: number[] }> = {};
    for (const [strategyId, strategyRows] of Object.entries(groupedReturns)) {
      returns[strategyId] = {
        latest: strategyRows[0] ?? null,
        series: buildCanonicalYtdSeries([...strategyRows].reverse()).map((point) => point.value),
      };
    }

    // Investor counts (distinct real users per strategy) — the "latest"
    // view is already one row per user per strategy, so no manual dedup
    // needed, only the test-exclusion the raw table never had.
    const testIds = await testUserIds();
    const investors: Record<string, number> = {};
    const { data: csr } = await db
      .from("client_strategy_returns_effective_latest_c")
      .select("strategy_id, user_id")
      .limit(5000);
    for (const c of (csr ?? []) as Array<{ strategy_id: string; user_id: string }>) {
      if (!c.user_id || testIds.has(c.user_id)) continue;
      investors[c.strategy_id] = (investors[c.strategy_id] || 0) + 1;
    }

    const securities = await securitiesFor(rows);
    return NextResponse.json({ ok: true, strategies: rows, returns, securities, investors });
  }

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}
