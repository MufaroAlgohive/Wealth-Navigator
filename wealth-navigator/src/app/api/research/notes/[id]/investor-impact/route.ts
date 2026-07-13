import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient, createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET /api/research/notes/[id]/investor-impact
 *
 * Affected-investor preview for a research note that's been moved to
 * `ic_pending` / `approved`. Reads the note's proposed_composition (if any)
 * and the most-recent `client_strategy_returns_c` snapshot per affected
 * investor (RETAIL) to compute a per-investor P&L impact estimate. Read-only:
 * never writes to Supabase. Returns an empty list when the institutional
 * research_note_c table hasn't been migrated yet.
 */

export const dynamic = "force-dynamic";

interface ResearchNoteRow {
  id: string;
  symbol: string;
  status: string;
  thesis: unknown;
}

interface ProposedHolding {
  symbol?: string;
  ticker?: string;
  shares?: number;
  weight?: number;
  action?: "remove" | "decrease" | "increase" | "add" | "hold";
}

interface StrategyReturnRow {
  user_id: string;
  strategy_id: string;
  as_of_date: string;
  basket_value: number | string | null;
  ytd_pct: number | string | null;
}

interface HoldingRow {
  user_id: string;
  family_member_id: string | null;
  security_id: string;
  strategy_id: string | null;
  quantity: number;
  avg_fill: number | null;
}

interface SecurityRow {
  id: string;
  symbol: string;
}

interface ProfileRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

