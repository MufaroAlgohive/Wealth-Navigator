/**
 * Broker fill ingest.
 *
 * Two responsibilities:
 *
 *   1. Fetch fills since the last successful poll.
 *      - Mock mode: synthesize fills for every `working` row in
 *        `oems_order_audit` so the desk can verify the end-to-end flow
 *        without a live broker.
 *      - Live mode: hit the broker API (NOT IMPLEMENTED — vendor pending
 *        per Lonwabo); any live-mode request fails loud and the worker
 *        keeps the safety posture.
 *
 *   2. Apply fills to `oems_order_audit` keyed by `order_id` (the
 *      rebalance_request_c.id / push payload writes one audit row per
 *      ISIN with `order_id = rebalance_id`). Cumulative fills flip an
 *      audit row to `status='filled'` once the row's quantity is fully
 *      covered, and once every row for a book is filled we stamp
 *      `result_payload.dayOnePnlCents` (limit - fill; in cents) and
 *      promote the matching `rebalance_request_c` row to `status='executed'`.
 *
 * Math notes:
 *  - `oems_order_audit.price_cents` is the limit (in cents). The worker's
 *    fill avgFillPrice is in cents too; we keep everything in cents and
 *    only convert to Rands at the BFF.
 *  - `dayOnePnlCents` is computed per audit row once filled: the cumulative
 *    fill qty × (limit - avgFill) — negative means clients paid more than
 *    the limit (slippage). The Finance tab sums this for the daily slip.
 */

import type { WorkerEnv } from "./env";
import type { WorkerSupabase } from "./supabase";

/** Shape produced by the upstream broker (mocked or — once live — real). */
export interface BrokerFill {
  order_id: string;
  symbol: string;
  qty: number;
  avg_fill_price_cents: number;
  fill_timestamp: string; // ISO
}

export interface FetchFillsResult {
  fills: BrokerFill[];
  /** Where the fills came from. */
  source: "mock" | "live" | "empty";
  /** Cursor the next poll should start from. Mock mode returns now(). */
  nextCursor: string;
}

export interface ApplyFillsResult {
  updatedAuditRows: number;
  booksCompleted: string[]; // order_ids whose audit rows all hit 'filled'
  rebalanceRequestIdsExecuted: string[]; // rebalance_request_c rows flipped to 'executed'
  totalDayOnePnlCents: number; // sum across all rows updated in this batch
}

interface AuditRow {
  id: string;
  order_id: string;
  symbol: string;
  quantity: number;
  status: string;
  price_cents: number | null;
  payload: Record<string, unknown> | null;
  result_payload: Record<string, unknown> | null;
}

const SCHEMA_MISSING_CODES = new Set(["42P01", "PGRST204", "PGRST205"]);

function isSchemaMissing(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (m.includes("does not exist") && m.includes("relation")) || m.includes("could not find the table");
}

/**
 * Synthesize one mock fill per `working` audit row. Caps qty at `quantity`
 * so multiple polls do not over-fill. The generated fill price is a
 * deterministic-ish walk off the limit price (± a few bps) so the
 * `slippageBps` / `dayOnePnlCents` math has realistic sign + magnitude.
 *
 * Pure — no I/O. The caller writes the fills to Supabase via `applyFills`.
 */
function generateMockFills(auditRows: AuditRow[]): BrokerFill[] {
  const fills: BrokerFill[] = [];
  const now = new Date().toISOString();
  for (const row of auditRows) {
    if (row.status !== "working") continue;
    const limit = Number(row.price_cents ?? 0);
    const spreadBps = (Math.random() - 0.4) * 20; // skew slightly favourable for verisimilitude
    const avgFillCents = Math.max(1, Math.round(limit * (1 + spreadBps / 10000)));
    // First poll = 100% so verification flips the row to filled immediately.
    fills.push({
      order_id: row.order_id,
      symbol: row.symbol,
      qty: Number(row.quantity) || 0,
      avg_fill_price_cents: avgFillCents,
      fill_timestamp: now,
    });
  }
  return fills;
}

/**
 * Fetch fills since the cursor.
 *
 * Mock mode: introspects the `working` audit rows and synthesises one
 * fill per row (so a fresh boot immediately exercises the full path).
 * Live mode: returns empty until the broker vendor is wired (gated by
 * `brokerApiUrl`); logs a warning so the operator notices.
 */
