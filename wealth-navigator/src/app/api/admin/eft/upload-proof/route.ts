import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/admin/eft/upload-proof
 *
 * Phase B4 — proof-of-funds upload for an inbound EFT deposit.
 *
 * Accepts: `multipart/form-data` with `transaction_id` (uuid) + `file`
 * (image/*). Uploads into the Supabase Storage bucket `wealth-navigator-proofs`
 * under `eft/<transaction_id>/<timestamp>.<ext>`, then persists the resulting
 * signed URL on `wallet_transactions.proof_url`.
 *
 * Bucket is created lazily by the first upload — Supabase Storage creates
 * the bucket on `.upload()` if it doesn't exist as a private bucket. RLS
 * service-role is fine here because we serve the file via signed URLs the
 * UI hydrates from the row.
 *
 * Gates: signed-in team member with `eft/approve_eft` (the operator who can
 * later approve / reject is the same person who reads the proof; we keep the
 * permission symmetric so the operator's role covers both halves of the
 * flow).
 *
 * Returns `{ ok, proof_url, transaction }` on success.
 */

export const dynamic = "force-dynamic";

const BUCKET = "wealth-navigator-proofs";
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB ceiling for a phone screenshot.
const ALLOWED = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/heic", "image/heif"]);

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (auth.ctx.approverTier !== "dev" && !can(auth.ctx, "eft", "approve_eft")) {
    return NextResponse.json({ ok: false, error: "Missing eft/approve_eft" }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "Expected multipart/form-data" }, { status: 400 });
  }

  const transactionId = String(form.get("transaction_id") || "");
  const file = form.get("file");
  if (!transactionId)
    return NextResponse.json({ ok: false, error: "transaction_id required" }, { status: 400 });
  if (!(file instanceof File))
    return NextResponse.json({ ok: false, error: "file required" }, { status: 400 });
  if (!ALLOWED.has(file.type))
    return NextResponse.json({ ok: false, error: "Unsupported file type" }, { status: 400 });
  if (file.size > MAX_BYTES)
    return NextResponse.json({ ok: false, error: "File too large (max 8MB)" }, { status: 400 });

  let db: ReturnType<typeof createRetailServiceRoleClient> | null = null;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
  }

  // Ensure the bucket exists (no-op if it does). Supabase silently creates
  // a private bucket on first upload, but creating it here gives us a clean
  // error path if the org's Storage quota blocks it.
  try {
    const { data: bucketInfo } = await db.storage.getBucket(BUCKET);
    if (!bucketInfo) {
      const { error: createErr } = await db.storage.createBucket(BUCKET, {
        public: false,
        fileSizeLimit: MAX_BYTES,
        allowedMimeTypes: Array.from(ALLOWED),
      });
      if (createErr) {
        // Race-tolerant — another request may have created it concurrently.
        const { data: retry } = await db.storage.getBucket(BUCKET);
        if (!retry)
          return NextResponse.json(
            { ok: false, error: createErr.message || "Bucket create failed" },
            { status: 500 },
          );
      }
    }
  } catch {
    /* bucket enumeration requires service role; if it fails, still try the upload */
  }

  const ext =
    file.type === "image/jpeg" || file.type === "image/jpg"
      ? "jpg"
      : file.type === "image/png"
        ? "png"
        : file.type === "image/webp"
          ? "webp"
          : "img";
  const path = `eft/${transactionId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const arrayBuffer = await file.arrayBuffer();
  const { error: upErr } = await db.storage
    .from(BUCKET)
    .upload(path, arrayBuffer, { contentType: file.type, upsert: true });
  if (upErr) return NextResponse.json({ ok: false, error: upErr.message }, { status: 500 });

  // Persist on the row. The PATCH endpoint (update-proof) is the alternate
  // write path used by flows that landed the signed URL via another mechanism
  // (e.g. an admin upload running client-side directly to the bucket).
  const { data: signed } = await db.storage.from(BUCKET).createSignedUrl(path, 60 * 60 * 24 * 30); // 30d
  const url = signed?.signedUrl ?? null;
  const { data: updated, error: updErr } = await db
    .from("wallet_transactions")
    .update({ proof_url: url })
    .eq("id", transactionId)
    .select("id, proof_url")
    .maybeSingle();
  if (updErr) return NextResponse.json({ ok: false, error: updErr.message }, { status: 500 });
  if (!updated) return NextResponse.json({ ok: false, error: "Transaction not found" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    proof_url: updated.proof_url,
    transaction: { id: updated.id, proof_url: updated.proof_url },
  });
}
