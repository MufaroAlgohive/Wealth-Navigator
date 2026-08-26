import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "@/lib/supabase/server";

/**
 * Guarded per-owner strategy return publisher.
 *
 * The strategy publisher (publish-eod-returns.ts) answers "how did this model
 * perform". This one answers "how did THIS client's money in that model
 * perform", per (user, family member, strategy) triple, which is a different
 * and harder question: a client's NAV moves when they add cash, when fees
 * accrue, and when a rebalance swaps what they hold — none of which is
 * investment performance.
 *
 * Three ideas keep those out of the return:
 *
 * 1. NAV is split. `performance_nav = securities + residual cash (CA) +
 *    unused reserve`; `complete_nav = performance_nav − accrued AUM fee
 *    liability`. Performance is measured on the performance NAV; the accrued
 *    liability is a claim against the client, not a loss of market value.
 *
 * 2. The daily move is cash-neutral. It compares today's securities against
 *    yesterday's performance NAV using YESTERDAY'S cash, so money moving
 *    between the cash sleeves and the securities sleeve nets out instead of
 *    reading as a gain or loss.
 *
 * 3. A composition change must be explained. If the holdings snapshot differs
 *    from the last publication, there must be a SETTLED `rebalance_batch`
 *    linked to that owner and dated in the gap — then the chain factor is
 *    carried across untouched, exactly like the strategy-level boundary. With
 *    no such batch the guard RPC refuses the row rather than booking the swap
 *    as return. (This is why an OEM rebalance must record owner linkage on the
 *    batch it settles — see seal-rebalance-boundary.ts.)
 *
 * Port of the CRM's `api/_client-returns-publish.js`, reading and writing the
 * same retail tables and the same `publish_guarded_client_strategy_return`
 * RPC. Only one of the two may be scheduled at a time.
 *
 * SAFE BY DEFAULT: writes only when `apply` is true.
 */

const NIL = "00000000-0000-0000-0000-000000000000";
const DAY_MS = 86_400_000;
/** PostgREST `in.(…)` lists are URL-encoded; unchunked they 404 at roughly 300 ids. */
const IN_CHUNK = 100;

function bare(symbol: string): string {
  return String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

function ownerKey(userId: string, familyId: string | null, strategyId: string): string {
  return `${userId}|${familyId || NIL}|${strategyId}`;
}

/**
 * A raw JSON.stringify comparison is brittle to object KEY ORDER — two
 * snapshots with identical security_id/quantity pairs but different property
 * insertion order serialise differently and register as "changed" when
 * nothing did, which jams every owner on "composition changed without a
 * settled rebalance boundary". Compare only the fields that define
 * composition, in a canonical order.
 */
function normalizeSnapshot(rows: unknown): Array<{ security_id: string; quantity: number }> {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const r = (row ?? {}) as Record<string, unknown>;
      return { security_id: String(r.security_id ?? ""), quantity: Number(r.quantity) || 0 };
    })
    .filter((row) => row.security_id && row.quantity > 0)
    .sort((a, b) => a.security_id.localeCompare(b.security_id));
}

function sameSnapshot(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeSnapshot(a)) === JSON.stringify(normalizeSnapshot(b));
}

/**
 * Run an `in.(…)` filtered select in id-chunks and concatenate the rows. The
 * caller supplies the whole query for a chunk, so each call site stays a plain
 * readable Supabase chain instead of a partially-built one.
 */
async function inChunks<T>(
  ids: string[],
  run: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    if (chunk.length === 0) continue;
    const { data, error } = await run(chunk);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) out.push(row);
  }
  return out;
}

interface HoldingRow {
  id: string;
  user_id: string;
  family_member_id: string | null;
  strategy_id: string;
  security_id: string;
  quantity: number | null;
  transaction_id: string | null;
  created_at: string | null;
  Fill_date: string | null;
}

