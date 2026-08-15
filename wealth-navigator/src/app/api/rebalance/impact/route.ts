import { NextResponse } from "next/server";

import { canResearchIc, getAdminContext } from "@/lib/admin/rbac";
import {
  type ModelUnitAction,
  calculateModelUnitImpact,
  fullModelLots,
} from "@/lib/rebalance/model-unit-impact";
import { calculateProceedsBridge } from "@/lib/rebalance/proceeds";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/rebalance/impact
 *
 * Read-only investor impact of a proposed strategy rebalance, for the Rebalance
 * Builder. Given the strategy + proposed model units per name, it applies the
 * same unit delta to every complete client lot and
 * returns, per investor: shares to trade, buy/sell cash, strategy CA, execution
 * reserve, and a shortfall flag. General wallet balances are deliberately not
 * rebalance funding.
 *
 * ── HARD CLIENT-DATA BOUNDARY ────────────────────────────────────────────────
 * The persisted strategy environment controls the preview scope. UAT reads
 * test owners only and LIVE reads non-test owners only. The browser cannot
 * override that boundary, and every subsequent retail query is bounded to the
 * resolved profile ids. Read-only: this endpoint performs no writes.
 *
 * Securities prices, holdings, strategy CA, and reserve are calculated in cents.
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
  if (!canResearchIc(auth.ctx, "rebalance", "raise_rebalance")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const strategyId = typeof body.strategy_id === "string" ? body.strategy_id.trim() : "";
  const strategyName = typeof body.strategy_name === "string" ? body.strategy_name.trim() : "";
  const proceedsMode =
    body.proceeds_mode === "reinvest" || body.proceeds_mode === "liquidate" ? body.proceeds_mode : null;
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
  // NOTE: "reinvest chosen but no BUY yet" is NOT rejected here — it's the
  // normal, valid state right after switching to Reinvest mode and before an
  // instrument is picked. Rejecting it here used to make this endpoint return
  // `ok:false` (totals undefined) at that exact moment, and the Buy Execution
  // dropdown's auto-share-count (`chooseBuyInstrument`) reads
  // `impactQ.data.totals.netProceedsCents` to size the very first pick — so
  // every first buy attempt silently computed 0 shares off the failed
  // response, which then failed the "invalid add" check on the next request
  // regardless of which instrument was chosen. Compute sell-only totals
  // instead (buyGross stays 0 below); `commitDisabled`/`submitToIc()` on the
  // client is what actually blocks committing a reinvest with no BUY.
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
    return NextResponse.json({
      ok: true,
      scope: "unavailable",
      investors: [],
      totals: null,
      notice: "RETAIL database not configured.",
    });
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
      totals: {
        investorCount: 0,
        buyCents: 0,
        sellCents: 0,
        residualCents: 0,
        reserveCents: 0,
        cashOk: true,
      },
      notice: `No ${investorEnvironment} clients hold this strategy yet.`,
    });
  }

  // Active BUY holdings for this strategy, bounded to eligible clients.
  let holdRes = await db
    .from("stock_holdings_c")
    .select(
      "user_id, family_member_id, security_id, quantity, strategy_id, strategy_name_snapshot, transaction_id, avg_fill, Expected_fill, Fill_date",
    )
    .eq("is_active", true)
    .eq("trade_side", "BUY")
    .in("user_id", eligibleIds)
    .eq("strategy_id", strategyId || "00000000-0000-0000-0000-000000000000");
  if ((!holdRes.data || holdRes.data.length === 0) && strategyName) {
    holdRes = await db
      .from("stock_holdings_c")
      .select(
        "user_id, family_member_id, security_id, quantity, strategy_id, strategy_name_snapshot, transaction_id, avg_fill, Expected_fill, Fill_date",
      )
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
    family_member_id: string | null;
    security_id: string;
    quantity: number | null;
    transaction_id: string | null;
    avg_fill: number | null;
    Expected_fill: number | null;
    Fill_date: string | null;
  }>;
  // Same "parked" signal as reconcile-parked-holdings.ts (see its docstring
  // for the caveat) — surfaced here purely for the UI to highlight these
  // clients, since they get rebalanced fee-free on IC approval instead of a
  // real trade like everyone else.
  const ownerKey = (userId: string, familyMemberId: string | null | undefined) =>
    `${userId}|${familyMemberId ?? ""}`;
  const parkedOwnerKeys = new Set(
    holdings.filter((h) => !h.Fill_date).map((h) => ownerKey(h.user_id, h.family_member_id)),
  );

  const familyIds = [...new Set(holdings.map((holding) => holding.family_member_id).filter(Boolean))] as string[];
  const familyRes = familyIds.length
    ? await db.from("family_members").select("id,first_name,last_name,mint_number").in("id", familyIds)
    : { data: [] as Array<{ id: string; first_name: string | null; last_name: string | null; mint_number: string | null }>, error: null };
  if (familyRes.error) {
    return NextResponse.json({ ok: false, error: familyRes.error.message }, { status: 500 });
  }
  const familyNameById = new Map<string, string>();
  const familyAccountById = new Map<string, string>();
  for (const member of familyRes.data ?? []) {
    familyNameById.set(
      member.id,
      `${member.first_name ?? ""} ${member.last_name ?? ""}`.trim() || "Family member",
    );
    familyAccountById.set(member.id, String(member.mint_number || member.id));
  }

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

  const residualByOwner = new Map<string, number>();
  if (strategyId) {
    const residualRes = await db
      .from("strategy_rebalance_residuals")
      .select("user_id,family_member_id,balance_cents")
      .in("user_id", eligibleIds)
      .eq("strategy_id", strategyId);
    if (residualRes.error) {
      return NextResponse.json({ ok: false, error: residualRes.error.message }, { status: 500 });
    }
    for (const residual of (residualRes.data ?? []) as Array<{
      user_id: string;
      family_member_id: string | null;
      balance_cents: number | null;
    }>) {
      const key = ownerKey(residual.user_id, residual.family_member_id);
      residualByOwner.set(
        key,
        (residualByOwner.get(key) ?? 0) + Number(residual.balance_cents ?? 0),
      );
    }
  }

  // Unused execution reserve is attached to the purchase transactions behind
  // the holdings. Settlement consumes this reserve before sale/buy fees reduce
  // the proceeds available for the replacement trade.
  const transactionIds = [
    ...new Set(holdings.map((holding) => holding.transaction_id).filter(Boolean)),
  ] as string[];
  const reserveByOwner = new Map<string, number>();
  const ownerKeyByTransactionId = new Map<string, string>();
  for (const holding of holdings) {
    if (holding.transaction_id) {
      ownerKeyByTransactionId.set(
        holding.transaction_id,
        ownerKey(holding.user_id, holding.family_member_id),
      );
    }
  }
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
      const key = ownerKeyByTransactionId.get(transaction.id) ?? ownerKey(transaction.user_id, null);
      reserveByOwner.set(key, (reserveByOwner.get(key) ?? 0) + available);
    }
  }

  // (5) Per-investor model-unit impact. A model decrease always produces a
  // client SELL and an increase always produces a BUY. Existing odd shares are
  // retained on partial changes; a full remove exits the entire holding.
  const byOwner = new Map<
    string,
    {
      userId: string;
      familyMemberId: string | null;
      positions: Map<string, { quantity: number; costValueCents: number }>;
    }
  >();
  for (const h of holdings) {
    const meta = secById.get(h.security_id);
    if (!meta) continue;
    const quantity = Number(h.quantity) || 0;
    const rawFill = Number(h.Expected_fill) > 0 ? Number(h.Expected_fill) : Number(h.avg_fill) || 0;
    const referencePriceCents = priceCentsForSymbol(meta.symbol) || meta.lastCents;
    const costPriceCents =
      rawFill > 0 && rawFill < referencePriceCents / 5 ? Math.round(rawFill * 100) : Math.round(rawFill);
    const key = ownerKey(h.user_id, h.family_member_id);
    const owner = byOwner.get(key) ?? {
      userId: h.user_id,
      familyMemberId: h.family_member_id ?? null,
      positions: new Map<string, { quantity: number; costValueCents: number }>(),
    };
    const m = owner.positions;
    const current = m.get(meta.symbol) ?? { quantity: 0, costValueCents: 0 };
    m.set(meta.symbol, {
      quantity: current.quantity + quantity,
      costValueCents: current.costValueCents + Math.round(quantity * costPriceCents),
    });
    byOwner.set(key, owner);
  }

  // Strategy-wide model basket value (same for every investor) — denominator
  // for each symbol's model weight %, used by the per-client drift panel.
  let modelBasketCents = 0;
  for (const [sym, units] of currentModelUnits) {
    modelBasketCents += units * priceCentsForSymbol(sym);
  }

  const investors: Array<Record<string, unknown>> = [];
  let tBuy = 0;
  let tSell = 0;
  let tResidual = 0;
  let tStrategyCashAfter = 0;
  let tCashAfter = 0;
  let tNetProceeds = 0;
  let tSellFees = 0;
  let tBuyFees = 0;
  let tReserve = 0;
  let tReserveUsed = 0;
  let tFeeShortfall = 0;
  for (const [key, owner] of byOwner) {
    const { userId, familyMemberId, positions } = owner;
    let basketCents = 0;
    for (const [sym, position] of positions) {
      basketCents += position.quantity * priceCentsForSymbol(sym);
    }

    const changedExistingLots = [...targets.entries()]
      .filter(([, target]) => target.action !== "hold" && target.action !== "add")
      .map(([symbol]) =>
        fullModelLots(positions.get(symbol)?.quantity ?? 0, currentModelUnits.get(symbol) ?? 0),
      )
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

    // Compliance drift — current holding vs. the strategy's PERSISTED model
    // (currentModelUnits, never the staged/proposed target), scaled to this
    // client's own lot count. Unlike `lines` below, this covers every held
    // or modelled symbol regardless of whether it has a proposed change, so
    // it works even when `proposed` is all-"hold" (nothing staged yet).
    const driftLines: Array<Record<string, unknown>> = [];
    for (const sym of names) {
      const priceCents = priceCentsForSymbol(sym);
      const position = positions.get(sym) ?? { quantity: 0, costValueCents: 0 };
      const currentQty = position.quantity;
      const modelUnits = currentModelUnits.get(sym) ?? 0;
      const modelQty = Math.round(modelUnits * fallbackLots);
      const modelValueCents = modelQty * priceCents;
      driftLines.push({
        symbol: sym,
        lots: fallbackLots,
        currentQty,
        modelQty,
        deltaQty: modelQty - currentQty,
        priceCents,
        currentValueCents: currentQty * priceCents,
        modelValueCents,
        currentWeightPct: basketCents > 0 ? (currentQty * priceCents * 100) / basketCents : 0,
        modelWeightPct: modelBasketCents > 0 ? (modelUnits * priceCents * 100) / modelBasketCents : 0,
        currentPnlCents: Math.round(currentQty * priceCents - position.costValueCents),
      });
    }
    driftLines.sort((a, b) => Number(b.currentValueCents) - Number(a.currentValueCents));
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
      const valueCents = Math.abs(deltaQty) * priceCents;
      if (deltaQty > 0) buyCents += valueCents;
      else if (deltaQty < 0) sellCents += valueCents;
      lines.push({
        symbol: sym,
        action: target.action,
        lots,
        currentQty,
        targetQty,
        deltaQty,
        side: deltaQty > 0 ? "buy" : deltaQty < 0 ? "sell" : "none",
        priceCents,
        valueCents,
        currentPnlCents: Math.round(currentQty * priceCents - position.costValueCents),
      });
    }

    const residualCents = residualByOwner.get(key) ?? 0;
    const reserveCents = reserveByOwner.get(key) ?? 0;
    // A parked (never-filled) client is rewritten fee-free on IC approval —
    // see reconcile-parked-holdings.ts. Match that exactly here so this
    // preview's numbers back up the "Unfilled" badge's fee-free claim
    // instead of contradicting it: no brokerage, no fee on repositioning,
    // only a genuinely new asset (action="add") costs one custody fee.
    const isParked = parkedOwnerKeys.has(key);
    const bridge = calculateProceedsBridge({
      grossSellCents: sellCents,
      grossBuyCents: buyCents,
      sellAssetCount: isParked ? 0 : lines.filter((line) => line.side === "sell").length,
      buyAssetCount: isParked
        ? lines.filter((line) => line.action === "add").length
        : lines.filter((line) => line.side === "buy").length,
      brokerageRate: isParked ? 0 : brokerageRate,
      custodyFeeCents,
      reserveCents,
      residualCents,
    });
    tBuy += buyCents;
    tSell += sellCents;
    tResidual += bridge.residualCents;
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
      family_member_id: familyMemberId,
      name: familyMemberId ? familyNameById.get(familyMemberId) ?? "Family member" : nameById.get(userId) ?? "Client",
      account: familyMemberId
        ? familyAccountById.get(familyMemberId) ?? familyMemberId
        : accountById.get(userId) ?? userId,
      basketCents,
      buyCents,
      sellCents,
      netCashCents: sellCents - buyCents - bridge.feeShortfallCents,
      ...bridge,
      lines: lines.sort((a, b) => Number(b.valueCents) - Number(a.valueCents)),
      driftLines,
      parked: parkedOwnerKeys.has(key),
    });
  }

  investors.sort(
    (a, b) => Number(b.buyCents) + Number(b.sellCents) - (Number(a.buyCents) + Number(a.sellCents)),
  );

  const totals = {
    investorCount: investors.length,
    buyCents: tBuy,
    sellCents: tSell,
    residualCents: tResidual,
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
