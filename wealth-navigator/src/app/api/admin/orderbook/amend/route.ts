import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { isIressWorkerConfigured } from "@/lib/data-policy";
import { callWorker } from "@/lib/iress/worker-api";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/orderbook/amend
 *
 * Mint OEM Finalisation — amend an in-flight UAT or production order from
 * the OEMS desk UI. Forwards to the Railway worker's `/orders/amend`
 * route which calls IRESS `OrderAmend2` on the IOS+ service session and
 * stamps `oems_order_audit.status = "amend_pending"` so the desk sees
 * the in-flight instruction immediately. The next poll (or a manual
 * broker ack) flips the row back to WORKING/PARTIAL, preserving any
 * partial fills already on the book.
 *
 * Body: {
 *   account: string,
 *   order_number: string,
 *   price?: number,         // new limit price in Rands (cents optional)
 *   volume?: number,        // new volume in shares
 *   tif?: "DAY" | "GTC" | "IOC" | "FOK",
 *   triggerPrice?: number,  // new trigger price (stop orders)
 * }
 *
 * `OrderAmend2` is a partial update — only the fields you supply are
 * sent to the broker. At least one of price / volume / tif /
 * triggerPrice must be set; the worker rejects an empty amend with
 * 400 + `code: "no_fields"` and the BFF forwards that as-is.
 *
 * 2026-07-15 (Andre + Juan, transcript 09:19-09:42): IRESS OrderAmend2
 * cannot change PricingInstructions — MARKET→LIMIT (or vice versa) is
 * not supported, the broker silently no-ops. The desk reported that
 * "amend price R180" on a MARKET order looked like a successful amend
 * (we set AMEND_PENDING on our side) but Hermes showed nothing changed.
 * We now pre-read the audit row's `payload.order_type` and hard-reject
 * `price` changes on a MARKET order with 422 + `code: "market_price_amend"`
 * so the UI shows the constraint inline.
 *
 * Returns: { ok, orderNumber, account, amendedAt?, newPrice?,
 *   newVolume?, newTif?, workerId?, error? }
 *
 * Auth: same RBAC as cancel + send-to-market (cancelling and amending
 * are both inverse-of-placing operations).
 *
 * 2026-07-14 (Andre + Juan, transcript 36:14-37:04): Andre flagged the
 * absence of an amend function as a next-step deliverable. The
 * lifecycle mirrors cancel: optimistic AMEND_PENDING chip, broker
 * ack flips back to WORKING/PARTIAL. Cancelling an order is disabled
 * once amend_pending is set — the operator must wait for the amend
 * ack before issuing a cancel (avoids racing instructions on the
 * same broker row).
 */

export const dynamic = "force-dynamic";

