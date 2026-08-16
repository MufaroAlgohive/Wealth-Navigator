import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
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

export async function GET() {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  let db;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: true, holdings: [], strategies: [], stratHist: [], profiles: [], secMeta: [], secLive: [], txns: [], familyMembers: [], residuals: [], closedHoldings: [], notice: "RETAIL database not configured." });
  }

  // Active BUY holdings (cost basis source).
  const { data: holdingsRaw } = await db
    .from("stock_holdings_c")
    .select("user_id, family_member_id, security_id, strategy_id, quantity, avg_fill, Expected_fill, market_value, created_at, transaction_id")
    .eq("is_active", true)
    .eq("trade_side", "BUY");
  let holdings = holdingsRaw ?? [];

  // Exclude test accounts — dual classifier: profiles.is_test OR
  // wallets.status='test' (some test accounts are flagged only on the wallet).
  try {
    const [{ data: testRows }, { data: testWallets }] = await Promise.all([
      db.from("profiles").select("id").eq("is_test", true),
      db.from("wallets").select("user_id").eq("status", "test"),
    ]);
    const testIds = new Set([
      ...(testRows ?? []).map((r) => r.id),
      ...(testWallets ?? []).map((w) => w.user_id).filter(Boolean),
    ]);
    if (testIds.size) holdings = holdings.filter((h) => !testIds.has(h.user_id));
  } catch {
    /* is_test absent */
  }

  const userIds = [...new Set(holdings.map((h) => h.user_id).filter(Boolean))];
  const secIds = [...new Set(holdings.map((h) => h.security_id).filter(Boolean))];
  const famIds = [...new Set(holdings.map((h) => h.family_member_id).filter(Boolean))];

  const inList = (ids: string[]) => `(${ids.join(",")})`;

  const [strategies, profiles, secMeta, secReturns, secIntraday, txns, familyMembers, residuals, closedHoldings, stratHist] = await Promise.all([
    db.from("strategies_c").select("id, name, short_name, description, risk_level, sector").then((r) => r.data ?? []),
    userIds.length ? db.from("profiles").select("id, first_name, last_name, email, mint_number, computershare_number").in("id", [...new Set([...userIds, ...famIds.length ? (await db.from("family_members").select("primary_user_id, parent_id").in("id", famIds)).data?.flatMap(f => [f.primary_user_id, f.parent_id]).filter(Boolean) as string[] : []])]).then((r) => r.data ?? []) : [],
    secIds.length ? db.from("securities_c").select("id, symbol, name, sector, logo_url").in("id", secIds).then((r) => r.data ?? []) : [],
    secIds.length ? db.from("stock_returns_c").select("security_id, symbol, current_price, ytd_pct, as_of_date").in("security_id", secIds).order("as_of_date", { ascending: false }).then((r) => r.data ?? []) : [],
    secIds.length ? db.from("stock_intraday_c").select("security_id, current_price, timestamp").in("security_id", secIds).order("timestamp", { ascending: false }).then((r) => r.data ?? []) : [],
    userIds.length ? db.from("transactions").select("id, user_id, family_member_id, amount, direction, name, description, status, transaction_date, broker_fee_cents, isin_fee_cents, transaction_fee_cents, base_amount_cents, buffer_cents, buffer_consumed_cents").in("user_id", userIds).order("transaction_date", { ascending: false }).then((r) => r.data ?? []) : [],
    famIds.length ? db.from("family_members").select("id, first_name, last_name, computershare_number, primary_user_id, parent_id").in("id", famIds).then((r) => r.data ?? []) : [],
    userIds.length ? db.from("strategy_rebalance_residuals").select("user_id, strategy_id, family_member_id, balance_cents").in("user_id", userIds).then((r) => r.data ?? []) : [],
    userIds.length ? db.from("stock_holdings_c").select("user_id, family_member_id, strategy_id, quantity, avg_fill, avg_exit").eq("is_active", false).in("user_id", userIds).then((r) => r.data ?? []) : [],
    userIds.length
      ? db
          .from("client_strategy_returns_effective_c")
          .select(
            'user_id, family_member_id, strategy_id, as_of_date, basket_value_cents, ytd_pct, inception_pct, inception_pnl_cents, "1d_pct"',
          )
          .in("user_id", userIds)
          .order("as_of_date", { ascending: true })
          .then((r) =>
            (r.data ?? []).map((row) => ({
              ...row,
              basket_value: row.basket_value_cents,
              inception_pnl: row.inception_pnl_cents,
            })),
          )
      : [],
  ]);

  // Merge intraday (cents) over stock_returns_c current_price.
  const intraById: Record<string, number> = {};
  for (const row of secIntraday as Array<{ security_id?: string; current_price?: number }>) {
    if (!row?.security_id || intraById[row.security_id] != null) continue;
    if (row.current_price != null) intraById[row.security_id] = Number(row.current_price);
  }
  const returnsIds = new Set((secReturns as Array<{ security_id: string }>).map((r) => r.security_id));
  const secLive: Array<Record<string, unknown>> = (secReturns as Array<Record<string, unknown>>).map((r) => {
    const c = intraById[r.security_id as string];
    return c != null && c > 0 ? { ...r, current_price: c } : r;
  });
  for (const [sid, cents] of Object.entries(intraById)) if (!returnsIds.has(sid)) secLive.push({ security_id: sid, current_price: cents });

  void inList;
  return NextResponse.json({ ok: true, holdings, strategies, stratHist, profiles, secMeta, secLive, txns, familyMembers, residuals, closedHoldings });
}
