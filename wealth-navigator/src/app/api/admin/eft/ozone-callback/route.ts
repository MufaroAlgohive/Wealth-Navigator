import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

import { logEmail } from "@/lib/admin/email";
import { signOzoneCallback } from "@/lib/payments/ozone";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/eft/ozone-callback
 *
 * Mint OEM Finalisation Phase C6 — Ozone webhook receiver.
 *
 * - Body: `{ transaction_id, status, reference }`
 * - Optional header `X-Ozone-Signature: sha256=<hex>`; verified when
 *   `OZONE_WEBHOOK_SECRET` is set (live-mode hardening). For mock
 *   mode the route accepts the unsigned envelope so dev + the
 *   simulated webhook can both exercise the flow.
 * - Flips the matching `wallet_transactions` row to `status` from the
 *   body (`completed` | `failed`) and stashes the provider's
 *   transaction_id in `metadata.ozone_transaction_id`.
 * - On `completed`, logs an `email_logs` row (the dispatch side is
 *   deferred — `console.info` is the audit mark today). Once Tsie
 *   confirms the vendor, this is where the customer confirmation
 *   email will be wired (mirroring the `eft_decision` log emitted by
 *   `/api/admin/eft` `approved-deposit` action).
 *
 * The endpoint is intentionally public-ish (Vercel must accept POSTs
 * from Ozone without a session cookie). We compensate with HMAC + a
 * per-transaction lookup: an attacker who learned the secret could
 * spoof the status of a row they don't know the id of.
 */

export const dynamic = "force-dynamic";

interface CallbackBody {
  transaction_id: string;
  status: "completed" | "failed" | "pending";
  reference?: string;
  metadata?: Record<string, unknown> | null;
}

const VALID_STATUSES = new Set(["completed", "failed", "pending"]);

function openRetail(): SupabaseClient | null {
  try {
    return createRetailServiceRoleClient();
  } catch {
    return null;
  }
}

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = signOzoneCallback(rawBody, secret);
  // Constant-time comparison to avoid timing-side-channel signature leaks.
  if (header.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Whether the callback MUST be signed. Live provider or a production build
 * always requires the HMAC secret (fail-closed). Only dev + mock keep the
 * unsigned escape hatch so the simulated webhook can exercise the flow.
 */
function signatureRequired(): boolean {
  return (
    (process.env.OZONE_MODE ?? "mock").toLowerCase().trim() === "live" ||
    process.env.NODE_ENV === "production"
  );
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const sig = req.headers.get("x-ozone-signature");
  const secret = process.env.OZONE_WEBHOOK_SECRET ?? "";
  if (!secret) {
    // Fail closed in live/prod: an unset secret is a misconfiguration. Reject
    // loudly (recoverable: set OZONE_WEBHOOK_SECRET). Dev + mock keep the
    // unsigned escape hatch so offline simulation still works.
    if (signatureRequired()) {
      return NextResponse.json(
        { ok: false, error: "webhook secret not configured (set OZONE_WEBHOOK_SECRET)" },
        { status: 503 },
      );
    }
  } else if (!verifySignature(rawBody, sig, secret)) {
    return NextResponse.json(
      {
        ok: false,
        error: "invalid signature (X-Ozone-Signature must be the HMAC of the body with OZONE_WEBHOOK_SECRET)",
      },
      { status: 401 },
    );
  }

  let body: CallbackBody;
  try {
    body = rawBody ? (JSON.parse(rawBody) as CallbackBody) : ({} as CallbackBody);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Invalid JSON body: ${(err as Error).message}` },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "Body must be a JSON object" }, { status: 400 });
  }
  const transactionId = typeof body.transaction_id === "string" ? body.transaction_id.trim() : "";
  const status = String(body.status ?? "").toLowerCase();
  const reference = typeof body.reference === "string" ? body.reference.trim() : "";
  if (!transactionId) {
    return NextResponse.json({ ok: false, error: "transaction_id is required" }, { status: 400 });
  }
  if (!VALID_STATUSES.has(status)) {
    return NextResponse.json(
      { ok: false, error: `status must be one of ${[...VALID_STATUSES].join(", ")}` },
      { status: 400 },
    );
  }

  const db = openRetail();
  if (!db) {
    return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
  }

  // Look up the wallet_transactions row by the metadata.ozone_transaction_id
  // we stamped in /api/admin/eft/ozone-topup. If no row matches we 404 so
  // the provider can retry / alert.
  const { data, error: findErr } = await db
    .from("wallet_transactions")
    .select("id, user_id, amount, status, metadata, ozone_reference, topup_method")
    .eq("topup_method", "ozone")
    .contains("metadata", { ozone_transaction_id: transactionId })
    .maybeSingle();

  if (findErr) {
    return NextResponse.json({ ok: false, error: findErr.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json(
      { ok: false, error: `No wallet_transactions row matches ozone_transaction_id="${transactionId}"` },
      { status: 404 },
    );
  }
  const row = data as {
    id: string;
    user_id: string;
    amount: number | string | null;
    status: string | null;
    metadata: Record<string, unknown> | null;
    ozone_reference: string | null;
    topup_method: string | null;
  };

  // Idempotency: skip already-completed rows so a duplicate webhook doesn't
  // double-credit the wallet. Surface the previous decision so the provider
  // can update its own state.
  if (row.status === "completed" && status === "completed") {
    return NextResponse.json({ ok: true, idempotent: true, transaction_id: transactionId });
  }

  const now = new Date().toISOString();
  const upd = await db
    .from("wallet_transactions")
    .update({
      status,
      processed_at: status === "pending" ? null : now,
      metadata: {
        ...(row.metadata ?? {}),
        ozone_callback: {
          status,
          reference: reference || row.ozone_reference || null,
          received_at: now,
          provider_metadata: body.metadata ?? null,
        },
      },
    })
    .eq("id", row.id);
  if (upd.error) {
    return NextResponse.json({ ok: false, error: upd.error.message }, { status: 500 });
  }

  if (status === "completed") {
    // Audit-side email log. The actual customer confirmation send is
    // deferred — once Tsie confirms the vendor this becomes a
    // Resend dispatch mirroring `/api/admin/eft approved-deposit`.
    try {
      const profile = await db
        .from("profiles")
        .select("email, first_name")
        .eq("id", row.user_id)
        .maybeSingle();
      const prof = profile.data as { email: string | null; first_name: string | null } | null;
      if (prof?.email) {
        await logEmail({
          emailType: "wallet_topup_ozone",
          recipient: prof.email,
          subject: "Wallet top-up received",
          status: "sent",
          triggerSource: "ozone-callback",
          metadata: {
            transaction_id: transactionId,
            amount_rands: row.amount,
            reference: reference || row.ozone_reference || null,
          },
        });
      }
    } catch {
      /* email_logs optional; never fail the webhook */
    }
    console.info(
      JSON.stringify({
        level: "info",
        event: "ozone_topup_completed",
        transaction_id: transactionId,
        user_id: row.user_id,
        amount: row.amount,
      }),
    );
  }

  return NextResponse.json({
    ok: true,
    transaction_id: transactionId,
    wallet_transaction_id: row.id,
    status,
  });
}
