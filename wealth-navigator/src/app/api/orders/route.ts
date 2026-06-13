import { createServiceRoleClient, isSupabaseConfigured } from "@/lib/supabase/server";
import { isSupabaseSchemaMissing, type BffUnavailableReason } from "@/lib/bff-reasons";
import type { Order, OrderDestination, OrderSide, OrderState, OrderTIF, OrderType } from "@/types/iress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS_TO_STATE: Record<string, OrderState> = {
  working: "WORKING",
  partial: "PARTIAL",
  filled: "FILLED",
  cancelled: "CANCELLED",
  rejected: "REJECTED",
  created: "WORKING",
  amended: "WORKING",
};

const SIDE_TO_ORDER: Record<string, OrderSide> = {
  buy: "BUY",
  sell: "SELL",
  sell_short: "SELL",
  buy_cover: "BUY",
};

interface AuditRow {
  id: string;
  order_id: string;
  client_account: string;
  symbol: string;
  side: string;
  quantity: number;
  price_cents: number | null;
  status: string;
  source: string;
  payload: Record<string, unknown>;
  result_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

function mapAuditRow(row: AuditRow): Order {
  const payload = row.payload ?? {};
  const result = row.result_payload ?? {};
  const limit = row.price_cents != null ? Number(row.price_cents) / 100 : null;
  const arrivalMid = typeof result.arrivalMid === "number" ? result.arrivalMid : limit ?? 0;
  const filled = typeof payload.filled === "number" ? payload.filled : 0;
  const tsRaw = payload.ts;
  const ts = typeof tsRaw === "number" ? tsRaw : new Date(row.updated_at).getTime();

  return {
    id: row.order_id,
    account: row.client_account,
    strategy: typeof payload.strategy === "string" ? payload.strategy : "—",
    side: SIDE_TO_ORDER[row.side] ?? "BUY",
    symbol: row.symbol,
    isin: typeof payload.isin === "string" ? payload.isin : "",
    type: (typeof payload.type === "string" ? payload.type : "LMT") as OrderType,
    tif: (typeof payload.tif === "string" ? payload.tif : "DAY") as OrderTIF,
    destination: (typeof payload.destination === "string" ? payload.destination : "JSE") as OrderDestination,
    qty: Number(row.quantity) || 0,
    filled,
    limit,
    stop: null,
    avgPx: typeof payload.avgPx === "number" ? payload.avgPx : arrivalMid,
    vwap: typeof payload.vwap === "number" ? payload.vwap : arrivalMid,
    trader: typeof payload.trader === "string" ? payload.trader : "—",
    ts,
    state: STATUS_TO_STATE[row.status] ?? "WORKING",
    rejectReason: typeof result.rejectReason === "string" ? result.rejectReason : undefined,
    slippageBps: typeof result.slippageBps === "number" ? result.slippageBps : 0,
    arrivalMid,
    orderTag: typeof payload.orderTag === "string" ? payload.orderTag : row.order_id,
  };
}

/**
 * GET /api/orders?account=...&state=WORKING
 * Reads `oems_order_audit` via service role (RLS denies anon reads).
 */
export async function GET(req: Request) {
  if (!isSupabaseConfigured()) {
    return Response.json(
      {
        error: "Supabase not configured",
        orders: [] as Order[],
        source: "unavailable",
        reason: "supabase_not_configured",
        migration: "supabase/migrations/20260613000000_oems_order_audit.sql",
      },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const account = url.searchParams.get("account") ?? undefined;
  const stateFilter = url.searchParams.get("state") ?? undefined;
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 500);

  const supabase = createServiceRoleClient();
  let query = supabase
    .from("oems_order_audit")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (account) query = query.eq("client_account", account);

  const { data, error } = await query;
  if (error) {
    const reason: BffUnavailableReason = "supabase_query_failed";
    return Response.json(
      {
        error: error.message,
        orders: [] as Order[],
        source: "unavailable",
        reason,
        migration: isSupabaseSchemaMissing(error)
          ? "supabase/migrations/20260613000000_oems_order_audit.sql"
          : undefined,
      },
      { status: 200 },
    );
  }

  let orders = ((data ?? []) as AuditRow[]).map(mapAuditRow);

  if (stateFilter && stateFilter !== "ALL") {
    orders = orders.filter((o) => o.state === stateFilter);
  }

  return Response.json({
    orders,
    count: orders.length,
    source: orders.length > 0 ? "supabase" : "unavailable",
    reason: orders.length === 0 ? "empty" : undefined,
  });
}
