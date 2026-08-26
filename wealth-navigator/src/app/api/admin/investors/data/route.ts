import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { loadCanonicalRetailAum } from "@/lib/aum/canonical-retail-aum";
import { loadRetailLiveScope } from "@/lib/aum/retail-live-scope";
import { applyYahooFallback } from "@/lib/market-prices/fallback";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * Investor analytics data. Ports `/api/investors/data` — a read-only
 * aggregation across holdings / returns / NAV history / transactions / fees /
 * residuals / closed positions (RETAIL/LIVE). Test accounts (profiles.is_test)
 * are excluded. The heavy per-investor maths is done client-side in the page.
 *
 * Digit-prefixed period columns (1d_pct…) are skipped — the page derives daily
 * returns from the basket_value series.
 */

export const dynamic = "force-dynamic";

async function requiredData<T>(
  label: string,
  query: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  if (data == null) throw new Error(`${label}: no data returned`);
  return data;
}

export async function GET() {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  let db;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json(
      { ok: false, error: "RETAIL database not configured; investor values cannot be verified." },
      { status: 503 },
    );
  }

  let canonicalAum;
  let liveScope;
  try {
    [canonicalAum, liveScope] = await Promise.all([loadCanonicalRetailAum(db), loadRetailLiveScope(db)]);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: `Canonical LIVE AUM unavailable: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 503 },
    );
  }

  // Active BUY holdings (cost basis source).
  const holdingsRaw = await requiredData(
    "active holdings",
    db.from("stock_holdings_c")
      .select("user_id, family_member_id, security_id, strategy_id, quantity, avg_fill, Expected_fill, market_value, created_at, Fill_date, transaction_id")
      .eq("is_active", true).eq("trade_side", "BUY"),
  );
  const holdings = (holdingsRaw ?? []).filter(
    (holding) =>
      // A parked order creates a placeholder row before execution. It is not
      // an owned security until settlement stamps a fill date or average fill.
      Boolean(holding.Fill_date || Number(holding.avg_fill) > 0) &&
      !liveScope.excludedUserIds.has(holding.user_id) &&
      (!holding.strategy_id || !liveScope.excludedStrategyIds.has(holding.strategy_id)),
  );

  // Test-account exclusion already happened above via liveScope.excludedUserIds
  // (loadRetailLiveScope dual-classifies on profiles.is_test OR
  // wallets.status='test'). This used to re-run the same two queries and
  // filter again here -- a second, independently-maintained copy of the same
  // check sitting right next to the shared one, exactly the drift risk that
  // makes two implementations quietly disagree later. Removed; holdings is
  // already correctly scoped.

  const userIds = [...new Set(holdings.map((h) => h.user_id).filter(Boolean))];
  const secIds = [...new Set(holdings.map((h) => h.security_id).filter(Boolean))];
  const famIds = [...new Set(holdings.map((h) => h.family_member_id).filter(Boolean))];

  const inList = (ids: string[]) => `(${ids.join(",")})`;

  // Resolving a child's "Managed by <parent>" label needs the parent's profile,
  // so the family rows have to be known BEFORE the profiles query is built.
  // Fetched once here and reused as the `familyMembers` element below: this was
  // previously queried twice against the same table (once inline inside the
  // Promise.all array purely to derive parent ids, once again as its own
  // element). The inline copy also did `.data?.flatMap(...).filter(...)`, and
  // because optional chaining short-circuits the WHOLE trailing chain, any
  // error on that query made the expression `undefined` rather than `[]` --
  // which then hit `...undefined` in the surrounding array literal and threw
  // "undefined is not iterable", collapsing the entire investors payload over a
  // transient failure in one unrelated table.
  const familyRows = famIds.length
    ? await requiredData("family members", db.from("family_members").select("id, first_name, last_name, computershare_number, primary_user_id, parent_id").in("id", famIds))
    : [];
  const parentUserIds = familyRows
    .flatMap((f) => [f.primary_user_id, f.parent_id])
    .filter((id): id is string => Boolean(id));
  const profileIds = [...new Set([...userIds, ...parentUserIds])];
  // The intraday table is append-heavy. Never sort its entire history for an
  // admin page; the canonical AUM reader uses the same bounded window.
  const intradaySince = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  const [
    strategies,
    profiles,
    secMeta,
    secReturns,
    secIntraday,
    txns,
    familyMembers,
    residuals,
    closedHoldings,
    stratHist,
  ] = await Promise.all([
    requiredData("strategies", db.from("strategies_c").select("id, name, short_name, description, risk_level, sector")),
    profileIds.length
      ? requiredData("profiles", db.from("profiles").select("id, first_name, last_name, email, mint_number, computershare_number").in("id", profileIds))
      : [],
    secIds.length
      ? requiredData("security metadata", db.from("securities_c").select("id, symbol, name, sector, logo_url, last_price, change_percent, updated_at").in("id", secIds))
      : [],
    secIds.length
      ? requiredData("stored closes", db.from("stock_returns_c").select("security_id, symbol, current_price, ytd_pct, as_of_date").in("security_id", secIds).order("as_of_date", { ascending: false }).limit(5000))
      : [],
    secIds.length
      ? requiredData("intraday prices", db.from("stock_intraday_c").select("security_id, current_price, timestamp").in("security_id", secIds).gte("timestamp", intradaySince).order("timestamp", { ascending: false }).limit(5000))
      : [],
    userIds.length
      ? requiredData("transactions", db.from("transactions").select("id, user_id, family_member_id, amount, direction, name, description, status, transaction_date, broker_fee_cents, isin_fee_cents, transaction_fee_cents, base_amount_cents, buffer_cents, buffer_consumed_cents").in("user_id", userIds).order("transaction_date", { ascending: false }))
      : [],
    familyRows,
    userIds.length
      ? requiredData("rebalance residuals", db.from("strategy_rebalance_residuals").select("user_id, strategy_id, family_member_id, balance_cents").in("user_id", userIds))
      : [],
    userIds.length
      ? requiredData("closed holdings", db.from("stock_holdings_c").select("user_id, family_member_id, strategy_id, quantity, avg_fill, avg_exit").eq("is_active", false).in("user_id", userIds))
      : [],
    userIds.length
      ? requiredData("effective client returns", db.from("client_strategy_returns_effective_c")
          .select(
            'user_id, family_member_id, strategy_id, as_of_date, basket_value_cents, ytd_pct, inception_pct, inception_pnl_cents, "1d_pct"',
          )
          .in("user_id", userIds)
          .order("as_of_date", { ascending: true }))
      : [],
  ]);

  const mappedStratHist = (stratHist as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    basket_value: row.basket_value_cents,
    inception_pnl: row.inception_pnl_cents,
  }));

  // Keep exactly one price per security. The previous implementation emitted
  // every stored-return row; the client Map then let the OLDEST row win.
  const intraById: Record<string, { price: number; timestamp: string }> = {};
  for (const row of secIntraday as Array<{ security_id?: string; current_price?: number; timestamp?: string }>) {
    if (!row?.security_id || intraById[row.security_id] != null) continue;
    if (row.current_price != null && row.timestamp) intraById[row.security_id] = { price: Number(row.current_price), timestamp: row.timestamp };
  }
  const storedById = new Map<string, Record<string, unknown>>();
  for (const row of secReturns as Array<Record<string, unknown>>) {
    const id = String(row.security_id ?? "");
    if (id && !storedById.has(id)) storedById.set(id, row);
  }
  const now = Date.now();
  const sastParts = new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const part = (type: string) => sastParts.find((item) => item.type === type)?.value ?? "";
  const hour = Number(part("hour"));
  const minute = Number(part("minute"));
  const weekday = part("weekday");
  const duringJseSession = !["Sat", "Sun"].includes(weekday) && hour * 60 + minute >= 9 * 60 && hour * 60 + minute <= 17 * 60;
  const secLiveById = new Map<string, Record<string, unknown>>();
  for (const id of secIds) {
    const intraday = intraById[id];
    const stored = storedById.get(id);
    const intradayAgeSeconds = intraday ? Math.max(0, (now - Date.parse(intraday.timestamp)) / 1000) : null;
    if (intraday && intraday.price > 0) {
      secLiveById.set(id, { security_id: id, current_price: intraday.price, price_source: "stock_intraday_c", price_as_of: intraday.timestamp, stale: duringJseSession && Number(intradayAgeSeconds) > 300, age_seconds: intradayAgeSeconds });
    } else if (Number(stored?.current_price) > 0) {
      secLiveById.set(id, { security_id: id, current_price: Number(stored?.current_price), price_source: "stock_returns_c", price_as_of: stored?.as_of_date, stale: duringJseSession, age_seconds: null });
    }
  }

  // Yahoo fallback for symbols still missing a price after intraday + stock_returns_c.
  // Reads only — never writes back. Cents-safe via yahooPriceToCents. IRESS-back-
  // online re-sync is automatic via isPriceStale on the next call.
  const fallbackIds = secIds.filter((id) => !secLiveById.has(id) || secLiveById.get(id)?.stale === true);
  if (fallbackIds.length > 0) {
    const fallbackRows = fallbackIds.map((id) => {
      const meta = (
        secMeta as Array<{
          id?: string;
          symbol?: string;
          last_price?: number | null;
          change_percent?: number | null;
          updated_at?: string | null;
        }>
      ).find((s) => String(s.id ?? "") === id);
      return {
        symbol: meta?.symbol ?? "",
        last_price: meta?.last_price ?? null,
        change_percent: meta?.change_percent ?? null,
        updated_at: meta?.updated_at ?? null,
      };
    });
    // Keep this page gentle on Yahoo: at most eight lookups, two at a time.
    // Remaining stale DB prices stay visible as explicitly provisional.
    await applyYahooFallback({ rows: fallbackRows, maxYahoo: 8, concurrency: 2 });
    for (const row of fallbackRows as Array<{
      symbol: string;
      last_price: number | null;
      price_source?: string;
    }>) {
      if (row.price_source === "yahoo" && row.last_price != null && row.last_price > 0) {
        const meta = (secMeta as Array<{ id?: string; symbol?: string }>).find(
          (s) => String(s.symbol ?? "") === row.symbol,
        );
        const id = meta?.id ? String(meta.id) : null;
        if (id) secLiveById.set(id, { security_id: id, current_price: row.last_price, price_source: "yahoo", price_as_of: new Date().toISOString(), stale: false, age_seconds: 0 });
      }
    }
  }
  // A single illiquid/unmapped instrument must not hide every other investor.
  // Use the same reference price already included by canonical AUM, but label
  // it stale/provisional. If even that is absent, emit an unavailable row at
  // zero so the UI can disclose the gap instead of crashing or using cost.
  for (const id of secIds) {
    if (Number(secLiveById.get(id)?.current_price) > 0) continue;
    const meta = (secMeta as Array<{ id?: string; last_price?: number | null; updated_at?: string | null }>).find(
      (row) => String(row.id ?? "") === id,
    );
    const referencePrice = Number(meta?.last_price);
    secLiveById.set(id, {
      security_id: id,
      current_price: referencePrice > 0 ? referencePrice : 0,
      price_source: referencePrice > 0 ? "securities_c_reference" : "unavailable",
      price_as_of: meta?.updated_at ?? null,
      stale: true,
      age_seconds: meta?.updated_at ? Math.max(0, (now - Date.parse(meta.updated_at)) / 1000) : null,
      provisional_reason: referencePrice > 0 ? "No recent market price; stale reference used" : "No price evidence available",
    });
  }
  const secLive = [...secLiveById.values()];

  void inList;
  const canonicalPositions = [...canonicalAum.byPosition.values()].map((position) => ({
    key: position.key,
    user_id: position.userId,
    family_member_id: position.familyMemberId,
    strategy_id: position.strategyId,
    aum_cents: position.aumCents,
    securities_cents: position.securitiesCents,
    reserve_cents: position.reserveCents,
    residual_cents: position.residualCents,
    consumed_aum_fee_cents: position.consumedAumFeeCents,
  }));
  return NextResponse.json({
    ok: true,
    holdings,
    strategies: strategies.filter((strategy) => !liveScope.excludedStrategyIds.has(strategy.id)),
    stratHist: mappedStratHist,
    profiles,
    secMeta,
    secLive,
    txns,
    familyMembers,
    residuals,
    closedHoldings,
    canonicalPositions,
    canonicalSummary: {
      total_aum_cents: canonicalAum.totalAumCents,
      investor_count: canonicalAum.investorCount,
      as_of: canonicalAum.asOf,
    },
  });
}
