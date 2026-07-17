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

export function deriveKyc(
  ob?: { kyc_status?: string | null; sumsub_review_answer?: string | null; sumsub_review_status?: string | null },
  ra?: { kyc_verified?: boolean | null; kyc_needs_resubmission?: boolean | null },
  pack?: unknown,
): KycState {
  const status = String(ob?.kyc_status || "").trim().toLowerCase();
  const answer = String(ob?.sumsub_review_answer || "").trim().toLowerCase();
  const review = String(ob?.sumsub_review_status || "").trim().toLowerCase();
  const packRecord = parseRecord(pack);
  const packReview = parseRecord(packRecord.review);
  const packResult = parseRecord(packReview.result);
  const packAnswer = String(packResult.reviewAnswer || packReview.reviewAnswer || packRecord.reviewAnswer || "").trim().toLowerCase();
  const packStatus = String(packReview.reviewStatus || packRecord.reviewStatus || packRecord.status || "").trim().toLowerCase();
  if (packAnswer === "red" || (!packAnswer && status.includes("reject"))) return "rejected";
  if (packAnswer === "yellow" || packAnswer === "orange" || (!packAnswer && /pending|init|review|process/.test(packStatus))) return "pending";
  if (packAnswer === "green" || (!packAnswer && /completed|approved/.test(packStatus))) return "verified";
  if (/verified|completed|approved|done/.test(status)) return "verified";
  if (/pending|in.progress|review|processing|queued/.test(status)) return "pending";
  // These fields are fallbacks only when CRM's onboarding + pack sources are empty.
  if (ra?.kyc_verified) return "verified";
  if (ra?.kyc_needs_resubmission) return "resubmission_required";
  if (answer === "red") return "rejected";
  if (answer === "green") return "verified";
  if (answer === "yellow" || answer === "orange" || /pending|review|process|init/.test(review)) return "pending";
  if (status || answer || review || packStatus) return "pending";
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

function findProviderValue(source: unknown, aliases: string[], depth = 0): unknown {
  if (!source || typeof source !== "object" || depth > 8) return null;
  const wanted = new Set(aliases.map((alias) => alias.replace(/[^a-z0-9]/gi, "").toLowerCase()));
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (wanted.has(key.replace(/[^a-z0-9]/gi, "").toLowerCase()) && value != null && value !== "" && typeof value !== "object") return value;
  }
  for (const value of Object.values(source as Record<string, unknown>)) {
    const found = findProviderValue(value, aliases, depth + 1);
    if (found != null && found !== "") return found;
  }
  return null;
}

export function inferGenderFromSouthAfricanId(value: unknown): "Female" | "Male" | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!/^\d{13}$/.test(digits)) return null;
  const month = Number(digits.slice(2, 4));
  const day = Number(digits.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    let digit = Number(digits[index]);
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  if ((10 - (sum % 10)) % 10 !== Number(digits[12])) return null;
  return Number(digits.slice(6, 10)) >= 5000 ? "Male" : "Female";
}

