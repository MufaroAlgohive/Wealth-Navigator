import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import {
  calculatePositionTruth,
  calculateStrategyLiveValue,
  auditReturnChain,
  classifyValuationComparison,
  classifyPercentageDifference,
  possibleDifferenceReasons,
  reconcileIressPrice,
  reconstructClientHistoryPoint,
  reconstructStrategyHistoryPoint,
  returnScopeBenchmarks,
} from "@/lib/truth/calculations";
import { fetchYahooTruthQuote, type YahooTruthQuote } from "@/lib/truth/yahoo-live";
import { callWorker } from "@/lib/iress/worker-api";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Db = ReturnType<typeof createRetailServiceRoleClient>;
type Row = Record<string, unknown>;
type SurfaceCheck = {
  surface: string;
  sourcePage?: string;
  sourceEndpoint?: string;
  status: "ok" | "warning" | "urgent";
  latencyMs: number;
  actual: string;
  expected: string;
  difference?: string;
  evidence: string[];
  comparisons: Array<{
    metric: string;
    actual: number | null;
    expected: number | null;
    difference: number | null;
    unit: "percent" | "cents";
    status: "ok" | "warning" | "urgent";
  }>;
};

const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const nullableNumber = (value: unknown): number | null =>
  value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
const text = (value: unknown) => String(value ?? "").trim();
const moneyText = (cents: number) => `R ${(cents / 100).toFixed(2)}`;
const comparison = (
  metric: string,
  actual: number | null,
  expected: number | null,
  unit: "percent" | "cents",
) => {
  const difference = actual == null || expected == null ? null : actual - expected;
  const tolerance = unit === "percent" ? 0.01 : 1;
  const urgent = unit === "percent" ? 0.25 : Math.max(100, Math.abs(expected ?? 0) * 0.0025);
  return {
    metric,
    actual,
    expected,
    difference,
    unit,
    status:
      difference == null
        ? ("warning" as const)
        : Math.abs(difference) > urgent
          ? ("urgent" as const)
          : Math.abs(difference) > tolerance
            ? ("warning" as const)
            : ("ok" as const),
  };
};
const ownerKey = (userId: unknown, familyId: unknown, strategyId: unknown) =>
  `${text(userId)}:${text(familyId)}:${text(strategyId)}`;
const chained = (rows: Row[]) => {
  const daily = rows.map((row) => nullableNumber(row["1d_pct"]));
  let factor = 1;
  for (const value of daily) {
    if (value == null) return null;
    factor *= 1 + value / 100;
  }
  return factor * 100 - 100;
};
const periodReturns = (rows: Row[]) => {
  const sorted = [...rows].sort((a, b) => text(a.as_of_date).localeCompare(text(b.as_of_date)));
  const latestDate = text(sorted.at(-1)?.as_of_date);
  const month = latestDate.slice(0, 7);
  const five = sorted.slice(-5);
  const mtd = sorted.filter((row) => text(row.as_of_date).startsWith(month));
  return {
    fiveDayPct: five.length ? chained(five) : null,
    mtdPct: mtd.length ? chained(mtd) : null,
    ytdPct: nullableNumber(sorted.at(-1)?.ytd_pct),
    allTimePct: nullableNumber(sorted.at(-1)?.inception_pct ?? sorted.at(-1)?.all_pct),
  };
};

async function staffDb(): Promise<{ db?: Db; response?: NextResponse }> {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return { response: NextResponse.json({ ok: false, error: "no-session" }, { status: 401 }) };
  if (auth.status !== "ok")
    return { response: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  try {
    return { db: createRetailServiceRoleClient() };
  } catch {
    return {
      response: NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 }),
    };
  }
}

async function testUsers(db: Db) {
  const [{ data: profiles }, { data: wallets }] = await Promise.all([
    db.from("profiles").select("id").eq("is_test", true),
    db.from("wallets").select("user_id").eq("status", "test"),
  ]);
  return new Set([
    ...(profiles ?? []).map((row) => text(row.id)),
    ...(wallets ?? []).map((row) => text(row.user_id)),
  ]);
}

async function listTruth(db: Db) {
  const [
    { data: latest, error },
    { data: profiles },
    { data: strategies },
    { data: strategyReturns },
    { data: ledgerRows, error: ledgerError },
    excluded,
  ] = await Promise.all([
    db
      .from("client_strategy_returns_effective_latest_c")
      .select(
        "user_id,family_member_id,strategy_id,as_of_date,basket_value_cents,securities_value_cents,residual_cash_cents,unused_reserve_cents,accrued_liability_cents,inception_pnl_cents,inception_pct,ytd_pct",
      ),
    db.from("profiles").select("id,first_name,last_name,email,mint_number,created_at"),
    db.from("strategies_c").select("id,name,short_name,min_investment,status"),
    db
      .from("strategy_returns_effective_c")
      .select(
        "strategy_id,as_of_date,complete_value_cents,basket_value_cents,securities_value_cents,continuity_cash_cents",
      )
      .order("as_of_date", { ascending: false })
      .limit(4000),
    db
      .from("strategy_canonical_daily_ledger_c")
      .select("strategy_id,as_of_date,certification_status,securities_value_cents,continuity_cash_cents,complete_value_cents,leg_snapshot,period_metrics,source_evidence,calculation_notes")
      .order("as_of_date", { ascending: false })
      .limit(1000),
    testUsers(db),
  ]);
  if (error) throw new Error(error.message);
  if (ledgerError) throw new Error(`Canonical ledger: ${ledgerError.message}`);
  const profileMap = new Map((profiles ?? []).map((row) => [text(row.id), row]));
  const strategyMap = new Map((strategies ?? []).map((row) => [text(row.id), row]));
  const latestStrategyReturn = new Map<string, Row>();
  for (const row of (strategyReturns ?? []) as Row[]) {
    const id = text(row.strategy_id);
    if (id && !latestStrategyReturn.has(id)) latestStrategyReturn.set(id, row);
  }
  const positions = ((latest ?? []) as Row[])
    .filter((row) => !excluded.has(text(row.user_id)) && num(row.basket_value_cents) > 0)
    .map((row) => {
      const profile = profileMap.get(text(row.user_id));
      const strategy = strategyMap.get(text(row.strategy_id));
      return {
        key: ownerKey(row.user_id, row.family_member_id, row.strategy_id),
        userId: row.user_id,
        familyMemberId: row.family_member_id,
        strategyId: row.strategy_id,
        client:
          [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") ||
          profile?.email ||
          text(row.user_id),
        email: profile?.email,
        mintNumber: profile?.mint_number,
        strategy: strategy?.short_name || strategy?.name || row.strategy_id,
        asOf: row.as_of_date,
        currentCents: row.basket_value_cents,
        securitiesCents: row.securities_value_cents,
        residualCents: row.residual_cash_cents,
        reserveCents: row.unused_reserve_cents,
        liabilityCents: row.accrued_liability_cents,
        pnlCents: row.inception_pnl_cents,
        inceptionPct: row.inception_pct,
        ytdPct: row.ytd_pct,
      };
    });
  return {
    positions,
    strategies: (strategies ?? []).map((strategy) => {
      const model = latestStrategyReturn.get(text(strategy.id));
      return {
        id: strategy.id,
        name: strategy.short_name || strategy.name,
        minInvestment: strategy.min_investment,
        status: strategy.status,
        investedPositions: positions.filter((position) => position.strategyId === strategy.id).length,
        modelValueCents: model?.complete_value_cents ?? model?.basket_value_cents ?? null,
        modelSecuritiesCents: model?.securities_value_cents ?? null,
        modelCaCents: model?.continuity_cash_cents ?? null,
        modelAsOf: model?.as_of_date ?? null,
      };
    }),
    ledger: (ledgerRows ?? []).map((row) => ({
      strategyId: text(row.strategy_id),
      strategy: strategyMap.get(text(row.strategy_id))?.short_name || strategyMap.get(text(row.strategy_id))?.name || text(row.strategy_id),
      asOf: text(row.as_of_date),
      certificationStatus: text(row.certification_status),
      securitiesCents: num(row.securities_value_cents),
      continuityCashCents: num(row.continuity_cash_cents),
      completeValueCents: num(row.complete_value_cents),
      legs: Array.isArray(row.leg_snapshot) ? row.leg_snapshot : [],
      periods: row.period_metrics && typeof row.period_metrics === "object" ? row.period_metrics : {},
      evidence: row.source_evidence && typeof row.source_evidence === "object" ? row.source_evidence : {},
      notes: row.calculation_notes && typeof row.calculation_notes === "object" ? row.calculation_notes : {},
    })),
  };
}

type QuoteSnapshot = {
  id: string;
  startedAt: string;
  requests: Map<string, Promise<YahooTruthQuote>>;
};

const createQuoteSnapshot = (): QuoteSnapshot => ({
  id: crypto.randomUUID(),
  startedAt: new Date().toISOString(),
  requests: new Map(),
});

async function quoteMap(symbols: string[], snapshot: QuoteSnapshot) {
  const unique = [...new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean))];
  if (!unique.length) return new Map<string, YahooTruthQuote>();
  const requests = unique.map((symbol) => {
    const key = symbol.toUpperCase();
    const existing = snapshot.requests.get(key);
    if (existing) return existing;
    const request = fetchYahooTruthQuote(symbol);
    snapshot.requests.set(key, request);
    return request;
  });
  const settled = await Promise.allSettled(requests);
  const quotes = new Map<string, YahooTruthQuote>();
  const errors: string[] = [];
  settled.forEach((result, index) => {
    const symbol = unique[index] ?? "";
    if (result.status === "fulfilled") quotes.set(symbol, result.value);
    else errors.push(`${symbol}: ${result.reason instanceof Error ? result.reason.message : result.reason}`);
  });
  if (errors.length) throw new Error(`Live truth blocked—missing Yahoo quote(s): ${errors.join("; ")}`);
  return quotes;
}

