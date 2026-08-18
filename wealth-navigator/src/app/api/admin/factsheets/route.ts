import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { buildCanonicalYtdSeries } from "@/lib/returns/canonical-index";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import { strategyCashAssetFromCanonicalReturns } from "@/lib/strategy-cash-asset";
import { loadRetailLiveScope } from "@/lib/aum/retail-live-scope";

/**
 * Factsheets (read-only). Gallery + single-strategy detail over strategies_c,
 * strategy_returns_effective_c, securities_c, client_strategy_returns_effective_latest_c
 * (RETAIL). Performance is read only from the effective canonical return
 * chain; raw basket-value moves are never interpreted as returns.
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
  "5d_pct": number | null;
  "1m_pct": number | null;
  mtd_pct: number | null;
  "6m_pct": number | null;
  "1y_pct": number | null;
  basket_value: number | null;
  complete_value_cents: number | null;
  continuity_cash_cents: number | null;
  securities_value_cents: number | null;
  source_kind: string | null;
}

type CertifiedOverlay = Partial<
  Pick<ReturnRow, "ytd_pct" | "all_pct" | "1d_pct" | "5d_pct" | "1m_pct" | "mtd_pct" | "6m_pct" | "basket_value" | "complete_value_cents" | "continuity_cash_cents" | "securities_value_cents" | "source_kind">
>;

/**
 * CERTIFIED canonical ledger overlay, matched by (strategy_id, as_of_date).
 * strategy_returns_effective_c is the pre-certification "guarded" chain —
 * confirmed live (see file header) to disagree with the certified figure,
 * sometimes by an opposite sign. Same "certified wins" rule as
 * /api/strategies, /api/admin/dashboard and MINT's /api/returns/approved.
 */
async function loadCertifiedOverlay(
  db: NonNullable<ReturnType<typeof createRetailServiceRoleClient>>,
  strategyIds: string[],
): Promise<Map<string, CertifiedOverlay>> {
  const map = new Map<string, CertifiedOverlay>();
  if (!strategyIds.length) return map;
  const { data } = await db
    .from("strategy_canonical_daily_ledger_c")
    .select("strategy_id,as_of_date,period_metrics,complete_value_cents,continuity_cash_cents,securities_value_cents")
    .eq("certification_status", "CERTIFIED")
    .in("strategy_id", strategyIds);
  for (const r of (data ?? []) as Array<{
    strategy_id: string;
    as_of_date: string;
    period_metrics: Record<string, { return_pct?: number | null }> | null;
    complete_value_cents: number | null;
    continuity_cash_cents: number | null;
    securities_value_cents: number | null;
  }>) {
    const metrics = r.period_metrics ?? {};
    const pick = (key: string) => {
      const v = metrics[key]?.return_pct;
      return v != null && Number.isFinite(Number(v)) ? Number(v) : undefined;
    };
    map.set(`${r.strategy_id}|${r.as_of_date}`, {
      ytd_pct: pick("YTD"),
      // "SI" (since-inception) is the certified ledger's equivalent of the
      // legacy schema's all_pct. buildCanonicalPeriodSeries (canonical-index.ts)
      // uses all_pct to build the 3M/6M/1Y/ALL chart ranges -- YTD alone was
      // fixed by ytd_pct above, but every OTHER range was still silently
      // reading the stale guarded chain until this field was added.
      all_pct: pick("SI"),
      "1d_pct": pick("1D"),
      "5d_pct": pick("1W"),
      "1m_pct": pick("1M"),
      mtd_pct: pick("MTD"),
      "6m_pct": pick("6M"),
      basket_value: r.complete_value_cents ?? undefined,
      complete_value_cents: r.complete_value_cents ?? undefined,
      continuity_cash_cents: r.continuity_cash_cents ?? undefined,
      securities_value_cents: r.securities_value_cents ?? undefined,
      source_kind: "CERTIFIED_CANONICAL_LEDGER",
    });
  }
  return map;
}

/**
 * Merges certified rows into the guarded series AND drops any guarded-only
 * date for a strategy that has certified coverage at all. Only overlaying
 * matching dates (the previous behaviour) left every date the certifier
 * hadn't reached yet on the guarded chain right next to certified dates on
 * the same line — two different calculation methodologies stitched together,
 * which is exactly what produced the spiky/jagged chart shape reported live
 * (MINT's own /api/returns/approved.js already avoids this the same way: a
 * certified strategy's guarded-only dates are dropped, not shown). Any
 * certified date missing from the guarded fetch (certifier ahead of the
 * publisher) is appended too, so a healthy certified point is never hidden.
 */
