/**
 * GET /api/client-book
 *
 * Retail "client book" aggregate — the real money MINT manages for its retail
 * customers. Powers the Cockpit's "Platform AUM / Day P&L" tiles while the
 * IRESS institutional portfolio (IPS) feed is blocked.
 *
 * Only LIVE money counts: UAT strategies and test accounts are excluded on both
 * axes (a test account can hold a LIVE strategy, and vice versa).
 *
 * AUM and counts come from the shared canonical holdings-based calculation.
 * Day/YTD P&L read the GUARDED `client_strategy_returns_effective_c` view
 * (same personal-return contract MINT's /api/returns/approved and this repo's
 * own factsheets route already use), not the raw `client_strategy_returns_c`
 * table. There is no CERTIFIED table at the per-client level yet -- only
 * strategy-level performance has reached that stage
 * (`strategy_canonical_daily_ledger_c`); personal/owner P&L is a distinct
 * concern (it reflects each investor's own cash-flow timing) and must not be
 * replaced by model-strategy performance, so this stays on the guarded view
 * rather than being pointed at the strategy canonical ledger.
 *
 * All money values are RANDS (numbers — `basket_value`, `1d_pnl`, `ytd_pnl` are
 * the user's portion in Rands). `source: "retail-supabase"` lets the UI badge
 * the tiles honestly while IPS is unavailable.
 */
import type { BffUnavailableReason } from "@/lib/bff-reasons";
import { getAdminContext } from "@/lib/admin/rbac";
import { loadCanonicalRetailAum } from "@/lib/aum/canonical-retail-aum";
import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ClientStrategyReturnRow {
  user_id: string;
  strategy_id: string;
  as_of_date: string;
  basket_value_cents: number | null;
  "1d_pct": number | null;
  ytd_pct: number | null;
}

/** P&L in cents implied by a stored pct against the CURRENT basket value —
 * same formula useUserStrategies.js already uses for this exact backing-out. */
function pnlCentsFromPct(basketValueCents: number, pct: number | null): number {
  if (pct == null || !Number.isFinite(pct)) return 0;
  return basketValueCents - basketValueCents / (1 + pct / 100);
}

interface ClientBookResponse {
  source: "retail-supabase" | "unavailable";
  aum: number;
  dayPnl: number;
  ytdPnl: number;
  investors: number;
  holdings: number;
  asOf: string | null;
  investorRows?: Array<{
    id: string;
    name: string;
    accountCode: string | null;
    aum: number;
    dayPnl: number;
    ytdPnl: number;
    holdings: number;
    strategies: string[];
  }>;
  reason?: BffUnavailableReason;
  error?: string;
}

const RETURNS_SELECT = 'user_id,strategy_id,as_of_date,basket_value_cents,"1d_pct","ytd_pct"';