async function quoteSnapshotEvidence(snapshot: QuoteSnapshot) {
  const settled = await Promise.allSettled([...snapshot.requests.values()]);
  const quotes = settled
    .filter((result): result is PromiseFulfilledResult<YahooTruthQuote> => result.status === "fulfilled")
    .map((result) => result.value);
  const exchangeTimes = quotes.map((quote) => quote.exchangeTime).filter(Boolean).sort();
  return {
    id: snapshot.id,
    provider: "Yahoo Finance chart API",
    startedAt: snapshot.startedAt,
    completedAt: new Date().toISOString(),
    instruments: quotes.length,
    earliestExchangeTime: exchangeTimes.at(0) ?? null,
    latestExchangeTime: exchangeTimes.at(-1) ?? null,
    frozenWithinRun: true,
  };
}

function requiredQuote(
  quotes: Map<string, Awaited<ReturnType<typeof fetchYahooTruthQuote>>>,
  symbol: string,
) {
  const quote = quotes.get(symbol);
  if (!quote) throw new Error(`Live truth blocked—quote map has no ${symbol}`);
  return quote;
}

async function clientTruth(db: Db, userId: string, snapshot: QuoteSnapshot = createQuoteSnapshot()) {
  const [{ data: profile }, { data: holdings }, { data: canonical }] = await Promise.all([
    db
      .from("profiles")
      .select("id,first_name,last_name,email,mint_number,created_at")
      .eq("id", userId)
      .maybeSingle(),
    db
      .from("stock_holdings_c")
      .select(
        "id,user_id,family_member_id,strategy_id,security_id,quantity,avg_fill,Expected_fill,transaction_id,created_at,Fill_date,rebalance_batch_id,strategy_name_snapshot",
      )
      .eq("user_id", userId)
      .eq("is_active", true)
      .eq("trade_side", "BUY"),
    db.from("client_strategy_returns_effective_latest_c").select("*").eq("user_id", userId),
  ]);
  if (!profile) throw new Error("Client not found");
  const securityIds = [...new Set((holdings ?? []).map((row) => text(row.security_id)).filter(Boolean))];
  const strategyIds = [
    ...new Set([
      ...(holdings ?? []).map((row) => text(row.strategy_id)),
      ...(canonical ?? []).map((row) => text(row.strategy_id)),
    ].filter(Boolean)),
  ];
  const transactionIds = [
    ...new Set((holdings ?? []).map((row) => text(row.transaction_id)).filter(Boolean)),
  ];
  const [
    { data: securities },
    { data: strategies },
    { data: residuals },
    { data: transactions },
    { data: fees },
  ] = await Promise.all([
    securityIds.length
      ? db.from("securities_c").select("id,symbol,name").in("id", securityIds)
      : Promise.resolve({ data: [] }),
    strategyIds.length
      ? db.from("strategies_c").select("id,name,short_name").in("id", strategyIds)
      : Promise.resolve({ data: [] }),
    strategyIds.length
      ? db
          .from("strategy_rebalance_residuals")
          .select("user_id,family_member_id,strategy_id,balance_cents,updated_at")
          .eq("user_id", userId)
      : Promise.resolve({ data: [] }),
    transactionIds.length
      ? db
          .from("transactions")
          .select("id,amount,buffer_cents,buffer_consumed_cents,status,created_at,reversed")
          .in("id", transactionIds)
      : Promise.resolve({ data: [] }),
    strategyIds.length
      ? db
          .from("aum_fee_accrual_segments")
          .select(
            "user_id,family_member_id,strategy_id,accrued_fee_cents,segment_start_date,segment_end_date",
          )
          .eq("user_id", userId)
          .is("segment_end_date", null)
      : Promise.resolve({ data: [] }),
  ]);
  const [
    { data: history },
    { data: activity },
    { data: strategyHistory },
    { data: rawHistory },
    { data: rebalanceBatches },
    { data: rebalanceEvents },
    { data: rawStrategyHistory },
  ] = await Promise.all([
    db
      .from("client_strategy_returns_effective_c")
      .select(
        'user_id,family_member_id,strategy_id,as_of_date,basket_value_cents,securities_value_cents,residual_cash_cents,unused_reserve_cents,accrued_liability_cents,inception_pnl_cents,inception_pct,ytd_pct,opening_performance_nav_cents,"1d_pct",source_kind',
      )
      .eq("user_id", userId)
      .order("as_of_date", { ascending: true }),
    db
      .from("transactions")
      .select(
        "id,user_id,family_member_id,amount,base_amount_cents,direction,name,description,status,transaction_date,created_at,buffer_cents,buffer_consumed_cents,reversed",
      )
      .eq("user_id", userId)
      .order("transaction_date", { ascending: false })
      .limit(250),
    strategyIds.length
      ? db
          .from("strategy_returns_effective_c")
          .select(
            'strategy_id,as_of_date,ytd_pct,all_pct,"1d_pct",securities_value_cents,continuity_cash_cents,complete_value_cents',
          )
          .in("strategy_id", strategyIds)
          .order("as_of_date", { ascending: false })
          .limit(2000)
      : Promise.resolve({ data: [] }),
    db
      .from("client_strategy_returns_c")
      .select('user_id,strategy_id,as_of_date,basket_value,"1d_pnl",ytd_pnl')
      .eq("user_id", userId)
      .order("as_of_date", { ascending: true }),
    strategyIds.length
      ? db
          .from("rebalance_batch")
          .select(
            "id,strategy_id,status,settlement_state,effective_date,strategy_name_snapshot,created_at,settled_at,reversed_at,reversed_reason",
          )
          .in("strategy_id", strategyIds)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] }),
    db
      .from("rebalance_event")
      .select(
        "id,batch_id,user_id,family_member_id,security_id,trade_side,quantity,price_at_commit,avg_fill,fill_date,closed_reason,created_at",
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: true }),
    strategyIds.length
      ? db
          .from("strategies_returns_c")
          .select("strategy_id,as_of_date,basket_value,ytd_pct")
          .in("strategy_id", strategyIds)
          .order("as_of_date", { ascending: true })
      : Promise.resolve({ data: [] }),
  ]);
  const secMap = new Map((securities ?? []).map((row) => [text(row.id), row]));
  const stratMap = new Map((strategies ?? []).map((row) => [text(row.id), row]));
  const symbols = (holdings ?? []).map((row) => text(secMap.get(text(row.security_id))?.symbol));
  const quotes = await quoteMap(symbols, snapshot);
  type IressCoverageRow = {
    symbol?: string;
    iressCode?: string;
    ok?: boolean;
    outcome?: string;
    last?: number | null;
    marketState?: string | null;
    currency?: string | null;
    error?: string | null;
  };
  type IressCoverageBody = {
    ok?: boolean;
    iressMode?: string;
    covered?: number;
    requested?: number;
    probedAt?: string;
    rows?: IressCoverageRow[];
  };
  const uniqueSymbols = [...new Set(symbols.map((symbol) => text(symbol)).filter(Boolean))];
  const iressCoverage = await callWorker<IressCoverageBody>({
    method: "POST",
    path: "/debug/coverage",
    body: { symbols: uniqueSymbols, exchange: "JSE" },
    timeoutMs: 30_000,
  });
  const iressBody = iressCoverage.ok ? iressCoverage.body : null;
  const iressRows = new Map(
    (iressBody?.rows ?? []).map((row) => [
      text(row.symbol || row.iressCode).replace(/\.(JO|JSE)$/i, "").toUpperCase(),
      row,
    ]),
  );
  const rows = (holdings ?? []).map((holding) => {
    const security = secMap.get(text(holding.security_id));
    const symbol = text(security?.symbol);
    const quote = requiredQuote(quotes, symbol);
    const quantity = num(holding.quantity);
    const expected = num(holding.Expected_fill);
    const rawFill = expected > 0 ? expected : num(holding.avg_fill);
    const costCents =
      rawFill > 0 && rawFill < quote.priceCents / 5 ? Math.round(rawFill * 100) : Math.round(rawFill);
    const iressRow = iressRows.get(symbol.replace(/\.(JO|JSE)$/i, "").toUpperCase());
    const iressReconciliation = reconcileIressPrice(quote.priceCents, iressRow?.last ?? null);
    const previousCloseCents = quote.previousCloseCents;
    const todayPnlCents =
      previousCloseCents == null ? null : Math.round(quantity * (quote.priceCents - previousCloseCents));
    return {
      holdingId: holding.id,
      strategyId: holding.strategy_id,
      strategy:
        stratMap.get(text(holding.strategy_id))?.short_name || stratMap.get(text(holding.strategy_id))?.name,
      symbol,
      security: security?.name,
      quantity,
      livePriceCents: quote.priceCents,
      previousCloseCents,
      todayPnlCents,
      marketValueCents: Math.round(quantity * quote.priceCents),
      costPriceCents: costCents,
      costValueCents: Math.round(quantity * costCents),
      fillDate: holding.Fill_date,
      createdAt: holding.created_at,
      transactionId: holding.transaction_id,
      rebalanceBatchId: holding.rebalance_batch_id,
      quote,
      iress: {
        available: Boolean(iressRow?.ok),
        rawLast: iressRow?.last ?? null,
        normalisedCents: iressReconciliation.normalisedCents,
        scale: iressReconciliation.scale,
        differenceCents: iressReconciliation.differenceCents,
        differencePct: iressReconciliation.differencePct,
        status: iressRow?.ok ? iressReconciliation.status : "warning",
        outcome: iressRow?.outcome ?? (iressCoverage.ok ? "not-covered" : iressCoverage.code),
        marketState: iressRow?.marketState ?? null,
        error: iressRow?.error ?? (iressCoverage.ok ? null : iressCoverage.error),
      },
      formula: `${quantity} × ${quote.priceCents} cents`,
    };
  });
  const transactionMap = new Map((transactions ?? []).map((row) => [text(row.id), row]));
  const strategyBenchmarks = new Map<string, Row>();
  for (const row of (strategyHistory ?? []) as Row[]) {
    const id = text(row.strategy_id);
    if (id && !strategyBenchmarks.has(id)) strategyBenchmarks.set(id, row);
  }
  const byPosition = ((canonical ?? []) as Row[]).map((position) => {
    const key = ownerKey(position.user_id, position.family_member_id, position.strategy_id);
    const positionHoldings = rows.filter(
      (row) =>
        text(row.strategyId) === text(position.strategy_id) &&
        text((holdings ?? []).find((holding) => holding.id === row.holdingId)?.family_member_id) ===
          text(position.family_member_id),
    );
    const securitiesCents = positionHoldings.reduce((sum, row) => sum + row.marketValueCents, 0);
    const residual = ((residuals ?? []).find(
      (row) =>
        text(row.strategy_id) === text(position.strategy_id) &&
        text(row.family_member_id) === text(position.family_member_id),
    ) ?? {}) as Row;
    const usedTransactions = new Set(positionHoldings.map((row) => text(row.transactionId)).filter(Boolean));
    const reserveCents = [...usedTransactions].reduce((sum, id) => {
      const transaction = transactionMap.get(id);
      if (!transaction || transaction.status !== "posted" || transaction.reversed === true) return sum;
      return sum + Math.max(0, num(transaction.buffer_cents) - num(transaction.buffer_consumed_cents));
    }, 0);
    const liabilityCents = (fees ?? [])
      .filter(
        (row) =>
          text(row.strategy_id) === text(position.strategy_id) &&
          text(row.family_member_id) === text(position.family_member_id),
      )
      .reduce((sum, row) => sum + num(row.accrued_fee_cents), 0);
    const residualCents = num(residual.balance_cents);
    const canonicalValueCents = num(position.basket_value_cents);
    const canonicalPnlCents = num(position.inception_pnl_cents);
    const calculated = calculatePositionTruth({
      securitiesCents,
      residualCents,
      reserveCents,
      liabilityCents,
      canonicalValueCents,
      canonicalPnlCents,
    });
    const positionHistory = ((history ?? []) as Row[]).filter(
      (row) =>
        text(row.strategy_id) === text(position.strategy_id) &&
        text(row.family_member_id) === text(position.family_member_id),
    );
    const latestHistory = positionHistory.at(-1);
    const latestYear = text(latestHistory?.as_of_date).slice(0, 4);
    const ytdHistory = positionHistory.filter((row) => text(row.as_of_date).startsWith(latestYear));
    const expectedYtdDates = ((strategyHistory ?? []) as Row[])
      .filter(
        (row) =>
          text(row.strategy_id) === text(position.strategy_id) &&
          text(row.as_of_date).startsWith(latestYear),
      )
      .map((row) => text(row.as_of_date));
    const returnChainAudit = auditReturnChain(
      ytdHistory.map((row, index) => ({
        date: text(row.as_of_date),
        anchorPct: index === 0 ? nullableNumber(row.ytd_pct) : null,
        dailyPct: nullableNumber(row["1d_pct"]),
      })),
      expectedYtdDates,
    );
    const independentYtdPct = returnChainAudit.returnPct;
    const storedYtdPct = nullableNumber(latestHistory?.ytd_pct);
    const ytdDifferencePp =
      independentYtdPct == null || storedYtdPct == null ? null : independentYtdPct - storedYtdPct;
    const ytdStatus = classifyPercentageDifference(ytdDifferencePp);
    const hasAllPreviousCloses = positionHoldings.every((row) => row.previousCloseCents != null);
    const previousSecuritiesCents = hasAllPreviousCloses
      ? positionHoldings.reduce(
          (sum, row) => sum + Math.round(row.quantity * Number(row.previousCloseCents)),
          0,
        )
      : null;
    const todayStrategyPnlCents = hasAllPreviousCloses
      ? positionHoldings.reduce((sum, row) => sum + Number(row.todayPnlCents ?? 0), 0)
      : null;
    const todayStrategyPct =
      previousSecuritiesCents && todayStrategyPnlCents != null
        ? (todayStrategyPnlCents / previousSecuritiesCents) * 100
        : null;
    const iressHoldingStatus = positionHoldings.some((row) => row.iress.status === "urgent")
      ? "urgent"
      : positionHoldings.some((row) => row.iress.status === "warning")
        ? "warning"
        : "ok";
    const rebalanceDiagnostics = ((rebalanceBatches ?? []) as Row[])
      .filter((batch) => text(batch.strategy_id) === text(position.strategy_id))
      .map((batch) => {
        const date = text(batch.settled_at || batch.effective_date || batch.created_at).slice(0, 10);
        const index = positionHistory.findIndex((row) => text(row.as_of_date) >= date);
        const before = index > 0 ? positionHistory[index - 1] : null;
        const after = index >= 0 ? positionHistory[index] : null;
        const beforeValue = before == null ? null : num(before.basket_value_cents);
        const afterValue = after == null ? null : num(after.basket_value_cents);
        const rawNavChangePct =
          beforeValue && afterValue != null ? (afterValue / beforeValue - 1) * 100 : null;
        const canonicalDailyPct = after?.["1d_pct"] == null ? null : num(after["1d_pct"]);
        return {
          id: batch.id,
          date,
          status: batch.status,
          settlementState: batch.settlement_state,
          beforeValueCents: beforeValue,
          afterValueCents: afterValue,
          rawNavChangePct,
          canonicalDailyPct,
          canonicalYtdPct: after?.ytd_pct == null ? null : num(after.ytd_pct),
          neutralisedDifferencePp:
            rawNavChangePct == null || canonicalDailyPct == null
              ? null
              : rawNavChangePct - canonicalDailyPct,
          protected:
            text(batch.status).toUpperCase() === "SETTLED" &&
            text(batch.settlement_state).toUpperCase() === "COMPLETE" &&
            canonicalDailyPct != null,
        };
      });
    const quoteTime = positionHoldings
      .map((row) => row.quote.exchangeTime)
      .sort()
      .at(-1) ?? `${text(position.as_of_date)}T23:59:59Z`;
    const valuationComparison = classifyValuationComparison({
      differenceCents: calculated.differenceCents,
      baselineCents: canonicalValueCents,
      canonicalAsOf: text(position.as_of_date),
      quoteTime,
    });
    const valueSeverity = valuationComparison.severity;
    const severity = [valueSeverity, ytdStatus, iressHoldingStatus].includes("urgent")
      ? "urgent"
      : [valueSeverity, ytdStatus, iressHoldingStatus].includes("warning")
        ? "warning"
        : "ok";
    const reasons = possibleDifferenceReasons({
      differenceCents: calculated.differenceCents,
      canonicalAsOf: text(position.as_of_date),
      quoteTime,
      residualUpdatedAt: text(residual.updated_at),
      hasReserve: reserveCents > 0,
      hasLiability: liabilityCents > 0,
    });
    return {
      key,
      strategyId: position.strategy_id,
      strategy:
        stratMap.get(text(position.strategy_id))?.short_name ||
        stratMap.get(text(position.strategy_id))?.name,
      familyMemberId: position.family_member_id,
      asOf: position.as_of_date,
      holdings: positionHoldings,
      securitiesCents,
      residualCents,
      residualUpdatedAt: residual.updated_at,
      reserveCents,
      liabilityCents,
      ...calculated,
      valuationComparison,
      canonicalValueCents,
      canonicalPnlCents,
      appDisplayedValueCents: canonicalValueCents,
      appDisplayedPnlCents: canonicalPnlCents,
      severity,
      reasons,
      returns: periodReturns(positionHistory),
      performance: {
        definition: "Client strategy movement from entry; cash flows and rebalances neutralised; fees excluded",
        storedYtdPct,
        independentYtdPct,
        ytdDifferencePp,
        ytdStatus,
        returnChainAudit,
        performancePnlCents: canonicalPnlCents,
        openingPerformanceNavCents: num(position.opening_performance_nav_cents),
        previousSecuritiesCents,
        todayStrategyPnlCents,
        todayStrategyPct,
        feeTreatment: "Fees affect withdrawable value only and are excluded from the performance chain",
        iressStatus: iressHoldingStatus,
        iressMode: iressBody?.iressMode ?? (iressCoverage.ok ? "unknown" : iressCoverage.code),
        iressCovered: positionHoldings.filter((row) => row.iress.available).length,
        iressRequested: positionHoldings.length,
        iressProbedAt: iressBody?.probedAt ?? null,
      },
      rebalanceDiagnostics,
      history: positionHistory.map((row) => ({
        date: row.as_of_date,
        valueCents: row.basket_value_cents,
        securitiesCents: row.securities_value_cents,
        residualCents: row.residual_cash_cents,
        reserveCents: row.unused_reserve_cents,
        pnlCents: row.inception_pnl_cents,
        ytdPct: row.ytd_pct,
        allTimePct: row.inception_pct,
        dailyPct: row["1d_pct"],
        source: row.source_kind,
        reconstructionProvable:
          row.securities_value_cents != null &&
          row.residual_cash_cents != null &&
          row.unused_reserve_cents != null &&
          row.accrued_liability_cents != null,
        reconstructedCents: reconstructClientHistoryPoint({
          securitiesCents: row.securities_value_cents == null ? null : num(row.securities_value_cents),
          residualCents: row.residual_cash_cents == null ? null : num(row.residual_cash_cents),
          reserveCents: row.unused_reserve_cents == null ? null : num(row.unused_reserve_cents),
          liabilityCents: row.accrued_liability_cents == null ? null : num(row.accrued_liability_cents),
        }),
      })),
      rawHistory: ((rawHistory ?? []) as Row[])
        .filter((row) => text(row.strategy_id) === text(position.strategy_id))
        .map((row) => ({
          date: row.as_of_date,
          valueCents: row.basket_value,
          dailyPnlCents: row["1d_pnl"],
          ytdPnlCents: row.ytd_pnl,
        })),
      ledger: [
        {
          cell: "B2",
          label: "Yahoo-priced securities",
          formula: "SUM(quantity * YahooPrice)",
          cents: securitiesCents,
        },
        { cell: "B3", label: "Strategy residual / CA", formula: "ResidualBalance", cents: residualCents },
        {
          cell: "B4",
          label: "Unused execution reserve",
          formula: "SUM(Buffer-Consumed)",
          cents: reserveCents,
        },
        { cell: "B5", label: "Accrued liabilities", formula: "SUM(OpenFees)", cents: liabilityCents },
        {
          cell: "B6",
          label: "Independent live value",
          formula: "=B2+B3+B4-B5",
          cents: calculated.liveValueCents,
        },
        {
          cell: "B7",
          label: "Invested basis",
          formula: "=AppValue-AppInceptionPnL",
          cents: calculated.investedCents,
        },
        { cell: "B8", label: "Independent live P&L", formula: "=B6-B7", cents: calculated.livePnlCents },
        {
          cell: "B9",
          label: "Difference vs app",
          formula: "=B6-AppValue",
          cents: calculated.differenceCents,
        },
      ],
      formula: "Yahoo securities + residual + unused reserve − accrued liability",
    };
  });
  return {
    kind: "client" as const,
    generatedAt: new Date().toISOString(),
    provider: "Yahoo Finance live chart API",
    pricingSnapshot: await quoteSnapshotEvidence(snapshot),
    profile,
    positions: byPosition,
    strategyBenchmarks: Object.fromEntries(
      [...strategyBenchmarks].map(([id, row]) => [
        id,
        {
          asOf: row.as_of_date,
          ytdPct: row.ytd_pct,
          allTimePct: row.all_pct,
          caCents: row.continuity_cash_cents,
          completeValueCents: row.complete_value_cents,
        },
      ]),
    ),
    strategyModelHistory: Object.fromEntries(
      strategyIds.map((id) => [
        id,
        ((strategyHistory ?? []) as Row[])
          .filter((row) => text(row.strategy_id) === id)
          .reverse()
          .map((row) => ({
            date: row.as_of_date,
            valueCents: row.complete_value_cents,
            securitiesCents: row.securities_value_cents,
            caCents: row.continuity_cash_cents,
            ytdPct: row.ytd_pct,
            allTimePct: row.all_pct,
            dailyPct: row["1d_pct"],
            reconstructionProvable: row.securities_value_cents != null && row.continuity_cash_cents != null,
            reconstructedCents: reconstructStrategyHistoryPoint(
              row.securities_value_cents == null ? null : num(row.securities_value_cents),
              row.continuity_cash_cents == null ? null : num(row.continuity_cash_cents),
            ),
          })),
      ]),
    ),
    rawStrategyHistory: Object.fromEntries(
      strategyIds.map((id) => [
        id,
        ((rawStrategyHistory ?? []) as Row[])
          .filter((row) => text(row.strategy_id) === id)
          .map((row) => ({
            date: row.as_of_date,
            valueCents: row.basket_value,
            ytdPct: row.ytd_pct,
          })),
      ]),
    ),
    rebalances: (rebalanceBatches ?? []).map((batch) => {
      const events = (rebalanceEvents ?? []).filter((event) => text(event.batch_id) === text(batch.id));
      return {
        id: batch.id,
        strategyId: batch.strategy_id,
        strategy: batch.strategy_name_snapshot,
        date: batch.settled_at || batch.effective_date || batch.created_at,
        status: batch.status,
        settlementState: batch.settlement_state,
        reversedAt: batch.reversed_at,
        reversedReason: batch.reversed_reason,
        events: events.map((event) => ({
          id: event.id,
          date: event.fill_date || event.created_at,
          side: event.trade_side,
          securityId: event.security_id,
          quantity: event.quantity,
          priceCents: event.avg_fill || event.price_at_commit,
          reason: event.closed_reason,
        })),
      };
    }),
    activity: (activity ?? []).map((row) => ({
      id: row.id,
      date: row.transaction_date || row.created_at,
      direction: row.direction,
      name: row.name,
      description: row.description,
      status: row.status,
      amountCents: row.base_amount_cents ?? row.amount,
      reserveCents: row.buffer_cents,
      reserveConsumedCents: row.buffer_consumed_cents,
      reversed: row.reversed,
    })),
    audit: {
      severity: byPosition.some((row) => row.severity === "urgent")
        ? "urgent"
        : byPosition.some((row) => row.severity === "warning")
          ? "warning"
          : "ok",
      urgent: byPosition.filter((row) => row.severity === "urgent").length,
      warnings: byPosition.filter((row) => row.severity === "warning").length,
    },
    totals: {
      securitiesCents: byPosition.reduce((sum, row) => sum + row.securitiesCents, 0),
      residualCents: byPosition.reduce((sum, row) => sum + row.residualCents, 0),
      reserveCents: byPosition.reduce((sum, row) => sum + row.reserveCents, 0),
      liabilityCents: byPosition.reduce((sum, row) => sum + row.liabilityCents, 0),
      liveValueCents: byPosition.reduce((sum, row) => sum + row.liveValueCents, 0),
      investedCents: byPosition.reduce((sum, row) => sum + row.investedCents, 0),
      livePnlCents: byPosition.reduce((sum, row) => sum + row.livePnlCents, 0),
    },
  };
}

