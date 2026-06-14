/**
 * GET /api/client-book
 *
 * Retail "client book" aggregate — the real money MINT manages for its retail
 * customers. Powers the Cockpit's "Platform AUM / Day P&L" tiles while the
 * IRESS institutional portfolio (IPS) feed is blocked.
 *
 * Reads the RETAIL prod DB:
 *   - `client_strategy_returns_c`: one row per (user/family-member/strategy) per
 *     `as_of_date`. We snapshot the LATEST date and sum the book.
 *   - `stock_holdings_c`: count of active holdings across the book.
 *
 * All money values are RANDS (numbers — `basket_value`, `1d_pnl`, `ytd_pnl` are
 * the user's portion in Rands). `source: "retail-supabase"` lets the UI badge
 * the tiles honestly while IPS is unavailable.
 */
import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "@/lib/supabase/server";
import type { BffUnavailableReason } from "@/lib/bff-reasons";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ClientStrategyReturnRow {
  user_id: string;
  family_member_id: string | null;
  strategy_id: string;
  as_of_date: string;
  basket_value: number | null;
  "1d_pnl": number | null;
  "ytd_pnl": number | null;
}

interface ClientBookResponse {
  source: "retail-supabase" | "unavailable";
  aum: number;
  dayPnl: number;
  ytdPnl: number;
  investors: number;
  holdings: number;
  asOf: string | null;
  reason?: BffUnavailableReason;
  error?: string;
}

const RETURNS_SELECT =
  'user_id,family_member_id,strategy_id,as_of_date,basket_value,"1d_pnl","ytd_pnl"';

function num(value: number | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function GET() {
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
        error:
          "Retail Supabase not configured (RETAIL_SUPABASE_URL / RETAIL_SUPABASE_SERVICE_ROLE_KEY)",
      } satisfies ClientBookResponse,
      { status: 503 },
    );
  }

  const supabase = createRetailServiceRoleClient();

  // 1. Latest snapshot date in the book.
  const { data: latestRows, error: latestError } = await supabase
    .from("client_strategy_returns_c")
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

  // 2. All rows for the latest date.
  const { data: rows, error: rowsError } = await supabase
    .from("client_strategy_returns_c")
    .select(RETURNS_SELECT)
    .eq("as_of_date", asOf);

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

  const returns = (rows ?? []) as ClientStrategyReturnRow[];
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

  // 3. Aggregate the book.
  let aum = 0;
  let dayPnl = 0;
  let ytdPnl = 0;
  const investorSet = new Set<string>();
  for (const r of returns) {
    aum += num(r.basket_value);
    dayPnl += num(r["1d_pnl"]);
    ytdPnl += num(r["ytd_pnl"]);
    if (r.user_id) investorSet.add(r.user_id);
  }

  // Active holdings — counted separately from `stock_holdings_c`. A count
  // failure must not blank the AUM tile, so degrade holdings to 0.
  let holdings = 0;
  const { count, error: holdingsError } = await supabase
    .from("stock_holdings_c")
    .select("*", { count: "exact", head: true })
    .eq("is_active", true);
  if (!holdingsError) holdings = count ?? 0;

  return Response.json({
    source: "retail-supabase",
    aum,
    dayPnl,
    ytdPnl,
    investors: investorSet.size,
    holdings,
    asOf,
  } satisfies ClientBookResponse);
}
