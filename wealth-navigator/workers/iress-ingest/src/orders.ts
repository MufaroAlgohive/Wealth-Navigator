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
    OrderFilter: 1, // WORKING only; widen to 3 (all) when audit needs history
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
  return { polled: accounts.length, upserted: rows.length, accounts };
}