async function strategyTruth(db: Db, strategyId: string, snapshot: QuoteSnapshot = createQuoteSnapshot()) {
  const { data: strategy } = await db
    .from("strategies_c")
    .select("id,name,short_name,min_investment,holdings,updated_at")
    .eq("id", strategyId)
    .maybeSingle();
  if (!strategy) throw new Error("Strategy not found");
  const holdings = Array.isArray(strategy.holdings) ? (strategy.holdings as Row[]) : [];
  const symbols = holdings.map((row) => text(row.ticker || row.symbol)).filter(Boolean);
  const quotes = await quoteMap(symbols, snapshot);
  const rows = holdings.map((holding) => {
    const symbol = text(holding.ticker || holding.symbol);
    const quote = requiredQuote(quotes, symbol);
    const quantity = num(holding.shares || holding.quantity || 1);
    return {
      symbol,
      name: holding.name,
      quantity,
      livePriceCents: quote.priceCents,
      marketValueCents: Math.round(quantity * quote.priceCents),
      quote,
      formula: `${quantity} × ${quote.priceCents} cents`,
    };
  });
  const securitiesCents = rows.reduce((sum, row) => sum + row.marketValueCents, 0);
  const { data: canonicalHistory } = await db
    .from("strategy_returns_effective_c")
    .select(
      'as_of_date,securities_value_cents,continuity_cash_cents,complete_value_cents,basket_value_cents,ytd_pct,all_pct,"1d_pct",source_kind',
    )
    .eq("strategy_id", strategyId)
    .order("as_of_date", { ascending: false })
    .limit(1000);
  const [{ data: rawHistory }, { data: rebalances }] = await Promise.all([
    db
      .from("strategies_returns_c")
      .select("strategy_id,as_of_date,basket_value,ytd_pct")
      .eq("strategy_id", strategyId)
      .order("as_of_date", { ascending: true })
      .limit(1000),
    db
      .from("rebalance_batch")
      .select(
        "id,strategy_id,status,settlement_state,effective_date,strategy_name_snapshot,created_at,settled_at,reversed_at,reversed_reason",
      )
      .eq("strategy_id", strategyId)
      .order("created_at", { ascending: true }),
  ]);
  const canonical = canonicalHistory?.[0];
  if (canonical?.continuity_cash_cents == null) {
    throw new Error("Live truth blocked—strategy CA is not published in the canonical model ledger");
  }
  const cash = calculateStrategyLiveValue(securitiesCents, num(canonical.continuity_cash_cents));
  const differences = {
    securitiesCents: securitiesCents - num(canonical?.securities_value_cents),
    caCents: cash.strategyCaCents - num(canonical?.continuity_cash_cents),
    completeCents: cash.modelCapitalCents - num(canonical?.complete_value_cents),
  };
  const quoteTime = rows.map((row) => row.quote.exchangeTime).sort().at(-1);
  const valuationComparison = classifyValuationComparison({
    differenceCents: differences.completeCents,
    baselineCents: num(canonical?.complete_value_cents),
    canonicalAsOf: text(canonical?.as_of_date),
    quoteTime,
  });
  const canonicalAscending = [...(canonicalHistory ?? [])].reverse() as Row[];
  const latestYear = text(canonicalAscending.at(-1)?.as_of_date).slice(0, 4);
  const ytdHistory = canonicalAscending.filter((row) => text(row.as_of_date).startsWith(latestYear));
  const returnChainAudit = auditReturnChain(
    ytdHistory.map((row, index) => ({
      date: text(row.as_of_date),
      anchorPct: index === 0 ? nullableNumber(row.ytd_pct) : null,
      dailyPct: nullableNumber(row["1d_pct"]),
    })),
  );
  const storedYtdPct = nullableNumber(canonical?.ytd_pct);
  const ytdDifferencePp =
    returnChainAudit.returnPct == null || storedYtdPct == null
      ? null
      : returnChainAudit.returnPct - storedYtdPct;
  const ytdStatus = classifyPercentageDifference(ytdDifferencePp);
  const severity =
    valuationComparison.severity === "urgent" || ytdStatus === "urgent"
      ? "urgent"
      : valuationComparison.severity === "warning" || ytdStatus === "warning"
        ? "warning"
        : "ok";
  return {
    kind: "strategy" as const,
    generatedAt: new Date().toISOString(),
    provider: "Yahoo Finance live chart API",
    pricingSnapshot: await quoteSnapshotEvidence(snapshot),
    strategy,
    holdings: rows,
    live: {
      securitiesCents,
      ...cash,
      formula: "live value of fixed model quantities + attributable canonical strategy CA",
    },
    canonical,
    differences,
    valuationComparison,
    returnChainAudit,
    storedYtdPct,
    rebuiltYtdPct: returnChainAudit.returnPct,
    ytdDifferencePp,
    ytdStatus,
    severity,
    reasons: possibleDifferenceReasons({
      differenceCents: differences.completeCents,
      canonicalAsOf: text(canonical?.as_of_date),
      quoteTime,
      hasReserve: false,
      hasLiability: false,
    }),
    returns: periodReturns(canonicalAscending),
    history: [...(canonicalHistory ?? [])].reverse().map((row) => ({
      date: row.as_of_date,
      valueCents: row.complete_value_cents || row.basket_value_cents,
      securitiesCents: row.securities_value_cents,
      caCents: row.continuity_cash_cents,
      ytdPct: row.ytd_pct,
      allTimePct: row.all_pct,
      dailyPct: row["1d_pct"],
      source: row.source_kind,
      reconstructionProvable: row.securities_value_cents != null && row.continuity_cash_cents != null,
      reconstructedCents: reconstructStrategyHistoryPoint(
        row.securities_value_cents == null ? null : num(row.securities_value_cents),
        row.continuity_cash_cents == null ? null : num(row.continuity_cash_cents),
      ),
    })),
    rawHistory: (rawHistory ?? []).map((row) => ({
      date: row.as_of_date,
      valueCents: row.basket_value,
      ytdPct: row.ytd_pct,
    })),
    rebalances: (rebalances ?? []).map((batch) => ({
      id: batch.id,
      strategyId: batch.strategy_id,
      strategy: batch.strategy_name_snapshot,
      date: batch.settled_at || batch.effective_date || batch.created_at,
      status: batch.status,
      settlementState: batch.settlement_state,
      reversedAt: batch.reversed_at,
      reversedReason: batch.reversed_reason,
    })),
  };
}

