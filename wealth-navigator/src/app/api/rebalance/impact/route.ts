import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import {
  calculateModelUnitImpact,
  fullModelLots,
  type ModelUnitAction,
} from "@/lib/rebalance/model-unit-impact";
import { calculateProceedsBridge } from "@/lib/rebalance/proceeds";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/rebalance/impact
 *
 * Read-only investor impact of a proposed strategy rebalance, for the Rebalance
 * Builder. Given the strategy + proposed model units per name, it applies the
 * same unit delta to every complete client lot and
 * returns, per investor: shares to trade, buy/sell cash, wallet-after, and a
 * shortfall flag — plus a combined cash-availability check across all wallets
 * ("only buy with money we have"). This is the meeting's Builder requirement.
 *
 * ── HARD CLIENT-DATA BOUNDARY ────────────────────────────────────────────────
 * The persisted strategy environment controls the preview scope. UAT reads
 * test owners only and LIVE reads non-test owners only. The browser cannot
 * override that boundary, and every subsequent retail query is bounded to the
 * resolved profile ids. Read-only: this endpoint performs no writes.
 *
 * Units: wallets.balance is in RANDS; securities prices / holdings are in CENTS.
 * All maths is done in cents; wallet rands are converted (× 100) to compare.
 */

export const dynamic = "force-dynamic";

interface ProposedLine {
  ticker: string;
  action?: string;
  shares?: number | null;
}
interface CurrentModelLine {
  ticker: string;
  shares?: number | null;
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
  const proceedsMode =
    body.proceeds_mode === "reinvest" || body.proceeds_mode === "liquidate"
      ? body.proceeds_mode
      : null;
  const proposedRaw = Array.isArray(body.proposed) ? (body.proposed as ProposedLine[]) : [];
  const currentRaw = Array.isArray(body.current) ? (body.current as CurrentModelLine[]) : [];
  if (!strategyId && !strategyName) {
    return NextResponse.json(
      { ok: false, error: "strategy_id or strategy_name is required" },
      { status: 400 },
    );
  }

  // Normalise the proposed model units. Client trades must follow the model-unit
  // direction; relative portfolio weights can move the opposite way when the
  // basket denominator changes and are therefore unsafe for trade sizing.
  const targets = new Map<string, { action: ModelUnitAction; units: number }>();
  for (const p of proposedRaw) {
    const sym = bare(p.ticker);
    if (!sym) continue;
    const action = String(p.action ?? "hold") as ModelUnitAction;
    targets.set(sym, {
      action,
      units: Math.max(0, Math.round(Number(p.shares) || 0)),
    });
  }
  const currentModelUnits = new Map<string, number>();
  for (const line of currentRaw) {
    const symbol = bare(line.ticker);
    const shares = Math.max(0, Number(line.shares) || 0);
    if (symbol && shares > 0) currentModelUnits.set(symbol, shares);
  }
  for (const [symbol, target] of targets) {
    const currentUnits = currentModelUnits.get(symbol) ?? 0;
    const invalidDecrease = target.action === "decrease" && !(target.units < currentUnits);
    const invalidIncrease = target.action === "increase" && !(target.units > currentUnits);
    const invalidAdd = target.action === "add" && !(currentUnits === 0 && target.units > 0);
    const invalidRemove = target.action === "remove" && target.units !== 0;
    if (invalidDecrease || invalidIncrease || invalidAdd || invalidRemove) {
      return NextResponse.json(
        { ok: false, error: `${symbol} has an invalid ${target.action} model-unit change.` },
        { status: 400 },
      );
    }
  }
  const hasSellTarget = [...targets.values()].some(
    (target) => target.action === "remove" || target.action === "decrease",
  );
  const hasBuyTarget = [...targets.values()].some(
    (target) => target.action === "add" || target.action === "increase",
  );
  if (hasSellTarget && !proceedsMode) {
    return NextResponse.json(
      { ok: false, error: "Choose whether sale proceeds will be reinvested or liquidated to strategy cash." },
      { status: 400 },
    );
  }
  if (proceedsMode === "reinvest" && !hasBuyTarget) {
    return NextResponse.json(
      { ok: false, error: "Reinvest was selected but the proposal has no replacement BUY." },
      { status: 400 },
    );
  }
  if (proceedsMode === "liquidate" && hasBuyTarget) {
    return NextResponse.json(
      { ok: false, error: "Liquidation to cash cannot contain a replacement BUY." },
      { status: 400 },
    );
  }

