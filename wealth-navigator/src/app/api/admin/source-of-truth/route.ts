import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import {
  calculatePositionTruth,
  calculateStrategyCashAsset,
  classifyDifference,
  possibleDifferenceReasons,
  returnScopeBenchmarks,
} from "@/lib/truth/calculations";
import { fetchYahooTruthQuote } from "@/lib/truth/yahoo-live";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Db = ReturnType<typeof createRetailServiceRoleClient>;
type Row = Record<string, unknown>;
type SurfaceCheck = {
  surface: string;
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
const chained = (rows: Row[]) =>
  rows.reduce((total, row) => total * (1 + num(row["1d_pct"]) / 100), 1) * 100 - 100;
const periodReturns = (rows: Row[]) => {
  const sorted = [...rows].sort((a, b) => text(a.as_of_date).localeCompare(text(b.as_of_date)));
  const latestDate = text(sorted.at(-1)?.as_of_date);
  const month = latestDate.slice(0, 7);
  const five = sorted.slice(-5);
  const mtd = sorted.filter((row) => text(row.as_of_date).startsWith(month));
  return {
    fiveDayPct: five.length ? chained(five) : null,
    mtdPct: mtd.length ? chained(mtd) : null,
    ytdPct: sorted.length ? num(sorted.at(-1)?.ytd_pct) : null,
    allTimePct: sorted.length ? num(sorted.at(-1)?.inception_pct ?? sorted.at(-1)?.all_pct) : null,
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
  const [{ data: latest, error }, { data: profiles }, { data: strategies }, excluded] = await Promise.all([
    db
      .from("client_strategy_returns_effective_latest_c")
      .select(
        "user_id,family_member_id,strategy_id,as_of_date,basket_value_cents,securities_value_cents,residual_cash_cents,unused_reserve_cents,accrued_liability_cents,inception_pnl_cents,inception_pct,ytd_pct",
      ),
    db.from("profiles").select("id,first_name,last_name,email,mint_number,created_at"),
    db.from("strategies_c").select("id,name,short_name,min_investment,status"),
    testUsers(db),
  ]);
  if (error) throw new Error(error.message);
  const profileMap = new Map((profiles ?? []).map((row) => [text(row.id), row]));
  const strategyMap = new Map((strategies ?? []).map((row) => [text(row.id), row]));
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
    strategies: (strategies ?? []).map((strategy) => ({
      id: strategy.id,
      name: strategy.short_name || strategy.name,
      minInvestment: strategy.min_investment,
      status: strategy.status,
      investedPositions: positions.filter((position) => position.strategyId === strategy.id).length,
    })),
  };
}

async function quoteMap(symbols: string[]) {
  const unique = [...new Set(symbols.map((symbol) => symbol.trim()).filter(Boolean))];
  if (!unique.length) throw new Error("Live truth blocked—no priced holdings were found");
  const settled = await Promise.allSettled(unique.map(fetchYahooTruthQuote));
  const quotes = new Map<string, Awaited<ReturnType<typeof fetchYahooTruthQuote>>>();
  const errors: string[] = [];
  settled.forEach((result, index) => {
    const symbol = unique[index] ?? "";
    if (result.status === "fulfilled") quotes.set(symbol, result.value);
    else errors.push(`${symbol}: ${result.reason instanceof Error ? result.reason.message : result.reason}`);
  });
  if (errors.length) throw new Error(`Live truth blocked—missing Yahoo quote(s): ${errors.join("; ")}`);
  return quotes;
}

function requiredQuote(
  quotes: Map<string, Awaited<ReturnType<typeof fetchYahooTruthQuote>>>,
  symbol: string,
) {
  const quote = quotes.get(symbol);
  if (!quote) throw new Error(`Live truth blocked—quote map has no ${symbol}`);
  return quote;
}

async function clientTruth(db: Db, userId: string) {
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
  const strategyIds = [...new Set((holdings ?? []).map((row) => text(row.strategy_id)).filter(Boolean))];
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
  const [{ data: history }, { data: activity }, { data: strategyHistory }] = await Promise.all([
    db
      .from("client_strategy_returns_effective_c")
      .select(
        'user_id,family_member_id,strategy_id,as_of_date,basket_value_cents,securities_value_cents,residual_cash_cents,unused_reserve_cents,accrued_liability_cents,inception_pnl_cents,inception_pct,ytd_pct,"1d_pct",source_kind',
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
          .select("strategy_id,as_of_date,ytd_pct,all_pct,continuity_cash_cents,complete_value_cents")
          .in("strategy_id", strategyIds)
          .order("as_of_date", { ascending: false })
          .limit(2000)
      : Promise.resolve({ data: [] }),
  ]);
  const secMap = new Map((securities ?? []).map((row) => [text(row.id), row]));
  const stratMap = new Map((strategies ?? []).map((row) => [text(row.id), row]));
  const symbols = (holdings ?? []).map((row) => text(secMap.get(text(row.security_id))?.symbol));
  const quotes = await quoteMap(symbols);
  const rows = (holdings ?? []).map((holding) => {
    const security = secMap.get(text(holding.security_id));
    const symbol = text(security?.symbol);
    const quote = requiredQuote(quotes, symbol);
    const quantity = num(holding.quantity);
    const expected = num(holding.Expected_fill);
    const rawFill = expected > 0 ? expected : num(holding.avg_fill);
    const costCents =
      rawFill > 0 && rawFill < quote.priceCents / 5 ? Math.round(rawFill * 100) : Math.round(rawFill);
    return {
      holdingId: holding.id,
      strategyId: holding.strategy_id,
      strategy:
        stratMap.get(text(holding.strategy_id))?.short_name || stratMap.get(text(holding.strategy_id))?.name,
      symbol,
      security: security?.name,
      quantity,
      livePriceCents: quote.priceCents,
      marketValueCents: Math.round(quantity * quote.priceCents),
      costPriceCents: costCents,
      costValueCents: Math.round(quantity * costCents),
      fillDate: holding.Fill_date,
      createdAt: holding.created_at,
      transactionId: holding.transaction_id,
      rebalanceBatchId: holding.rebalance_batch_id,
      quote,
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
    const quoteTime = positionHoldings
      .map((row) => row.quote.exchangeTime)
      .sort()
      .at(-1);
    const severity = classifyDifference(calculated.differenceCents, canonicalValueCents);
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
      canonicalValueCents,
      canonicalPnlCents,
      appDisplayedValueCents: canonicalValueCents,
      appDisplayedPnlCents: canonicalPnlCents,
      severity,
      reasons,
      returns: periodReturns(positionHistory),
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

async function strategyTruth(db: Db, strategyId: string) {
  const { data: strategy } = await db
    .from("strategies_c")
    .select("id,name,short_name,min_investment,holdings,updated_at")
    .eq("id", strategyId)
    .maybeSingle();
  if (!strategy) throw new Error("Strategy not found");
  const holdings = Array.isArray(strategy.holdings) ? (strategy.holdings as Row[]) : [];
  const symbols = holdings.map((row) => text(row.ticker || row.symbol)).filter(Boolean);
  const quotes = await quoteMap(symbols);
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
  const cash = calculateStrategyCashAsset(securitiesCents, num(strategy.min_investment));
  const { data: canonicalHistory } = await db
    .from("strategy_returns_effective_c")
    .select(
      'as_of_date,securities_value_cents,continuity_cash_cents,complete_value_cents,basket_value_cents,ytd_pct,all_pct,"1d_pct",source_kind',
    )
    .eq("strategy_id", strategyId)
    .order("as_of_date", { ascending: false })
    .limit(1000);
  const canonical = canonicalHistory?.[0];
  const differences = {
    securitiesCents: securitiesCents - num(canonical?.securities_value_cents),
    caCents: cash.strategyCaCents - num(canonical?.continuity_cash_cents),
    completeCents: cash.modelCapitalCents - num(canonical?.complete_value_cents),
  };
  const severity = classifyDifference(differences.completeCents, num(canonical?.complete_value_cents));
  return {
    kind: "strategy" as const,
    generatedAt: new Date().toISOString(),
    provider: "Yahoo Finance live chart API",
    strategy,
    holdings: rows,
    live: {
      securitiesCents,
      ...cash,
      formula: "max(model capital, actual securities) − actual securities",
    },
    canonical,
    differences,
    severity,
    reasons: possibleDifferenceReasons({
      differenceCents: differences.completeCents,
      canonicalAsOf: text(canonical?.as_of_date),
      quoteTime: rows
        .map((row) => row.quote.exchangeTime)
        .sort()
        .at(-1),
      hasReserve: false,
      hasLiability: false,
    }),
    returns: periodReturns([...(canonicalHistory ?? [])].reverse() as Row[]),
    history: [...(canonicalHistory ?? [])].reverse().map((row) => ({
      date: row.as_of_date,
      valueCents: row.complete_value_cents || row.basket_value_cents,
      securitiesCents: row.securities_value_cents,
      caCents: row.continuity_cash_cents,
      ytdPct: row.ytd_pct,
      allTimePct: row.all_pct,
      dailyPct: row["1d_pct"],
      source: row.source_kind,
    })),
  };
}

async function generalTruth(db: Db) {
  const truthIndex = await listTruth(db);
  const clientIds = [...new Set(truthIndex.positions.map((row) => text(row.userId)))];
  const startedAt = new Date().toISOString();
  const clientRuns = await Promise.allSettled(clientIds.map((id) => clientTruth(db, id)));
  const strategyRuns = await Promise.allSettled(
    truthIndex.strategies.map((row) => strategyTruth(db, text(row.id))),
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

async function probeDeployment(req: Request, baseUrl: string | undefined, path: string) {
  if (!baseUrl) {
    return {
      ok: false,
      status: 0,
      latencyMs: 0,
      body: {} as Row,
      error: "Deployment URL is not configured",
    };
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(new URL(path, baseUrl), {
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
  const clientCardPath = clientId ? `/api/overall-portfolio?investor=${encodeURIComponent(clientId)}` : "";
  const [strategyPage, factsheet, investors, iress, devClientCard, liveClientCard] = await Promise.all([
    probeJson(req, "/api/strategies?part=core"),
    probeJson(req, factsheetPath),
    probeJson(req, "/api/admin/investors/data"),
    probeJson(req, "/api/iress/health"),
    clientCardPath
      ? probeDeployment(req, process.env.MINT_APP_URL_DEV, clientCardPath)
      : Promise.resolve(null),
    clientCardPath
      ? probeDeployment(req, process.env.MINT_APP_URL_LIVE, clientCardPath)
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
      ? num(truth.canonical?.ytd_pct)
      : truth.kind === "client"
        ? num(clientStrategyBenchmark?.ytdPct)
        : null;
  const expectedClientYtd = truth.kind === "client" ? num(truth.positions[0]?.returns.ytdPct) : null;
  const returnScopes = returnScopeBenchmarks(expectedClientYtd, expectedStrategyYtd);
  const strategyYtdDifference =
    returnScopes.strategyPageExpectedYtd == null || !strategyPageRow
      ? null
      : num(strategyPageRow.ytd) - returnScopes.strategyPageExpectedYtd;
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
        strategyPageRow ? num(strategyPageRow.ytd) : null,
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
      : num(factsheetLatest.ytd_pct) - returnScopes.factsheetExpectedYtd;
  const expectedStrategyCa =
    truth.kind === "strategy"
      ? num(truth.canonical?.continuity_cash_cents)
      : truth.kind === "client"
        ? num(clientStrategyBenchmark?.caCents)
        : null;
  const factsheetCash = factsheet.body.cashAsset as Row | undefined;
  const factsheetCaCents = factsheetCash ? num(factsheetCash.value) * 100 : null;
  const factsheetValueMismatch =
    (factsheetYtdDifference != null && Math.abs(factsheetYtdDifference) > 0.01) ||
    (expectedStrategyCa != null &&
      factsheetCaCents != null &&
      Math.abs(factsheetCaCents - expectedStrategyCa) > 1);
  const factsheetValueCritical =
    (factsheetYtdDifference != null && Math.abs(factsheetYtdDifference) > 0.25) ||
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
            expectedStrategyCa == null || factsheetCaCents == null
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
        factsheetLatest ? num(factsheetLatest.ytd_pct) : null,
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
      : num(investorLatest.ytd_pct) - returnScopes.investorsExpectedYtd;
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
        investorLatest ? num(investorLatest.ytd_pct) : null,
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
      const cardRows = Array.isArray(probe.body.strategies) ? (probe.body.strategies as Row[]) : [];
      const card = cardRows.find((row) => text(row.strategyId) === strategyId);
      const valueComparison = comparison(
        "Client card current value",
        card ? Math.round(num(card.basketValue) * 100) : null,
        expectedPosition.canonicalValueCents,
        "cents",
      );
      const ytdComparison = comparison(
        "Client card personal YTD",
        card?.ytdPct == null ? null : num(card.ytdPct),
        returnScopes.investorsExpectedYtd,
        "percent",
      );
      const caComparison = comparison(
        "Client strategy CA / residual",
        null,
        expectedPosition.residualCents,
        "cents",
      );
      const comparisons = [valueComparison, ytdComparison, caComparison];
      const hasUrgent = comparisons.some((row) => row.status === "urgent");
      const hasWarning = comparisons.some((row) => row.status === "warning");
      checks.push({
        surface: `Client app ${label} card`,
        status: !probe.ok || !card || hasUrgent ? "urgent" : hasWarning ? "warning" : "ok",
        latencyMs: probe.latencyMs,
        actual: !probe.ok
          ? probe.error || `HTTP ${probe.status}`
          : card
            ? `${moneyText(Math.round(num(card.basketValue) * 100))}; personal YTD ${
                card.ytdPct == null ? "not supplied" : `${num(card.ytdPct).toFixed(2)}%`
              }`
            : "Selected strategy card is missing",
        expected: `${moneyText(expectedPosition.canonicalValueCents)} including ${moneyText(
          expectedPosition.residualCents,
        )} CA; personal YTD ${returnScopes.investorsExpectedYtd?.toFixed(2) ?? "n/a"}%`,
        difference: !card
          ? "The selected client strategy card is absent"
          : caComparison.actual == null && expectedPosition.residualCents > 0
            ? "The app contract does not expose CA separately, so its inclusion cannot be proven from the card payload"
            : "Card fields agree with canonical client truth",
        evidence: [
          `deployment=${label}`,
          `base_url=${configuredUrl || "not configured"}`,
          `endpoint=${clientCardPath}`,
          `source=${text(probe.body.source)}`,
          `as_of=${text(probe.body.asOf)}`,
          `strategy_id=${strategyId}`,
          `card_present=${Boolean(card)}`,
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
    const calculated =
      body.kind === "general"
        ? await generalTruth(access.db)
        : body.kind === "client"
          ? await clientTruth(access.db, id)
          : await strategyTruth(access.db, id);
    const truth = { ...calculated, surfaceChecks: await auditSurfaces(req, calculated) };
    return NextResponse.json({ ok: true, truth });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Truth calculation failed" },
      { status: 422 },
    );
  }
}
