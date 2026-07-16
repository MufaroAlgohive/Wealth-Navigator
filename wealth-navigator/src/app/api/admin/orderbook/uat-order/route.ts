import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { isIressWorkerConfigured } from "@/lib/data-policy";
import { callWorker } from "@/lib/iress/worker-api";
import { createInstitutionalServiceRoleClient, createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/orderbook/uat-order
 *
 * Ad-hoc single-order UAT tester. Places one BUY/SELL on the IRESS UAT (IOS+)
 * seat without the book/holdings machinery of send-to-market: it writes ONE
 * `oems_order_audit` row (tagged book_id "UAT-ADHOC", uat_test) and, when the
 * worker is configured + IRESS_UAT_MODE is on, fans out to the worker's
 * `POST /uat/send-to-market` which calls OrderCreate3 on MINT_CT and stamps the
 * broker OrderNumber back. Lifecycle (fills/route/status) is then polled via
 * /api/admin/orderbook/execution?book_id=UAT-ADHOC and the SSE stream, exactly
 * like the scenario runner.
 *
 * Body: { symbol: string, side: "buy" | "sell", qty: number, price?: number }
 *   - `price` is in RANDS (limit); omit/0 for a market order.
 * Returns: { ok, orderAuditId, orderId, bookId, mode, iressOrderNumber?, status?, error? }
 *
 * Gated: admin + orderbook.send_to_market, and IRESS_UAT_MODE=true (never
 * touches the production account; the worker enforces the UAT account).
 */

export const dynamic = "force-dynamic";

const BOOK_ID = "UAT-ADHOC";
// UAT orders route to the LONGMARK CARE destination (-> EXT_BROKERTI), per IRESS
// (Andre, 2026-07-13, connecting the LONGMARK CARE session).
// IRESS_UAT_DESTINATION overrides without a redeploy.
const BROKER = process.env.IRESS_UAT_DESTINATION?.trim() || "LONGMARK CARE";

interface Security {
  id: string;
  symbol: string;
  name: string | null;
  isin: string | null;
  last_price: number | null;
}

interface WorkerUatResponse {
  ok: boolean;
  iressOrderNumber?: string;
  status?: string;
  errorNumber?: number;
  errorDescription?: string;
}

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok" || !can(auth.ctx, "orderbook", "send_to_market")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (process.env.IRESS_UAT_MODE !== "true") {
    return NextResponse.json({ ok: false, error: "IRESS_UAT_MODE is not enabled." }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const rawSymbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const side = String(body.side ?? "").toLowerCase() === "sell" ? "sell" : "buy";
  const qty = Math.floor(Number(body.qty));
  const priceRaw = body.price == null || body.price === "" ? null : Number(body.price);
  const priceRands = priceRaw != null && Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null;

  if (!rawSymbol) return NextResponse.json({ ok: false, error: "symbol is required" }, { status: 400 });
  if (!Number.isFinite(qty) || qty <= 0) return NextResponse.json({ ok: false, error: "qty must be a positive integer" }, { status: 400 });

  let retail: SupabaseClient;
  try {
    retail = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
  }

  // Resolve the security by symbol (accept bare or .JO form).
  const bare = rawSymbol.replace(/\.(JO|JSE)$/i, "");
  const { data: secs } = await retail
    .from("securities_c")
    .select("id, symbol, name, isin, last_price")
    .in("symbol", [rawSymbol, `${bare}.JO`, bare]);
  const sec = (secs ?? [])[0] as Security | undefined;
  if (!sec) return NextResponse.json({ ok: false, error: `Unknown ticker '${rawSymbol}' (not in securities_c).` }, { status: 404 });

  let institutional: SupabaseClient;
  try {
    institutional = createInstitutionalServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: false, error: "INSTITUTIONAL database not configured" }, { status: 503 });
  }

  const orderId = `UAT-ADHOC-${Date.now().toString(36)}`;
  const nowIso = new Date().toISOString();
  const auditRow = {
    order_id: orderId,
    client_account: auth.ctx.email,
    symbol: sec.symbol,
    side,
    quantity: qty,
    price_cents: priceRands != null ? Math.round(priceRands * 100) : null,
    status: "working",
    source: "UAT_ADHOC_ORDER",
    payload: {
      book_id: BOOK_ID,
      broker: BROKER,
      order_type: priceRands != null ? "limit" : "market",
      strategy: BOOK_ID,
      security_id: sec.id,
      isin: sec.isin ?? null,
      limitPrice: priceRands,
      sent_by: auth.ctx.email,
      sent_at: nowIso,
      trader: auth.ctx.email,
      uat_test: true,
    },
    result_payload: {
      broker: BROKER,
      venue: "JSE",
      tif: "DAY",
      arrivalMid: sec.last_price != null ? Number(sec.last_price) / 100 : null,
      uat_test: true,
    },
  };

  const { data: inserted, error: insErr } = await institutional
    .from("oems_order_audit")
    .insert(auditRow)
    .select("id, order_id")
    .maybeSingle();
  if (insErr || !inserted) {
    return NextResponse.json({ ok: false, error: insErr?.message ?? "audit insert failed" }, { status: 500 });
  }
  const auditId = inserted.id as string;

  // Fan out to the worker (audit row is the source of truth either way).
  if (!isIressWorkerConfigured()) {
    return NextResponse.json({
      ok: true,
      orderAuditId: auditId,
      orderId,
      bookId: BOOK_ID,
      mode: "audit-only",
      notice: "IRESS_WORKER_URL not configured on Vercel; order recorded, not sent to IRESS.",
    });
  }

  const res = await callWorker<WorkerUatResponse>({
    method: "POST",
    path: "/uat/send-to-market",
    body: { order_audit_id: auditId, broker_destination: BROKER },
    timeoutMs: 15_000,
  });

  if (res.ok && res.body?.ok) {
    return NextResponse.json({
      ok: true,
      orderAuditId: auditId,
      orderId,
      bookId: BOOK_ID,
      mode: "uat",
      iressOrderNumber: res.body.iressOrderNumber ?? null,
      status: res.body.status ?? "working",
    });
  }

  // Surface the worker's actual reason. On a non-2xx (e.g. the 422 the
  // pre-trade naked-short guard returns) callWorker's `error` is the generic
  // "Worker returned 422" — the useful message ("Sell blocked: 200 CAC exceeds
  // available-to-sell 100…") is in `errorBody`. Prefer it so the desk sees WHY.
  const upstream =
    !res.ok && res.errorBody && typeof res.errorBody === "object"
      ? (res.errorBody as { message?: string; error?: string; code?: string })
      : undefined;
  const errMsg = res.ok
    ? (res.body?.errorDescription ?? res.body?.errorNumber?.toString() ?? "unknown worker error")
    : (upstream?.message ?? upstream?.error ?? res.error);
  return NextResponse.json({
    ok: false,
    orderAuditId: auditId,
    orderId,
    bookId: BOOK_ID,
    mode: "uat",
    status: "rejected",
    error: errMsg,
    code: upstream?.code ?? (res.ok ? undefined : res.code),
  });
}
