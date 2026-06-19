import { NextResponse } from "next/server";

import { getAdminContext, isAdminRole, can } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import { getApplicantByExternalId, sumsubConfigured } from "@/lib/admin/sumsub";

/**
 * Clients (CRM). Roster + client detail (profile, KYC status, holdings,
 * activity) — all reads over profiles / user_onboarding / required_actions /
 * stock_holdings_c / securities_c / transactions (RETAIL/LIVE).
 * KYC review + document actions are DEFERRED (SumSub / storage backend bucket).
 */

export const dynamic = "force-dynamic";

function deriveKyc(ob?: { kyc_status?: string | null; sumsub_review_answer?: string | null }, ra?: { kyc_verified?: boolean | null }): "verified" | "pending" | "rejected" {
  if (ra?.kyc_verified || ob?.kyc_status === "verified" || ob?.kyc_status === "completed" || ob?.sumsub_review_answer === "GREEN") return "verified";
  if (ob?.sumsub_review_answer === "RED" || ob?.kyc_status === "rejected") return "rejected";
  return "pending";
}

function costCentsPerShare(h: { avg_fill?: number | null; Expected_fill?: number | null }): number {
  const avgCents = Number(h.avg_fill) || 0;
  const expectedRaw = Number(h.Expected_fill) || 0;
  if (expectedRaw > 0) {
    const avgRands = avgCents > 0 ? avgCents / 100 : 0;
    const expectedRands = avgRands > 0 && expectedRaw > avgRands * 5 ? expectedRaw / 100 : expectedRaw;
    return Math.round(expectedRands * 100);
  }
  return avgCents > 0 ? avgCents : 0;
}

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "list";

  let db;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: true, clients: [], notice: "RETAIL database not configured." });
  }

  if (action === "list") {
    const { data: profiles } = await db
      .from("profiles")
      .select("id, first_name, last_name, email, mint_number, avatar_url, created_at, is_test")
      .order("created_at", { ascending: false })
      .limit(2000);
    const rows = profiles ?? [];
    const ids = rows.map((p) => p.id);
    const obMap: Record<string, { kyc_status?: string | null; sumsub_review_answer?: string | null }> = {};
    const raMap: Record<string, { kyc_verified?: boolean | null; bank_linked?: boolean | null }> = {};
    if (ids.length) {
      const [{ data: ob }, { data: ra }] = await Promise.all([
        db.from("user_onboarding").select("user_id, kyc_status, sumsub_review_answer").in("user_id", ids),
        db.from("required_actions").select("user_id, kyc_verified, bank_linked").in("user_id", ids),
      ]);
      for (const o of ob ?? []) obMap[o.user_id as string] = o;
      for (const r of ra ?? []) raMap[r.user_id as string] = r;
    }
    const clients = rows.map((p) => ({
      id: p.id,
      name: `${p.first_name || ""} ${p.last_name || ""}`.trim() || p.email || p.id.slice(0, 8),
      email: p.email,
      mint_number: p.mint_number,
      is_test: p.is_test,
      created_at: p.created_at,
      kyc: deriveKyc(obMap[p.id], raMap[p.id]),
      bank_linked: !!raMap[p.id]?.bank_linked,
    }));
    return NextResponse.json({ ok: true, clients });
  }

  if (action === "detail") {
    const userId = url.searchParams.get("user_id") || "";
    if (!userId) return NextResponse.json({ ok: false, error: "user_id required" }, { status: 400 });

    const [{ data: profile }, { data: onboarding }, { data: required }, { data: holds }, { data: txns }] = await Promise.all([
      db.from("profiles").select("*").eq("id", userId).maybeSingle(),
      db.from("user_onboarding").select("*").eq("user_id", userId).maybeSingle(),
      db.from("required_actions").select("*").eq("user_id", userId).maybeSingle(),
      db.from("stock_holdings_c").select("security_id, quantity, avg_fill, Expected_fill, strategy_name_snapshot").eq("user_id", userId).eq("is_active", true).eq("trade_side", "BUY"),
      db.from("transactions").select("id, name, description, amount, direction, status, transaction_date").eq("user_id", userId).order("transaction_date", { ascending: false }).limit(25),
    ]);

    const secIds = [...new Set((holds ?? []).map((h) => h.security_id).filter(Boolean))];
    const secMap: Record<string, { symbol: string; name: string | null; last_price: number | null }> = {};
    if (secIds.length) {
      const { data: secs } = await db.from("securities_c").select("id, symbol, name, last_price").in("id", secIds);
      for (const s of secs ?? []) secMap[s.id as string] = s as never;
    }
    const holdings = (holds ?? []).map((h) => {
      const sec = secMap[h.security_id as string];
      const qty = Number(h.quantity) || 0;
      const costCents = costCentsPerShare(h);
      const liveRands = sec?.last_price != null && Number(sec.last_price) > 0 ? Number(sec.last_price) : costCents / 100;
      const valueCents = qty * Math.round(liveRands * 100);
      const investedCents = qty * costCents;
      return { symbol: sec?.symbol ?? "—", name: sec?.name ?? "—", qty, valueCents, pnlCents: valueCents - investedCents, strategy: h.strategy_name_snapshot ?? null };
    }).sort((a, b) => b.valueCents - a.valueCents);

    return NextResponse.json({
      ok: true,
      profile: profile ?? null,
      onboarding: onboarding ?? null,
      required: required ?? null,
      kyc: deriveKyc(onboarding ?? undefined, required ?? undefined),
      holdings,
      transactions: txns ?? [],
    });
  }

  if (action === "sumsub") {
    const userId = url.searchParams.get("user_id") || "";
    if (!userId) return NextResponse.json({ ok: false, error: "user_id required" }, { status: 400 });
    if (!sumsubConfigured()) return NextResponse.json({ ok: true, configured: false, notice: "SumSub credentials are not configured." });
    const { data: ob } = await db.from("user_onboarding").select("sumsub_external_user_id").eq("user_id", userId).maybeSingle();
    const ext = (ob?.sumsub_external_user_id as string) || userId;
    const result = await getApplicantByExternalId(ext);
    return NextResponse.json({ ok: true, configured: true, sumsub: result });
  }

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}

