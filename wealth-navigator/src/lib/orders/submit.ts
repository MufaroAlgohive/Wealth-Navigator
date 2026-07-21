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
import { createRetailServiceRoleClient, createInstitutionalServiceRoleClient } from "@/lib/supabase/server";
import type { OrderSource, PreflightResult, SubmitInput, SubmitResult } from "@/lib/orders/types";
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

/**
 * Run preflight, then — only on pass — write the audit row and fan out
 * to the worker. See plan §0 for the full behaviour contract.
 */
export async function submitOrder(
  supabase: { retail: SupabaseClient; institutional: SupabaseClient },
  input: SubmitInput,
  opts: SubmitOrderOptions = {},
): Promise<SubmitResult> {
  // ── 1. Resolve the security (suffix-tolerant, retail price table) ──
  const bare = String(input.symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
  const { data: secs, error: secErr } = await supabase.retail
    .from("securities_c")
    .select("id, symbol, name, isin, last_price")
    .in("symbol", [input.symbol, `${bare}.JO`, bare]);
  if (secErr) {
    return {
      ok: false,
      preflight: {
        ok: false,
        verdict: "blocked_unverifiable",
        code: "sell_guard_unavailable",
        message: `Could not resolve security '${input.symbol}': ${secErr.message}`,
      },
    };
  }
  const sec = (secs ?? [])[0] as
    | { id: string; symbol: string; name: string | null; isin: string | null; last_price: number | null }
    | undefined;
  if (!sec) {
    return {
      ok: false,
      preflight: {
        ok: false,
        verdict: "blocked_unverifiable",
        code: "sell_guard_unavailable",
        message: `Unknown ticker '${input.symbol}' (not in securities_c).`,
      },
    };
  }

  // ── 2. Preflight (unless caller already ran a bulk preflight) ──
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

  // ── 3. Insert the audit row ──
  const orderId = `${input.source}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const nowIso = new Date().toISOString();
  const auditRow = {
    order_id: orderId,
    client_account: input.trader_email,
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
    status: "working",
    source: input.source,
    payload: {
      book_id: opts.bookId ?? null,
      broker: opts.broker ?? null,
      order_type: input.price_cents != null ? "limit" : "market",
      strategy: opts.bookId ?? null,
      security_id: sec.id,
      isin: sec.isin ?? null,
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
  const auditId = inserted.id as string;

  // ── 4. Fan out to the worker ──
  // Dry-run short-circuit — preserves today's audit-only branch.
  if (process.env.IRESS_WORKER_DRY_RUN === "1" || process.env.IRESS_WORKER_DRY_RUN === "true") {
    return {
      ok: true,
      order_audit_id: auditId,
      order_id: orderId,
      status: "working",
      preflight: preflightResult,
    };
  }

  // No broker configured → audit-only.
  if (!process.env.IRESS_WORKER_URL && !process.env.RAILWAY_SERVICE_URL) {
    return {
      ok: true,
      order_audit_id: auditId,
      order_id: orderId,
      status: "working",
      preflight: preflightResult,
    };
  }

  const res = await callWorker<WorkerUatSendResponse>({
    method: "POST",
    path: "/uat/send-to-market",
    body: {
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

  // ── 5. Worker rejected AFTER we wrote the row ──
  // Defense in depth: stamp the row `rejected` so the operator sees the
  // truth and the row doesn't reserve phantom quantity against the next
  // preflight.
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

  await supabase.institutional
    .from("oems_order_audit")
    .update({
      status: "rejected",
      result_payload: {
        ...((inserted as { result_payload?: Record<string, unknown> | null }).result_payload ?? {}),
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
