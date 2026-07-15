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

type KycState = "not_initiated" | "pending" | "verified" | "rejected" | "resubmission_required";

function deriveKyc(
  ob?: { kyc_status?: string | null; sumsub_review_answer?: string | null; sumsub_review_status?: string | null },
  ra?: { kyc_verified?: boolean | null; kyc_needs_resubmission?: boolean | null },
): KycState {
  const status = String(ob?.kyc_status || "").trim().toLowerCase();
  const answer = String(ob?.sumsub_review_answer || "").trim().toLowerCase();
  const review = String(ob?.sumsub_review_status || "").trim().toLowerCase();
  if (answer === "red" || status.includes("reject")) return "rejected";
  if (ra?.kyc_needs_resubmission) return "resubmission_required";
  if (ra?.kyc_verified || answer === "green" || /verified|completed|approved/.test(status)) return "verified";
  if (answer === "yellow" || answer === "orange" || /pending|review|process|init/.test(review)) return "pending";
  if (status || answer || review) return "pending";
  return "not_initiated";
}

function deriveChildKyc(member: Record<string, unknown>): KycState {
  const status = String(member.certificate_verification_status || member.kyc_status || "")
    .trim()
    .toLowerCase();
  if (/verified|approved|accepted|completed/.test(status)) return "verified";
  if (/reject|declined/.test(status)) return "rejected";
  if (/pending|review|submitted|uploaded/.test(status)) return "pending";
  return "not_initiated";
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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

  let db: ReturnType<typeof createRetailServiceRoleClient>;
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
    const obMap: Record<string, { kyc_status?: string | null; sumsub_review_answer?: string | null; sumsub_review_status?: string | null }> = {};
    const raMap: Record<string, { kyc_verified?: boolean | null; kyc_needs_resubmission?: boolean | null; bank_linked?: boolean | null }> = {};
    const parentIds = new Set<string>();
    const childProfileIds = new Set<string>();
    let familyRows: Record<string, unknown>[] = [];
    if (ids.length) {
      const [{ data: ob }, { data: ra }, { data: family }] = await Promise.all([
        db.from("user_onboarding").select("user_id, kyc_status, sumsub_review_answer, sumsub_review_status").in("user_id", ids),
        db.from("required_actions").select("user_id, kyc_verified, kyc_needs_resubmission, bank_linked").in("user_id", ids),
        db.from("family_members").select("*"),
      ]);
      for (const o of ob ?? []) obMap[o.user_id as string] = o;
      for (const r of ra ?? []) raMap[r.user_id as string] = r;
      familyRows = (family ?? []) as Record<string, unknown>[];
      for (const member of family ?? []) {
        if (String(member.relationship || "").trim().toLowerCase() !== "child") continue;
        const parentId = String(member.primary_user_id || member.parent_id || "").trim();
        const linkedUserId = String(member.linked_user_id || "").trim();
        if (parentId) parentIds.add(parentId);
        if (linkedUserId) childProfileIds.add(linkedUserId);
      }
    }
    const profileClients = rows.map((p) => ({
      id: p.id,
      name: `${p.first_name || ""} ${p.last_name || ""}`.trim() || p.email || p.id.slice(0, 8),
      email: p.email,
      mint_number: p.mint_number,
      is_test: p.is_test,
      created_at: p.created_at,
      kyc: deriveKyc(obMap[p.id], raMap[p.id]),
      bank_linked: !!raMap[p.id]?.bank_linked,
      family_role: childProfileIds.has(String(p.id)) ? "child" : parentIds.has(String(p.id)) ? "parent" : "other",
      family_member_id: null,
      is_linked_child: childProfileIds.has(String(p.id)),
    }));
    const unlinkedChildren = familyRows
      .filter((member) => String(member.relationship || "").trim().toLowerCase() === "child")
      .filter((member) => !String(member.linked_user_id || "").trim())
      .map((member) => {
        const familyMemberId = String(member.id || "");
        const firstName = String(member.first_name || "");
        const lastName = String(member.last_name || "");
        return {
          id: `family:${familyMemberId}`,
          name: `${firstName} ${lastName}`.trim() || `Child ${familyMemberId.slice(0, 8)}`,
          email: (member.email as string | null) ?? null,
          mint_number: (member.mint_number as string | null) ?? null,
          is_test: false,
          created_at: member.created_at ?? null,
          kyc: deriveChildKyc(member),
          bank_linked: false,
          family_role: "child" as const,
          family_member_id: familyMemberId,
          is_linked_child: false,
        };
      });
    const clients = [...profileClients, ...unlinkedChildren];
    return NextResponse.json({ ok: true, clients });
  }

  if (action === "detail") {
    const userId = url.searchParams.get("user_id") || "";
    const familyMemberId = url.searchParams.get("family_member_id") || "";
    if (familyMemberId) {
      const [{ data: member }, { data: holds }, { data: txns }] = await Promise.all([
        db.from("family_members").select("*").eq("id", familyMemberId).maybeSingle(),
        db.from("stock_holdings_c").select("security_id, quantity, avg_fill, Expected_fill, strategy_name_snapshot").eq("family_member_id", familyMemberId).eq("is_active", true).eq("trade_side", "BUY"),
        db.from("family_transactions").select("*").eq("member_id", familyMemberId).order("created_at", { ascending: false }).limit(25),
      ]);
      if (!member) return NextResponse.json({ ok: false, error: "Family member not found" }, { status: 404 });
      const secIds = [...new Set((holds ?? []).map((holding) => holding.security_id).filter(Boolean))];
      const secMap: Record<string, { symbol: string; name: string | null; last_price: number | null }> = {};
      if (secIds.length) {
        const { data: securities } = await db.from("securities_c").select("id, symbol, name, last_price").in("id", secIds);
        for (const security of securities ?? []) secMap[security.id as string] = security as never;
      }
      const holdings = (holds ?? []).map((holding) => {
        const security = secMap[holding.security_id as string];
        const qty = Number(holding.quantity) || 0;
        const costCents = costCentsPerShare(holding);
        const priceCents = Number(security?.last_price) > 0 ? Number(security?.last_price) : costCents;
        const valueCents = qty * priceCents;
        const purchaseValueCents = qty * costCents;
        return { symbol: security?.symbol ?? "—", name: security?.name ?? "—", qty, valueCents, purchaseValueCents, pnlCents: valueCents - purchaseValueCents, strategy: holding.strategy_name_snapshot ?? null };
      });
      const parentId = String(member.primary_user_id || member.parent_id || "");
      const { data: parent } = parentId
        ? await db.from("profiles").select("first_name,last_name,email").eq("id", parentId).maybeSingle()
        : { data: null };
      return NextResponse.json({
        ok: true,
        profile: {
          ...member,
          managing_parent: parent ? `${parent.first_name || ""} ${parent.last_name || ""}`.trim() : parentId || null,
          guardian_email: parent?.email ?? null,
        },
        onboarding: null,
        required: null,
        kyc: deriveChildKyc(member as Record<string, unknown>),
        holdings,
        transactions: (txns ?? []).map((transaction) => ({
          ...transaction,
          transaction_date: transaction.transaction_date || transaction.created_at || null,
        })),
        is_unlinked_child: true,
        child_certificate: {
          url: member.certificate_url ?? null,
          status: member.certificate_verification_status ?? member.kyc_status ?? null,
          reviewed_at: member.kyc_reviewed_at ?? null,
        },
      });
    }
    if (!userId) return NextResponse.json({ ok: false, error: "user_id required" }, { status: 400 });

    const [{ data: profile }, { data: onboarding }, { data: required }, { data: pack }, { data: holds }, { data: txns }] = await Promise.all([
      db.from("profiles").select("*").eq("id", userId).maybeSingle(),
      db.from("user_onboarding").select("*").eq("user_id", userId).maybeSingle(),
      db.from("required_actions").select("*").eq("user_id", userId).maybeSingle(),
      db.from("user_onboarding_pack_details").select("pack_details").eq("user_id", userId).maybeSingle(),
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
      // securities_c.last_price is INTEGER CENTS (ZAc) -> divide by 100 for Rands.
      const liveRands = sec?.last_price != null && Number(sec.last_price) > 0 ? Number(sec.last_price) / 100 : costCents / 100;
      const valueCents = qty * Math.round(liveRands * 100);
      const investedCents = qty * costCents;
      return { symbol: sec?.symbol ?? "—", name: sec?.name ?? "—", qty, valueCents, purchaseValueCents: investedCents, pnlCents: valueCents - investedCents, strategy: h.strategy_name_snapshot ?? null };
    }).sort((a, b) => b.valueCents - a.valueCents);

    const sumsubRaw = parseRecord(onboarding?.sumsub_raw);
    const mandateData = parseRecord(sumsubRaw.mandate_data);
    return NextResponse.json({
      ok: true,
      profile: profile ?? null,
      onboarding: onboarding ?? null,
      required: required ?? null,
      onboarding_pack: pack?.pack_details ?? null,
      mandate: {
        available: Object.keys(mandateData).length > 0 || Boolean(onboarding?.signed_agreement_url),
        data: mandateData,
        signed_agreement_url: onboarding?.signed_agreement_url ?? null,
      },
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
  const body = ((await req.json().catch(() => ({}))) ?? {}) as { user_id?: string; family_member_id?: string; decision?: string };

  if (action === "child-certificate-review") {
    const familyMemberId = String(body.family_member_id || "");
    const decision = body.decision === "approve" ? "verified" : body.decision === "reject" ? "rejected" : "pending";
    if (!familyMemberId) return NextResponse.json({ ok: false, error: "family_member_id required" }, { status: 400 });
    let db: ReturnType<typeof createRetailServiceRoleClient>;
    try {
      db = createRetailServiceRoleClient();
    } catch {
      return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
    }
    const now = new Date().toISOString();
    const { data: member, error } = await db
      .from("family_members")
      .update({
        certificate_verification_status: decision,
        kyc_status: decision,
        kyc_reviewed_at: now,
        updated_at: now,
      })
      .eq("id", familyMemberId)
      .select("id,certificate_verification_status,kyc_status,kyc_reviewed_at")
      .maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    if (!member) return NextResponse.json({ ok: false, error: "Family member not found" }, { status: 404 });
    return NextResponse.json({ ok: true, decision, member });
  }

  if (action === "kyc-review") {
    const userId = String(body.user_id || "");
    const decision = body.decision === "approve" ? "approve" : "reject";
    if (!userId) return NextResponse.json({ ok: false, error: "user_id required" }, { status: 400 });
    let db: ReturnType<typeof createRetailServiceRoleClient>;
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