function num(value: number | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function GET() {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return Response.json({ source: "unavailable", error: "no-session" }, { status: 401 });
  if (auth.status !== "ok")
    return Response.json({ source: "unavailable", error: "forbidden" }, { status: 403 });

  if (!isRetailSupabaseConfigured()) {
    return Response.json(
      {
        source: "unavailable",
        aum: 0,
        dayPnl: 0,
        ytdPnl: 0,
        investors: 0,
        holdings: 0,
        asOf: null,
        reason: "supabase_not_configured",
        error: "Retail Supabase not configured (RETAIL_SUPABASE_URL / RETAIL_SUPABASE_SERVICE_ROLE_KEY)",
      } satisfies ClientBookResponse,
      { status: 503 },
    );
  }

  const supabase = createRetailServiceRoleClient();
  let canonicalAum: Awaited<ReturnType<typeof loadCanonicalRetailAum>>;
  try {
    canonicalAum = await loadCanonicalRetailAum(supabase);
  } catch (error) {
    return Response.json(
      {
        source: "unavailable",
        aum: 0,
        dayPnl: 0,
        ytdPnl: 0,
        investors: 0,
        holdings: 0,
        asOf: null,
        reason: "supabase_query_failed",
        error: `Canonical LIVE AUM unavailable: ${error instanceof Error ? error.message : String(error)}`,
      } satisfies ClientBookResponse,
      { status: 200 },
    );
  }

  // 1. Latest snapshot date in the book.
  const { data: latestRows, error: latestError } = await supabase
    .from("client_strategy_returns_effective_c")
    .select("as_of_date")
    .order("as_of_date", { ascending: false })
    .limit(1);

  if (latestError) {
    return Response.json(
      {
        source: "unavailable",
        aum: 0,
        dayPnl: 0,
        ytdPnl: 0,
        investors: 0,
        holdings: 0,
        asOf: null,
        reason: "supabase_query_failed",
        error: latestError.message,
      } satisfies ClientBookResponse,
      { status: 200 },
    );
  }

  const asOf = (latestRows?.[0]?.as_of_date as string | undefined) ?? null;
  if (!asOf) {
    return Response.json(
      {
        source: "unavailable",
        aum: 0,
        dayPnl: 0,
        ytdPnl: 0,
        investors: 0,
        holdings: 0,
        asOf: null,
        reason: "empty",
      } satisfies ClientBookResponse,
      { status: 200 },
    );
  }

  // 2. All rows for the latest date, plus the two exclusion sets below.
  //
  // AUM is a real-money figure. UAT strategies and test accounts are neither,
  // and left unfiltered they dominated it: on 2026-08-11 the tile read
  // R56,261.61 when the genuine live book was R16,793.52 — 70% of it was
  // test data. Excluded on BOTH axes, because they don't fully overlap: a
  // test account can hold a LIVE strategy (a tester buying MyGrowthFund) and
  // a real client can appear against a UAT strategy.
  const [{ data: rows, error: rowsError }, stratRes, testProfileRes, testWalletRes, profilesRes] = await Promise.all([
    supabase.from("client_strategy_returns_effective_c").select(RETURNS_SELECT).eq("as_of_date", asOf),
    supabase.from("strategies_c").select("id, name, investor_environment"),
    supabase.from("profiles").select("id").eq("is_test", true),
    supabase.from("wallets").select("user_id").eq("status", "test"),
    supabase.from("profiles").select("id,first_name,last_name,email,mint_number"),
  ]);

  if (rowsError) {
    return Response.json(
      {
        source: "unavailable",
        aum: 0,
        dayPnl: 0,
        ytdPnl: 0,
        investors: 0,
        holdings: 0,
        asOf,
        reason: "supabase_query_failed",
        error: rowsError.message,
      } satisfies ClientBookResponse,
      { status: 200 },
    );
  }

  // Fail CLOSED on the exclusion sets: if we can't tell which strategies are
  // UAT or which accounts are test, publishing an unfiltered total would
  // overstate real AUM. Better to show the tile unavailable than a wrong number.
  if (stratRes.error || testProfileRes.error || testWalletRes.error || profilesRes.error) {
    return Response.json(
      {
        source: "unavailable",
        aum: 0,
        dayPnl: 0,
        ytdPnl: 0,
        investors: 0,
        holdings: 0,
        asOf,
        reason: "supabase_query_failed",
        error: `LIVE/test classification unavailable: ${
          stratRes.error?.message ??
          testProfileRes.error?.message ??
          testWalletRes.error?.message ??
          profilesRes.error?.message
        }`,
      } satisfies ClientBookResponse,
      { status: 200 },
    );
  }

  const uatStrategyIds = new Set(
    ((stratRes.data ?? []) as Array<{ id: string; name: string | null; investor_environment: string | null }>)
      .filter((s) => String(s.investor_environment ?? "LIVE").toUpperCase() === "UAT")
      .map((s) => s.id),
  );
  const testUserIds = new Set<string>([
    ...((testProfileRes.data ?? []) as Array<{ id: string }>).map((r) => String(r.id)),
    ...((testWalletRes.data ?? []) as Array<{ user_id: string }>).map((r) => String(r.user_id)),
  ]);

  const returns = ((rows ?? []) as ClientStrategyReturnRow[]).filter(
    (r) => !uatStrategyIds.has(r.strategy_id) && !testUserIds.has(r.user_id),
  );
  if (returns.length === 0) {
    return Response.json(
      {
        source: "unavailable",
        aum: 0,
        dayPnl: 0,
        ytdPnl: 0,
        investors: 0,
        holdings: 0,
        asOf,
        reason: "empty",
      } satisfies ClientBookResponse,
      { status: 200 },
    );
  }

  // 3. Aggregate P&L only. AUM and counts come from the canonical helper.
  // The effective view stores pct, not a cents P&L column, so back out cents
  // from the CURRENT basket value the same way useUserStrategies.js does.
  let dayPnl = 0;
  let ytdPnl = 0;
  for (const r of returns) {
    const basketValueCents = num(r.basket_value_cents);
    dayPnl += pnlCentsFromPct(basketValueCents, r["1d_pct"]);
    ytdPnl += pnlCentsFromPct(basketValueCents, r.ytd_pct);
  }

  const strategyNameById = new Map(
    ((stratRes.data ?? []) as Array<{ id: string; name: string | null }>).map((row) => [
      row.id,
      row.name?.trim() || "Unnamed strategy",
    ]),
  );
  const profileById = new Map(
    ((profilesRes.data ?? []) as Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      mint_number: string | null;
    }>).map((row) => [row.id, row]),
  );
  const investorById = new Map<
    string,
    { aumCents: number; dayPnlCents: number; ytdPnlCents: number; holdings: number; strategies: Set<string> }
  >();

  for (const position of canonicalAum.byPosition.values()) {
    const investor = investorById.get(position.userId) ?? {
      aumCents: 0,
      dayPnlCents: 0,
      ytdPnlCents: 0,
      holdings: 0,
      strategies: new Set<string>(),
    };
    investor.aumCents += position.aumCents;
    investor.holdings += position.holdingCount;
    investor.strategies.add(strategyNameById.get(position.strategyId) ?? "Unnamed strategy");
    investorById.set(position.userId, investor);
  }
  for (const row of returns) {
    const investor = investorById.get(row.user_id);
    if (!investor) continue;
    const basketValueCents = num(row.basket_value_cents);
    investor.dayPnlCents += pnlCentsFromPct(basketValueCents, row["1d_pct"]);
    investor.ytdPnlCents += pnlCentsFromPct(basketValueCents, row.ytd_pct);
  }

  const investorRows = [...investorById.entries()]
    .map(([id, investor]) => {
      const profile = profileById.get(id);
      const name = `${profile?.first_name ?? ""} ${profile?.last_name ?? ""}`.trim();
      return {
        id,
        name: name || profile?.email || `Investor ${id.slice(0, 8)}`,
        accountCode: profile?.mint_number ?? null,
        aum: investor.aumCents / 100,
        dayPnl: investor.dayPnlCents / 100,
        ytdPnl: investor.ytdPnlCents / 100,
        holdings: investor.holdings,
        strategies: [...investor.strategies].sort((a, b) => a.localeCompare(b)),
      };
    })
    .sort((a, b) => b.aum - a.aum || a.name.localeCompare(b.name));

  // basket_value / 1d_pnl / ytd_pnl are integer CENTS in retail (they match the
  // holdings_snapshot prices), despite the legacy docs saying Rands — convert.
  return Response.json({
    source: "retail-supabase",
    aum: canonicalAum.totalAumCents / 100,
    dayPnl: dayPnl / 100,
    ytdPnl: ytdPnl / 100,
    investors: canonicalAum.investorCount,
    holdings: canonicalAum.holdingCount,
    asOf: canonicalAum.asOf.slice(0, 10),
    investorRows,
  } satisfies ClientBookResponse);
}
