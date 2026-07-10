/**
 * UAT order poller — Mint OEM Finalisation Phase UAT.
 *
 * Polls IRESS `OrderPadGetByAccount` for the worker-configured
 * `IRESS_UAT_ACCOUNT_CODE` (a *separate* broker account from the production
 * `IRESS_ACCOUNT_CODE`) and writes observed fills back into
 * `oems_order_audit` so the OEMS Order Book UI can render live execution
 * state during UAT.
 *
 * Differs from the production order poll in `orders.ts`:
 *  - only ever touches the UAT account (never real client books)
 *  - reads broker state then UPDATES existing audit rows by `iress_order_number`
 *    (the production poll delete-and-inserts by order_id; the UAT path leaves
 *    the original audit row intact and only stamps the live fill deltas)
 *  - emits change events on the in-process `UatExecutionHub` so the
 *    `/uat/execution-stream` SSE endpoint can push deltas to subscribed UIs
 *
 * Safety:
 *  - the loop is a no-op unless `IRESS_UAT_MODE=1`
 *  - the loop refuses to start if `IRESS_UAT_ACCOUNT_CODE` is empty when UAT
 *    mode is on (caller pre-validates)
 *  - the loop honours `IRESS_WORKER_DRY_RUN` and `SUPABASE_ALLOW_WRITES` like
 *    every other write path
 */

import { IressError, isIressSessionDeadError } from "../../../src/lib/iress/errors";
import { getIressClient } from "../../../src/lib/iress/index";
import type { Order, OrderState } from "../../../src/types/iress";
import type { WorkerEnv } from "./env";
import type { WorkerMintSession, WorkerSessionManager } from "./session";
import type { WorkerSupabase } from "./supabase";

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

export interface UatExecutionDelta {
  /** The broker-assigned `OrderNumber` returned by `OrderCreate3`. */
  iressOrderNumber: string;
  /** Audit row this delta applies to (null when we haven't written one yet). */
  orderAuditId: string | null;
  state: string;
  filled: number;
  avgFillPrice: number | null;
  lastFillTimestamp: string | null;
  /** Full poll row (for new UAT orders the SSE consumer has never seen). */
  raw: Order;
  /** Book id (payload.book_id) — null for fresh-from-IRESS rows. */
  bookId: string | null;
  observedAt: string;
}

type Subscriber = (delta: UatExecutionDelta) => void;

