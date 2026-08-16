import type { SupabaseClient } from "@supabase/supabase-js";

import { loadRetailLiveScope } from "@/lib/aum/retail-live-scope";

type Holding = {
  user_id: string;
  family_member_id: string | null;
  strategy_id: string;
  security_id: string;
  quantity: number | string | null;
  transaction_id: string | null;
};

type Transaction = {
  id: string;
  buffer_cents: number | string | null;
  buffer_consumed_cents: number | string | null;
  status: string | null;
  reversed: boolean | null;
};

type PositionAmount = {
  user_id: string;
  family_member_id: string | null;
  strategy_id: string;
  balance_cents?: number | string | null;
  aum_fee_consumed_cents?: number | string | null;
};

export type CanonicalStrategyAum = {
  aumCents: number;
  securitiesCents: number;
  reserveCents: number;
  residualCents: number;
  consumedAumFeeCents: number;
  users: Set<string>;
  holdingCount: number;
};

export type CanonicalPositionAum = {
  key: string;
  userId: string;
  familyMemberId: string | null;
  strategyId: string;
  aumCents: number;
  securitiesCents: number;
  reserveCents: number;
  residualCents: number;
  consumedAumFeeCents: number;
  holdingCount: number;
};

export type CanonicalRetailAum = {
  totalAumCents: number;
  totalConsumedAumFeeCents: number;
  investorCount: number;
  holdingCount: number;
  asOf: string;
  byStrategy: Map<string, CanonicalStrategyAum>;
  byPosition: Map<string, CanonicalPositionAum>;
};

