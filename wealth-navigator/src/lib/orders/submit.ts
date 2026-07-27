/**
 * Core `submitOrder()` — single source of truth for writing an
 * `oems_order_audit` row and fanning out to the worker.
 *
 * Every BFF route (UAT ad-hoc, bulk send-to-market, blotter dialog,
 * future research-lab / paper-model consumers) delegates here so:
 *
 *   - Preflight ALWAYS runs BEFORE the audit row is written. A blocked
 *     verdict returns `{ ok: false, preflight }` with no DB write, killing
 *     the "ghost working row" bug at the source (plan §0 step 3).
 *   - On pass, exactly one audit row is inserted with both the new typed
 *     `broker_account_code` column AND `payload.broker_account_code` set,
 *     so every downstream query can filter cleanly.
 *   - The worker's `/uat/send-to-market` re-runs the guard as defense in
 *     depth (race window where another order lands between preflight and
 *     submit). If the worker rejects post-insert, the audit row is stamped
 *     `status: "rejected"` with `result_payload.rejectReason` so the
 *     blotter / execution view shows the truth.
 *   - `IRESS_WORKER_DRY_RUN=1` skips the worker fan-out and stamps
 *     `mode: "audit-only"`, preserving today's behaviour.
 *
 * This module is server-side only — it imports no client-only code and
 * must only be called from API routes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { callWorker } from "@/lib/iress/worker-api";
import { isUatEnv } from "@/lib/oems/uat-scope";
import { createRetailServiceRoleClient, createInstitutionalServiceRoleClient } from "@/lib/supabase/server";
import type {
  OrderSide,
  OrderSource,
  PreflightInput,
  PreflightResult,
  SubmitInput,
  SubmitResult,
} from "@/lib/orders/types";
import { preflight } from "@/lib/orders/preflight";

export interface SubmitOrderOptions {
  /** Book id / strategy_name_snapshot; written to `payload.book_id`. */
  bookId?: string;
  /** IRESS broker destination (e.g. "LONGMARK CARE" for UAT). */
  broker?: string;
  /** Stamped onto `payload.uat_test` and gates the UAT-test branch on the worker. */
  uatTest?: boolean;
  /** Skip the preflight gate (used by callers that already ran a bulk preflight). */
  skipPreflight?: boolean;
}

interface WorkerUatSendOk {
  ok: true;
  iressOrderNumber?: string;
  status?: string;
}
interface WorkerUatSendBlocked {
  ok: false;
  code?: string;
  errorDescription?: string;
  errorNumber?: number;
  message?: string;
}
type WorkerUatSendResponse = WorkerUatSendOk | WorkerUatSendBlocked;

interface ResolvedSecurity {
  id: string;
  symbol: string;
  name: string | null;
  isin: string | null;
  last_price: number | null;
}

async function resolveSecurity(
  supabase: { retail: SupabaseClient },
  symbol: string,
): Promise<{ ok: true; sec: ResolvedSecurity } | { ok: false; preflight: PreflightResult }> {
  const bare = String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
  const { data: secs, error: secErr } = await supabase.retail
    .from("securities_c")
    .select("id, symbol, name, isin, last_price")
    .in("symbol", [symbol, `${bare}.JO`, bare]);
  if (secErr) {
    return {
      ok: false,
      preflight: {
        ok: false,
        verdict: "blocked_unverifiable",
        code: "sell_guard_unavailable",
        message: `Could not resolve security '${symbol}': ${secErr.message}`,
      },
    };
  }
  const sec = (secs ?? [])[0] as ResolvedSecurity | undefined;
  if (!sec) {
    return {
      ok: false,
      preflight: {
        ok: false,
        verdict: "blocked_unverifiable",
        code: "sell_guard_unavailable",
        message: `Unknown ticker '${symbol}' (not in securities_c).`,
      },
    };
  }
  return { ok: true, sec };
}

interface InsertAuditRowResult {
  ok: boolean;
  order_audit_id?: string;
  order_id?: string;
  error?: string;
  preflight: PreflightResult;
}

/**
 * Resolve the security and insert one `oems_order_audit` row with the
 * given `status`. No preflight is run here — callers decide whether/when
 * to preflight (immediate-send runs it before calling this; park skips it
 * entirely; release re-derives it from the row later).
 */
