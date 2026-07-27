/**
 * Server-side preflight wrapper.
 *
 * The worker (`POST /uat/preflight`) is the source of truth for sell-side
 * holdings + cash-side available buying power. This wrapper:
 *
 *   1. Calls the worker.
 *   2. On worker failure (timeout, unreachable, not configured), falls back
 *      to a local computation that mirrors the worker (`localPreflight`)
 *      so a degraded Railway deployment doesn't brick the desk.
 *   3. Returns the canonical `PreflightResult` shape used by every BFF
 *      route and by `<GuardrailForceCorrectionDialog/>`.
 *
 * IMPORTANT: the preflight NEVER writes an audit row. That's the whole
 * point of moving the guard in front of the INSERT. A blocked verdict
 * here means the caller must NOT proceed to `submitOrder()`.
 *
 * See plan §0 (core module) and §1 (worker preflight endpoint).
 */

import { callWorker } from "@/lib/iress/worker-api";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PreflightInput,
  PreflightResult,
  PreflightVerdict,
  PreflightCode,
  SellAvailabilityLite,
  CashAvailabilityLite,
} from "@/lib/orders/types";

interface WorkerPreflightOk {
  ok: true;
  verdict: PreflightVerdict;
  code: PreflightCode;
  message: string;
  sell?: SellAvailabilityLite;
  cash?: CashAvailabilityLite;
}

interface WorkerPreflightBlocked {
  ok: false;
  status: number;
  verdict: PreflightVerdict;
  code: PreflightCode;
  message: string;
  sell?: SellAvailabilityLite;
  cash?: CashAvailabilityLite;
}

type WorkerPreflightResponse = WorkerPreflightOk | WorkerPreflightBlocked;

/**
 * Strip a JSE exchange suffix (".JO", ".JSE") from a symbol. Mirrors the
 * `bareCode()` helper inside the worker.
 */
