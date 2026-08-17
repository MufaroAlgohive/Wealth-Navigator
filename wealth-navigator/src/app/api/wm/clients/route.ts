import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";
import { loadCanonicalRetailAum } from "@/lib/aum/canonical-retail-aum";
import { loadRetailLiveScope } from "@/lib/aum/retail-live-scope";

export const dynamic = "force-dynamic";

type KycState = "not_initiated" | "pending" | "verified" | "rejected" | "resubmission_required";

function text(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function resolveKyc(
  onboarding?: Record<string, unknown> | null,
  required?: Record<string, unknown> | null,
): KycState {
  const status = text(onboarding?.kyc_status);
  const answer = text(onboarding?.sumsub_review_answer);
  const review = text(onboarding?.sumsub_review_status);
  if (answer === "red" || status.includes("reject")) return "rejected";
  if (required?.kyc_needs_resubmission === true) return "resubmission_required";
  if (answer === "yellow" || answer === "orange" || /pending|review|process|init/.test(review))
    return "pending";
  if (required?.kyc_verified === true || answer === "green" || /verified|completed|approved/.test(status))
    return "verified";
  if (status || answer || review) return "pending";
  return "not_initiated";
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

async function requireStaff() {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return { error: NextResponse.json({ ok: false, error: "no-session" }, { status: 401 }) };
  if (auth.status !== "ok")
    return { error: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  return { auth };
}

export async function GET(req: Request) {
  const access = await requireStaff();
  if ("error" in access) return access.error;

  let db: ReturnType<typeof createRetailServiceRoleClient>;
  try {
    db = createRetailServiceRoleClient();
  } catch {
    return NextResponse.json({ ok: false, error: "RETAIL database not configured" }, { status: 503 });
  }

  const url = new URL(req.url);
  const userId = url.searchParams.get("user_id");
  let canonicalAum;
  let liveScope;
  try {
    [canonicalAum, liveScope] = await Promise.all([
      loadCanonicalRetailAum(db),
      loadRetailLiveScope(db),
    ]);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: `Canonical LIVE AUM unavailable: ${error instanceof Error ? error.message : String(error)}` },
      { status: 503 },
    );
  }

  if (!userId) {
    const [
      { data: profiles, error: profileError },
      { data: onboarding },
      { data: required },
      { data: latestDate },
    ] = await Promise.all([
      db
        .from("profiles")
        .select("id,first_name,last_name,email,phone_number,mint_number,avatar_url,created_at,is_test")
        .order("created_at", { ascending: false })
        .limit(2000),
      db.from("user_onboarding").select("user_id,kyc_status,sumsub_review_answer,sumsub_review_status"),
      db.from("required_actions").select("user_id,kyc_verified,kyc_needs_resubmission,bank_linked"),
      db
        .from("client_strategy_returns_c")
        .select("as_of_date")
        .order("as_of_date", { ascending: false })
        .limit(1),
    ]);
    if (profileError) return NextResponse.json({ ok: false, error: profileError.message }, { status: 500 });

    const asOf = latestDate?.[0]?.as_of_date as string | undefined;
    const { data: returns } = asOf
      ? await db
          .from("client_strategy_returns_c")
          .select("user_id,strategy_id,basket_value,ytd_pnl")
          .eq("as_of_date", asOf)
      : { data: [] };
    const ob = new Map(
      (onboarding ?? []).map((row) => [String(row.user_id), row as Record<string, unknown>]),
    );
    const ra = new Map((required ?? []).map((row) => [String(row.user_id), row as Record<string, unknown>]));
    const money = new Map<string, { aumCents: number; ytdPnlCents: number }>();
    for (const position of canonicalAum.byPosition.values()) {
      const current = money.get(position.userId) ?? { aumCents: 0, ytdPnlCents: 0 };
      current.aumCents += position.aumCents;
      money.set(position.userId, current);
    }
    for (const row of returns ?? []) {
      const id = String(row.user_id);
      if (liveScope.excludedUserIds.has(id) || liveScope.excludedStrategyIds.has(String(row.strategy_id))) continue;
      const current = money.get(id) ?? { aumCents: 0, ytdPnlCents: 0 };
      current.ytdPnlCents += Number(row.ytd_pnl) || 0;
      money.set(id, current);
    }
    const clients = (profiles ?? []).filter((profile) => !liveScope.excludedUserIds.has(String(profile.id))).map((profile) => {
      const id = String(profile.id);
      const m = money.get(id) ?? { aumCents: 0, ytdPnlCents: 0 };
      return {
        ...profile,
        name:
          `${profile.first_name ?? ""} ${profile.last_name ?? ""}`.trim() || profile.email || id.slice(0, 8),
        kyc: resolveKyc(ob.get(id), ra.get(id)),
        bankLinked: ra.get(id)?.bank_linked === true,
        aumCents: m.aumCents,
        ytdPct: m.aumCents ? (m.ytdPnlCents / (m.aumCents - m.ytdPnlCents || m.aumCents)) * 100 : null,
      };
    });
    return NextResponse.json({ ok: true, source: "canonical-live-retail-aum", asOf: canonicalAum.asOf, clients });
  }

  if (liveScope.excludedUserIds.has(userId)) {
    return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  }

  const [{ data: profile }, { data: onboarding }, { data: required }, { data: pack }, { data: family }] =
    await Promise.all([
      db.from("profiles").select("*").eq("id", userId).maybeSingle(),
      db.from("user_onboarding").select("*").eq("user_id", userId).maybeSingle(),
      db.from("required_actions").select("*").eq("user_id", userId).maybeSingle(),
      db.from("user_onboarding_pack_details").select("*").eq("user_id", userId).maybeSingle(),
      db
        .from("family_members")
        .select("*")
        .or(`primary_user_id.eq.${userId},parent_id.eq.${userId},linked_user_id.eq.${userId}`)
        .order("created_at"),
    ]);
  if (!profile) return NextResponse.json({ ok: false, error: "Client not found" }, { status: 404 });

  const children = (family ?? []).filter((member) => text(member.relationship) === "child");
  const linkedUserIds = [
    userId,
    ...children.map((child) => String(child.linked_user_id ?? "")).filter(Boolean),
  ];
  const familyIds = children.map((child) => child.id).filter(Boolean);
  const [{ data: holdings }, { data: transactions }, { data: familyTransactions }] = await Promise.all([
    db
      .from("stock_holdings_c")
      .select("*")
      .in("user_id", linkedUserIds)
      .eq("is_active", true)
      .eq("trade_side", "BUY"),
    db
      .from("transactions")
      .select("*")
      .in("user_id", linkedUserIds)
      .order("transaction_date", { ascending: false })
      .limit(250),
    familyIds.length
      ? db
          .from("family_transactions")
          .select("*")
          .in("member_id", familyIds)
          .order("created_at", { ascending: false })
          .limit(250)
      : Promise.resolve({ data: [] }),
  ]);

  const securityIds = [...new Set((holdings ?? []).map((row) => row.security_id).filter(Boolean))];
  const strategyIds = [...new Set((holdings ?? []).map((row) => row.strategy_id).filter(Boolean))];
  const [
    { data: securities },
    { data: intraday },
    { data: strategies },
    { data: strategyReturns },
    { data: residuals },
    { data: aumFeeState },
  ] = await Promise.all([
    securityIds.length
      ? db.from("securities_c").select("id,symbol,name,sector,last_price").in("id", securityIds)
      : Promise.resolve({ data: [] }),
    securityIds.length
      ? db
          .from("stock_intraday_c")
          .select("security_id,current_price,timestamp")
          .in("security_id", securityIds)
          .order("timestamp", { ascending: false })
          .limit(5000)
      : Promise.resolve({ data: [] }),
    strategyIds.length
      ? db.from("strategies_c").select("id,name,short_name").in("id", strategyIds)
      : Promise.resolve({ data: [] }),
    strategyIds.length
      ? db
          .from("client_strategy_returns_c")
          .select("user_id,strategy_id,as_of_date,basket_value,1d_pct,5d_pct,1m_pct,ytd_pct,inception_pct,inception_pnl")
          .in("user_id", linkedUserIds)
          .in("strategy_id", strategyIds)
          .order("as_of_date", { ascending: true })
      : Promise.resolve({ data: [] }),
    strategyIds.length
      ? db
          .from("strategy_rebalance_residuals")
          .select("user_id,family_member_id,strategy_id,balance_cents")
          .in("user_id", linkedUserIds)
          .in("strategy_id", strategyIds)
      : Promise.resolve({ data: [] }),
    strategyIds.length
      ? db
          .from("strategy_aum_fee_state")
          .select("user_id,family_member_id,strategy_id,aum_fee_consumed_cents,aum_fee_receivable_cents,low_cash_flag")
          .in("user_id", linkedUserIds)
          .in("strategy_id", strategyIds)
      : Promise.resolve({ data: [] }),
  ]);
  const secMap = new Map((securities ?? []).map((row) => [String(row.id), row]));
  const intradayMap = new Map<string, number>();
  for (const row of intraday ?? []) {
    const id = String(row.security_id);
    if (!intradayMap.has(id) && Number(row.current_price) > 0) intradayMap.set(id, Number(row.current_price));
  }
  const strategyMap = new Map((strategies ?? []).map((row) => [String(row.id), row]));
  const enrichedHoldings = (holdings ?? []).map((holding) => {
    const security = secMap.get(String(holding.security_id));
    const strategy = strategyMap.get(String(holding.strategy_id));
    const quantity = Number(holding.quantity) || 0;
    const priceCents =
      intradayMap.get(String(holding.security_id)) ||
      Number(security?.last_price) ||
      Number(holding.avg_fill) ||
      0;
    let fillCents = Number(holding.avg_fill) || 0;
    if (fillCents > 0 && priceCents > 0) {
      const rawDistance = Math.abs(fillCents - priceCents);
      const randDistance = Math.abs(fillCents * 100 - priceCents);
      if (randDistance < rawDistance) fillCents *= 100;
    }
    let costCents = fillCents;
    // Column is "Expected_fill" (capital E) — the row comes from .select("*"), so the
    // lowercase key was always undefined, silently disabling this cost-basis branch and
    // falling back to avg_fill (the broker fill). That made this route's cost basis /
    // P&L disagree with every other surface, which uses Expected_fill (the price the
    // client actually saw). Lowercase kept as a defensive fallback.
    const expected = Number(holding.Expected_fill ?? holding.expected_fill) || 0;
    if (expected > 0) {
      const expectedAsCents = Math.abs(expected - priceCents) <= Math.abs(expected * 100 - priceCents)
        ? expected
        : expected * 100;
      costCents = expectedAsCents;
    }
    return {
      ...holding,
      symbol: security?.symbol ?? null,
      securityName: security?.name ?? null,
      sector: security?.sector ?? null,
      strategyName: strategy?.short_name ?? strategy?.name ?? holding.strategy_name_snapshot ?? null,
      priceCents,
      averageFillCents: fillCents,
      averageCostCents: costCents,
      marketValueCents: Math.round(quantity * priceCents),
      investedCents: Math.round(quantity * costCents),
    };
  });

  const sumsubRaw = parseObject(onboarding?.sumsub_raw);
  const mandate = parseObject(sumsubRaw.mandate_data);
  return NextResponse.json({
    ok: true,
    source: "retail-supabase",
    profile,
    onboarding,
    required,
    onboardingPack: pack?.pack_details ?? null,
    kyc: resolveKyc(onboarding as Record<string, unknown> | null, required as Record<string, unknown> | null),
    mandate: { available: Object.keys(mandate).length > 0, data: mandate },
    household: family ?? [],
    children,
    holdings: enrichedHoldings,
    strategyReturns: strategyReturns ?? [],
    residuals: residuals ?? [],
    aumFeeState: aumFeeState ?? [],
    transactions: transactions ?? [],
    familyTransactions: familyTransactions ?? [],
  });
}