function cents(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function ownerKey(userId: string, familyId: string | null, strategyId: string): string {
  return `${userId}|${familyId ?? ""}|${strategyId}`;
}

export function aggregateCanonicalRetailAum(input: {
  holdings: Holding[];
  priceCentsBySecurityId: Map<string, number>;
  transactions: Transaction[];
  residuals: PositionAmount[];
  feeStates: PositionAmount[];
  excludedUserIds?: Set<string>;
  excludedStrategyIds?: Set<string>;
  asOf: string;
}): CanonicalRetailAum {
  const excludedUsers = input.excludedUserIds ?? new Set<string>();
  const excludedStrategies = input.excludedStrategyIds ?? new Set<string>();
  const eligible = input.holdings.filter(
    (holding) =>
      holding.user_id &&
      holding.strategy_id &&
      !excludedUsers.has(holding.user_id) &&
      !excludedStrategies.has(holding.strategy_id),
  );
  const txById = new Map(input.transactions.map((row) => [row.id, row] as const));
  const residualByPosition = new Map<string, number>();
  for (const row of input.residuals) {
    const key = ownerKey(row.user_id, row.family_member_id, row.strategy_id);
    residualByPosition.set(key, (residualByPosition.get(key) ?? 0) + Math.max(0, cents(row.balance_cents)));
  }
  const feesByPosition = new Map<string, number>();
  for (const row of input.feeStates) {
    const key = ownerKey(row.user_id, row.family_member_id, row.strategy_id);
    feesByPosition.set(key, (feesByPosition.get(key) ?? 0) + Math.max(0, cents(row.aum_fee_consumed_cents)));
  }

  const positions = new Map<
    string,
    { userId: string; familyMemberId: string | null; strategyId: string; securitiesCents: number; txIds: Set<string>; holdingCount: number }
  >();
  for (const holding of eligible) {
    const price = input.priceCentsBySecurityId.get(holding.security_id);
    if (!(price && price > 0))
      throw new Error(`canonical AUM price unavailable for security ${holding.security_id}`);
    const key = ownerKey(holding.user_id, holding.family_member_id, holding.strategy_id);
    const position = positions.get(key) ?? {
      userId: holding.user_id,
      familyMemberId: holding.family_member_id,
      strategyId: holding.strategy_id,
      securitiesCents: 0,
      txIds: new Set<string>(),
      holdingCount: 0,
    };
    position.securitiesCents += Math.round(Math.abs(Number(holding.quantity) || 0) * price);
    if (holding.transaction_id) position.txIds.add(holding.transaction_id);
    position.holdingCount += 1;
    positions.set(key, position);
  }

  const byStrategy = new Map<string, CanonicalStrategyAum>();
  const byPosition = new Map<string, CanonicalPositionAum>();
  const investorIds = new Set<string>();
  let totalConsumedAumFeeCents = 0;
  for (const [key, position] of positions) {
    let reserveCents = 0;
    for (const txId of position.txIds) {
      const transaction = txById.get(txId);
      if (!transaction || transaction.reversed || String(transaction.status ?? "").toLowerCase() !== "posted")
        continue;
      reserveCents += Math.max(0, cents(transaction.buffer_cents) - cents(transaction.buffer_consumed_cents));
    }
    const residualCents = residualByPosition.get(key) ?? 0;
    const consumedAumFeeCents = feesByPosition.get(key) ?? 0;
    const aumCents = position.securitiesCents + reserveCents + residualCents - consumedAumFeeCents;
    if (aumCents < 0) throw new Error(`consumed AUM fees exceed position value for ${key}`);
    byPosition.set(key, {
      key,
      userId: position.userId,
      familyMemberId: position.familyMemberId,
      strategyId: position.strategyId,
      aumCents,
      securitiesCents: position.securitiesCents,
      reserveCents,
      residualCents,
      consumedAumFeeCents,
      holdingCount: position.holdingCount,
    });
    const aggregate = byStrategy.get(position.strategyId) ?? {
      aumCents: 0,
      securitiesCents: 0,
      reserveCents: 0,
      residualCents: 0,
      consumedAumFeeCents: 0,
      users: new Set<string>(),
      holdingCount: 0,
    };
    aggregate.aumCents += aumCents;
    aggregate.securitiesCents += position.securitiesCents;
    aggregate.reserveCents += reserveCents;
    aggregate.residualCents += residualCents;
    aggregate.consumedAumFeeCents += consumedAumFeeCents;
    aggregate.users.add(position.userId);
    aggregate.holdingCount += position.holdingCount;
    byStrategy.set(position.strategyId, aggregate);
    investorIds.add(position.userId);
    totalConsumedAumFeeCents += consumedAumFeeCents;
  }

  return {
    totalAumCents: [...byStrategy.values()].reduce((sum, row) => sum + row.aumCents, 0),
    totalConsumedAumFeeCents,
    investorCount: investorIds.size,
    holdingCount: eligible.length,
    asOf: input.asOf,
    byStrategy,
    byPosition,
  };
}

async function required<T>(
  label: string,
  query: PromiseLike<{ data: T | null; error: { message: string } | null }>,
): Promise<T> {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  if (data == null) throw new Error(`${label}: no data`);
  return data;
}

export async function loadCanonicalRetailAum(db: SupabaseClient): Promise<CanonicalRetailAum> {
  const [liveScope, holdings] = await Promise.all([
    loadRetailLiveScope(db),
    required<Holding[]>(
      "active holdings",
      db
        .from("stock_holdings_c")
        .select("user_id,family_member_id,strategy_id,security_id,quantity,transaction_id")
        .eq("is_active", true)
        .eq("trade_side", "BUY"),
    ),
  ]);
  const { excludedStrategyIds, excludedUserIds } = liveScope;
  const eligible = holdings.filter(
    (row) =>
      Boolean(row.user_id && row.strategy_id && row.security_id) &&
      !excludedUserIds.has(row.user_id) &&
      !excludedStrategyIds.has(row.strategy_id),
  );
  const securityIds = [...new Set(eligible.map((row) => row.security_id))];
  const transactionIds = [
    ...new Set(eligible.flatMap((row) => (row.transaction_id ? [row.transaction_id] : []))),
  ];
  const ownerIds = [...new Set(eligible.map((row) => row.user_id))];
  const strategyIds = [...new Set(eligible.map((row) => row.strategy_id))];
  if (eligible.length === 0) {
    return aggregateCanonicalRetailAum({
      holdings: [],
      priceCentsBySecurityId: new Map(),
      transactions: [],
      residuals: [],
      feeStates: [],
      asOf: new Date().toISOString(),
    });
  }

  const securities = await required<
    Array<{ id: string; symbol: string; last_price: number | string | null }>
  >("holding securities", db.from("securities_c").select("id,symbol,last_price").in("id", securityIds));
  const symbols = [
    ...new Set(
      securities.flatMap((row) => {
        const normalized = row.symbol.trim().toUpperCase().replace(/\.JO$/i, "");
        return [normalized, `${normalized}.JO`];
      }),
    ),
  ];
  const since = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const [intraday, closes, transactions, residuals, feeStates] = await Promise.all([
    required<Array<{ security_id: string; current_price: number | string | null; timestamp: string }>>(
      "latest holding quotes",
      db
        .from("stock_intraday_c")
        .select("security_id,current_price,timestamp")
        .in("security_id", securityIds)
        .gte("timestamp", since)
        .order("timestamp", { ascending: false })
        .limit(5000),
    ),
    required<
      Array<{ symbol: string; current_price: number | string | null; as_of_date: string; fetched_at: string }>
    >(
      "latest stored closes",
      db
        .from("stock_returns_c")
        .select("symbol,current_price,as_of_date,fetched_at")
        .in("symbol", symbols)
        .order("as_of_date", { ascending: false })
        .order("fetched_at", { ascending: false })
        .limit(5000),
    ),
    transactionIds.length
      ? required<Transaction[]>(
          "transaction reserves",
          db
            .from("transactions")
            .select("id,buffer_cents,buffer_consumed_cents,status,reversed")
            .in("id", transactionIds),
        )
      : Promise.resolve([]),
    required<PositionAmount[]>(
      "rebalance residuals",
      db
        .from("strategy_rebalance_residuals")
        .select("user_id,family_member_id,strategy_id,balance_cents")
        .in("user_id", ownerIds)
        .in("strategy_id", strategyIds),
    ),
    required<PositionAmount[]>(
      "AUM fee state",
      db
        .from("strategy_aum_fee_state")
        .select("user_id,family_member_id,strategy_id,aum_fee_consumed_cents")
        .in("user_id", ownerIds)
        .in("strategy_id", strategyIds),
    ),
  ]);

  const priceCentsBySecurityId = new Map<string, number>();
  let newestEvidence = "";
  for (const row of intraday) {
    const price = cents(row.current_price);
    if (!priceCentsBySecurityId.has(row.security_id) && price > 0)
      priceCentsBySecurityId.set(row.security_id, price);
    if (row.timestamp > newestEvidence) newestEvidence = row.timestamp;
  }
  const securityBySymbol = new Map(
    securities.map((row) => [row.symbol.trim().toUpperCase().replace(/\.JO$/i, ""), row] as const),
  );
  for (const row of closes) {
    const symbol = row.symbol.trim().toUpperCase().replace(/\.JO$/i, "");
    const security = securityBySymbol.get(symbol);
    const price = cents(row.current_price);
    if (security && !priceCentsBySecurityId.has(security.id) && price > 0)
      priceCentsBySecurityId.set(security.id, price);
    const evidenceAt = row.fetched_at || `${row.as_of_date}T23:59:59.000Z`;
    if (evidenceAt > newestEvidence) newestEvidence = evidenceAt;
  }
  for (const security of securities) {
    const price = cents(security.last_price);
    if (!priceCentsBySecurityId.has(security.id) && price > 0) priceCentsBySecurityId.set(security.id, price);
  }

  return aggregateCanonicalRetailAum({
    holdings,
    priceCentsBySecurityId,
    transactions,
    residuals,
    feeStates,
    excludedUserIds,
    excludedStrategyIds,
    asOf: newestEvidence || new Date().toISOString(),
  });
}