async function generalTruth(db: Db) {
  const truthIndex = await listTruth(db);
  const snapshot = createQuoteSnapshot();
  const clientIds = [...new Set(truthIndex.positions.map((row) => text(row.userId)))];
  const startedAt = new Date().toISOString();
  const clientRuns = await Promise.allSettled(clientIds.map((id) => clientTruth(db, id, snapshot)));
  const strategyRuns = await Promise.allSettled(
    truthIndex.strategies.map((row) => strategyTruth(db, text(row.id), snapshot)),
  );
  const findings = [
    ...clientRuns.map((run, position) =>
      run.status === "fulfilled"
        ? {
            kind: "client",
            id: clientIds[position],
            label: run.value.profile.email || clientIds[position],
            severity: run.value.audit.severity,
            differenceCents: run.value.positions.reduce((sum, row) => sum + Math.abs(row.differenceCents), 0),
            message: `${run.value.audit.urgent} urgent and ${run.value.audit.warnings} warning position(s)`,
          }
        : {
            kind: "client",
            id: clientIds[position],
            label: clientIds[position],
            severity: "urgent",
            differenceCents: 0,
            message: run.reason instanceof Error ? run.reason.message : String(run.reason),
          },
    ),
    ...strategyRuns.map((run, position) =>
      run.status === "fulfilled"
        ? {
            kind: "strategy",
            id: truthIndex.strategies[position]?.id,
            label: truthIndex.strategies[position]?.name,
            severity: run.value.severity,
            differenceCents: Math.abs(run.value.differences.completeCents),
            message: run.value.reasons[0],
          }
        : {
            kind: "strategy",
            id: truthIndex.strategies[position]?.id,
            label: truthIndex.strategies[position]?.name,
            severity: "urgent",
            differenceCents: 0,
            message: run.reason instanceof Error ? run.reason.message : String(run.reason),
          },
    ),
  ];
  return {
    kind: "general" as const,
    startedAt,
    generatedAt: new Date().toISOString(),
    auditedClients: clientIds.length,
    auditedStrategies: truthIndex.strategies.length,
    pricingSnapshot: await quoteSnapshotEvidence(snapshot),
    findings,
    summary: {
      urgent: findings.filter((row) => row.severity === "urgent").length,
      warning: findings.filter((row) => row.severity === "warning").length,
      ok: findings.filter((row) => row.severity === "ok").length,
    },
  };
}