interface WorkerAmendResponse {
  ok: boolean;
  orderId?: string;
  account?: string;
  amendedAt?: string;
  workerId?: string;
  iressMode?: string;
  newPrice?: number | null;
  newVolume?: number | null;
  newTif?: string | null;
  error?: { code: string; message: string };
}

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (!can(auth.ctx, "orderbook", "send_to_market")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const account = typeof body.account === "string" ? body.account.trim() : "";
  const orderNumber = typeof body.order_number === "string" ? body.order_number.trim() : "";

  if (!account) {
    return NextResponse.json({ ok: false, error: "account is required" }, { status: 400 });
  }
  if (!orderNumber) {
    return NextResponse.json(
      { ok: false, error: "order_number is required (the broker OrderNumber from OrderCreate3)" },
      { status: 400 },
    );
  }

  const numOrUndef = (v: unknown): number | undefined => {
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const priceCents = numOrUndef(body.price_cents);
  const priceRands = numOrUndef(body.price);
  // Accept either price (Rands) or price_cents (cents) — the BFF normalises
  // to Rands for the worker, which then forwards OrderAmend2 in Rands.
  const price = priceCents != null ? priceCents / 100 : priceRands;
  const volume = numOrUndef(body.volume) ?? numOrUndef(body.qty);
  const tifRaw = typeof body.tif === "string" ? body.tif.trim().toUpperCase() : "";
  const tif: "DAY" | "GTC" | "IOC" | "FOK" | undefined =
    tifRaw === "DAY" || tifRaw === "GTC" || tifRaw === "IOC" || tifRaw === "FOK" ? tifRaw : undefined;
  if (typeof body.tif === "string" && tif == null) {
    return NextResponse.json(
      { ok: false, error: "tif must be one of DAY / GTC / IOC / FOK" },
      { status: 400 },
    );
  }
  const triggerPrice = numOrUndef(body.triggerPrice);

  if (price == null && volume == null && tif == null && triggerPrice == null) {
    return NextResponse.json(
      {
        ok: false,
        error: "no_fields",
        message: "Amend requires at least one of price / volume / tif / triggerPrice",
      },
      { status: 400 },
    );
  }

  // 2026-07-15: if the operator is trying to amend `price` we need to
  // confirm the row is LIMIT-ordered. IRESS OrderAmend2 cannot change
  // PricingInstructions — a price change on a MARKET order silently
  // no-ops at the broker (Andre + Juan, transcript 09:19-09:42). We
  // hard-reject here so the UI surfaces the constraint instead of
  // showing a fake AMEND_PENDING that didn't actually change anything.
  if (price != null) {
    try {
      const institutional = createInstitutionalServiceRoleClient();
      if (!institutional) {
        console.warn(
          "[orderbook/amend] cannot read payload.order_type — institutional Supabase not configured; skipping market-amend guard",
        );
      } else {
        const { data: auditRow } = await institutional
          .from("oems_order_audit")
          .select("payload")
          .or(`order_id.eq.${orderNumber},payload->>iress_order_number.eq.${orderNumber}`)
          .limit(1)
          .maybeSingle();
        const auditPayload =
          auditRow && typeof auditRow.payload === "object" && auditRow.payload !== null
            ? (auditRow.payload as Record<string, unknown>)
            : {};
        const rawOrderType = auditPayload.order_type;
        const normalised: "limit" | "market" | null =
          rawOrderType === "limit" || rawOrderType === "market"
            ? rawOrderType
            : null;
        if (normalised === "market") {
          return NextResponse.json(
            {
              ok: false,
              error: "market_price_amend",
              message:
                "OrderAmend2 cannot change PricingInstructions (LIMIT↔MARKET). For a MARKET order, cancel + re-create to set a limit price; volume / TIF amendments are still applied.",
              orderNumber,
              account,
              order_type: normalised,
            },
            { status: 422 },
          );
        }
      }
    } catch (guardErr) {
      console.warn(
        `[orderbook/amend] could not enforce market-price guard: ${guardErr instanceof Error ? guardErr.message : String(guardErr)}`,
      );
      // Fall through — better to attempt the amend than to false-block
      // on a transient Supabase read error.
    }
  }

  if (!isIressWorkerConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: "worker_not_configured",
        message:
          "IRESS_WORKER_URL is not set on Vercel. Amends must go through Hermes directly until the worker is wired up.",
      },
      { status: 503 },
    );
  }

  const amend = await callWorker<WorkerAmendResponse>({
    method: "POST",
    path: "/orders/amend",
    body: {
      account,
      orderId: orderNumber,
      ...(price != null ? { price } : {}),
      ...(volume != null ? { volume } : {}),
      ...(tif != null ? { tif } : {}),
      ...(triggerPrice != null ? { triggerPrice } : {}),
    },
    timeoutMs: 15_000,
  });

  if (!amend.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: "worker_unreachable",
        message: amend.error,
      },
      { status: 502 },
    );
  }

  const body2 = amend.body;
  if (!body2.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: body2.error?.code ?? "amend_failed",
        message: body2.error?.message ?? "Worker returned ok:false for amend",
        orderNumber,
        account,
      },
      { status: 200 }, // ok:false with 200 so the UI can render the reason
    );
  }

  return NextResponse.json({
    ok: true,
    orderNumber,
    account,
    amendedAt: body2.amendedAt ?? new Date().toISOString(),
    newPrice: body2.newPrice ?? null,
    newVolume: body2.newVolume ?? null,
    newTif: body2.newTif ?? null,
    workerId: body2.workerId ?? null,
    iressMode: body2.iressMode ?? null,
  });
}