class UatExecutionHub {
  private subs = new Set<Subscriber>();
  /** Most recent snapshot per (iressOrderNumber) — keyed so we only push diffs. */
  private lastState = new Map<string, { state: string; filled: number; ts: string }>();

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  publish(delta: UatExecutionDelta): void {
    const prev = this.lastState.get(delta.iressOrderNumber);
    const next = { state: delta.state, filled: delta.filled, ts: delta.observedAt };
    const changed = !prev || prev.state !== next.state || prev.filled !== next.filled;
    this.lastState.set(delta.iressOrderNumber, next);
    if (!changed) return;
    for (const fn of this.subs) {
      try {
        fn(delta);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[iress-ingest] uat execution subscriber threw: ${msg}`);
      }
    }
  }

  /** Force the next poll to publish even if state hasn't changed (used by the initial snapshot). */
  reset(): void {
    this.lastState.clear();
  }
}

export const uatExecutionHub = new UatExecutionHub();

async function fetchUatOrders(session: WorkerMintSession, account: string): Promise<Order[]> {
  const iosKey = session.serviceKeys.IOSPlus;
  if (!iosKey) {
    throw new Error("IOSPlus service session not available for UAT order poll");
  }
  const client = getIressClient("live");
  const res = await client.orderPadGetByAccount({
    ServiceSessionKey: iosKey,
    AccountCode: account,
    OrderFilter: 1, // WORKING only — the UAT flow cares about in-flight orders;
    // historical fills are written via the order-creation ack and don't need
    // to be re-polled.
    RequestID: newRequestID(`uat-pad-${account}`),
  });
  return res.DataRows;
}

interface AuditRow {
  id: string;
  order_id: string;
  client_account: string;
  symbol: string;
  side: string;
  quantity: number;
  price_cents: number | null;
  status: string;
  source: string | null;
  payload: Record<string, unknown>;
  result_payload: Record<string, unknown>;
}

interface AuditUpdate {
  id: string;
  payload: Record<string, unknown>;
  result_payload: Record<string, unknown>;
  status: string;
}

export interface UatOrderPollResult {
  polled: number;
  /** Audit rows that received a state/fill update this cycle. */
  updated: number;
  /** Deltas that were published to the SSE hub this cycle. */
  published: number;
  /** Total time taken. */
  elapsedMs: number;
  /** Empty when the loop is gated off. */
  skipReason: string | null;
}

export interface UatOrderPollOptions {
  env: WorkerEnv;
  sessions: WorkerSessionManager;
  supabase: WorkerSupabase | null;
}

export async function pollUatForFills(opts: UatOrderPollOptions): Promise<UatOrderPollResult> {
  const started = Date.now();
  const skip = (reason: string): UatOrderPollResult => ({
    polled: 0,
    updated: 0,
    published: 0,
    elapsedMs: Date.now() - started,
    skipReason: reason,
  });

  if (!opts.env.uatMode) return skip("uat_mode_disabled");
  if (!opts.env.uatAccountCode) return skip("uat_account_not_configured");

  const isLive = opts.env.iressMode === "live" || opts.env.iressMode === "wsdl-stub";
  if (!isLive) {
    // In mock mode the UAT flow is fully simulated by the audit-write side
    // (the BFF already wrote a working audit row). Polling is a no-op.
    return skip("iress_mode_not_live");
  }

  let orders: Order[] = [];
  try {
    await opts.sessions.withSession(async (session) => {
      orders = await fetchUatOrders(session, opts.env.uatAccountCode);
    });
  } catch (err) {
    if (isIressSessionDeadError(err) || (err instanceof IressError && err.code === 25001)) {
      // Session is dead — withSession already invalidates + rebuilds; surface
      // the recovery hint to the operator.
      console.warn(`[iress-ingest] uat poll session died: ${(err as Error).message}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[iress-ingest] uat poll failed: ${msg}`);
    }
    return skip("poll_failed");
  }

  if (orders.length === 0) {
    return { polled: 1, updated: 0, published: 0, elapsedMs: Date.now() - started, skipReason: null };
  }

  // Match observed orders back to their audit rows by `iress_order_number`
  // (stored in payload). The audit row was created by the BFF at send-to-market
  // time; the worker stamped the OrderNumber when OrderCreate3 returned it.
  const iressOrderNumbers = orders
    .map((o) => o.id)
    .filter((id): id is string => Boolean(id && id.length > 0));

  if (opts.env.dryRun || !opts.env.allowWrites || !opts.supabase) {
    console.info(
      JSON.stringify({
        level: "info",
        event: "uat_poll_dry_run",
        uatAccount: opts.env.uatAccountCode,
        count: orders.length,
        sample: orders.slice(0, 3).map((o) => ({
          orderNumber: o.id,
          state: o.state,
          filled: o.filled,
          avgPx: o.avgPx,
        })),
      }),
    );
    return { polled: 1, updated: 0, published: 0, elapsedMs: Date.now() - started, skipReason: null };
  }

  // Read existing audit rows tagged with one of the observed OrderNumbers.
  // PostgREST can't `.in()` inside jsonb arrays, so we filter on `order_id`
  // (the broker number) which is the column we store it under.
  const { data: matches, error: matchErr } = await opts.supabase
    .from("oems_order_audit")
    .select(
      "id, order_id, client_account, symbol, side, quantity, price_cents, status, source, payload, result_payload",
    )
    .in("order_id", iressOrderNumbers);

  if (matchErr) {
    console.warn(`[iress-ingest] uat audit match read failed: ${matchErr.message}`);
    return skip("audit_read_failed");
  }

  const auditByNumber = new Map<string, AuditRow>();
  for (const r of (matches ?? []) as AuditRow[]) {
    auditByNumber.set(r.order_id, r);
  }

  const updates: AuditUpdate[] = [];
  const observedAt = new Date().toISOString();
  let published = 0;

  for (const order of orders) {
    if (!order.id) continue;
    const audit = auditByNumber.get(order.id);
    const fillQty = Number(order.filled) || 0;
    const avgFillPrice = order.avgPx != null && Number.isFinite(order.avgPx) ? order.avgPx : null;
    const state = mapStateToDb(order.state);

    // Publish first so subscribers see the latest regardless of write success.
    uatExecutionHub.publish({
      iressOrderNumber: order.id,
      orderAuditId: audit?.id ?? null,
      state,
      filled: fillQty,
      avgFillPrice,
      lastFillTimestamp: observedAt,
      raw: order,
      bookId: audit && typeof audit.payload?.book_id === "string" ? (audit.payload.book_id as string) : null,
      observedAt,
    });
    published += 1;

    if (!audit) continue; // Not our row — don't write.

    const prevPayload = audit.payload ?? {};
    const prevResult = audit.result_payload ?? {};
    const newPayload: Record<string, unknown> = {
      ...prevPayload,
      filled: fillQty,
      avgPx: avgFillPrice,
      lastFillAt: observedAt,
      brokerState: order.state,
    };
    const newResult: Record<string, unknown> = {
      ...prevResult,
      avgFillPrice,
      brokerState: order.state,
      lastObservedAt: observedAt,
    };
    // Slippage / day-1 P&L refresh so the UI updates without waiting for
    // a manual /fills POST.
    if (avgFillPrice != null) {
      const limitRands =
        typeof prevPayload.limitPrice === "number"
          ? (prevPayload.limitPrice as number)
          : audit.price_cents != null
            ? Number(audit.price_cents) / 100
            : null;
      if (limitRands != null) {
        newResult.slippageBps = Math.round(
          ((limitRands - avgFillPrice) * 10000) / Math.max(0.0001, limitRands),
        );
        newResult.dayOnePnlCents = Math.round((limitRands - avgFillPrice) * 100) * fillQty;
      }
    }
    updates.push({
      id: audit.id,
      payload: newPayload,
      result_payload: newResult,
      status: state,
    });
  }

  if (updates.length === 0) {
    return { polled: 1, updated: 0, published, elapsedMs: Date.now() - started, skipReason: null };
  }

  // Apply updates. Per-row update keeps the audit trail honest — we never
  // delete or rewrite the row, only stamp fresh state.
  const writeResults = await Promise.all(
    updates.map((u) => {
      const supabase = opts.supabase;
      if (!supabase) return Promise.resolve({ ok: false, reason: "no_supabase_client" as const });
      return supabase
        .from("oems_order_audit")
        .update({
          payload: u.payload,
          result_payload: u.result_payload,
          status: u.status,
          updated_at: observedAt,
        })
        .eq("id", u.id);
    }),
  );
  const failed = writeResults.find((r) => "error" in r && r.error);
  if (failed && "error" in failed && failed.error) {
    console.warn(`[iress-ingest] uat audit write failed: ${failed.error.message}`);
    return {
      polled: 1,
      updated: 0,
      published,
      elapsedMs: Date.now() - started,
      skipReason: "audit_write_failed",
    };
  }

  console.info(
    JSON.stringify({
      level: "info",
      event: "uat_audit_updated",
      uatAccount: opts.env.uatAccountCode,
      matched: updates.length,
      published,
      states: updates.map((u) => u.status),
    }),
  );

  return { polled: 1, updated: updates.length, published, elapsedMs: Date.now() - started, skipReason: null };
}

/** Track the last UAT poll timestamp so `/uat/execution-stream` can show staleness. */
let lastUatPollAt: string | undefined;

export function getLastUatPollAt(): string | undefined {
  return lastUatPollAt;
}

export function stampLastUatPollAt(): void {
  lastUatPollAt = new Date().toISOString();
}