async function probeJson(
  req: Request,
  path: string,
): Promise<{ ok: boolean; status: number; latencyMs: number; body: Row; error?: string }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(new URL(path, req.url), {
      cache: "no-store",
      signal: controller.signal,
      headers: { cookie: req.headers.get("cookie") ?? "" },
    });
    const body = (await response.json().catch(() => ({}))) as Row;
    return { ok: response.ok, status: response.status, latencyMs: Date.now() - started, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      body: {},
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function issueClientAuditToken(email: string) {
  if (!email) return { token: null, userId: null, error: "Client email is unavailable" };
  try {
    const db = createRetailServiceRoleClient();
    const { data: link, error: linkError } = await db.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    const tokenHash = (
      link as { properties?: { hashed_token?: string } } | null
    )?.properties?.hashed_token;
    if (linkError || !tokenHash) {
      return {
        token: null,
        userId: null,
        error: linkError?.message || "Could not create an audit session",
      };
    }
    const { data: verified, error: verifyError } = await db.auth.verifyOtp({
      token_hash: tokenHash,
      type: "magiclink",
    });
    return {
      token: verified.session?.access_token ?? null,
      userId: verified.user?.id ?? null,
      error: verifyError?.message,
    };
  } catch (error) {
    return {
      token: null,
      userId: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeClientDeployment(
  baseUrl: string | undefined,
  path: string,
  accessToken: string | null,
  authError?: string,
) {
  if (!baseUrl) {
    return {
      ok: false,
      status: 0,
      latencyMs: 0,
      body: {} as Row,
      error: "Deployment URL is not configured",
    };
  }
  if (!accessToken) {
    return {
      ok: false,
      status: 0,
      latencyMs: 0,
      body: {} as Row,
      error: authError || "Could not create the read-only client audit session",
    };
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(new URL(path, baseUrl), {
      cache: "no-store",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json().catch(() => ({}))) as Row;
    return { ok: response.ok, status: response.status, latencyMs: Date.now() - started, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      latencyMs: Date.now() - started,
      body: {} as Row,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function auditSurfaces(
  req: Request,
  truth: Awaited<
    ReturnType<typeof clientTruth> | ReturnType<typeof strategyTruth> | ReturnType<typeof generalTruth>
  >,
): Promise<SurfaceCheck[]> {
  const strategyId =
    truth.kind === "strategy"
      ? text(truth.strategy.id)
      : truth.kind === "client"
        ? text(truth.positions[0]?.strategyId)
        : "";
  const clientId = truth.kind === "client" ? text(truth.profile.id) : "";
  const factsheetPath = strategyId
    ? `/api/admin/factsheets?action=detail&id=${encodeURIComponent(strategyId)}`
    : "/api/admin/factsheets?action=list";
  // The Mint home carousel is fed by this authenticated retail endpoint.
  // `/api/overall-portfolio` belongs to OEM and must never be probed on Mint.
  const clientFamilyMemberId =
    truth.kind === "client" ? text(truth.positions[0]?.familyMemberId) : "";
  const clientCardPath = clientId
    ? `/api/user/strategies${
        clientFamilyMemberId
          ? `?familyMemberId=${encodeURIComponent(clientFamilyMemberId)}`
          : ""
      }`
    : "";
  const clientAuditSession =
    truth.kind === "client"
      ? await issueClientAuditToken(text(truth.profile.email))
      : { token: null, userId: null, error: undefined };
  if (
    truth.kind === "client" &&
    clientAuditSession.userId &&
    clientAuditSession.userId !== clientId
  ) {
    clientAuditSession.token = null;
    clientAuditSession.error = `Audit session resolved to ${clientAuditSession.userId}, expected ${clientId}`;
  }
  const [strategyPage, factsheet, investors, iress, devClientCard, liveClientCard] = await Promise.all([
    probeJson(req, "/api/strategies?part=core"),
    probeJson(req, factsheetPath),
    probeJson(req, "/api/admin/investors/data"),
    probeJson(req, "/api/iress/health"),
    clientCardPath
      ? probeClientDeployment(
          process.env.MINT_APP_URL_DEV,
          clientCardPath,
          clientAuditSession.token,
          clientAuditSession.error,
        )
      : Promise.resolve(null),
    clientCardPath
      ? probeClientDeployment(
          process.env.MINT_APP_URL_LIVE,
          clientCardPath,
          clientAuditSession.token,
          clientAuditSession.error,
        )
      : Promise.resolve(null),
  ]);
  const checks: SurfaceCheck[] = [];
  const strategyRows = Array.isArray(strategyPage.body.strategies)
    ? (strategyPage.body.strategies as Row[])
    : [];
  const strategyPageRow = strategyRows.find((row) => text(row.id) === strategyId);
  const strategyVisible = !strategyId || Boolean(strategyPageRow);
  const clientStrategyBenchmark =
    truth.kind === "client" ? ((truth.strategyBenchmarks[strategyId] ?? {}) as Row) : null;
  const expectedStrategyYtd =
    truth.kind === "strategy"
      ? nullableNumber(truth.canonical?.ytd_pct)
      : truth.kind === "client"
        ? nullableNumber(clientStrategyBenchmark?.ytdPct)
        : null;
  const expectedClientYtd =
    truth.kind === "client" ? nullableNumber(truth.positions[0]?.returns.ytdPct) : null;
  const returnScopes = returnScopeBenchmarks(expectedClientYtd, expectedStrategyYtd);
  const strategyYtdDifference =
    returnScopes.strategyPageExpectedYtd == null || !strategyPageRow
      ? null
      : nullableNumber(strategyPageRow.ytd) == null
        ? null
        : Number(nullableNumber(strategyPageRow.ytd)) - returnScopes.strategyPageExpectedYtd;
  const strategyValueMismatch = strategyYtdDifference != null && Math.abs(strategyYtdDifference) > 0.01;
  const strategyValueCritical = strategyYtdDifference != null && Math.abs(strategyYtdDifference) > 0.25;
  checks.push({
    surface: "Strategy page",
    status:
      !strategyPage.ok || !strategyVisible || strategyValueCritical
        ? "urgent"
        : strategyValueMismatch || strategyPage.latencyMs > 10_000
          ? "warning"
          : "ok",
    latencyMs: strategyPage.latencyMs,
    actual: strategyPage.ok
      ? `${strategyRows.length} strategy records; source ${text(strategyPage.body.source) || "unknown"}`
      : `HTTP ${strategyPage.status}`,
    expected: strategyId
      ? `Strategy ${strategyId} must be present with canonical return and CA inputs`
      : "All live strategies must load",
    difference: !strategyVisible
      ? "Selected strategy is absent from the page API"
      : strategyValueMismatch
        ? `Page YTD differs from canonical by ${strategyYtdDifference?.toFixed(4)} percentage points`
        : "Selected strategy and YTD agree with the effective canonical contract",
    evidence: [
      "endpoint=/api/strategies?part=core",
      `selected_strategy_present=${strategyVisible}`,
      `page_ytd=${strategyPageRow?.ytd ?? "n/a"}`,
      `expected_strategy_ytd=${expectedStrategyYtd ?? "n/a"}`,
      `latency_ms=${strategyPage.latencyMs}`,
      ...(strategyPage.error ? [`error=${strategyPage.error}`] : []),
    ],
    comparisons: [
      comparison(
        "Model strategy YTD",
        strategyPageRow ? nullableNumber(strategyPageRow.ytd) : null,
        returnScopes.strategyPageExpectedYtd,
        "percent",
      ),
    ],
  });
  const factsheetOk = factsheet.ok && factsheet.body.ok !== false;
  const factsheetStrategy = factsheet.body.strategy as Row | undefined;
  const factsheetVisible = !strategyId || text(factsheetStrategy?.id) === strategyId;
  const factsheetReturns = Array.isArray(factsheet.body.returns) ? (factsheet.body.returns as Row[]) : [];
  const factsheetLatest = factsheetReturns.at(-1);
  const factsheetYtdDifference =
    returnScopes.factsheetExpectedYtd == null || !factsheetLatest
      ? null
      : nullableNumber(factsheetLatest.ytd_pct) == null
        ? null
        : Number(nullableNumber(factsheetLatest.ytd_pct)) - returnScopes.factsheetExpectedYtd;
  const expectedStrategyCa =
    truth.kind === "strategy"
      ? nullableNumber(truth.canonical?.continuity_cash_cents)
      : truth.kind === "client"
        ? nullableNumber(clientStrategyBenchmark?.caCents)
        : null;
  const factsheetCash = factsheet.body.cashAsset as Row | undefined;
  const factsheetCaCents = factsheetCash ? num(factsheetCash.value) * 100 : null;
  const factsheetCaMissing =
    expectedStrategyCa != null && expectedStrategyCa > 0 && factsheetCaCents == null;
  const factsheetValueMismatch =
    (factsheetYtdDifference != null && Math.abs(factsheetYtdDifference) > 0.01) ||
    factsheetCaMissing ||
    (expectedStrategyCa != null &&
      factsheetCaCents != null &&
      Math.abs(factsheetCaCents - expectedStrategyCa) > 1);
  const factsheetValueCritical =
    (factsheetYtdDifference != null && Math.abs(factsheetYtdDifference) > 0.25) ||
    factsheetCaMissing ||
    (expectedStrategyCa != null &&
      factsheetCaCents != null &&
      Math.abs(factsheetCaCents - expectedStrategyCa) > Math.max(100, Math.abs(expectedStrategyCa) * 0.0025));
  checks.push({
    surface: "Factsheet",
    status:
      !factsheetOk || !factsheetVisible || factsheetValueCritical
        ? "urgent"
        : factsheetValueMismatch || factsheet.latencyMs > 10_000
          ? "warning"
          : "ok",
    latencyMs: factsheet.latencyMs,
    actual: factsheetOk
      ? strategyId
        ? `Strategy ${text(factsheetStrategy?.id)}; ${(factsheet.body.returns as unknown[] | undefined)?.length ?? 0} canonical history rows`
        : `${(factsheet.body.strategies as unknown[] | undefined)?.length ?? 0} strategies`
      : `HTTP ${factsheet.status}`,
    expected: "Effective canonical return history, strategy CA, securities and real investors",
    difference: !factsheetVisible
      ? "Selected strategy detail is missing"
      : factsheetValueMismatch
        ? `Mismatch: YTD delta ${factsheetYtdDifference?.toFixed(4) ?? "n/a"} pp; CA delta ${
            factsheetCaMissing
              ? "missing from factsheet"
              : expectedStrategyCa == null || factsheetCaCents == null
                ? "n/a"
              : moneyText(factsheetCaCents - expectedStrategyCa)
          }`
        : "Factsheet YTD and strategy CA agree with canonical truth",
    evidence: [
      `endpoint=${factsheetPath}`,
      `selected_strategy_present=${factsheetVisible}`,
      `cash_asset_present=${Boolean(factsheet.body.cashAsset)}`,
      `factsheet_ytd=${factsheetLatest?.ytd_pct ?? "n/a"}`,
      `expected_strategy_ytd=${expectedStrategyYtd ?? "n/a"}`,
      `factsheet_ca_cents=${factsheetCaCents ?? "n/a"}`,
      `expected_ca_cents=${expectedStrategyCa ?? "n/a"}`,
      `latency_ms=${factsheet.latencyMs}`,
      ...(factsheet.error ? [`error=${factsheet.error}`] : []),
    ],
    comparisons: [
      comparison(
        "Model strategy YTD",
        factsheetLatest ? nullableNumber(factsheetLatest.ytd_pct) : null,
        returnScopes.factsheetExpectedYtd,
        "percent",
      ),
      comparison("Strategy CA", factsheetCaCents, expectedStrategyCa, "cents"),
    ],
  });
  const investorHoldings = Array.isArray(investors.body.holdings) ? (investors.body.holdings as Row[]) : [];
  const investorVisible = !clientId || investorHoldings.some((row) => text(row.user_id) === clientId);
  const investorHistory = Array.isArray(investors.body.stratHist)
    ? (investors.body.stratHist as Row[]).filter(
        (row) =>
          (!clientId || text(row.user_id) === clientId) &&
          (!strategyId || text(row.strategy_id) === strategyId),
      )
    : [];
  const investorLatest = investorHistory
    .sort((a, b) => text(a.as_of_date).localeCompare(text(b.as_of_date)))
    .at(-1);
  const expectedClientValue = truth.kind === "client" ? num(truth.positions[0]?.canonicalValueCents) : null;
  const investorValueDifference =
    expectedClientValue == null || !investorLatest
      ? null
      : num(investorLatest.basket_value_cents ?? investorLatest.basket_value) - expectedClientValue;
  const investorValueMismatch = investorValueDifference != null && Math.abs(investorValueDifference) > 1;
  const investorYtdDifference =
    returnScopes.investorsExpectedYtd == null || !investorLatest
      ? null
      : nullableNumber(investorLatest.ytd_pct) == null
        ? null
        : Number(nullableNumber(investorLatest.ytd_pct)) - returnScopes.investorsExpectedYtd;
  const investorYtdMismatch = investorYtdDifference != null && Math.abs(investorYtdDifference) > 0.01;
  const investorCritical =
    (investorValueDifference != null &&
      Math.abs(investorValueDifference) > Math.max(100, Math.abs(expectedClientValue ?? 0) * 0.0025)) ||
    (investorYtdDifference != null && Math.abs(investorYtdDifference) > 0.25);
  checks.push({
    surface: "Investors",
    status:
      !investors.ok || !investorVisible || investorCritical
        ? "urgent"
        : investorValueMismatch || investorYtdMismatch || investors.latencyMs > 10_000
          ? "warning"
          : "ok",
    latencyMs: investors.latencyMs,
    actual: investors.ok
      ? `${investorHoldings.length} active holding rows; ${(investors.body.stratHist as unknown[] | undefined)?.length ?? 0} canonical history rows`
      : `HTTP ${investors.status}`,
    expected: clientId
      ? `Client ${clientId} holdings and effective return history must be present`
      : "All real invested clients must load",
    difference: !investorVisible
      ? "Selected client is absent from Investors data"
      : investorValueMismatch || investorYtdMismatch
        ? `Investors differs: value ${moneyText(investorValueDifference ?? 0)}; personal YTD ${
            investorYtdDifference?.toFixed(4) ?? "n/a"
          } pp`
        : "Selected client value agrees with canonical truth",
    evidence: [
      "endpoint=/api/admin/investors/data",
      `selected_client_present=${investorVisible}`,
      `investors_value_cents=${investorLatest?.basket_value_cents ?? investorLatest?.basket_value ?? "n/a"}`,
      `expected_value_cents=${expectedClientValue ?? "n/a"}`,
      `investors_personal_ytd=${investorLatest?.ytd_pct ?? "n/a"}`,
      `expected_client_ytd=${expectedClientYtd ?? "n/a"}`,
      `latency_ms=${investors.latencyMs}`,
      ...(investors.error ? [`error=${investors.error}`] : []),
    ],
    comparisons: [
      comparison(
        "Client basket value",
        investorLatest ? num(investorLatest.basket_value_cents ?? investorLatest.basket_value) : null,
        expectedClientValue,
        "cents",
      ),
      comparison(
        "Client personal YTD",
        investorLatest ? nullableNumber(investorLatest.ytd_pct) : null,
        returnScopes.investorsExpectedYtd,
        "percent",
      ),
    ],
  });
  if (truth.kind === "client" && strategyId && truth.positions[0]) {
    const expectedPosition = truth.positions[0];
    const appendClientCardCheck = (
      label: "DEV" | "LIVE",
      probe: NonNullable<typeof devClientCard>,
      configuredUrl: string | undefined,
    ) => {
      const nestedData = (probe.body.data ?? {}) as Row;
      const nestedPortfolio = (probe.body.portfolio ?? {}) as Row;
      const cardRows = Array.isArray(probe.body.strategies)
        ? (probe.body.strategies as Row[])
        : Array.isArray(nestedData.strategies)
          ? (nestedData.strategies as Row[])
          : Array.isArray(nestedPortfolio.strategies)
            ? (nestedPortfolio.strategies as Row[])
            : [];
      const card = cardRows.find(
        (row) => text(row.strategyId || row.strategy_id || row.id) === strategyId,
      );
      const cardValueRands = card
        ? num(
            card.currentMarketValue ??
              card.currentValue ??
              card.current_value ??
              card.basketValue ??
              card.basket_value,
          )
        : null;
      const cardInvestedRands = card
        ? num(card.investedAmount ?? card.invested_amount ?? card.invested)
        : null;
      const cardResidualRands = card
        ? num(card.residualCash ?? card.residual_cash ?? card.residual)
        : null;
      const cardReserveRands = card
        ? num(card.reserveCash ?? card.reserve_cash ?? card.reserve)
        : null;
      const cardReturnPct =
        cardValueRands != null && cardInvestedRands != null && cardInvestedRands > 0
          ? ((cardValueRands - cardInvestedRands) / cardInvestedRands) * 100
          : null;
      const expectedReturnPct =
        expectedPosition.investedCents > 0
          ? (expectedPosition.canonicalPnlCents / expectedPosition.investedCents) * 100
          : null;
      const valueComparison = comparison(
        "Client card current value",
        cardValueRands == null ? null : Math.round(cardValueRands * 100),
        expectedPosition.canonicalValueCents,
        "cents",
      );
      const returnComparison = comparison(
        "Client card all-time return",
        cardReturnPct,
        expectedReturnPct,
        "percent",
      );
      const caComparison = comparison(
        "Client strategy CA / residual",
        cardResidualRands == null ? null : Math.round(cardResidualRands * 100),
        expectedPosition.residualCents,
        "cents",
      );
      const reserveComparison = comparison(
        "Client strategy execution reserve",
        cardReserveRands == null ? null : Math.round(cardReserveRands * 100),
        expectedPosition.reserveCents,
        "cents",
      );
      const comparisons = [valueComparison, returnComparison, caComparison, reserveComparison];
      const hasUrgent = comparisons.some((row) => row.status === "urgent");
      const hasWarning = comparisons.some((row) => row.status === "warning");
      checks.push({
        surface: `Client app ${label} card`,
        sourcePage: `${configuredUrl?.replace(/\/$/, "") || ""}/`,
        sourceEndpoint: `${configuredUrl?.replace(/\/$/, "") || ""}${clientCardPath}`,
        status: !probe.ok || !card || hasUrgent ? "urgent" : hasWarning ? "warning" : "ok",
        latencyMs: probe.latencyMs,
        actual: !probe.ok
          ? probe.error || `HTTP ${probe.status}`
          : card
            ? `${moneyText(Math.round((cardValueRands ?? 0) * 100))}; all-time return ${
                cardReturnPct == null ? "not supplied" : `${cardReturnPct.toFixed(2)}%`
              }; CA ${
                cardResidualRands == null ? "not supplied" : moneyText(Math.round(cardResidualRands * 100))
              }; reserve ${
                cardReserveRands == null ? "not supplied" : moneyText(Math.round(cardReserveRands * 100))
              }`
            : "Selected strategy card is missing",
        expected: `${moneyText(expectedPosition.canonicalValueCents)} including ${moneyText(
          expectedPosition.residualCents,
        )} CA and ${moneyText(expectedPosition.reserveCents)} reserve; all-time return ${
          expectedReturnPct?.toFixed(2) ?? "n/a"
        }%`,
        difference: !card
          ? "The selected client strategy card is absent"
          : caComparison.actual == null && expectedPosition.residualCents > 0
            ? "The app contract does not expose residual CA separately"
            : reserveComparison.actual == null && expectedPosition.reserveCents > 0
              ? "The app contract does not expose execution reserve separately"
              : "Card value, return, residual CA and reserve agree with canonical client truth",
        evidence: [
          `deployment=${label}`,
          `base_url=${configuredUrl || "not configured"}`,
          `endpoint=${clientCardPath}`,
          `source=${text(probe.body.source)}`,
          `as_of=${text(probe.body.asOf)}`,
          `strategy_id=${strategyId}`,
          `family_member_id=${clientFamilyMemberId || "parent"}`,
          `audit_session_user_id=${clientAuditSession.userId || "unavailable"}`,
          `returned_card_ids=${cardRows
            .map((row) => text(row.strategyId || row.strategy_id || row.id))
            .filter(Boolean)
            .join(",") || "none"}`,
          `card_present=${Boolean(card)}`,
          `card_residual_cents=${cardResidualRands == null ? "not supplied" : Math.round(cardResidualRands * 100)}`,
          `card_reserve_cents=${cardReserveRands == null ? "not supplied" : Math.round(cardReserveRands * 100)}`,
          `latency_ms=${probe.latencyMs}`,
          ...(probe.error ? [`error=${probe.error}`] : []),
        ],
        comparisons,
      });
    };
    if (devClientCard) appendClientCardCheck("DEV", devClientCard, process.env.MINT_APP_URL_DEV);
    if (liveClientCard) appendClientCardCheck("LIVE", liveClientCard, process.env.MINT_APP_URL_LIVE);
  }
  const iressHealthy = iress.ok && iress.body.ok === true;
  checks.push({
    surface: "IRESS",
    status: iressHealthy ? (text(iress.body.mode) === "mock" ? "warning" : "ok") : "urgent",
    latencyMs: iress.latencyMs,
    actual: iressHealthy
      ? `${text(iress.body.mode)} mode; session ${iress.body.sessionStarted ? "started" : "not started"}`
      : text(iress.body.error) || `HTTP ${iress.status}`,
    expected: "Live mode with a valid authenticated service session",
    difference:
      text(iress.body.mode) === "mock" ? "Mock mode does not prove live IRESS connectivity" : undefined,
    evidence: [
      "endpoint=/api/iress/health",
      `mode=${text(iress.body.mode)}`,
      `session_started=${Boolean(iress.body.sessionStarted)}`,
      `latency_ms=${iress.latencyMs}`,
      ...(iress.error ? [`error=${iress.error}`] : []),
    ],
    comparisons: [],
  });
  const yahooEvidence =
    truth.kind === "client"
      ? truth.positions.flatMap((position) => position.holdings.map((holding) => holding.quote))
      : truth.kind === "strategy"
        ? truth.holdings.map((holding) => holding.quote)
        : [];
  checks.push({
    surface: "Yahoo Finance",
    status:
      truth.kind === "general"
        ? truth.summary.urgent > 0
          ? "warning"
          : "ok"
        : yahooEvidence.length
          ? "ok"
          : "urgent",
    latencyMs: 0,
    actual:
      truth.kind === "general"
        ? `Used by ${truth.auditedClients} client and ${truth.auditedStrategies} strategy audits`
        : `${yahooEvidence.length} fresh quote records`,
    expected: "Every priced holding must have a positive no-cache quote and exchange timestamp",
    evidence:
      yahooEvidence.length > 0
        ? yahooEvidence.map((quote) => `${quote.yahooSymbol}@${quote.exchangeTime}`).slice(0, 50)
        : ["General audit quote failures are surfaced as Urgent entity findings"],
    comparisons: [],
  });
  return checks;
}

export async function GET() {
  const access = await staffDb();
  if (!access.db)
    return access.response ?? NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  try {
    return NextResponse.json({ ok: true, ...(await listTruth(access.db)) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Could not load truth index" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const access = await staffDb();
  if (!access.db)
    return access.response ?? NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { kind?: string; id?: string };
  if (!["client", "strategy", "general"].includes(body.kind ?? "") || (body.kind !== "general" && !body.id)) {
    return NextResponse.json({ ok: false, error: "kind and id are required" }, { status: 400 });
  }
  try {
    const id = body.id ?? "";
    const snapshot = createQuoteSnapshot();
    const calculated =
      body.kind === "general"
        ? await generalTruth(access.db)
        : body.kind === "client"
          ? await clientTruth(access.db, id, snapshot)
          : await strategyTruth(access.db, id, snapshot);
    const truth = { ...calculated, surfaceChecks: await auditSurfaces(req, calculated) };
    return NextResponse.json({ ok: true, truth });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Truth calculation failed" },
      { status: 422 },
    );
  }
}