function buildRichDetails(profileValue: unknown, onboardingValue: unknown, packValue: unknown, archiveValue: unknown = []) {
  const profile = parseRecord(profileValue);
  const onboarding = parseRecord(onboardingValue);
  const pack = parseRecord(packValue);
  const raw = parseRecord(onboarding.sumsub_raw);
  const info = { ...parseRecord(pack.fixedInfo), ...parseRecord(pack.info) };
  const provenance = parseRecord(pack.data_provenance);
  const archiveRows = Array.isArray(archiveValue) ? archiveValue.map(parseRecord) : [];
  const experianArchive = archiveRows.map((row) => parseRecord(row.resource_metadata)).filter((metadata) => {
    const marker = `${String(metadata.provider || "")} ${String(metadata.source || "")}`.toLowerCase();
    return marker.includes("experian");
  });
  const retainedKyc = raw.experian_kyc_addresses || raw.experian_kyc_contact || experianArchive.length
    ? { addresses: raw.experian_kyc_addresses, contact: raw.experian_kyc_contact, stats: raw.experian_kyc_stats, archive: experianArchive }
    : null;
  const experianKyc = raw.experian_kyc_result ?? parseRecord(pack.experian).kyc ?? retainedKyc;
  const experianIdmn = raw.experian_idmn_result ?? parseRecord(pack.experian).idmn ?? pack.experian_idmn ?? null;
  const experian = experianIdmn ?? experianKyc;
  const choose = (...candidates: Array<[unknown, string]>): { value: unknown; source: string } => {
    const match = candidates.find(([value]) => value != null && value !== "");
    return { value: match?.[0] ?? null, source: match?.[1] ?? "Not available" };
  };
  const idNumber = choose([profile.id_number,"Profile"],[info.idNumber ?? findProviderValue(info,["idNumber","documentNumber"]),"SumSub"],[findProviderValue(experian,["identityNumber","idNumber","documentNumber"]),"Experian"]);
  const storedGenderSource = String(provenance.gender || "").toLowerCase().includes("derived") ? "Derived from SA ID" : "SumSub";
  const explicitGender = choose([profile.gender,"Profile"],[info.gender,storedGenderSource],[findProviderValue(experian,["gender","sex"]),"Experian"]);
  const inferredGender = inferGenderFromSouthAfricanId(idNumber.value);
  const gender = explicitGender.value != null
    ? explicitGender
    : { value: inferredGender, source: inferredGender ? "Derived from SA ID" : "Not available" };
  return {
    fields: {
      first_name: choose([profile.first_name,"Profile"],[info.firstName ?? info.firstNameEn,"SumSub"],[findProviderValue(experian,["firstName","first_name","forename","givenName"]),"Experian"]),
      last_name: choose([profile.last_name,"Profile"],[info.lastName ?? info.lastNameEn,"SumSub"],[findProviderValue(experian,["lastName","last_name","surname","familyName"]),"Experian"]),
      email: choose([profile.email,"Profile"],[info.email,"SumSub"],[findProviderValue(experian,["email","emailAddress"]),"Experian"]),
      phone: choose([profile.phone_number,"Profile"],[info.phone ?? pack.phone,"SumSub"],[findProviderValue(experian,["phoneNumber","mobileNumber","cellphone","cell"]),"Experian"]),
      date_of_birth: choose([profile.date_of_birth,"Profile"],[info.dob ?? info.dateOfBirth,"SumSub"],[findProviderValue(experian,["dateOfBirth","birthDate","dob"]),"Experian"]),
      gender,
      id_number: idNumber,
      address: choose([profile.address,"Profile"],[findProviderValue(info,["formattedAddress","residentialAddress","streetAddress"]),"SumSub"],[findProviderValue(experianKyc ?? experian,["formattedAddress","formatted","residentialAddress","streetAddress","address"]),"Experian"]),
      employer: choose([onboarding.employer_name,"Onboarding"],[findProviderValue(info,["employerName","employer"]),"SumSub"],[findProviderValue(experianKyc ?? experian,["employerName","employer"]),"Experian"]),
      employment_status: choose([onboarding.employment_status,"Onboarding"],[findProviderValue(info,["employmentStatus","occupation"]),"SumSub"],[findProviderValue(experianKyc ?? experian,["employmentStatus","occupation"]),"Experian"]),
    },
    providers: { profile: Object.keys(profile).length>0, sumsub: Boolean(pack.info||pack.fixedInfo), experian: Boolean(experianKyc||experianIdmn) },
  };
}