async function insertAuditRow(
  supabase: { retail: SupabaseClient; institutional: SupabaseClient },
  input: SubmitInput,
  opts: SubmitOrderOptions,
  status: string,
  preflightResult: PreflightResult,
): Promise<InsertAuditRowResult> {
  const resolved = await resolveSecurity(supabase, input.symbol);
  if (!resolved.ok) return { ok: false, preflight: resolved.preflight };
  const sec = resolved.sec;

  const orderId = `${input.source}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const nowIso = new Date().toISOString();
  const auditRow = {
    order_id: orderId,
    /* WHOSE order this is — rendered as the "Client" column on the order book.
       Defaults to the trader's email, which is right for a desk order placed on
       the desk's own book. For a manual CLIENT order it is NOT: the column then
       shows the dealer who clicked the button instead of the client whose money
       is at risk, and a dealer cannot tell whose order they are releasing.
       `client_account` overrides it; `sent_by` / `trader` in the payload keep
       the audit trail of who actually placed it. */
    client_account: input.client_account ?? input.trader_email,
    // The new typed column — every BFF-seeded row carries the IRESS
    // AccountCode here so downstream queries filter on this column
    // directly, dropping the `payload->>` workaround.
    broker_account_code: input.account_code,
    symbol: sec.symbol,
    side: input.side,
    quantity: input.qty,
    price_cents:
      input.price_cents != null && Number.isFinite(Number(input.price_cents)) && Number(input.price_cents) > 0
        ? Math.round(Number(input.price_cents))
        : null,
    status,
    source: input.source,
    payload: {
      book_id: opts.bookId ?? null,
      broker: opts.broker ?? null,
      // 2026-07-23: market orders only, for now — the worker
      // (http-api.ts) forces MKT and omits Price regardless of
      // price_cents, so this label must say "market" too rather than
      // implying a limit order was actually sent. `limitPrice` (key kept
      // for existing readers — execution/fills/send-to-market routes) is
      // now a reference/expected price only, never an actual submitted
      // limit.
      order_type: "market",
      strategy: opts.bookId ?? null,
      security_id: sec.id,
      isin: sec.isin ?? null,
      holding_id: input.holding_id ?? null,
      // Drives resolveHolderKind in the worker: present => the pre-trade guard
      // checks THIS client's wallet and holdings instead of the desk omnibus.
      // Never sent to the broker — LONGMARK sees only the MINT account.
      user_id: input.user_id ?? null,
      limitPrice: input.price_cents != null ? Number(input.price_cents) / 100 : null,
      sent_by: input.trader_email,
      sent_at: nowIso,
      trader: input.trader_email,
      uat_test: opts.uatTest === true,
      // Also write into the payload for backwards-compat with the existing
      // `payload->>broker_account_code.eq.X` filter (cheap; indexed only
      // on the typed column).
      broker_account_code: input.account_code,
    },
    result_payload: {
      broker: opts.broker ?? null,
      venue: "JSE",
      tif: "DAY",
      arrivalMid: sec.last_price != null ? Number(sec.last_price) / 100 : null,
      uat_test: opts.uatTest === true,
      preflight: preflightResult,
    },
  };

  const { data: inserted, error: insErr } = await supabase.institutional
    .from("oems_order_audit")
    .insert(auditRow)
    .select("id, order_id")
    .maybeSingle();
  if (insErr || !inserted) {
    return {
      ok: false,
      preflight: preflightResult,
      error: insErr?.message ?? "audit insert failed",
    };
  }
  return {
    ok: true,
    order_audit_id: inserted.id as string,
    order_id: orderId,
    preflight: preflightResult,
  };
}

/**
 * Fan out an already-inserted audit row to the worker's `/uat/send-to-market`
 * endpoint, and stamp the outcome back onto that same row. Used both by the
 * immediate-send path (`submitOrder`) right after insert, and by the
 * deferred-release path (`releaseOrder`) against a row inserted earlier by
 * a different request.
 */
async function fanOutToWorker(
  supabase: { institutional: SupabaseClient },
  auditId: string,
  orderId: string,
  opts: { broker?: string },
  preflightResult: PreflightResult,
): Promise<SubmitResult> {
  const productionOrders = ["1", "true"].includes(
    (process.env.IRESS_PRODUCTION_ORDERS ?? "").trim().toLowerCase(),
  );

  /* Dry-run short-circuit — audit-only, no worker call.
     Refused on the production lane. Returning `status: "working"` without
     contacting a broker is a lie the operator cannot see: the order book shows
     the order live while nothing was ever sent. Better to fail loudly than to
     report a phantom fill on real client money. */
  if (process.env.IRESS_WORKER_DRY_RUN === "1" || process.env.IRESS_WORKER_DRY_RUN === "true") {
    if (productionOrders) {
      return {
        ok: false,
        order_audit_id: auditId,
        order_id: orderId,
        preflight: preflightResult,
        error:
          "IRESS_PRODUCTION_ORDERS=1 but IRESS_WORKER_DRY_RUN is also set on this deployment. Refusing to report an order as working without sending it. Unset IRESS_WORKER_DRY_RUN on Vercel.",
      };
    }
    return {
      ok: true,
      order_audit_id: auditId,
      order_id: orderId,
      status: "working",
      preflight: preflightResult,
    };
  }

  // No broker configured → audit-only. Same reasoning: never fake "working" on
  // the production lane.
  if (!process.env.IRESS_WORKER_URL && !process.env.RAILWAY_SERVICE_URL) {
    if (productionOrders) {
      return {
        ok: false,
        order_audit_id: auditId,
        order_id: orderId,
        preflight: preflightResult,
        error:
          "IRESS_PRODUCTION_ORDERS=1 but no IRESS_WORKER_URL is configured — the order cannot reach the worker.",
      };
    }
    return {
      ok: true,
      order_audit_id: auditId,
      order_id: orderId,
      status: "working",
      preflight: preflightResult,
    };
  }

  /* LANE. This is the path the "Send to Market" button actually takes
     (release-to-market -> releaseOrder -> here). It was hardcoded to
     /uat/send-to-market, which 403s whenever IRESS_UAT_MODE is off — so on a
     production deployment no released order could ever reach a market.

     Production takes the account AND destination from the worker's own env;
     passing broker_destination on that lane would let a caller route a client's
     trade to an arbitrary book. UAT keeps its existing behaviour. */
  const productionLane =
    ["1", "true"].includes((process.env.IRESS_PRODUCTION_ORDERS ?? "").trim().toLowerCase()) &&
    !isUatEnv();
  const res = await callWorker<WorkerUatSendResponse>({
    method: "POST",
    path: productionLane ? "/orders/send-to-market" : "/uat/send-to-market",
    body: productionLane
      ? { order_audit_id: auditId }
      : {
          order_audit_id: auditId,
          broker_destination: opts.broker ?? "LONGMARK CARE",
        },
    timeoutMs: 15_000,
  });

  if (res.ok && res.body?.ok) {
    return {
      ok: true,
      order_audit_id: auditId,
      order_id: orderId,
      iress_order_number: res.body.iressOrderNumber ?? undefined,
      status: res.body.status ?? "working",
      preflight: preflightResult,
    };
  }

  // Worker rejected AFTER the row was already written. Defense in depth:
  // stamp the row `rejected` so the operator sees the truth and the row
  // doesn't reserve phantom quantity against the next preflight.
  const upstream =
    !res.ok && res.errorBody && typeof res.errorBody === "object"
      ? (res.errorBody as { message?: string; error?: string; code?: string })
      : undefined;
  const rejectReason = res.ok
    ? ((res.body && "errorDescription" in res.body ? res.body.errorDescription : null) ??
      (res.body && "errorNumber" in res.body
        ? String((res.body as { errorNumber?: number }).errorNumber ?? "")
        : null) ??
      (res.body && "message" in res.body ? (res.body as { message?: string }).message : null) ??
      "worker rejected")
    : (upstream?.message ?? upstream?.error ?? res.error ?? "worker rejected");
  const workerCode =
    upstream?.code ??
    (res.ok && res.body && "code" in res.body ? (res.body as { code?: string }).code : undefined);

  const { data: existing } = await supabase.institutional
    .from("oems_order_audit")
    .select("result_payload")
    .eq("id", auditId)
    .maybeSingle();

  await supabase.institutional
    .from("oems_order_audit")
    .update({
      status: "rejected",
      result_payload: {
        ...((existing as { result_payload?: Record<string, unknown> | null } | null)?.result_payload ?? {}),
        rejectReason,
        worker_code: workerCode ?? null,
        rejected_at: new Date().toISOString(),
      },
    })
    .eq("id", auditId);

  return {
    ok: false,
    order_audit_id: auditId,
    order_id: orderId,
    preflight: preflightResult,
    error: rejectReason,
    worker_code: workerCode,
  };
}

/**
 * Run preflight, then — only on pass — write the audit row and fan out
 * to the worker. See plan §0 for the full behaviour contract.
 */
export async function submitOrder(
  supabase: { retail: SupabaseClient; institutional: SupabaseClient },
  input: SubmitInput,
  opts: SubmitOrderOptions = {},
): Promise<SubmitResult> {
  // ── 1. Preflight (unless caller already ran a bulk preflight) ──
  let preflightResult: PreflightResult;
  if (opts.skipPreflight) {
    // Caller takes responsibility for the verdict. We still require a
    // pass before writing the row.
    preflightResult = {
      ok: true,
      verdict: "pass",
      code: "pass",
      message: "Skipped (caller ran a bulk preflight).",
    };
  } else {
    preflightResult = await preflight(input);
    if (!preflightResult.ok) {
      // CRITICAL: no audit row written here. This is the force-correction
      // path — the trader stays on the entry screen.
      return { ok: false, preflight: preflightResult };
    }
  }

  // ── 2. Insert the audit row ──
  const insertResult = await insertAuditRow(supabase, input, opts, "working", preflightResult);
  if (!insertResult.ok || !insertResult.order_audit_id) {
    return {
      ok: false,
      preflight: preflightResult,
      error: insertResult.error,
    };
  }

  // ── 3. Fan out to the worker ──
  return fanOutToWorker(
    supabase,
    insertResult.order_audit_id,
    insertResult.order_id as string,
    opts,
    preflightResult,
  );
}

/**
 * Write a `parked` audit row with zero worker/IRESS contact — no preflight
 * is run at park time (see client-order/route.ts for why: preflight against
 * a cash/position snapshot taken at arrival time would be stale by the time
 * the order is actually released). The row sits visibly in the order-book
 * UI until `releaseOrder` is called for it.
 */
export async function parkOrder(
  supabase: { retail: SupabaseClient; institutional: SupabaseClient },
  input: SubmitInput,
  opts: SubmitOrderOptions = {},
): Promise<{ ok: boolean; order_audit_id?: string; order_id?: string; error?: string }> {
  const noPreflightYet: PreflightResult = {
    ok: true,
    verdict: "pass",
    code: "pass",
    message: "Not yet preflighted — parked, awaiting Send to Market release.",
  };
  const result = await insertAuditRow(supabase, input, opts, "parked", noPreflightYet);
  return {
    ok: result.ok,
    order_audit_id: result.order_audit_id,
    order_id: result.order_id,
    error: result.error,
  };
}

/**
 * Release a single parked row: re-derive a `PreflightInput` from the row's
 * own stored columns, run preflight against it (a fresh, current-moment
 * check — not the stale one from park time), and only on pass fan out to
 * the worker. On a preflight block, the row is left `parked` (not
 * rejected) so the next "Send to Market" click retries it automatically —
 * see release-to-market/route.ts for the batch-level rationale.
 */
export async function releaseOrder(
  supabase: { retail: SupabaseClient; institutional: SupabaseClient },
  auditId: string,
  opts: { broker?: string } = {},
): Promise<SubmitResult> {
  const { data: row, error: rowErr } = await supabase.institutional
    .from("oems_order_audit")
    .select("id, order_id, symbol, side, quantity, price_cents, broker_account_code, source, payload")
    .eq("id", auditId)
    .maybeSingle();
  if (rowErr || !row) {
    return {
      ok: false,
      preflight: {
        ok: false,
        verdict: "blocked_unverifiable",
        code: "sell_guard_unavailable",
        message: rowErr?.message ?? `Parked order ${auditId} not found.`,
      },
    };
  }

  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const preflightInput: PreflightInput = {
    account_code: (row.broker_account_code as string) ?? (payload.broker_account_code as string) ?? "",
    symbol: row.symbol as string,
    side: row.side as OrderSide,
    qty: row.quantity as number,
    price_cents: row.price_cents as number | null,
    source: (row.source as OrderSource) ?? "MINT_CLIENT_ORDER",
    book_id: (payload.book_id as string) ?? undefined,
  };

  const preflightResult = await preflight(preflightInput);
  if (!preflightResult.ok) {
    // Leave the row parked — stamp the verdict so the UI can show why this
    // round's release skipped it, but don't reject a still-viable order.
    await supabase.institutional
      .from("oems_order_audit")
      .update({
        result_payload: {
          ...((row as { result_payload?: Record<string, unknown> | null }).result_payload ?? {}),
          preflight: preflightResult,
        },
      })
      .eq("id", auditId);
    return { ok: false, order_audit_id: auditId, preflight: preflightResult };
  }

  return fanOutToWorker(supabase, auditId, row.order_id as string, opts, preflightResult);
}

/**
 * Open both service-role Supabase clients. Centralized so callers don't
 * have to know about the retail/institutional split.
 */
export async function openSupabaseClients(): Promise<{
  retail: SupabaseClient;
  institutional: SupabaseClient;
}> {
  return {
    retail: createRetailServiceRoleClient(),
    institutional: createInstitutionalServiceRoleClient(),
  };
}

/** Convenience re-export so callers can pull types from a single import. */
export type { OrderSource, PreflightResult, SubmitInput, SubmitResult } from "@/lib/orders/types";