export async function POST(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  // KYC review is gated to admins or staff granted clients.manage_kyc.
  if (!isAdminRole(auth.ctx) && can(auth.ctx, "clients", "manage_kyc") !== true) {
    return NextResponse.json({ ok: false, error: "Not permitted to review KYC" }, { status: 403 });
  }

  const action = new URL(req.url).searchParams.get("action") || "";
  const body = ((await req.json().catch(() => ({}))) ?? {}) as { user_id?: string; decision?: string };

  if (action === "kyc-review") {
    const userId = String(body.user_id || "");
    const decision = body.decision === "approve" ? "approve" : "reject";
    if (!userId) return NextResponse.json({ ok: false, error: "user_id required" }, { status: 400 });
    let db;
    try {
      db = createRetailServiceRoleClient();
    } catch {
      return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
    }
    const now = new Date().toISOString();
    if (decision === "approve") {
      await db.from("user_onboarding").update({ kyc_status: "verified", kyc_verified_at: now }).eq("user_id", userId);
      await db.from("required_actions").update({ kyc_verified: true, kyc_verified_at: now, kyc_pending: false, kyc_needs_resubmission: false }).eq("user_id", userId);
    } else {
      await db.from("user_onboarding").update({ kyc_status: "rejected" }).eq("user_id", userId);
      await db.from("required_actions").update({ kyc_verified: false, kyc_needs_resubmission: true, kyc_pending: false }).eq("user_id", userId);
    }
    return NextResponse.json({ ok: true, decision });
  }

  // Document operations (certificate view/download/re-evaluate) → storage backend bucket.
  return NextResponse.json({ ok: false, error: "Document operations are deferred to the storage/backend phase.", deferred: true }, { status: 501 });
}
