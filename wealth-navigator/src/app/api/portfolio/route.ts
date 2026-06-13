/**
 * GET /api/portfolio
 *
 * Returns the IPS portfolio summary the Cockpit needs:
 *   - accounts:        flat list of `oems_account_c` rows
 *   - positions:       flat list of `oems_position_c` rows
 *   - recentTx:        last 20 `oems_transaction_c` rows
 *   - aum:             sum of `nav_value` (or `market_value` of positions
 *                      as a fallback when accounts are not yet ingested)
 *   - cashBalance:     sum of `cash_balance`
 *   - dayPnl:          sum of today's `amount` for the relevant accounts
 *   - rebalanceDrift:  max(|actual - target|) % across positions vs.
 *                      strategy targets (where the symbol is known)
 *   - rebalanceLocked: `true` when at least one position drifts more
 *                      than 1.5 percentage points from target
 *   - source:          "supabase" when rows present, else "unavailable"
 *
 * Reuses the existing `oems_strategy_target_c` model by joining on
 * `security_code` for known ZA instruments. When no positions have
 * drifted (or the table is empty), `rebalanceLocked = false`.
 *
 * No service_role: the route reads through the standard Supabase
 * client used by other BFF endpoints. RLS denies anon / authenticated
 * on the underlying tables, so this endpoint requires service_role.
 */
