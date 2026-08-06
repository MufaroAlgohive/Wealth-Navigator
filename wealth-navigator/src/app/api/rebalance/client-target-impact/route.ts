import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { calculateProceedsBridge } from "@/lib/rebalance/proceeds";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/rebalance/client-target-impact
 *
 * Fee-adjusted impact of bringing ONE client's own holdings to a set of
 * target quantities — the single-client counterpart to /api/rebalance/impact.
 * That route models a shared strategy composition scaled per-investor by a
 * `lots` multiplier; this route has no model-unit concept at all, it's just
 * "this account currently holds X, wants to hold Y" priced with the same
 * fee bridge. No other investor and no strategy composition is touched or
 * even read beyond resolving this one client's holdings.
 *
 * Read-only: performs no writes.
 */

export const dynamic = "force-dynamic";

interface TargetLine {
  symbol: string;
  targetQty?: number | null;
}

/** "MTN.JO" / " mtn " -> "MTN". */
function bare(sym: string): string {
  return String(sym ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (!can(auth.ctx, "rebalance", "raise_rebalance")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const strategyId = typeof body.strategy_id === "string" ? body.strategy_id.trim() : "";
  const strategyName = typeof body.strategy_name === "string" ? body.strategy_name.trim() : "";
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  const targetsRaw = Array.isArray(body.targets) ? (body.targets as TargetLine[]) : [];
  if (!strategyId && !strategyName) {
    return NextResponse.json(
      { ok: false, error: "strategy_id or strategy_name is required" },
      { status: 400 },
    );
  }
  if (!userId) {
    return NextResponse.json({ ok: false, error: "user_id is required" }, { status: 400 });
  }

  const targetQtyBySymbol = new Map<string, number>();
  for (const t of targetsRaw) {
    const sym = bare(t.symbol);
    if (!sym) continue;
    targetQtyBySymbol.set(sym, Math.max(0, Math.round(Number(t.targetQty) || 0)));
  }

  let db;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: false, error: "RETAIL database not configured." });
  }

  // Fee estimates use the exact CRM/App Settings contract — same block as
  // /api/rebalance/impact, must not diverge into a second source of truth.
  const feeRes = await db
    .from("app_settings")
    .select("value,updated_at")
    .eq("key", "fees")
    .limit(1)
    .maybeSingle();
  const feeValue = (feeRes.data?.value ?? null) as Record<string, unknown> | null;
  const brokerageRate = Number(feeValue?.rebBrokerageRate);
  const custodyFeeRands = Number(feeValue?.rebCustodyFee);
  if (
    feeRes.error ||
    !feeValue ||
    !Number.isFinite(brokerageRate) ||
    brokerageRate < 0 ||
    !Number.isFinite(custodyFeeRands) ||
    custodyFeeRands < 0
  ) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Rebalance proceeds preview blocked: rebBrokerageRate and rebCustodyFee must be configured in App Settings.",
      },
      { status: 422 },
    );
  }
  const custodyFeeCents = Math.round(custodyFeeRands * 100);

  const profileRes = await db
    .from("profiles")
    .select("id, first_name, last_name, email, mint_number")
    .eq("id", userId)
    .maybeSingle();
  if (profileRes.error || !profileRes.data) {
    return NextResponse.json(
      { ok: false, error: profileRes.error?.message ?? "Client not found." },
      { status: 404 },
    );
  }
  const profile = profileRes.data;
  const name =
    `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim() || (profile.email as string) || "Client";
  const account = String(profile.mint_number || profile.email || profile.id);

  let holdRes = await db
    .from("stock_holdings_c")
    .select("security_id, quantity, avg_fill, Expected_fill")
    .eq("is_active", true)
    .eq("trade_side", "BUY")
    .eq("user_id", userId)
    .eq("strategy_id", strategyId || "00000000-0000-0000-0000-000000000000");
  if ((!holdRes.data || holdRes.data.length === 0) && strategyName) {
    holdRes = await db
      .from("stock_holdings_c")
      .select("security_id, quantity, avg_fill, Expected_fill")
      .eq("is_active", true)
      .eq("trade_side", "BUY")
      .eq("user_id", userId)
      .eq("strategy_name_snapshot", strategyName);
  }
  if (holdRes.error) {
    return NextResponse.json({ ok: false, error: holdRes.error.message }, { status: 500 });
  }
  const holdings = (holdRes.data ?? []) as Array<{
    security_id: string;
    quantity: number | null;
    avg_fill: number | null;
    Expected_fill: number | null;
  }>;

  const heldSecIds = [...new Set(holdings.map((h) => h.security_id).filter(Boolean))];
  const targetSymbols = [...targetQtyBySymbol.keys()];
  const symbolCandidates = targetSymbols.flatMap((s) => [s, `${s}.JO`]);
  const [secByIdRes, secBySymRes] = await Promise.all([
    heldSecIds.length
      ? db.from("securities_c").select("id, symbol, last_price").in("id", heldSecIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    symbolCandidates.length
      ? db.from("securities_c").select("id, symbol, last_price").in("symbol", symbolCandidates)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
  ]);
  const secRows = [...(secByIdRes.data ?? []), ...(secBySymRes.data ?? [])] as Array<{
    id: string;
    symbol: string;
    last_price: number | null;
  }>;
  const secById = new Map<string, { symbol: string; lastCents: number }>();
  const secBySymbol = new Map<string, { id: string; lastCents: number }>();
  for (const s of secRows) {
    const sym = bare(s.symbol);
    const cents = Number(s.last_price) || 0;
    secById.set(s.id, { symbol: sym, lastCents: cents });
    if (!secBySymbol.has(sym)) secBySymbol.set(sym, { id: s.id, lastCents: cents });
  }

  const allSecIds = [...new Set([...heldSecIds, ...secRows.map((s) => s.id)])];
  const intradayById = new Map<string, number>();
  if (allSecIds.length) {
    const tickRes = await db
      .from("securities_with_latest_quote")
      .select("security_id,latest_intraday_price")
      .in("security_id", allSecIds);
    if (!tickRes.error) {
      for (const t of (tickRes.data ?? []) as Array<{
        security_id: string;
        latest_intraday_price: number | null;
      }>) {
        if (t.latest_intraday_price != null) intradayById.set(t.security_id, Number(t.latest_intraday_price));
      }
    }
  }
  const priceCentsForSymbol = (sym: string): number => {
    const s = secBySymbol.get(sym);
    if (!s) return 0;
    return intradayById.get(s.id) || s.lastCents || 0;
  };

  const positions = new Map<string, { quantity: number; costValueCents: number }>();
  for (const h of holdings) {
    const meta = secById.get(h.security_id);
    if (!meta) continue;
    const quantity = Number(h.quantity) || 0;
    const rawFill = Number(h.Expected_fill) > 0 ? Number(h.Expected_fill) : Number(h.avg_fill) || 0;
    const referencePriceCents = priceCentsForSymbol(meta.symbol) || meta.lastCents;
    const costPriceCents =
      rawFill > 0 && rawFill < referencePriceCents / 5 ? Math.round(rawFill * 100) : Math.round(rawFill);
    const current = positions.get(meta.symbol) ?? { quantity: 0, costValueCents: 0 };
    positions.set(meta.symbol, {
      quantity: current.quantity + quantity,
      costValueCents: current.costValueCents + Math.round(quantity * costPriceCents),
    });
  }

  const names = new Set<string>([...positions.keys(), ...targetQtyBySymbol.keys()]);
  const lines: Array<Record<string, unknown>> = [];
  let grossBuyCents = 0;
  let grossSellCents = 0;
  for (const sym of names) {
    const priceCents = priceCentsForSymbol(sym);
    const position = positions.get(sym) ?? { quantity: 0, costValueCents: 0 };
    const currentQty = position.quantity;
    const targetQty = targetQtyBySymbol.has(sym) ? (targetQtyBySymbol.get(sym) ?? currentQty) : currentQty;
    const deltaQty = targetQty - currentQty;
    const valueCents = Math.abs(deltaQty) * priceCents;
    if (deltaQty > 0) grossBuyCents += valueCents;
    else if (deltaQty < 0) grossSellCents += valueCents;
    lines.push({
      symbol: sym,
      currentQty,
      targetQty,
      deltaQty,
      side: deltaQty > 0 ? "buy" : deltaQty < 0 ? "sell" : "none",
      priceCents,
      valueCents,
      currentPnlCents: Math.round(currentQty * priceCents - position.costValueCents),
    });
  }
  lines.sort((a, b) => Number(b.valueCents) - Number(a.valueCents));

  const residualRes = strategyId
    ? await db
        .from("strategy_rebalance_residuals")
        .select("balance_cents")
        .eq("user_id", userId)
        .eq("strategy_id", strategyId)
    : { data: [] as Array<{ balance_cents: number | null }>, error: null };
  if (residualRes.error) {
    return NextResponse.json({ ok: false, error: residualRes.error.message }, { status: 500 });
  }
  const residualCents = (residualRes.data ?? []).reduce((s, r) => s + Number(r.balance_cents ?? 0), 0);

  const heldTransactionIds = [
    ...new Set(
      (
        await db
          .from("stock_holdings_c")
          .select("transaction_id")
          .eq("is_active", true)
          .eq("trade_side", "BUY")
          .eq("user_id", userId)
      ).data?.map((r) => r.transaction_id) ?? [],
    ),
  ].filter(Boolean) as string[];
  let reserveCents = 0;
  if (heldTransactionIds.length) {
    const transactionRes = await db
      .from("transactions")
      .select("buffer_cents,buffer_consumed_cents,status,reversed")
      .in("id", heldTransactionIds);
    if (transactionRes.error) {
      return NextResponse.json({ ok: false, error: transactionRes.error.message }, { status: 500 });
    }
    for (const t of (transactionRes.data ?? []) as Array<{
      buffer_cents: number | null;
      buffer_consumed_cents: number | null;
      status: string | null;
      reversed: boolean | null;
    }>) {
      if (t.status !== "posted" || t.reversed === true) continue;
      reserveCents += Math.max(0, Number(t.buffer_cents ?? 0) - Number(t.buffer_consumed_cents ?? 0));
    }
  }

  const bridge = calculateProceedsBridge({
    grossSellCents,
    grossBuyCents,
    sellAssetCount: lines.filter((l) => l.side === "sell").length,
    buyAssetCount: lines.filter((l) => l.side === "buy").length,
    brokerageRate,
    custodyFeeCents,
    reserveCents,
    residualCents,
  });

  return NextResponse.json({
    ok: true,
    user: { user_id: userId, name, account },
    feeConfig: {
      brokerageRate,
      custodyFeeCents,
      source: "app_settings",
      updatedAt: feeRes.data?.updated_at ?? null,
    },
    lines,
    bridge,
  });
}