  let db;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: true, scope: "unavailable", investors: [], totals: null, notice: "RETAIL database not configured." });
  }

  // Fee estimates use the exact CRM/App Settings contract. Never silently
  // substitute a hard-coded rate: an unavailable fee configuration blocks the
  // preview because gross proceeds are not safe to present as spendable cash.
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

  // Resolve eligible owner ids from the server-owned strategy environment.
  const strategyRes = await db
    .from("strategies_c")
    .select("id,name,short_name,investor_environment")
    .eq("id", strategyId || "00000000-0000-0000-0000-000000000000")
    .maybeSingle();
  if (strategyRes.error || !strategyRes.data) {
    return NextResponse.json(
      { ok: false, error: strategyRes.error?.message ?? "Strategy not found." },
      { status: 404 },
    );
  }
  const investorEnvironment =
    String(strategyRes.data.investor_environment || "LIVE").toUpperCase() === "UAT" ? "UAT" : "LIVE";
  const [profilesRes, testWalletRes] = await Promise.all([
    db.from("profiles").select("id, first_name, last_name, email, mint_number, is_test"),
    db.from("wallets").select("user_id").eq("status", "test"),
  ]);
  if (profilesRes.error || testWalletRes.error) {
    return NextResponse.json(
      { ok: false, error: profilesRes.error?.message ?? testWalletRes.error?.message },
      { status: 500 },
    );
  }
  const testWalletIds = new Set((testWalletRes.data ?? []).map((wallet) => String(wallet.user_id)));
  const eligibleProfiles = (profilesRes.data ?? []).filter((profile) => {
    const isTest = profile.is_test === true || testWalletIds.has(String(profile.id));
    return investorEnvironment === "UAT" ? isTest : !isTest;
  });
  const eligibleIds = eligibleProfiles.map((profile) => String(profile.id));
  const nameById = new Map<string, string>();
  const accountById = new Map<string, string>();
  for (const p of eligibleProfiles) {
    const nm = `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || (p.email as string) || "Client";
    nameById.set(p.id as string, nm);
    accountById.set(p.id as string, String(p.mint_number || p.email || p.id));
  }
  if (eligibleIds.length === 0) {
    return NextResponse.json({
      ok: true,
      scope: investorEnvironment.toLowerCase(),
      strategy: { id: strategyId || null, name: strategyName || null },
      investors: [],
      totals: { investorCount: 0, buyCents: 0, sellCents: 0, walletCents: 0, walletAfterCents: 0, cashOk: true },
      notice: `No ${investorEnvironment} clients hold this strategy yet.`,
    });
  }

  // Active BUY holdings for this strategy, bounded to eligible clients.
  let holdRes = await db
    .from("stock_holdings_c")
    .select("user_id, security_id, quantity, strategy_id, strategy_name_snapshot, transaction_id, avg_fill, Expected_fill")
    .eq("is_active", true)
    .eq("trade_side", "BUY")
    .in("user_id", eligibleIds)
    .eq("strategy_id", strategyId || "00000000-0000-0000-0000-000000000000");
  if ((!holdRes.data || holdRes.data.length === 0) && strategyName) {
    holdRes = await db
      .from("stock_holdings_c")
      .select("user_id, security_id, quantity, strategy_id, strategy_name_snapshot, transaction_id, avg_fill, Expected_fill")
      .eq("is_active", true)
      .eq("trade_side", "BUY")
      .in("user_id", eligibleIds)
      .eq("strategy_name_snapshot", strategyName);
  }
  if (holdRes.error) {
    return NextResponse.json({ ok: false, error: holdRes.error.message }, { status: 500 });
  }
  const holdings = (holdRes.data ?? []) as Array<{
    user_id: string;
    security_id: string;
    quantity: number | null;
    transaction_id: string | null;
    avg_fill: number | null;
    Expected_fill: number | null;
  }>;

  // (3) Resolve securities: held ids + proposed symbols → price (cents).
  const heldSecIds = [...new Set(holdings.map((h) => h.security_id).filter(Boolean))];
  const proposedSymbols = [...targets.keys()];
  const symbolCandidates = proposedSymbols.flatMap((s) => [s, `${s}.JO`]);
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

  // Latest intraday tick (cents) per security. The indexed view avoids scanning
  // millions of historical ticks every time an analyst clicks +/-.
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
        if (t.latest_intraday_price != null) {
          intradayById.set(t.security_id, Number(t.latest_intraday_price));
        }
      }
    }
  }
  const priceCentsForSymbol = (sym: string): number => {
    const s = secBySymbol.get(sym);
    if (!s) return 0;
    return intradayById.get(s.id) || s.lastCents || 0;
  };

  // Wallet cash (RANDS) per eligible client.
  const walletRandsByUser = new Map<string, number>();
  const walletRes = await db.from("wallets").select("user_id, balance").in("user_id", eligibleIds);
  for (const w of (walletRes.data ?? []) as Array<{ user_id: string; balance: number | null }>) {
    walletRandsByUser.set(w.user_id, (walletRandsByUser.get(w.user_id) ?? 0) + (Number(w.balance) || 0));
  }
  const residualByUser = new Map<string, number>();
  if (strategyId) {
    const residualRes = await db
      .from("strategy_rebalance_residuals")
      .select("user_id,balance_cents")
      .in("user_id", eligibleIds)
      .eq("strategy_id", strategyId);
    if (residualRes.error) {
      return NextResponse.json({ ok: false, error: residualRes.error.message }, { status: 500 });
    }
    for (const residual of (residualRes.data ?? []) as Array<{
      user_id: string;
      balance_cents: number | null;
    }>) {
      residualByUser.set(
        residual.user_id,
        (residualByUser.get(residual.user_id) ?? 0) + Number(residual.balance_cents ?? 0),
      );
    }
  }

  // Unused execution reserve is attached to the purchase transactions behind
  // the holdings. Settlement consumes this reserve before sale/buy fees reduce
  // the proceeds available for the replacement trade.
  const transactionIds = [...new Set(holdings.map((holding) => holding.transaction_id).filter(Boolean))] as string[];
  const reserveByUser = new Map<string, number>();
  if (transactionIds.length) {
    const transactionRes = await db
      .from("transactions")
      .select("id,user_id,buffer_cents,buffer_consumed_cents,status,reversed")
      .in("id", transactionIds);
    if (transactionRes.error) {
      return NextResponse.json({ ok: false, error: transactionRes.error.message }, { status: 500 });
    }
    for (const transaction of (transactionRes.data ?? []) as Array<{
      id: string;
      user_id: string;
      buffer_cents: number | null;
      buffer_consumed_cents: number | null;
      status: string | null;
      reversed: boolean | null;
    }>) {
      if (transaction.status !== "posted" || transaction.reversed === true) continue;
      const available = Math.max(
        0,
        Number(transaction.buffer_cents ?? 0) - Number(transaction.buffer_consumed_cents ?? 0),
      );
      reserveByUser.set(transaction.user_id, (reserveByUser.get(transaction.user_id) ?? 0) + available);
    }
  }

  // (5) Per-investor model-unit impact. A model decrease always produces a
  // client SELL and an increase always produces a BUY. Existing odd shares are
  // retained on partial changes; a full remove exits the entire holding.
  const byUser = new Map<
    string,
    Map<string, { quantity: number; costValueCents: number }>
  >();
  for (const h of holdings) {
    const meta = secById.get(h.security_id);
    if (!meta) continue;
    const quantity = Number(h.quantity) || 0;
    const rawFill = Number(h.Expected_fill) > 0 ? Number(h.Expected_fill) : Number(h.avg_fill) || 0;
    const referencePriceCents = priceCentsForSymbol(meta.symbol) || meta.lastCents;
    const costPriceCents =
      rawFill > 0 && rawFill < referencePriceCents / 5 ? Math.round(rawFill * 100) : Math.round(rawFill);
    const m =
      byUser.get(h.user_id) ?? new Map<string, { quantity: number; costValueCents: number }>();
    const current = m.get(meta.symbol) ?? { quantity: 0, costValueCents: 0 };
    m.set(meta.symbol, {
      quantity: current.quantity + quantity,
      costValueCents: current.costValueCents + Math.round(quantity * costPriceCents),
    });
    byUser.set(h.user_id, m);
  }

  const investors: Array<Record<string, unknown>> = [];
  let tBuy = 0;
  let tSell = 0;
  let tWallet = 0;
  let tWalletAfter = 0;
  let tResidual = 0;
  let tAvailableCash = 0;
  let tStrategyCashAfter = 0;
  let tCashAfter = 0;
  let tNetProceeds = 0;
  let tSellFees = 0;
  let tBuyFees = 0;
  let tReserve = 0;
  let tReserveUsed = 0;
  let tFeeShortfall = 0;
  for (const [userId, positions] of byUser) {
    let basketCents = 0;
    for (const [sym, position] of positions) {
      basketCents += position.quantity * priceCentsForSymbol(sym);
    }

    const changedExistingLots = [...targets.entries()]
      .filter(([, target]) => target.action !== "hold" && target.action !== "add")
      .map(([symbol]) => fullModelLots(
        positions.get(symbol)?.quantity ?? 0,
        currentModelUnits.get(symbol) ?? 0,
      ))
      .filter((lots) => lots > 0);
    const allModelLots = [...currentModelUnits.entries()]
      .map(([symbol, units]) => fullModelLots(positions.get(symbol)?.quantity ?? 0, units))
      .filter((lots) => lots > 0);
    const fallbackLots = changedExistingLots.length
      ? Math.min(...changedExistingLots)
      : allModelLots.length
        ? Math.min(...allModelLots)
        : 0;

    const lines: Array<Record<string, unknown>> = [];
    let buyCents = 0;
    let sellCents = 0;
    // Every name that is either held or targeted.
    const names = new Set<string>([...positions.keys(), ...targets.keys()]);
    for (const sym of names) {
      const target = targets.get(sym);
      const priceCents = priceCentsForSymbol(sym);
      const position = positions.get(sym) ?? { quantity: 0, costValueCents: 0 };
      const currentQty = position.quantity;
      if (!target || target.action === "hold") continue;
      const { lots, targetQty, deltaQty } = calculateModelUnitImpact({
        action: target.action,
        currentQty,
        currentModelUnits: currentModelUnits.get(sym) ?? 0,
        targetModelUnits: target.units,
        fallbackLots,
      });
      if (deltaQty === 0) continue;
      const valueCents = Math.abs(deltaQty) * priceCents;
      if (deltaQty > 0) buyCents += valueCents;
      else sellCents += valueCents;
      lines.push({
        symbol: sym,
        action: target.action,
        lots,
        currentQty,
        targetQty,
        deltaQty,
        side: deltaQty > 0 ? "buy" : "sell",
        priceCents,
        valueCents,
        currentPnlCents: Math.round(currentQty * priceCents - position.costValueCents),
      });
    }

    if (lines.length === 0) continue;
    const walletCents = Math.round((walletRandsByUser.get(userId) ?? 0) * 100);
    const residualCents = residualByUser.get(userId) ?? 0;
    const reserveCents = reserveByUser.get(userId) ?? 0;
    const bridge = calculateProceedsBridge({
      grossSellCents: sellCents,
      grossBuyCents: buyCents,
      sellAssetCount: lines.filter((line) => line.side === "sell").length,
      buyAssetCount: lines.filter((line) => line.side === "buy").length,
      brokerageRate,
      custodyFeeCents,
      reserveCents,
      walletCents,
      residualCents,
    });
    tBuy += buyCents;
    tSell += sellCents;
    tWallet += walletCents;
    tWalletAfter += bridge.walletAfterCents;
    tResidual += bridge.residualCents;
    tAvailableCash += bridge.availableCashCents;
    tStrategyCashAfter += bridge.strategyCashAfterCents;
    tCashAfter += bridge.cashAfterCents;
    tNetProceeds += bridge.netProceedsCents;
    tSellFees += bridge.sellFeesCents;
    tBuyFees += bridge.buyFeesCents;
    tReserve += bridge.reserveCents;
    tReserveUsed += bridge.reserveUsedCents;
    tFeeShortfall += bridge.feeShortfallCents;
    investors.push({
      user_id: userId,
      name: nameById.get(userId) ?? "Client",
      account: accountById.get(userId) ?? userId,
      basketCents,
      buyCents,
      sellCents,
      netCashCents: sellCents - buyCents - bridge.feeShortfallCents,
      ...bridge,
      lines: lines.sort((a, b) => Number(b.valueCents) - Number(a.valueCents)),
    });
  }

  investors.sort((a, b) => Number(b.buyCents) + Number(b.sellCents) - (Number(a.buyCents) + Number(a.sellCents)));

  const totals = {
    investorCount: investors.length,
    buyCents: tBuy,
    sellCents: tSell,
    walletCents: tWallet,
    walletAfterCents: tWalletAfter,
    residualCents: tResidual,
    availableCashCents: tAvailableCash,
    strategyCashAfterCents: tStrategyCashAfter,
    cashAfterCents: tCashAfter,
    netProceedsCents: tNetProceeds,
    sellFeesCents: tSellFees,
    buyFeesCents: tBuyFees,
    totalFeesCents: tSellFees + tBuyFees,
    reserveCents: tReserve,
    reserveUsedCents: tReserveUsed,
    feeShortfallCents: tFeeShortfall,
    // Per-owner protection: a combined positive balance cannot hide one
    // investor whose replacement trade would overdraw their own cash.
    cashOk: investors.every((investor) => investor.shortfall !== true),
  };

  return NextResponse.json({
    ok: true,
    scope: investorEnvironment.toLowerCase(),
    strategy: { id: strategyId || null, name: strategyName || null },
    proceedsMode,
    feeConfig: {
      brokerageRate,
      custodyFeeCents,
      source: "app_settings.fees",
      updatedAt: feeRes.data?.updated_at ?? null,
    },
    investors,
    totals,
    notice:
      investors.length === 0
        ? `No ${investorEnvironment} client holdings match this strategy yet.`
        : undefined,
  });
}