export async function fetchFills(
  env: WorkerEnv,
  supabase: WorkerSupabase | null,
  cursor: string,
): Promise<FetchFillsResult> {
  if (env.brokerMode === "mock") {
    if (!supabase) return { fills: [], source: "empty", nextCursor: cursor };
    const { data, error } = await supabase
      .from("oems_order_audit")
      .select("id, order_id, symbol, quantity, status, price_cents, payload, result_payload")
      .eq("status", "working")
      .order("updated_at", { ascending: false })
      .limit(200);
    if (error) {
      if (SCHEMA_MISSING_CODES.has(String(error.code ?? "")) || isSchemaMissing(error.message)) {
        console.warn("[broker-ingest] oems_order_audit not migrated yet — skipping mock fill synthesis");
        return { fills: [], source: "empty", nextCursor: new Date().toISOString() };
      }
      console.error(`[broker-ingest] audit read failed: ${error.message}`);
      return { fills: [], source: "empty", nextCursor: cursor };
    }
    const rows = (data ?? []) as AuditRow[];
    return {
      fills: generateMockFills(rows),
      source: "mock",
      nextCursor: new Date().toISOString(),
    };
  }

  // LIVE MODE — vendor pending.
  if (!env.brokerApiUrl) {
    console.warn(
      "[broker-ingest] BROKER_MODE=live but BROKER_API_URL is empty — skipping fetch (vendor contract pending)",
    );
    return { fills: [], source: "empty", nextCursor: cursor };
  }
  // Real call deferred until vendor contract lands. The call would look like:
  //   GET `${env.brokerApiUrl}/fills?since=${cursor}`
  //   with `Authorization: Bearer ${env.brokerApiKey}`.
  // Until then, return empty + log a loud warning so the operator notices.
  console.warn(
    "[broker-ingest] live broker fetch is not implemented (vendor pending per Lonwabo) — no fills fetched",
  );
  return { fills: [], source: "empty", nextCursor: cursor };
}

/**
 * Apply a batch of fills to the audit table.
 *
 * For each fill we find the matching audit row (`order_id` + `symbol`)
 * and update:
 *   - `payload.filled` = cumulative qty from this fill
 *   - `payload.avgPx`  = fill avg price in Rands (price_cents / 100)
 *   - `result_payload.avgFillPrice` = same
 *   - `result_payload.dayOnePnlCents` = qty × (limit - avgFillCents)
 *   - `result_payload.slippageBps`    = (limit - avgFillCents) / limit × 10 000
 *   - `status` = 'filled' when filled ≥ quantity, else 'partial'
 *
 * When all rows of a book flip to 'filled' we collect the book_id so the
 * caller can flip the matching rebalance_request_c row to 'executed'.
 */
