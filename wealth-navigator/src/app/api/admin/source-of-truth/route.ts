import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import {
  calculatePositionTruth,
  calculateStrategyCashAsset,
  classifyDifference,
  possibleDifferenceReasons,
} from "@/lib/truth/calculations";
import { fetchYahooTruthQuote } from "@/lib/truth/yahoo-live";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Db = ReturnType<typeof createRetailServiceRoleClient>;
type Row = Record<string, unknown>;

const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const text = (value: unknown) => String(value ?? "").trim();
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
  const [{ data: history }, { data: activity }] = await Promise.all([
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
    kind: "client",
    generatedAt: new Date().toISOString(),
    provider: "Yahoo Finance live chart API",
    profile,
    positions: byPosition,
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
    kind: "strategy",
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
    kind: "general",
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
    const truth =
      body.kind === "general"
        ? await generalTruth(access.db)
        : body.kind === "client"
          ? await clientTruth(access.db, id)
          : await strategyTruth(access.db, id);
    return NextResponse.json({ ok: true, truth });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Truth calculation failed" },
      { status: 422 },
    );
  }
}