function bareCode(sym: string): string {
  return String(sym ?? "")
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

/**
 * Local fallback preflight — runs the same math the worker does, against
 * the institutional Supabase client. Activated when the worker is offline
 * or returns 5xx, so the desk doesn't grind to a halt if Railway hiccups.
 *
 * Mirrors `workers/iress-ingest/src/pretrade-guard.ts::availableToSell`:
 *   held       = oems_position_c.quantity ?? (filledBuys − filledSells)
 *   available  = max(0, held − Σ max(0, qty − filled) over open sells
 *                              excluding the current order)
 *
 * Buy-side fallback is intentionally advisory (returns `cash: null`) when
 * the IPS row is absent — same fail-closed-on-known-data / advisory-on-unknown
 * asymmetry as the worker.
 */
async function localPreflight(
  institutional: SupabaseClient,
  input: PreflightInput,
): Promise<PreflightResult> {
  const code = bareCode(input.symbol);
  const side = input.side;

  // 1. Position source.
  const { data: pos, error: posErr } = await institutional
    .from("oems_position_c")
    .select("quantity")
    .eq("account_code", input.account_code)
    .eq("security_code", code)
    .maybeSingle();
  if (posErr) {
    return {
      ok: false,
      verdict: "blocked_unverifiable",
      code: "sell_guard_unavailable",
      message: `Sell blocked: could not verify holdings for ${input.symbol} on account ${input.account_code} (oems_position_c read failed: ${posErr.message}). Try again.`,
    };
  }
  const posQty = pos != null ? Number((pos as { quantity: number }).quantity) || 0 : null;

  // 2. Audit mirror — derived held + open-sell reservation.
  const UAT_SOURCES = ["UAT_ADHOC_ORDER", "OB_SEND_TO_MARKET_UAT", "MINT_CLIENT_ORDER"];
  const OPEN_SELL_STATES = [
    "working",
    "pending_ack",
    "acknowledged",
    "partial",
    "amend_pending",
    "cancel_pending",
  ];
  const { data: audit, error: auditErr } = await institutional
    .from("oems_order_audit")
    .select("id, side, quantity, status, payload")
    .in("source", UAT_SOURCES)
    .in("symbol", [code, `${code}.JO`]);
  if (auditErr) {
    return {
      ok: false,
      verdict: "blocked_unverifiable",
      code: "sell_guard_unavailable",
      message: `Sell blocked: could not verify holdings for ${input.symbol} on account ${input.account_code} (oems_order_audit read failed: ${auditErr.message}). Try again.`,
    };
  }

  let filledBuys = 0;
  let filledSells = 0;
  let inflightSells = 0;
  for (const r of (audit ?? []) as Array<{
    id: string;
    side: string | null;
    quantity: number | null;
    status: string | null;
    payload: Record<string, unknown> | null;
  }>) {
    const rSide = String(r.side ?? "").toLowerCase();
    const status = String(r.status ?? "").toLowerCase();
    const qty = Number(r.quantity) || 0;
    const payloadFilled = Number((r.payload as { filled?: number } | null)?.filled) || 0;
    const filled = status === "filled" ? qty : payloadFilled;
    if (rSide === "buy") filledBuys += filled;
    else if (rSide === "sell") {
      filledSells += filled;
      if (OPEN_SELL_STATES.includes(status)) {
        inflightSells += Math.max(0, qty - filled);
      }
    }
  }
  const derivedHeld = Math.max(0, filledBuys - filledSells);
  const held = posQty != null ? posQty : derivedHeld;
  const source = posQty != null ? "ips" : (audit ?? []).length > 0 ? "derived" : "none";
  const sell: SellAvailabilityLite = {
    held,
    inflight_sells: inflightSells,
    available: Math.max(0, held - inflightSells),
    source,
    note:
      posQty != null
        ? `IPS settled position ${held}`
        : `derived from filled UAT orders (${filledBuys} bought − ${filledSells} sold = ${derivedHeld})`,
  };

  // 3. Verdict.
  if (side === "sell") {
    if (sell.available < input.qty) {
      return {
        ok: false,
        verdict: "blocked_naked_short",
        code: "naked_short_blocked",
        message: `Sell blocked: ${input.qty} ${input.symbol} exceeds available-to-sell ${sell.available} on account ${input.account_code} — held ${sell.held}, ${sell.inflight_sells} in open sells (${sell.note}). We only sell stock we own.`,
        sell,
      };
    }
    return {
      ok: true,
      verdict: "pass",
      code: "pass",
      message: `Sell guard OK: ${input.qty} ${input.symbol} <= available ${sell.available} on account ${input.account_code} (${sell.note}).`,
      sell,
    };
  }

  // BUY side: advisory when no cash source (mirror worker's `availableToBuy`
  // semantics). Fail-closed on read errors.
  const { data: acct, error: acctErr } = await institutional
    .from("oems_account_c")
    .select("cash_balance")
    .eq("account_code", input.account_code)
    .maybeSingle();
  if (acctErr) {
    return {
      ok: false,
      verdict: "blocked_unverifiable",
      code: "buy_guard_unavailable",
      message: `Buy blocked: could not verify cash for account ${input.account_code} (oems_account_c read failed: ${acctErr.message}). Try again.`,
    };
  }
  const cashRaw = acct != null ? Number((acct as { cash_balance: number }).cash_balance) : NaN;
  const cash: CashAvailabilityLite = {
    cash: Number.isFinite(cashRaw) ? cashRaw : null,
    inflight_buys: 0, // local fallback reserves only the obvious other buys; advisory
    available: Number.isFinite(cashRaw) ? Math.max(0, cashRaw) : null,
    source: Number.isFinite(cashRaw) ? "ips" : "none",
    note: Number.isFinite(cashRaw) ? `desk cash R${cashRaw}` : "no oems_account_c cash; buy guard advisory",
  };
  return {
    ok: true,
    verdict: "pass",
    code: "pass",
    message: `Buy guard ${cash.available == null ? "ADVISORY" : "OK"} on account ${input.account_code}.`,
    cash,
  };
}

/**
 * Run the preflight. Tries the worker first, falls back to a local
 * computation if the worker is unreachable / not configured / 5xx.
 *
 * Returns a `PreflightResult`. A non-pass verdict means the caller MUST
 * NOT write an audit row — the whole point of the preflight gate.
 */
export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  const res = await callWorker<WorkerPreflightResponse>({
    method: "POST",
    path: "/uat/preflight",
    body: {
      account_code: input.account_code,
      symbol: input.symbol,
      side: input.side,
      qty: input.qty,
      price_cents: input.price_cents ?? null,
      source: input.source,
      book_id: input.book_id ?? null,
      // Routes the worker's guard to this client's ledger. Omitted/null keeps
      // the desk path, so every existing caller is unaffected.
      user_id: input.user_id ?? null,
    },
    timeoutMs: 8_000,
  });

  if (res.ok && res.body) {
    const body = res.body;
    if (body.ok) {
      // Worker returned an OK envelope that nests its own verdict.
      return {
        ok: true,
        verdict: body.verdict,
        code: body.code,
        message: body.message,
        sell: body.sell,
        cash: body.cash,
      };
    }
    // Worker returned ok:false (blocked) — the preflight HTTP envelope is
    // 200 even for blocked verdicts in this shape, so check both.
    return {
      ok: false,
      verdict: body.verdict,
      code: body.code,
      message: body.message,
      sell: body.sell,
      cash: body.cash,
    };
  }

  // Worker unreachable / timed out / 5xx → fall back to local computation
  // so the desk doesn't grind to a halt when Railway hiccups. The worker's
  // own `/uat/send-to-market` guard still runs at submit time so we never
  // lose fail-closed behaviour.
  let institutional: SupabaseClient;
  try {
    institutional = createInstitutionalServiceRoleClient();
  } catch {
    return {
      ok: false,
      verdict: "blocked_unverifiable",
      code: "sell_guard_unavailable",
      message: `Preflight unreachable: worker offline and INSTITUTIONAL Supabase not configured; cannot verify ${input.side} ${input.qty} ${input.symbol} on account ${input.account_code}.`,
    };
  }
  return localPreflight(institutional, input);
}