function toNum(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

async function openDb(target: "INSTITUTIONAL" | "RETAIL") {
  try {
    return target === "INSTITUTIONAL"
      ? createInstitutionalServiceRoleClient()
      : createRetailServiceRoleClient();
  } catch {
    return null;
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  const inst = await openDb("INSTITUTIONAL");
  if (!inst) {
    return NextResponse.json({
      ok: true,
      affected: [],
      notice: "INSTITUTIONAL database not configured.",
    });
  }

  const noteRes = await inst
    .from("research_note_c")
    .select("id, symbol, status, thesis")
    .eq("id", id)
    .maybeSingle();

  if (noteRes.error) {
    if (isSupabaseSchemaMissing(noteRes.error)) {
      return NextResponse.json({
        ok: true,
        affected: [],
        notice: "research_note_c table not migrated yet — apply 20260710000001_research_note_c.sql.",
      });
    }
    return NextResponse.json({ ok: false, error: noteRes.error.message }, { status: 500 });
  }

  const note = (noteRes.data ?? null) as ResearchNoteRow | null;
  if (!note) return NextResponse.json({ ok: false, error: "research note not found" }, { status: 404 });

  // Pull the proposed composition out of the thesis JSONB. The note author
  // stores proposed changes as { proposed_composition: ProposedHolding[] }
  // inside thesis; if absent we fall back to an empty list so the IC UI can
  // still render an "empty" preview rather than crashing.
  const thesis = (note.thesis ?? {}) as { proposed_composition?: ProposedHolding[] };
  const proposed = Array.isArray(thesis.proposed_composition) ? thesis.proposed_composition : [];
  const symbol = String(note.symbol ?? "")
    .trim()
    .toUpperCase();

  const retail = await openDb("RETAIL");
  if (!retail) {
    return NextResponse.json({
      ok: true,
      affected: [],
      notice: "RETAIL database not configured.",
    });
  }

  // Find all investors holding the symbol (active BUY positions only —
  // matches the production /api/admin/investors/data filter).
  const [holdingsRes, returnsRes] = await Promise.all([
    retail
      .from("stock_holdings_c")
      .select("user_id, family_member_id, security_id, strategy_id, quantity, avg_fill")
      .eq("is_active", true)
      .eq("trade_side", "BUY"),
    retail
      .from("client_strategy_returns_c")
      .select("user_id, strategy_id, as_of_date, basket_value, ytd_pct")
      .order("as_of_date", { ascending: false })
      .limit(2000),
  ]);

  if (holdingsRes.error) {
    return NextResponse.json({ ok: false, error: holdingsRes.error.message }, { status: 500 });
  }
  if (returnsRes.error) {
    return NextResponse.json({ ok: false, error: returnsRes.error.message }, { status: 500 });
  }

  const allHoldings = (holdingsRes.data ?? []) as HoldingRow[];

  // Exclude test accounts (parity with /api/admin/investors/data, which this
  // route's docstring claims to match). This is a real-investor analytics view;
  // is_test=true accounts must not pollute the affected-investor list.
  const testIds = new Set<string>();
  {
    const { data: testRows } = await retail.from("profiles").select("id").eq("is_test", true);
    for (const r of testRows ?? []) testIds.add(r.id as string);
  }

  // Resolve the symbol → security_id lookup once.
  const secIds = [...new Set(allHoldings.map((h) => h.security_id).filter(Boolean))];
  let secById = new Map<string, SecurityRow>();
  if (secIds.length) {
    const secRes = await retail.from("securities_c").select("id, symbol").in("id", secIds);
    if (!secRes.error) {
      secById = new Map(((secRes.data ?? []) as SecurityRow[]).map((s) => [s.id, s]));
    }
  }

  // Build investor-level rollups: total shares in the symbol, weighted cost basis.
  const investorAgg = new Map<string, { shares: number; avgCostCents: number; strategies: Set<string> }>();
  for (const h of allHoldings) {
    if (testIds.has(h.user_id)) continue; // exclude test accounts
    const meta = secById.get(h.security_id);
    if (!meta || meta.symbol.toUpperCase() !== symbol) continue;
    const cur = investorAgg.get(h.user_id) ?? { shares: 0, avgCostCents: 0, strategies: new Set() };
    cur.shares += toNum(h.quantity);
    cur.avgCostCents = toNum(h.avg_fill);
    if (h.strategy_id) cur.strategies.add(h.strategy_id);
    investorAgg.set(h.user_id, cur);
  }

  if (investorAgg.size === 0) {
    return NextResponse.json({ ok: true, affected: [] });
  }

  // Latest basket_value snapshot per investor (any strategy they hold the symbol in).
  const latestByUser = new Map<string, StrategyReturnRow>();
  for (const r of (returnsRes.data ?? []) as StrategyReturnRow[]) {
    if (latestByUser.has(r.user_id)) continue;
    latestByUser.set(r.user_id, r);
  }

  // Try to resolve profiles for nicer display names; don't fail the request if missing.
  const userIds = [...investorAgg.keys()];
  let profById = new Map<string, ProfileRow>();
  if (userIds.length) {
    const profRes = await retail
      .from("profiles")
      .select("id, first_name, last_name, email")
      .in("id", userIds);
    if (!profRes.error) {
      profById = new Map(((profRes.data ?? []) as ProfileRow[]).map((p) => [p.id, p]));
    }
  }

  // P&L impact is an illustrative estimate: shares × current avg_cost basis.
  // Live tick prices are NOT joined here — the rebalance preview is a "would
  // we expose this investor to a change in <symbol>?" sanity check, not a
  // pre-trade P&L. Display as a delta of basket_value ± current holding value.
  const affected = userIds
    .map((uid) => {
      const agg = investorAgg.get(uid);
      if (!agg) return null;
      const snap = latestByUser.get(uid);
      const prof = profById.get(uid);
      const basket = toNum(snap?.basket_value);
      const exposureCents = Math.round(agg.shares * agg.avgCostCents);
      const exposurePct = basket > 0 ? (exposureCents / basket) * 100 : 0;
      return {
        user_id: uid,
        name: prof
          ? `${prof.first_name ?? ""} ${prof.last_name ?? ""}`.trim() || prof.email || uid.slice(0, 8)
          : uid.slice(0, 8),
        email: prof?.email ?? null,
        shares: agg.shares,
        exposure_cents: exposureCents,
        exposure_pct: Number.isFinite(exposurePct) ? exposurePct : 0,
        basket_value_cents: Math.round(basket),
        as_of_date: snap?.as_of_date ?? null,
        strategies: [...agg.strategies],
        // Summary of the proposed composition moves (used by the IC UI badge).
        proposed_changes: proposed.map((p) => ({
          symbol: p.symbol ?? p.ticker ?? null,
          action: p.action ?? null,
          shares: typeof p.shares === "number" ? p.shares : null,
          weight: typeof p.weight === "number" ? p.weight : null,
        })),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  affected.sort((a, b) => b.exposure_cents - a.exposure_cents);

  return NextResponse.json({ ok: true, affected });
}