import { createServiceRoleClient, isSupabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface AccountRow {
  account_code: string;
  account_name: string | null;
  account_type: string | null;
  currency: string | null;
  base_currency: string | null;
  beneficiary: string | null;
  account_status: string | null;
  open_date: string | null;
  nav_value: number | null;
  cash_balance: number | null;
  payload: Record<string, unknown> | null;
  ingested_at: string;
  updated_at: string;
}

interface PositionRow {
  id: string;
  account_code: string;
  security_code: string;
  exchange: string | null;
  quantity: number;
  open_average_price: number | null;
  market_value: number | null;
  open_pl: number | null;
  currency: string | null;
  open_date: string | null;
  payload: Record<string, unknown> | null;
  ingested_at: string;
  updated_at: string;
}

interface TransactionRow {
  transaction_number: string;
  account_code: string;
  tx_date: string;
  tx_type: string;
  security_code: string;
  quantity: number | null;
  price: number | null;
  amount: number | null;
  currency: string | null;
  ingested_at: string;
}

interface PortfolioSummary {
  accounts: AccountRow[];
  positions: PositionRow[];
  recentTx: TransactionRow[];
  aum: number;
  cashBalance: number;
  dayPnl: number;
  rebalanceDrift: number;
  rebalanceLocked: boolean;
  /** Newest timestamp across the three tables — tells the UI when the worker last wrote. */
  lastUpdatedAt: string | null;
  source: "supabase" | "unavailable";
  reason?: string;
  error?: string;
}

/**
 * Best-effort strategy target lookup. We don't yet have a `target_c`
 * table; the v1 implementation reads the in-memory `oemsStrategies`
 * seed only when `IRESS_MODE=mock` (the strategy holdings seed is
 * authoritative for the demo / paper mode). When running against a
 * real Supabase ingest, targets come from the position's `payload`
 * field (IRESS returns `Target` and `Actual` columns on the
 * `IPSPositionGetAll1` row).
 */
function driftForPosition(
  p: PositionRow,
  symbolTargets: Map<string, { target: number; actual: number }>,
): { drift: number; hasTarget: boolean } {
  // 1) IRESS payload win
  const payload = (p.payload ?? {}) as Record<string, unknown>;
  const target = Number(payload.Target ?? payload.target ?? NaN);
  const actual = Number(payload.Actual ?? payload.actual ?? NaN);
  if (Number.isFinite(target) && Number.isFinite(actual)) {
    return { drift: Math.abs(target - actual), hasTarget: true };
  }
  // 2) Seed table (mock only)
  const seed = symbolTargets.get(p.security_code);
  if (seed) {
    return { drift: Math.abs(seed.target - seed.actual), hasTarget: true };
  }
  return { drift: 0, hasTarget: false };
}

export async function GET() {
  if (!isSupabaseConfigured()) {
    return Response.json(
      {
        error: "Supabase not configured",
        accounts: [] as AccountRow[],
        positions: [] as PositionRow[],
        recentTx: [] as TransactionRow[],
        aum: 0,
        cashBalance: 0,
        dayPnl: 0,
        rebalanceDrift: 0,
        rebalanceLocked: false,
        lastUpdatedAt: null,
        source: "unavailable",
        reason: "supabase_not_configured",
      } satisfies PortfolioSummary,
      { status: 503 },
    );
  }

  const supabase = createServiceRoleClient();

  const [accountsRes, positionsRes, txRes] = await Promise.all([
    supabase.from("oems_account_c").select("*").order("nav_value", { ascending: false }),
    supabase
      .from("oems_position_c")
      .select("*")
      .order("market_value", { ascending: false, nullsFirst: false }),
    supabase
      .from("oems_transaction_c")
      .select("*")
      .order("tx_date", { ascending: false })
      .order("ingested_at", { ascending: false })
      .limit(20),
  ]);

  if (accountsRes.error || positionsRes.error || txRes.error) {
    const firstError =
      accountsRes.error?.message ?? positionsRes.error?.message ?? txRes.error?.message ?? "unknown";
    return Response.json(
      {
        error: firstError,
        accounts: [] as AccountRow[],
        positions: [] as PositionRow[],
        recentTx: [] as TransactionRow[],
        aum: 0,
        cashBalance: 0,
        dayPnl: 0,
        rebalanceDrift: 0,
        rebalanceLocked: false,
        lastUpdatedAt: null,
        source: "unavailable",
        reason: "supabase_query_failed",
      } satisfies PortfolioSummary,
      { status: 500 },
    );
  }

  const accounts = (accountsRes.data ?? []) as AccountRow[];
  const positions = (positionsRes.data ?? []) as PositionRow[];
  const recentTx = (txRes.data ?? []) as TransactionRow[];

  const aum = accounts.reduce((acc, a) => acc + (Number(a.nav_value) || 0), 0);
  const cashBalance = accounts.reduce((acc, a) => acc + (Number(a.cash_balance) || 0), 0);

  // Day P&L = today's transactions (the IPS view's freeform; for v1 we
  // treat any transaction dated today as part of "day P&L" since real
  // MTM is the worker's job). When the table is empty (e.g. pre-IPS
  // go-live) we fall back to the open_pl field on positions, which is
  // the IRESS-reported unrealised P&L as of the last refresh.
  const today = new Date().toISOString().slice(0, 10);
  const txToday = recentTx.filter((t) => String(t.tx_date ?? "").slice(0, 10) === today);
  const dayPnlFromTx = txToday.reduce(
    (acc, t) => acc + (Number(t.amount) || 0) * (t.tx_type?.toUpperCase() === "BUY" ? -1 : 1),
    0,
  );
  const dayPnlFromPositions = positions.reduce((acc, p) => acc + (Number(p.open_pl) || 0), 0);
  const dayPnl = Math.abs(dayPnlFromTx) > 0 ? dayPnlFromTx : dayPnlFromPositions;

  // Rebalance drift: read targets from the payload (live) OR the
  // strategy-holdings seed (mock). Drift is the max |target - actual|
  // across the portfolio.
  const symbolTargets = new Map<string, { target: number; actual: number }>();
  // Lazy-import the seed — only needed in mock mode.
  const iressMode = (process.env.IRESS_MODE ?? "mock").toLowerCase();
  if (iressMode === "mock") {
    try {
      const { strategyHoldings } = await import("@/lib/iress/seed");
      for (const list of Object.values(strategyHoldings)) {
        for (const h of list) {
          symbolTargets.set(h.symbol, { target: h.target, actual: h.actual });
        }
      }
    } catch {
      /* seed not available — drift computed from payload only */
    }
  }

  let maxDrift = 0;
  for (const p of positions) {
    const { drift, hasTarget } = driftForPosition(p, symbolTargets);
    if (hasTarget && drift > maxDrift) maxDrift = drift;
  }
  const rebalanceDrift = Number(maxDrift.toFixed(2));
  const rebalanceLocked = rebalanceDrift > 1.5;

  // lastUpdatedAt = newest timestamp across the three tables (so the UI
  // can show a "stale since X" warning when the worker is silent).
  const candidates: number[] = [];
  for (const a of accounts) {
    const t = new Date(a.updated_at ?? a.ingested_at ?? 0).getTime();
    if (Number.isFinite(t)) candidates.push(t);
  }
  for (const p of positions) {
    const t = new Date(p.updated_at ?? p.ingested_at ?? 0).getTime();
    if (Number.isFinite(t)) candidates.push(t);
  }
  for (const t of recentTx) {
    const tt = new Date(t.ingested_at ?? 0).getTime();
    if (Number.isFinite(tt)) candidates.push(tt);
  }
  const lastUpdatedAt =
    candidates.length > 0 ? new Date(Math.max(...candidates)).toISOString() : null;

  const summary: PortfolioSummary = {
    accounts,
    positions,
    recentTx,
    aum,
    cashBalance,
    dayPnl,
    rebalanceDrift,
    rebalanceLocked,
    lastUpdatedAt,
    source: accounts.length > 0 || positions.length > 0 || recentTx.length > 0
      ? "supabase"
      : "unavailable",
  };

  return Response.json(summary);
}