export async function applyFills(
  env: WorkerEnv,
  supabase: WorkerSupabase | null,
  fills: BrokerFill[],
): Promise<ApplyFillsResult> {
  const result: ApplyFillsResult = {
    updatedAuditRows: 0,
    booksCompleted: [],
    rebalanceRequestIdsExecuted: [],
    totalDayOnePnlCents: 0,
  };

  if (!supabase) return result;
  if (fills.length === 0) return result;

  // Group fills by order_id for one read per book.
  const orderIds = [...new Set(fills.map((f) => f.order_id))];
  const { data: rowsData, error: rowsErr } = await supabase
    .from("oems_order_audit")
    .select("id, order_id, symbol, quantity, status, price_cents, payload, result_payload")
    .in("order_id", orderIds)
    .limit(500);
  if (rowsErr) {
    console.error(`[broker-ingest] audit read for batch failed: ${rowsErr.message}`);
    return result;
  }
  const rows = (rowsData ?? []) as AuditRow[];

  const now = new Date().toISOString();
  const updates: Array<{
    id: string;
    payload: Record<string, unknown>;
    result_payload: Record<string, unknown>;
    status: string;
  }> = [];
  const rowByBook = new Map<string, { id: string; status: string }[]>();

  for (const fill of fills) {
    const row = rows.find((r) => r.order_id === fill.order_id && r.symbol === fill.symbol);
    if (!row) continue;
    const limit = Number(row.price_cents ?? 0);
    const filled = Number(fill.qty) || 0;
    const avgFillRands = (Number(fill.avg_fill_price_cents) || 0) / 100;
    const totalQty = Number(row.quantity) || 0;
    const dayOnePnlCents = filled * (limit - (Number(fill.avg_fill_price_cents) || 0));
    const slippageBps =
      limit > 0 ? Math.round(((limit - (Number(fill.avg_fill_price_cents) || 0)) / limit) * 10000) : 0;

    const newPayload: Record<string, unknown> = {
      ...(row.payload ?? {}),
      filled,
      avgPx: avgFillRands,
      lastFillAt: fill.fill_timestamp ?? now,
    };

    const newResult: Record<string, unknown> = {
      ...(row.result_payload ?? {}),
      avgFillPrice: avgFillRands,
      dayOnePnlCents,
      slippageBps,
      brokerFillTimestamp: fill.fill_timestamp ?? now,
    };

    const newStatus = filled >= totalQty ? "filled" : filled > 0 ? "partial" : row.status;

    updates.push({
      id: row.id,
      payload: newPayload,
      result_payload: newResult,
      status: newStatus,
    });

    if (!rowByBook.has(row.order_id)) rowByBook.set(row.order_id, []);
    rowByBook.get(row.order_id)?.push({ id: row.id, status: newStatus });
    result.totalDayOnePnlCents += dayOnePnlCents;
  }

  if (updates.length === 0) return result;

  // Log the would-be writes first if dry-run; otherwise apply.
  if (env.dryRun || !env.allowWrites) {
    console.info(
      JSON.stringify({
        level: "info",
        event: "would_apply_broker_fills",
        count: updates.length,
        sample: updates.slice(0, 3),
        dayOnePnlCents: result.totalDayOnePnlCents,
      }),
    );
    // For dry-run we still report the books that WOULD complete so the
    // operator can verify the threshold logic offline.
    for (const [bookId, items] of rowByBook.entries()) {
      if (items.every((r) => r.status === "filled")) result.booksCompleted.push(bookId);
    }
    return result;
  }

  const writeResults = await Promise.all(
    updates.map((u) =>
      supabase
        .from("oems_order_audit")
        .update({
          payload: u.payload,
          result_payload: u.result_payload,
          status: u.status,
          updated_at: now,
        })
        .eq("id", u.id),
    ),
  );
  const failed = writeResults.find((r) => r.error);
  if (failed?.error) {
    console.error(`[broker-ingest] audit update failed: ${failed.error.message}`);
    return result;
  }
  result.updatedAuditRows = updates.length;

  for (const [bookId, items] of rowByBook.entries()) {
    if (items.every((r) => r.status === "filled")) result.booksCompleted.push(bookId);
  }

  // Flip rebalance_request_c.status='executed' when the book is complete.
  for (const bookId of result.booksCompleted) {
    try {
      const { error: execErr } = await supabase
        .from("rebalance_request_c")
        .update({ status: "executed", executed_at: now, updated_at: now })
        .eq("id", bookId);
      if (execErr) {
        if (SCHEMA_MISSING_CODES.has(String(execErr.code ?? "")) || isSchemaMissing(execErr.message)) {
          // Table not migrated → nothing to flip, but the audit row flip stands.
          console.info(
            `[broker-ingest] rebalance_request_c not migrated; book ${bookId} marked filled but no rebalance flip`,
          );
        } else {
          console.warn(`[broker-ingest] rebalance flip for book=${bookId} failed: ${execErr.message}`);
        }
      } else {
        result.rebalanceRequestIdsExecuted.push(bookId);
        console.info(
          JSON.stringify({
            level: "info",
            event: "rebalance_executed",
            book_id: bookId,
            dayOnePnlCents: result.totalDayOnePnlCents,
          }),
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[broker-ingest] rebalance flip threw for book=${bookId}: ${msg}`);
    }
  }

  return result;
}

/**
 * One poll iteration. Caller loops with `env.pollIntervalMs` between calls.
 */
export async function pollOnce(
  env: WorkerEnv,
  supabase: WorkerSupabase | null,
  cursor: string,
): Promise<{ cursor: string; apply: ApplyFillsResult }> {
  const fetched = await fetchFills(env, supabase, cursor);
  const apply = await applyFills(env, supabase, fetched.fills);
  return { cursor: fetched.nextCursor, apply };
}
