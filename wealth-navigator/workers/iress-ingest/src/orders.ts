/**
 * Worker order poll — v1 is read-only.
 *
 * Polls IRESS `OrderPadGetByAccount` for the configured `IRESS_ACCOUNT_CODE`
 * accounts and upserts the observed orders into `oems_order_audit` so the
 * audit trail is current with what the broker shows.
 *
 * v1 deliberately does NOT post orders: the worker is a polling mirror, not
 * a control surface. OrderCreate3 / OrderAmend2 stay on the Vercel BFF.
 *
 * Dry-run safe: if `IRESS_WORKER_DRY_RUN=1` or `SUPABASE_ALLOW_WRITES=0`,
 * the worker logs the would-be upserts and never touches Supabase.
 */

import { getIressClient } from "../../../src/lib/iress/index";
import { iressQueries } from "../../../src/lib/iress/mock";
import { IressError, isIressSessionDeadError } from "../../../src/lib/iress/errors";
import type { Order, OrderState } from "../../../src/types/iress";
import type { WorkerEnv } from "./env";
import type { WorkerMintSession, WorkerSessionManager } from "./session";
import type { WorkerSupabase } from "./supabase";

export interface OrderPollResult {
  polled: number;
  upserted: number;
  accounts: string[];
}

const STATE_MAP: Record<OrderState, string> = {
  WORKING: "working",
  PARTIAL: "partial",
  FILLED: "filled",
  CANCELLED: "cancelled",
  REJECTED: "rejected",
};

function mapStateToDb(state: OrderState): string {
  return STATE_MAP[state] ?? "created";
}

function mapSide(side: "BUY" | "SELL"): string {
  return side === "BUY" ? "buy" : "sell";
}