async function resolveCertificateUrl(db: ReturnType<typeof createRetailServiceRoleClient>, rawValue: unknown) {
  const raw = String(rawValue || "").trim();
  if (!raw) return null;
  let bucket = "";
  let path = "";
  if (raw.startsWith("storage://")) {
    const pointer = raw.slice("storage://".length);
    const slash = pointer.indexOf("/");
    if (slash > 0) { bucket = pointer.slice(0, slash); path = pointer.slice(slash + 1); }
  } else if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      const marker = "/storage/v1/object/";
      const index = parsed.pathname.indexOf(marker);
      if (index >= 0) {
        const parts = parsed.pathname.slice(index + marker.length).split("/").filter(Boolean);
        if (parts[0] === "public" && parts.length >= 3) { bucket = parts[1] ?? ""; path = parts.slice(2).join("/"); }
        else if (parts[0] === "sign" && parts.length >= 4) { bucket = parts[2] ?? ""; path = parts.slice(3).join("/"); }
      }
    } catch { /* retain the original URL below */ }
  } else {
    const slash = raw.indexOf("/");
    if (slash > 0) { bucket = raw.slice(0, slash); path = raw.slice(slash + 1); }
  }
  if (bucket && path) {
    const { data } = await db.storage.from(bucket).createSignedUrl(decodeURIComponent(path), 60 * 60);
    if (data?.signedUrl) return data.signedUrl;
  }
  return /^https?:\/\//i.test(raw) ? raw : null;
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
    const packMap: Record<string, unknown> = {};
    const parentIds = new Set<string>();
    const childProfileIds = new Set<string>();
    let familyRows: Record<string, unknown>[] = [];
    if (ids.length) {
      const [{ data: ob }, { data: ra }, { data: packs }, { data: family }] = await Promise.all([
        db.from("user_onboarding").select("user_id, kyc_status, sumsub_review_answer, sumsub_review_status").in("user_id", ids),
        db.from("required_actions").select("user_id, kyc_verified, kyc_needs_resubmission, bank_linked").in("user_id", ids),
        db.from("user_onboarding_pack_details").select("user_id,pack_details").in("user_id", ids),
        db.from("family_members").select("*"),
      ]);
      for (const o of ob ?? []) obMap[o.user_id as string] = o;
      for (const r of ra ?? []) raMap[r.user_id as string] = r;
      for (const pack of packs ?? []) packMap[pack.user_id as string] = pack.pack_details;
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
      kyc: deriveKyc(obMap[p.id], raMap[p.id], packMap[p.id]),
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
    const stats = profileClients.reduce((counts, client) => {
      counts.total += 1;
      if (client.kyc === "verified") counts.completed += 1;
      else if (client.kyc === "pending" || client.kyc === "resubmission_required") counts.pending += 1;
      else if (client.kyc === "rejected") counts.rejected += 1;
      return counts;
    }, { total: 0, completed: 0, pending: 0, rejected: 0 });
    return NextResponse.json({ ok: true, clients, stats });
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
      const intradayMap = new Map<string, number>();
      if (secIds.length) {
        const [{ data: securities }, { data: intraday }] = await Promise.all([
          db.from("securities_c").select("id, symbol, name, last_price").in("id", secIds),
          db.from("stock_intraday_c").select("security_id,current_price,timestamp").in("security_id", secIds).order("timestamp", { ascending: false }).limit(5000),
        ]);
        for (const security of securities ?? []) secMap[security.id as string] = security as never;
        for (const quote of intraday ?? []) {
          const securityId = String(quote.security_id);
          if (!intradayMap.has(securityId) && Number(quote.current_price) > 0) intradayMap.set(securityId, Number(quote.current_price));
        }
      }
      const holdings = (holds ?? []).map((holding) => {
        const security = secMap[holding.security_id as string];
        const qty = Number(holding.quantity) || 0;
        const costCents = costCentsPerShare(holding);
        const priceCents = intradayMap.get(String(holding.security_id)) ?? (Number(security?.last_price) > 0 ? Number(security?.last_price) : costCents);
        const valueCents = qty * priceCents;
        const purchaseValueCents = qty * costCents;
        return { symbol: security?.symbol ?? "—", name: security?.name ?? "—", qty, valueCents, purchaseValueCents, pnlCents: valueCents - purchaseValueCents, strategy: holding.strategy_name_snapshot ?? null };
      });
      const parentId = String(member.primary_user_id || member.parent_id || "");
      const { data: parent } = parentId
        ? await db.from("profiles").select("first_name,last_name,email").eq("id", parentId).maybeSingle()
        : { data: null };
      const certificateUrl = await resolveCertificateUrl(db, member.certificate_url);
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
          url: certificateUrl,
          status: member.certificate_verification_status ?? member.kyc_status ?? null,
          reviewed_at: member.kyc_reviewed_at ?? null,
        },
      });
    }
    if (!userId) return NextResponse.json({ ok: false, error: "user_id required" }, { status: 400 });

    const [{ data: profile }, { data: onboarding }, { data: required }, { data: pack }, { data: experianArchive }, { data: holds }, { data: txns }] = await Promise.all([
      db.from("profiles").select("*").eq("id", userId).maybeSingle(),
      db.from("user_onboarding").select("*").eq("user_id", userId).maybeSingle(),
      db.from("required_actions").select("*").eq("user_id", userId).maybeSingle(),
      db.from("user_onboarding_pack_details").select("pack_details").eq("user_id", userId).maybeSingle(),
      db.from("sumsub_document_archive").select("resource_metadata,archived_at,file_name").eq("profile_id", userId),
      db.from("stock_holdings_c").select("security_id, quantity, avg_fill, Expected_fill, strategy_name_snapshot").eq("user_id", userId).eq("is_active", true).eq("trade_side", "BUY"),
      db.from("transactions").select("id, name, description, amount, direction, status, transaction_date").eq("user_id", userId).order("transaction_date", { ascending: false }).limit(25),
    ]);
    const { data: linkedChild } = await db.from("family_members").select("id,primary_user_id,parent_id,relationship,certificate_url,certificate_verification_status,kyc_status,kyc_reviewed_at").eq("linked_user_id", userId).eq("relationship", "child").maybeSingle();
    const linkedCertificateUrl = linkedChild ? await resolveCertificateUrl(db, linkedChild.certificate_url) : null;
    const linkedParentId = String(linkedChild?.primary_user_id || linkedChild?.parent_id || "");
    const { data: linkedParent } = linkedParentId
      ? await db.from("profiles").select("first_name,last_name,email").eq("id", linkedParentId).maybeSingle()
      : { data: null };

    const secIds = [...new Set((holds ?? []).map((h) => h.security_id).filter(Boolean))];
    const secMap: Record<string, { symbol: string; name: string | null; last_price: number | null }> = {};
    const intradayMap = new Map<string, number>();
    if (secIds.length) {
      const [{ data: secs }, { data: intraday }] = await Promise.all([
        db.from("securities_c").select("id, symbol, name, last_price").in("id", secIds),
        db.from("stock_intraday_c").select("security_id,current_price,timestamp").in("security_id", secIds).order("timestamp", { ascending: false }).limit(5000),
      ]);
      for (const s of secs ?? []) secMap[s.id as string] = s as never;
      for (const quote of intraday ?? []) {
        const securityId = String(quote.security_id);
        if (!intradayMap.has(securityId) && Number(quote.current_price) > 0) intradayMap.set(securityId, Number(quote.current_price));
      }
    }
    const holdings = (holds ?? []).map((h) => {
      const sec = secMap[h.security_id as string];
      const qty = Number(h.quantity) || 0;
      const costCents = costCentsPerShare(h);
      // securities_c.last_price is INTEGER CENTS (ZAc) -> divide by 100 for Rands.
      const priceCents = intradayMap.get(String(h.security_id)) ?? (sec?.last_price != null && Number(sec.last_price) > 0 ? Number(sec.last_price) : costCents);
      const liveRands = priceCents / 100;
      const valueCents = qty * Math.round(liveRands * 100);
      const investedCents = qty * costCents;
      return { symbol: sec?.symbol ?? "—", name: sec?.name ?? "—", qty, valueCents, purchaseValueCents: investedCents, pnlCents: valueCents - investedCents, strategy: h.strategy_name_snapshot ?? null };
    }).sort((a, b) => b.valueCents - a.valueCents);

    const sumsubRaw = parseRecord(onboarding?.sumsub_raw);
    const mandateData = parseRecord(sumsubRaw.mandate_data);
    return NextResponse.json({
      ok: true,
      profile: profile ? {
        ...profile,
        managing_parent: linkedParent ? `${linkedParent.first_name || ""} ${linkedParent.last_name || ""}`.trim() : null,
        guardian_email: linkedParent?.email ?? null,
        relationship: linkedChild?.relationship ?? profile.relationship ?? null,
      } : null,
      onboarding: onboarding ?? null,
      required: required ?? null,
      onboarding_pack: pack?.pack_details ?? null,
      mandate: {
        available: Object.keys(mandateData).length > 0 || Boolean(onboarding?.signed_agreement_url),
        data: mandateData,
        signed_agreement_url: onboarding?.signed_agreement_url ?? null,
      },
      rich_details: buildRichDetails(profile, onboarding, pack?.pack_details, experianArchive),
      kyc: deriveKyc(onboarding ?? undefined, required ?? undefined, pack?.pack_details),
      holdings,
      transactions: txns ?? [],
      child_family_member_id: linkedChild?.id ?? null,
      child_certificate: linkedChild ? {
        url: linkedCertificateUrl,
        status: linkedChild.certificate_verification_status ?? linkedChild.kyc_status ?? null,
        reviewed_at: linkedChild.kyc_reviewed_at ?? null,
      } : null,
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
    const updatePayload: { certificate_verification_status: string; kyc_pending?: boolean } = {
      certificate_verification_status: decision,
    };
    if (decision === "verified") updatePayload.kyc_pending = true;
    const { data: member, error } = await db
      .from("family_members")
      .update(updatePayload)
      .eq("id", familyMemberId)
      .select("id,certificate_verification_status,kyc_status,kyc_pending")
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
