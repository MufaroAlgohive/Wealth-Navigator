import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { getOzoneProvider } from "@/lib/payments/ozone";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/eft/ozone-topup
 *
 * Mint OEM Finalisation Phase C6 — initiate an Ozone wallet top-up.
 * Phase B4 left a "manual reference" pathway in `/api/admin/eft` (action
 * `topup-ozone`); this route is the structured replacement that consults
 * `OzoneProvider` (mock or live) for a redirect URL.
 *
 * Body: `{ client_id, amount_cents, reference }`
 *   client_id is the profile `id` of the receiving client
 *   amount_cents must be a positive integer in cents (e.g. R100 = 10000)
 *   reference is the operator-visible / ledger key
 *
 * Response: `{ ok, redirect_url, transaction_id, pending_transaction_id }`
 *
 * The wallet_transactions row is inserted with `topup_method='ozone'`
 * + `status='pending'` so the EFT approvals surface picks it up. When
 * the (mock) provider's simulated webhook fires 5s later the row flips
 * to `status='completed'` via `/api/admin/eft/ozone-callback`.
 *
 * Gate: `eft/approve_eft` OR admin tier. The wallet-topup page is in the
 * Banking group (`/oems/banking/wallet-topup`); non-Banking operators
 * already can't reach it.
 */

export const dynamic = "force-dynamic";

interface InitiateBody {
  client_id: string;
  amount_cents: number;
  reference: string;
}

function validate(
  body: Partial<InitiateBody>,
): { ok: true; value: InitiateBody } | { ok: false; error: string } {
  const client_id = typeof body.client_id === "string" ? body.client_id.trim() : "";
  const reference = typeof body.reference === "string" ? body.reference.trim() : "";
  const amount_cents = Number(body.amount_cents);
  if (!client_id) return { ok: false, error: "client_id is required" };
  if (!reference) return { ok: false, error: "reference is required" };
  if (!Number.isFinite(amount_cents) || amount_cents <= 0 || !Number.isInteger(amount_cents)) {
    return { ok: false, error: "amount_cents must be a positive integer (cents)" };
  }
  return { ok: true, value: { client_id, amount_cents, reference } };
}

function openRetail(): SupabaseClient | null {
  try {
    return createRetailServiceRoleClient();
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const hasEft = can(auth.ctx, "eft", "approve_eft") || can(auth.ctx, "eft", "manual_funds");
  if (!hasEft && auth.ctx.approverTier !== "dev" && auth.ctx.role !== "admin") {
    return NextResponse.json(
      { ok: false, error: "missing eft/approve_eft or eft/manual_funds" },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as Partial<InitiateBody>;
  const parsed = validate(body);
  if (!parsed.ok) {
    return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  const db = openRetail();
  if (!db) {
    return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
  }

  const provider = getOzoneProvider();

  // Insert the pending wallet_transactions row FIRST. We need its id so the
  // simulated webhook can correlate the callback. If `initiateTopup` throws
  // we roll back the insert so the queue isn't polluted with orphan rows.
  const insert = await db
    .from("wallet_transactions")
    .insert({
      user_id: parsed.value.client_id,
      amount: parsed.value.amount_cents / 100, // cents → Rands (legacy column)
      status: "pending",
      topup_method: "ozone",
      ozone_reference: parsed.value.reference,
      source: `ozone-${provider.name === "ozone" ? "provider" : "unknown"}`,
      metadata: {
        initiated_by: auth.ctx.email,
        provider_mode: process.env.OZONE_MODE ?? "mock",
        amount_cents: parsed.value.amount_cents,
      },
    })
    .select("id")
    .maybeSingle();
  if (insert.error || !insert.data) {
    return NextResponse.json(
      { ok: false, error: insert.error?.message ?? "wallet_transactions insert failed" },
      { status: 500 },
    );
  }
  const pendingId = (insert.data as { id: string }).id;

  try {
    const init = await provider.initiateTopup({
      client_id: parsed.value.client_id,
      amount_cents: parsed.value.amount_cents,
      reference: parsed.value.reference,
    });

    // Stamp the provider's transaction_id on the wallet_transactions row so
    // the callback can reconcile. If this update fails we surface the error
    // and the operator can either retry or manually dismiss the pending row.
    const stamp = await db
      .from("wallet_transactions")
      .update({
        metadata: {
          initiated_by: auth.ctx.email,
          provider_mode: process.env.OZONE_MODE ?? "mock",
          amount_cents: parsed.value.amount_cents,
          ozone_transaction_id: init.transaction_id,
          ozone_redirect_url: init.redirect_url,
        },
      })
      .eq("id", pendingId);
    if (stamp.error) {
      return NextResponse.json(
        {
          ok: true,
          warning: `topup row created (${pendingId}) but metadata stamp failed: ${stamp.error.message}`,
          redirect_url: init.redirect_url,
          transaction_id: init.transaction_id,
          pending_transaction_id: pendingId,
        },
        { status: 200 },
      );
    }

    return NextResponse.json({
      ok: true,
      redirect_url: init.redirect_url,
      transaction_id: init.transaction_id,
      pending_transaction_id: pendingId,
    });
  } catch (err) {
    // Provider refused — roll back the wallet_transactions row so the
    // operator doesn't see a phantom pending entry.
    await db.from("wallet_transactions").delete().eq("id", pendingId);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      {
        ok: false,
        error: `Ozone provider refused: ${message}`,
        provider_status: await safeHealth(provider),
      },
      { status: 503 },
    );
  }
}

async function safeHealth(provider: { health: () => Promise<unknown> }): Promise<string> {
  try {
    const h = await provider.health();
    return JSON.stringify(h);
  } catch {
    return "unreachable";
  }
}