function newRequestID(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface OrderAuditRow {
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
  updated_at: string;
}

function toAuditRow(order: Order): OrderAuditRow {
  const limit = order.limit ?? null;
  return {
    order_id: order.orderTag || order.id,
    client_account: order.account,
    symbol: order.symbol,
    side: mapSide(order.side),
    quantity: order.qty,
    price_cents: limit !== null ? Math.round(limit * 100) : null,
    status: mapStateToDb(order.state),
    source: "IRESS",
    payload: {
      orderTag: order.orderTag,
      type: order.type,
      tif: order.tif,
      destination: order.destination,
      isin: order.isin,
      avgPx: order.avgPx,
      vwap: order.vwap,
      filled: order.filled,
      trader: order.trader,
      ts: order.ts,
    },
    result_payload: {
      rejectReason: order.rejectReason,
      slippageBps: order.slippageBps,
      arrivalMid: order.arrivalMid,
      state: order.state,
    },
    updated_at: new Date().toISOString(),
  };
}

interface PositionUpsertRow {
  account_code: string;
  security_code: string;
  exchange: string | null;
  quantity: number;
  open_average_price: number | null;
  market_value: number | null;
  open_pl: number | null;
  currency: string | null;
  payload: Record<string, unknown>;
  updated_at: string;
}

/**
 * Derive net positions from filled orders — we don't use IPS (confirmed with
 * Andre), so positions come from IOS+ order fills. Net qty per (account,
 * security) = Σ DoneVolumeTotal signed by buy/sell; open average price is the
 * volume-weighted buy fill price. `market_value` / `open_pl` are left null
 * (no live mark wired yet). Reads 0 when there are no current fills (e.g. a
 * book of expired/unfilled demo orders) — which is the correct empty state.
 *
 * Prices come off the order rows in cents (same unit as quotes); we divide to
 * Rands for `open_average_price` to match the portfolio view's formatting.
 */
export function derivePositions(orders: Order[]): PositionUpsertRow[] {
  const ts = new Date().toISOString();
  const agg = new Map<
    string,
    { account: string; symbol: string; netQty: number; buyQty: number; buyCostCents: number }
  >();
  for (const o of orders) {
    if (!o.filled || o.filled <= 0) continue; // only fills contribute to a position
    const key = `${o.account}|${o.symbol}`;
    const a = agg.get(key) ?? { account: o.account, symbol: o.symbol, netQty: 0, buyQty: 0, buyCostCents: 0 };
    a.netQty += o.filled * (o.side === "BUY" ? 1 : -1);
    if (o.side === "BUY") {
      a.buyQty += o.filled;
      a.buyCostCents += o.filled * (o.avgPx || 0);
    }
    agg.set(key, a);
  }
  const out: PositionUpsertRow[] = [];
  for (const a of agg.values()) {
    if (a.netQty === 0) continue;
    const avgCostCents = a.buyQty > 0 ? a.buyCostCents / a.buyQty : 0;
    out.push({
      account_code: a.account,
      security_code: a.symbol,
      exchange: "JSE",
      quantity: a.netQty,
      open_average_price: avgCostCents > 0 ? Number((avgCostCents / 100).toFixed(4)) : null,
      market_value: null,
      open_pl: null,
      currency: "ZAR",
      payload: { derivedFrom: "iress-iosplus-orderpad-fills", buyQty: a.buyQty },
      updated_at: ts,
    });
  }
  return out;
}

async function fetchOrdersForAccount(
  session: WorkerMintSession,
  accountCode: string,
): Promise<Order[]> {
  const iosKey = session.serviceKeys.IOSPlus;
  if (!iosKey) {
    throw new Error("IOSPlus service session not available for order poll");
  }
  const client = getIressClient("live");
  const res = await client.orderPadGetByAccount({
    ServiceSessionKey: iosKey,
    AccountCode: accountCode,
    OrderFilter: 3, // ALL orders — feeds the audit/blotter history AND the
    // positions-from-fills derivation (net DoneVolumeTotal per security).
    RequestID: newRequestID(`pad-${accountCode}`),
  });
  return res.DataRows;
}

export interface OrderPollOptions {
  env: WorkerEnv;
  sessions: WorkerSessionManager;
  supabase: WorkerSupabase | null;
  accounts?: string[];
}

export async function pollAccountsForOrders(
  opts: OrderPollOptions,
): Promise<OrderPollResult> {
  // Read mode from the worker env (not the shared `iressConfig`) so the
  // test runner — which inherits IRESS_MODE=live from .env.local — doesn't
  // accidentally flip the stub into the SOAP path during unit tests.
  const isLive = opts.env.iressMode === "live" || opts.env.iressMode === "wsdl-stub";
  const accounts = (opts.accounts ?? [opts.env.iressAccountCode])
    .map((s) => s.trim())
    .filter(Boolean);

  if (accounts.length === 0) {
    return { polled: 0, upserted: 0, accounts: [] };
  }

  let orders: Order[] = [];
  if (isLive) {
    try {
      await opts.sessions.withSession(async (session) => {
        for (const account of accounts) {
          try {
            const rows = await fetchOrdersForAccount(session, account);
            orders = orders.concat(rows);
          } catch (err) {
            if (isIressSessionDeadError(err) || (err instanceof IressError && err.code === 25001)) {
              throw err;
            }
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[iress-ingest] order poll(${account}) failed: ${msg}`);
          }
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] order poll session failed: ${msg}`);
    }
  } else {
    const mockOrders = await iressQueries.orders();
    orders = mockOrders.filter((o) => accounts.includes(o.account));
  }

  if (orders.length === 0) {
    return { polled: accounts.length, upserted: 0, accounts };
  }

  const rows = orders.map(toAuditRow);
  if (opts.env.dryRun || !opts.env.allowWrites || !opts.supabase) {
    console.info(
      JSON.stringify({
        level: "info",
        event: "would_upsert_oems_order_audit",
        accounts,
        count: rows.length,
        sample: rows.slice(0, 3),
      }),
    );
    return { polled: accounts.length, upserted: 0, accounts };
  }

  const { error } = await opts.supabase
    .from("oems_order_audit")
    .upsert(rows, { onConflict: "order_id" });
  if (error) {
    console.error(`[iress-ingest] oems_order_audit upsert failed: ${error.message}`);
    return { polled: accounts.length, upserted: 0, accounts };
  }

  // Positions-from-fills snapshot. We don't use IPS, so positions are the net
  // of order fills (see derivePositions). Snapshot-replace per polled account
  // (delete then insert) so closed/expired positions clear out — no dependence
  // on a unique-constraint name for upsert, and scoped strictly to the polled
  // OEMS accounts (never touches customer tables). Reads 0 on a book with no
  // current fills, which is the correct empty state.
  try {
    const positions = derivePositions(orders);
    const { error: delErr } = await opts.supabase
      .from("oems_position_c")
      .delete()
      .in("account_code", accounts);
    if (delErr) {
      console.warn(`[iress-ingest] oems_position_c clear failed: ${delErr.message}`);
    } else if (positions.length > 0) {
      const { error: posErr } = await opts.supabase.from("oems_position_c").insert(positions);
      if (posErr) {
        console.error(`[iress-ingest] oems_position_c insert failed: ${posErr.message}`);
      } else {
        console.info(
          JSON.stringify({ level: "info", event: "oems_position_c_snapshot", accounts, count: positions.length }),
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[iress-ingest] positions derivation failed: ${msg}`);
  }

  return { polled: accounts.length, upserted: rows.length, accounts };
}