function applyCertifiedOverlay(
  rows: ReturnRow[],
  overlay: Map<string, CertifiedOverlay>,
  order: "asc" | "desc" = "asc",
): ReturnRow[] {
  if (!overlay.size) return rows;
  const certifiedStrategyIds = new Set<string>();
  const certifiedDates = new Set<string>();
  for (const key of overlay.keys()) {
    const sep = key.indexOf("|");
    certifiedStrategyIds.add(key.slice(0, sep));
    certifiedDates.add(key);
  }
  const merged = rows
    .filter((r) => !certifiedStrategyIds.has(r.strategy_id) || certifiedDates.has(`${r.strategy_id}|${r.as_of_date}`))
    .map((r) => {
      const cert = overlay.get(`${r.strategy_id}|${r.as_of_date}`);
      if (!cert) return r;
      const out: ReturnRow = { ...r };
      for (const [key, value] of Object.entries(cert)) {
        if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value;
      }
      certifiedDates.delete(`${r.strategy_id}|${r.as_of_date}`);
      return out;
    });
  for (const key of certifiedDates) {
    const sep = key.indexOf("|");
    const strategy_id = key.slice(0, sep);
    const as_of_date = key.slice(sep + 1);
    const cert = overlay.get(key)!;
    merged.push({
      strategy_id,
      as_of_date,
      ytd_pct: cert.ytd_pct ?? null,
      all_pct: cert.all_pct ?? null,
      "1d_pct": cert["1d_pct"] ?? null,
      "5d_pct": cert["5d_pct"] ?? null,
      "1m_pct": cert["1m_pct"] ?? null,
      mtd_pct: cert.mtd_pct ?? null,
      "6m_pct": cert["6m_pct"] ?? null,
      "1y_pct": null,
      basket_value: cert.basket_value ?? null,
      complete_value_cents: cert.complete_value_cents ?? null,
      continuity_cash_cents: cert.continuity_cash_cents ?? null,
      securities_value_cents: cert.securities_value_cents ?? null,
      source_kind: cert.source_kind ?? "CERTIFIED_CANONICAL_LEDGER",
    });
  }
  const dir = order === "asc" ? 1 : -1;
  return merged.sort((a, b) => (a.as_of_date < b.as_of_date ? -dir : a.as_of_date > b.as_of_date ? dir : 0));
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
  const liveScope = await loadRetailLiveScope(db);

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
        .select("id, symbol, name, logo_url, last_price, change_percent")
        .in("symbol", [...symbols]);
      const securityIds = (data ?? []).map((row) => row.id).filter(Boolean);
      const { data: intraday } = securityIds.length
        ? await db!
            .from("stock_intraday_c")
            .select('security_id,current_price,"1d_pct",timestamp')
            .in("security_id", securityIds)
            .order("timestamp", { ascending: false })
            .limit(5000)
        : { data: [] };
      const latestIntraday = new Map<string, Record<string, unknown>>();
      for (const row of (intraday ?? []) as Array<Record<string, unknown>>) {
        const securityId = String(row.security_id || "");
        if (securityId && !latestIntraday.has(securityId)) latestIntraday.set(securityId, row);
      }
      for (const sec of data ?? []) {
        const live = latestIntraday.get(String(sec.id));
        const priceCents =
          live?.current_price != null ? Number(live.current_price) : Number(sec.last_price || 0);
        out[sec.symbol as string] = {
          symbol: sec.symbol,
          name: sec.name,
          logo_url: sec.logo_url,
          price_rands: priceCents > 0 ? priceCents / 100 : null,
          day_pct:
            live?.["1d_pct"] != null
              ? Number(live["1d_pct"])
              : sec.change_percent == null
                ? null
                : Number(sec.change_percent),
          price_as_of: live?.timestamp ?? null,
          price_source: live ? "stock_intraday_c" : "securities_c",
        };
      }
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
    if (!strategy || liveScope.excludedStrategyIds.has(id)) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
    const { data: recentReturns } = await db
      .from("strategy_returns_effective_c")
      .select(
        'strategy_id,as_of_date,ytd_pct,all_pct,"1d_pct","5d_pct","1m_pct",mtd_pct,"6m_pct","1y_pct",basket_value,complete_value_cents,continuity_cash_cents,securities_value_cents,source_kind',
      )
      .eq("strategy_id", id)
      // Keep the newest rows when a long-lived strategy exceeds the page size,
      // then restore ascending order for charts. Ascending + limit returned the
      // oldest 800 rows and made MyGrowthFund stop at 10 Jul instead of 30 Jul.
      .order("as_of_date", { ascending: false })
      .limit(800);
    const certifiedOverlay = await loadCertifiedOverlay(db, [id]);
    const returns = applyCertifiedOverlay([...(recentReturns ?? [])].reverse() as ReturnRow[], certifiedOverlay, "asc");
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
    const cashAsset = strategyCashAssetFromCanonicalReturns(returns as ReturnRow[]);
    return NextResponse.json({
      ok: true,
      strategy,
      returns,
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
    const rows = (strategies ?? []).filter((strategy) => !liveScope.excludedStrategyIds.has(String(strategy.id)));

    // Recent returns series grouped by strategy (newest-first fetch → ascending series).
    const { data: ret } = await db
      .from("strategy_returns_effective_c")
      .select(
        'strategy_id,as_of_date,ytd_pct,all_pct,"1d_pct","5d_pct","1m_pct",mtd_pct,"6m_pct","1y_pct",basket_value,complete_value_cents,continuity_cash_cents,securities_value_cents,source_kind',
      )
      .order("as_of_date", { ascending: false })
      .limit(4000);
    const certifiedOverlay = await loadCertifiedOverlay(db, rows.map((s) => String(s.id)));
    const overlaidRet = applyCertifiedOverlay((ret ?? []) as ReturnRow[], certifiedOverlay, "desc");
    const groupedReturns: Record<string, ReturnRow[]> = {};
    for (const r of overlaidRet) {
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
      if (!c.user_id || testIds.has(c.user_id) || liveScope.excludedStrategyIds.has(c.strategy_id)) continue;
      investors[c.strategy_id] = (investors[c.strategy_id] || 0) + 1;
    }

    const securities = await securitiesFor(rows);
    return NextResponse.json({ ok: true, strategies: rows, returns, securities, investors });
  }

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}
