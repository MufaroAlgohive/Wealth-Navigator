import { NextResponse } from "next/server";

import { POST as parkClientOrder } from "@/app/api/admin/orderbook/client-order/route";
import { getAdminContext, isAdminRole } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ForwardResult = {
  symbol: string;
  securityId: string | null;
  holdingId: string;
  quantity: number;
  ok: boolean;
  alreadyForwarded?: boolean;
  orderAuditId?: string | null;
  orderId?: string | null;
  error?: string | null;
  recoveredAt: string;
};

const clean = (value: unknown) => String(value ?? "").trim();

/**
 * Idempotently recover a claimed direct gift whose pending holdings never
 * reached the OEM order book. The canonical client-order route still owns
 * validation, LIVE/UAT classification and payload.holding_id idempotency.
 */
export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok" || !isAdminRole(auth.ctx)) {
    return NextResponse.json({ ok: false, error: "Admins only" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const claimId = clean(body.claim_id);
  if (!claimId) {
    return NextResponse.json({ ok: false, error: "claim_id is required" }, { status: 400 });
  }

  let db: ReturnType<typeof createRetailServiceRoleClient>;
  try {
    db = createRetailServiceRoleClient();
  } catch (error) {
    return NextResponse.json({ ok: false, error: (error as Error).message }, { status: 503 });
  }

  const { data: claim, error: claimError } = await db
    .from("gift_claims")
    .select("id,status,sender_user_id,recipient_user_id,asset_name,oems_forward_payload")
    .eq("id", claimId)
    .maybeSingle();
  if (claimError || !claim) {
    return NextResponse.json(
      { ok: false, error: claimError?.message || "Gift claim not found" },
      { status: 404 },
    );
  }
  if (clean(claim.status).toLowerCase() !== "claimed") {
    return NextResponse.json(
      { ok: false, error: "Only a claimed direct gift can be recovered to the order book." },
      { status: 409 },
    );
  }
  if (!claim.recipient_user_id) {
    return NextResponse.json(
      { ok: false, error: "The claimed gift has no recipient user to settle the order to." },
      { status: 422 },
    );
  }

  const references = [`GIFT-CLAIM-${claimId}`, `GIFT2-CLAIM-${claimId}`];
  const { data: transactions, error: transactionError } = await db
    .from("transactions")
    .select("id")
    .eq("user_id", claim.recipient_user_id)
    .in("store_reference", references);
  if (transactionError) {
    return NextResponse.json({ ok: false, error: transactionError.message }, { status: 500 });
  }

  const transactionIds = (transactions ?? []).map((row) => clean(row.id)).filter(Boolean);
  let holdings: Array<{
    id: string;
    security_id: string | null;
    quantity: number | null;
    user_id: string | null;
  }> = [];
  if (transactionIds.length) {
    const result = await db
      .from("stock_holdings_c")
      .select("id,security_id,quantity,user_id")
      .eq("user_id", claim.recipient_user_id)
      .in("transaction_id", transactionIds);
    if (result.error) {
      return NextResponse.json({ ok: false, error: result.error.message }, { status: 500 });
    }
    holdings = result.data ?? [];
  }
  if (!holdings.length) {
    return NextResponse.json(
      { ok: false, error: "No pending holdings were found for this claimed gift." },
      { status: 404 },
    );
  }

  const securityIds = [...new Set(holdings.map((row) => clean(row.security_id)).filter(Boolean))];
  const { data: securities, error: securityError } = securityIds.length
    ? await db.from("securities_c").select("id,symbol,last_price").in("id", securityIds)
    : { data: [], error: null };
  if (securityError) {
    return NextResponse.json({ ok: false, error: securityError.message }, { status: 500 });
  }
  const securityById = new Map((securities ?? []).map((row) => [clean(row.id), row] as const));
  const { data: recipient } = await db
    .from("profiles")
    .select("email")
    .eq("id", claim.recipient_user_id)
    .maybeSingle();

  const recoveredAt = new Date().toISOString();
  const results: ForwardResult[] = [];
  for (const holding of holdings) {
    const security = securityById.get(clean(holding.security_id));
    const symbol = clean(security?.symbol).toUpperCase();
    const quantity = Math.floor(Number(holding.quantity));
    if (!symbol || !Number.isFinite(quantity) || quantity <= 0) {
      results.push({
        symbol: symbol || "UNKNOWN",
        securityId: holding.security_id,
        holdingId: holding.id,
        quantity: Number.isFinite(quantity) ? quantity : 0,
        ok: false,
        error: "Holding is missing a valid symbol or positive quantity.",
        recoveredAt,
      });
      continue;
    }

    const internalHeaders: Record<string, string> = { "content-type": "application/json" };
    const secret = process.env.MINT_CLIENT_ORDER_SECRET;
    if (secret) internalHeaders.authorization = `Bearer ${secret}`;
    const cookie = req.headers.get("cookie");
    if (cookie) internalHeaders.cookie = cookie;
    const orderResponse = await parkClientOrder(
      new Request("http://internal/api/admin/orderbook/client-order", {
        method: "POST",
        headers: internalHeaders,
        body: JSON.stringify({
          holding_id: holding.id,
          symbol,
          side: "buy",
          qty: quantity,
          price_cents:
            Number.isFinite(Number(security?.last_price)) && Number(security?.last_price) > 0
              ? Math.round(Number(security?.last_price))
              : null,
          client_email: clean(recipient?.email) || "gift-recipient@mint.system",
          source_ref: claimId,
          book_id: `GIFT-${claimId}`,
        }),
      }),
    );
    const responseBody = (await orderResponse.json().catch(() => ({}))) as Record<string, unknown>;
    const ok = orderResponse.ok && responseBody.ok === true;
    results.push({
      symbol,
      securityId: holding.security_id,
      holdingId: holding.id,
      quantity,
      ok,
      alreadyForwarded: responseBody.alreadyForwarded === true,
      orderAuditId: clean(responseBody.orderAuditId) || null,
      orderId: clean(responseBody.orderId) || null,
      error: ok ? null : clean(responseBody.error) || `HTTP ${orderResponse.status}`,
      recoveredAt,
    });
  }

  const succeeded = results.filter((row) => row.ok).length;
  const forwardStatus = succeeded === results.length ? "forwarded" : succeeded > 0 ? "partial" : "failed";
  const previousPayload = Array.isArray(claim.oems_forward_payload) ? claim.oems_forward_payload : [];
  const { error: updateError } = await db
    .from("gift_claims")
    .update({
      oems_forward_status: forwardStatus,
      oems_forward_payload: [...previousPayload, ...results],
      oems_forwarded_at: recoveredAt,
    })
    .eq("id", claimId);
  if (updateError) {
    return NextResponse.json(
      { ok: false, error: `Orders were recovered, but gift evidence could not be saved: ${updateError.message}`, results },
      { status: 500 },
    );
  }

  return NextResponse.json(
    { ok: succeeded > 0, claimId, status: forwardStatus, recovered: succeeded, total: results.length, results },
    { status: succeeded > 0 ? 200 : 502 },
  );
}