export interface ClientPublishResultRow {
  client: string;
  strategy: string;
  action: "published" | "plan" | "skip" | "failed";
  reason?: string;
  mode?: string;
  navCents?: number;
  twrPct?: number;
  dailyPct?: number | null;
  error?: string;
}

export interface PublishClientEodReturnsResult {
  ok: boolean;
  asOf: string;
  apply: boolean;
  summary: { published: number; skipped: number; failed: number; total: number };
  results: ClientPublishResultRow[];
  note?: string;
}

export async function publishClientEodReturns(
  options: { asOfDate?: string; apply?: boolean; includeUat?: boolean; includeTestUsers?: boolean } = {},
): Promise<PublishClientEodReturnsResult> {
  const asOf = options.asOfDate || new Date().toISOString().slice(0, 10);
  const apply = options.apply === true;
  const includeUat = options.includeUat === true;
  const includeTestUsers = options.includeTestUsers === true;
  const empty = { published: 0, skipped: 0, failed: 0, total: 0 };

  if (!isRetailSupabaseConfigured()) {
    return { ok: false, asOf, apply, summary: empty, results: [], note: "retail supabase not configured" };
  }
  const db = createRetailServiceRoleClient();

  const stratRes = await db
    .from("strategies_c")
    .select("id, name, investor_environment")
    .eq("status", "active");
  if (stratRes.error) {
    return { ok: false, asOf, apply, summary: empty, results: [], note: stratRes.error.message };
  }
  const strategyById = new Map(
    ((stratRes.data ?? []) as Array<{ id: string; name: string; investor_environment: string | null }>).map(
      (s) => [s.id, s],
    ),
  );

  const holdingsRes = await db
    .from("stock_holdings_c")
    .select(
      "id, user_id, family_member_id, strategy_id, security_id, quantity, transaction_id, created_at, Fill_date",
    )
    .eq("is_active", true)
    .gt("quantity", 0);
  if (holdingsRes.error) {
    return { ok: false, asOf, apply, summary: empty, results: [], note: holdingsRes.error.message };
  }

  // A test owner must never leak into production publication: if either
  // classification source cannot be read, fail closed rather than publish.
  let testUserIds = new Set<string>();
  if (!includeTestUsers) {
    const [testProfiles, testWallets] = await Promise.all([
      db.from("profiles").select("id").eq("is_test", true),
      db.from("wallets").select("user_id").eq("status", "test"),
    ]);
    if (testProfiles.error || testWallets.error) {
      return {
        ok: false,
        asOf,
        apply,
        summary: empty,
        results: [],
        note: `test-account classification unavailable: ${testProfiles.error?.message ?? testWallets.error?.message}`,
      };
    }
    testUserIds = new Set([
      ...((testProfiles.data ?? []) as Array<{ id: string }>).map((r) => String(r.id)),
      ...((testWallets.data ?? []) as Array<{ user_id: string }>).map((r) => String(r.user_id)),
    ]);
  }

  const eligible = ((holdingsRes.data ?? []) as HoldingRow[]).filter((row) => {
    const strategy = strategyById.get(row.strategy_id);
    if (!row.user_id || !strategy) return false;
    if (!includeTestUsers && testUserIds.has(String(row.user_id))) return false;
    return includeUat || String(strategy.investor_environment ?? "LIVE").toUpperCase() !== "UAT";
  });
  if (eligible.length === 0) {
    return { ok: true, asOf, apply, summary: empty, results: [], note: "no eligible owners" };
  }

  const securityIds = [...new Set(eligible.map((r) => r.security_id).filter(Boolean))];
  const securities = await inChunks<{ id: string; symbol: string }>(securityIds, (chunk) =>
    db.from("securities_c").select("id, symbol").in("id", chunk),
  );
  const securityById = new Map(securities.map((s) => [s.id, s]));

  const symbols = [...new Set(securities.flatMap((s) => [bare(s.symbol), `${bare(s.symbol)}.JO`]))];
  const since = new Date(new Date(`${asOf}T23:59:59Z`).getTime() - 4 * DAY_MS).toISOString();
  // An explicit limit stops a few frequently-ticking symbols exhausting the
  // row cap and starving other symbols' latest price out of the result.
  const ticks = await inChunks<{ symbol: string; current_price: number | string | null; timestamp: string }>(
    symbols,
    (chunk) =>
      db
        .from("stock_intraday_c")
        .select("symbol, current_price, timestamp")
        .in("symbol", chunk)
        .gte("timestamp", since)
        .order("timestamp", { ascending: false })
        .limit(5000),
  );
  const priceBySymbol = new Map<string, { cents: number; timestamp: string }>();
  for (const row of ticks) {
    const sym = bare(row.symbol);
    const cents = Number(row.current_price);
    if (priceBySymbol.has(sym) || !(cents > 0)) continue;
    priceBySymbol.set(sym, { cents, timestamp: row.timestamp });
  }

  /* FALLBACK for a symbol intraday didn't surface. A held symbol's actual
     intraday rows can exist well within the `since` window and still never
     reach `ticks`: the query above caps at 5000 rows PER CHUNK, ordered by
     timestamp across every symbol in that chunk together — a symbol whose
     feed has simply gone quiet for a few hours (still fresh enough to be
     real) gets crowded out of the top 5000 by symbols that never stopped
     ticking. That read as "missing prices", failing the owner's publish
     outright even though a perfectly good price exists. Same two-tier
     fallback canonical-retail-aum.ts already uses for the identical
     intraday shape: the latest stored daily close, then the security's own
     last_price. Only queried for symbols intraday didn't already resolve —
     the common case pays no extra cost. */
  const stillMissing = symbols.filter((sym) => !priceBySymbol.has(bare(sym)));
  if (stillMissing.length > 0) {
    const closes = await inChunks<{
      symbol: string;
      current_price: number | string | null;
      as_of_date: string;
      fetched_at: string | null;
    }>(stillMissing, (chunk) =>
      db
        .from("stock_returns_c")
        .select("symbol, current_price, as_of_date, fetched_at")
        .in("symbol", chunk)
        .order("as_of_date", { ascending: false })
        .order("fetched_at", { ascending: false })
        .limit(5000),
    );
    for (const row of closes) {
      const sym = bare(row.symbol);
      const cents = Number(row.current_price);
      if (priceBySymbol.has(sym) || !(cents > 0)) continue;
      const timestamp = row.fetched_at || `${row.as_of_date}T23:59:59.000Z`;
      priceBySymbol.set(sym, { cents, timestamp });
    }
  }
  const stillMissingAfterCloses = [...new Set(securities.map((s) => bare(s.symbol)))].filter(
    (sym) => !priceBySymbol.has(sym),
  );
  if (stillMissingAfterCloses.length > 0) {
    const lastPrices = await inChunks<{ symbol: string; last_price: number | string | null }>(
      securities.filter((s) => stillMissingAfterCloses.includes(bare(s.symbol))).map((s) => s.symbol),
      (chunk) => db.from("securities_c").select("symbol, last_price").in("symbol", chunk),
    );
    for (const row of lastPrices) {
      const sym = bare(row.symbol);
      const cents = Number(row.last_price);
      if (priceBySymbol.has(sym) || !(cents > 0)) continue;
      priceBySymbol.set(sym, { cents, timestamp: `${asOf}T00:00:00.000Z` });
    }
  }

  const groups = new Map<
    string,
    { userId: string; familyId: string | null; strategyId: string; rows: HoldingRow[] }
  >();
  for (const row of eligible) {
    const key = ownerKey(row.user_id, row.family_member_id, row.strategy_id);
    let g = groups.get(key);
    if (!g) {
      g = {
        userId: row.user_id,
        familyId: row.family_member_id || null,
        strategyId: row.strategy_id,
        rows: [],
      };
      groups.set(key, g);
    }
    g.rows.push(row);
  }

  const userIds = [...new Set(eligible.map((r) => r.user_id))];
  const strategyIds = [...new Set(eligible.map((r) => r.strategy_id))];
  const transactionIds = [...new Set(eligible.map((r) => r.transaction_id).filter(Boolean))] as string[];

  interface TxRow {
    id: string;
    buffer_cents: number | null;
    buffer_consumed_cents: number | null;
    status: string | null;
    reversed: boolean | null;
  }
  interface BatchRow {
    id: string;
    strategy_id: string;
    status: string;
    settled_at: string | null;
    settlement_effective_at: string | null;
    pending_swap_snapshot: unknown;
  }

  const [residuals, transactions, liabilities, previousRows, seedRows, recentBatches, recentEvents] =
    await Promise.all([
      inChunks<{
        user_id: string;
        family_member_id: string | null;
        strategy_id: string;
        balance_cents: number | null;
      }>(userIds, (chunk) =>
        db
          .from("strategy_rebalance_residuals")
          .select("user_id, family_member_id, strategy_id, balance_cents")
          .in("user_id", chunk)
          .in("strategy_id", strategyIds),
      ),
      inChunks<TxRow>(transactionIds, (chunk) =>
        db
          .from("transactions")
          .select("id, buffer_cents, buffer_consumed_cents, status, reversed")
          .in("id", chunk),
      ),
      inChunks<{
        user_id: string;
        family_member_id: string | null;
        strategy_id: string;
        accrued_fee_cents: number | null;
      }>(userIds, (chunk) =>
        db
          .from("aum_fee_accrual_segments")
          .select("user_id, family_member_id, strategy_id, accrued_fee_cents")
          .in("user_id", chunk)
          .in("strategy_id", strategyIds)
          .is("segment_end_date", null),
      ),
      inChunks<Record<string, unknown>>(userIds, (chunk) =>
        db
          .from("client_strategy_return_publication_audit_c")
          .select("*")
          .in("user_id", chunk)
          .in("strategy_id", strategyIds)
          .order("as_of_date", { ascending: false }),
      ),
      inChunks<Record<string, unknown>>(userIds, (chunk) =>
        db
          .from("client_strategy_returns_effective_latest_c")
          .select("*")
          .in("user_id", chunk)
          .in("strategy_id", strategyIds),
      ),
      inChunks<BatchRow>(strategyIds, (chunk) =>
        db
          .from("rebalance_batch")
          .select("id, strategy_id, status, settled_at, settlement_effective_at, pending_swap_snapshot")
          .in("strategy_id", chunk)
          .eq("status", "SETTLED")
          .order("updated_at", { ascending: false })
          .limit(200),
      ),
      inChunks<{ batch_id: string; user_id: string; family_member_id: string | null }>(userIds, (chunk) =>
        db
          .from("rebalance_event")
          .select("batch_id, user_id, family_member_id")
          .in("user_id", chunk)
          .order("updated_at", { ascending: false })
          .limit(1000),
      ),
    ]);

  const residualByKey = new Map(
    residuals.map((r) => [
      ownerKey(r.user_id, r.family_member_id, r.strategy_id),
      Math.max(0, Math.round(Number(r.balance_cents) || 0)),
    ]),
  );
  const txById = new Map(transactions.map((t) => [t.id, t]));
  const liabilityByKey = new Map<string, number>();
  for (const row of liabilities) {
    const key = ownerKey(row.user_id, row.family_member_id, row.strategy_id);
    liabilityByKey.set(
      key,
      (liabilityByKey.get(key) ?? 0) + Math.max(0, Math.round(Number(row.accrued_fee_cents) || 0)),
    );
  }
  const previousByKey = new Map<string, Record<string, unknown>>();
  for (const row of previousRows) {
    const key = ownerKey(
      String(row.user_id),
      (row.family_member_id as string | null) ?? null,
      String(row.strategy_id),
    );
    if (!previousByKey.has(key)) previousByKey.set(key, row);
  }
  const seedByKey = new Map(
    seedRows.map((r) => [
      ownerKey(String(r.user_id), (r.family_member_id as string | null) ?? null, String(r.strategy_id)),
      r,
    ]),
  );

  const batchById = new Map(recentBatches.map((b) => [b.id, b]));
  const boundaryBatchesByOwner = new Map<string, typeof recentBatches>();
  function addBoundaryBatch(key: string, batch: (typeof recentBatches)[number] | undefined) {
    if (!key || !batch) return;
    const list = boundaryBatchesByOwner.get(key) ?? [];
    if (!list.some((b) => b.id === batch.id)) list.push(batch);
    boundaryBatchesByOwner.set(key, list);
  }
  for (const event of recentEvents) {
    const batch = batchById.get(event.batch_id);
    if (!batch || batch.status !== "SETTLED") continue;
    addBoundaryBatch(ownerKey(event.user_id, event.family_member_id, batch.strategy_id), batch);
  }
  // An owner whose original order was still unfilled has no SELL/BUY
  // rebalance_event — the settlement rewrites that pending order in place and
  // records the affected owners only in pending_swap_snapshot. Without this,
  // their post-settlement composition is rejected as an unexplained change and
  // their return row stays stale. The OEM's own sealer writes the same shape.
  for (const batch of recentBatches) {
    if (batch.status !== "SETTLED") continue;
    const swaps = Array.isArray(batch.pending_swap_snapshot) ? batch.pending_swap_snapshot : [];
    for (const swap of swaps as Array<Record<string, unknown>>) {
      const uid = swap?.userId;
      if (typeof uid !== "string" || !uid) continue;
      addBoundaryBatch(
        ownerKey(uid, (swap.familyMemberId as string | null) ?? null, batch.strategy_id),
        batch,
      );
    }
  }

  const results: ClientPublishResultRow[] = [];
  let published = 0;
  let skipped = 0;
  let failed = 0;

  for (const [key, group] of groups) {
    const strategy = strategyById.get(group.strategyId);
    try {
      const aggregated = new Map<string, { security_id: string; symbol: string; quantity: number }>();
      for (const holding of group.rows) {
        const security = securityById.get(holding.security_id);
        if (!security) throw new Error(`unknown security ${holding.security_id}`);
        const cur = aggregated.get(holding.security_id) ?? {
          security_id: holding.security_id,
          symbol: bare(security.symbol),
          quantity: 0,
        };
        cur.quantity += Number(holding.quantity) || 0;
        aggregated.set(holding.security_id, cur);
      }
      const snapshot = [...aggregated.values()]
        .filter((r) => r.quantity > 0)
        .sort((a, b) => a.security_id.localeCompare(b.security_id));

      let securitiesCents = 0;
      let oldestPriceAt: string | null = null;
      const missing: string[] = [];
      for (const line of snapshot) {
        const quote = priceBySymbol.get(line.symbol);
        if (!quote) {
          missing.push(line.symbol);
          continue;
        }
        securitiesCents += Math.round(line.quantity * quote.cents);
        if (!oldestPriceAt || new Date(quote.timestamp) < new Date(oldestPriceAt))
          oldestPriceAt = quote.timestamp;
      }
      if (missing.length) throw new Error(`missing prices: ${missing.join(",")}`);
      if (
        !oldestPriceAt ||
        new Date(oldestPriceAt).getTime() < new Date(`${asOf}T00:00:00Z`).getTime() - DAY_MS
      ) {
        throw new Error("stale prices (non-trading day?)");
      }

      const residualCents = residualByKey.get(key) ?? 0;
      let reserveCents = 0;
      for (const id of new Set(group.rows.map((r) => r.transaction_id).filter(Boolean) as string[])) {
        const tx = txById.get(id);
        if (!tx || String(tx.status) !== "posted" || tx.reversed) continue;
        reserveCents += Math.max(
          0,
          Math.round(Number(tx.buffer_cents) || 0) - Math.round(Number(tx.buffer_consumed_cents) || 0),
        );
      }
      const liabilityCents = liabilityByKey.get(key) ?? 0;
      const performanceNavCents = Math.round(securitiesCents) + residualCents + reserveCents;
      const completeNavCents = performanceNavCents - liabilityCents;
      if (completeNavCents < 0) throw new Error("accrued liability exceeds the client performance NAV");

      const previous = previousByKey.get(key);
      const seed = seedByKey.get(key);
      if (previous && String(previous.as_of_date) === asOf) {
        results.push({
          client: group.userId,
          strategy: strategy?.name ?? group.strategyId,
          action: "skip",
          reason: "already published today",
        });
        skipped += 1;
        continue;
      }

      // A first filled allocation starts at 0%, never at an invented historical
      // return. Requiring same-day holdings plus posted, unreversed
      // transactions stops an old unseeded account being reset to zero.
      const isGenuineNewAllocation =
        !previous &&
        !seed &&
        group.rows.length > 0 &&
        group.rows.every((r) => String(r.Fill_date || r.created_at || "").slice(0, 10) === asOf) &&
        group.rows.every((r) => {
          const tx = r.transaction_id ? txById.get(r.transaction_id) : undefined;
          return Boolean(r.transaction_id) && String(tx?.status ?? "") === "posted" && !tx?.reversed;
        });
      if (!previous && !seed && !isGenuineNewAllocation) {
        results.push({
          client: group.userId,
          strategy: strategy?.name ?? group.strategyId,
          action: "skip",
          reason: "no trusted return seed",
        });
        skipped += 1;
        continue;
      }

      let chainFactor: number;
      let twr: number;
      let openingPerformanceNav: number;
      let externalContribution: number | null;
      let mode: string;
      let dailyPct: number | null = null;
      let boundaryBatchId: string | null = null;

      if (isGenuineNewAllocation) {
        twr = 0;
        chainFactor = 1;
        openingPerformanceNav = performanceNavCents;
        externalContribution = completeNavCents;
        mode = "new-allocation-inception";
      } else if (!previous) {
        const s = seed as Record<string, unknown>;
        twr = Number(s.ytd_pct ?? s.inception_pct ?? 0);
        chainFactor = 1 + twr / 100;
        openingPerformanceNav = Math.round(
          Number(s.opening_performance_nav_cents) || performanceNavCents / chainFactor,
        );
        externalContribution =
          s.net_cash_pnl_cents == null
            ? completeNavCents
            : completeNavCents - Math.round(Number(s.net_cash_pnl_cents));
        mode = `seed:${String(s.source_kind ?? "effective")}`;
      } else {
        chainFactor = Number(previous.chain_factor);
        openingPerformanceNav = Number(previous.opening_performance_nav_cents);
        externalContribution =
          previous.external_contribution_cents == null ? null : Number(previous.external_contribution_cents);
        if (!sameSnapshot(previous.holdings_snapshot, snapshot)) {
          // Comparing DATES (not timestamps) here used to reject a same-day
          // boundary outright: a client rebalanced mid-morning, published
          // again that evening, and the batch's own settlement date equalled
          // `previous.as_of_date` — `date > date` is false even though the
          // batch happened well after `previous` was captured. Reproduced
          // live 2026-08-25: a rebalance settled 2026-08-24T14:52 explaining
          // a change from a 2026-08-24T10:57 publish, both dated the same
          // calendar day, threw "composition changed without a settled
          // rebalance boundary" on the very next run. Comparing real
          // timestamps against `previous.published_at` (when that row was
          // actually captured, not just its date) fixes the same-day case
          // and is strictly more correct than the date-only version for the
          // cross-day case too — a batch that settled earlier the same day
          // `previous` was published is correctly excluded (already
          // reflected in `previous`), not just anything under the date.
          const previousPublishedAtMs = Date.parse(String(previous.published_at ?? "")) || 0;
          const nowMs = Date.now();
          const boundary = (boundaryBatchesByOwner.get(key) ?? []).find((batch) => {
            const batchMs = Date.parse(String(batch.settlement_effective_at || batch.settled_at || ""));
            return Number.isFinite(batchMs) && batchMs > previousPublishedAtMs && batchMs <= nowMs;
          });
          if (!boundary) throw new Error("composition changed without a settled rebalance boundary");
          boundaryBatchId = boundary.id;
          twr = (chainFactor - 1) * 100;
          mode = "rebalance-boundary";
        } else {
          const previousCash =
            Math.round(Number(previous.residual_cash_cents) || 0) +
            Math.round(Number(previous.unused_reserve_cents) || 0);
          const previousPerformance = Math.round(Number(previous.performance_nav_cents) || 0);
          if (previousPerformance <= 0) throw new Error("previous performance NAV is not positive");
          dailyPct = ((securitiesCents + previousCash) / previousPerformance - 1) * 100;
          chainFactor *= 1 + dailyPct / 100;
          twr = (chainFactor - 1) * 100;
          mode = "market-chain-cash-neutral";
        }
      }

      const inceptionPnlCents = Math.round((openingPerformanceNav * twr) / 100);
      const netCashPnlCents = externalContribution == null ? null : completeNavCents - externalContribution;
      const netCashReturnPct =
        externalContribution != null && externalContribution > 0 && netCashPnlCents != null
          ? (netCashPnlCents / externalContribution) * 100
          : null;

      if (apply) {
        const rpc = await db.rpc("publish_guarded_client_strategy_return", {
          p_user_id: group.userId,
          p_family_member_id: group.familyId,
          p_strategy_id: group.strategyId,
          p_as_of_date: asOf,
          p_securities_value_cents: Math.round(securitiesCents),
          p_residual_cash_cents: residualCents,
          p_unused_reserve_cents: reserveCents,
          p_accrued_liability_cents: liabilityCents,
          p_performance_nav_cents: performanceNavCents,
          p_complete_nav_cents: completeNavCents,
          p_opening_performance_nav_cents: Math.round(openingPerformanceNav),
          p_external_contribution_cents:
            externalContribution == null ? null : Math.round(externalContribution),
          p_gross_strategy_twr_pct: twr,
          p_chain_factor: chainFactor,
          p_inception_pnl_cents: inceptionPnlCents,
          p_net_cash_pnl_cents: netCashPnlCents,
          p_net_cash_return_pct: netCashReturnPct,
          p_covered_holdings: snapshot.length,
          p_expected_holdings: snapshot.length,
          p_oldest_price_at: oldestPriceAt,
          p_holdings_snapshot: snapshot,
          p_boundary_batch_id: boundaryBatchId,
          p_checks: {
            source: "oem_client_eod_cron",
            mode,
            cash_neutral: mode === "market-chain-cash-neutral",
            daily_pct: dailyPct,
          },
        });
        if (rpc.error) throw new Error(rpc.error.message);
      }

      results.push({
        client: group.userId,
        strategy: strategy?.name ?? group.strategyId,
        action: apply ? "published" : "plan",
        mode,
        navCents: completeNavCents,
        twrPct: Number(twr.toFixed(6)),
        dailyPct: dailyPct == null ? null : Number(dailyPct.toFixed(6)),
      });
      published += 1;
    } catch (err) {
      results.push({
        client: group.userId,
        strategy: strategy?.name ?? group.strategyId,
        action: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      failed += 1;
    }
  }

  return { ok: true, asOf, apply, summary: { published, skipped, failed, total: groups.size }, results };
}
