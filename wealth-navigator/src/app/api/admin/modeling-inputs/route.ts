import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * GET    /api/admin/modeling-inputs?symbol=ABC
 *   - Returns the saved DCF sandbox inputs for the current analyst
 *     (`modeling_input_c.user_id = ctx.email`, `symbol` normalised to upper).
 *   - 200 with `inputs: null` when there's no row yet (so the ModellingTab can
 *     fall back to localStorage without treating it as an error).
 *   - 200 with `{ source: "missing_table" }` when the migration hasn't landed.
 *   - 401/403 like the rest of `/api/admin/*`.
 *
 * POST   /api/admin/modeling-inputs
 *   body: { symbol, growth, years, riskFree, mrp, beta, costOfDebt, exitMult,
 *           inputs? }
 *   - Upserts on `(user_id, symbol)` so re-saving replaces the row.
 *   - Returns the saved row on success.
 *
 * The route lives under `/api/admin/*` so it's gated by `getAdminContext()`
 * (the same gate that already protects the existing `/api/admin/watchlist`
 * route). This matches the modeling-tab reality: only signed-in team
 * members can save sandbox state. localStorage remains the offline fallback
 * for unauthenticated viewers — see `analysis-tabs.tsx` `ModelingTab`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ModelingInputRow {
  id: string;
  user_id: string;
  symbol: string;
  growth_pct: number | null;
  years: number | null;
  risk_free_pct: number | null;
  market_premium_pct: number | null;
  beta: number | null;
  cost_of_debt_pct: number | null;
  exit_multiple: number | null;
  inputs: Record<string, unknown> | null;
  updated_at: string;
}

function tryOpenDb(): ReturnType<typeof createInstitutionalServiceRoleClient> | null {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

function normaliseSymbol(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/\.(JO|JSE)$/i, "");
}

function asNumberOrNull(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    if (v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export async function GET(req: Request) {
  const auth = await getAdminContext();
  if (auth.status === "no-session") {
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  }
  if (auth.status !== "ok") {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const rawSymbol = (url.searchParams.get("symbol") ?? "").trim();
  if (!rawSymbol) {
    return NextResponse.json({ ok: false, error: "symbol query param required" }, { status: 400 });
  }
  const symbol = normaliseSymbol(rawSymbol);

  const db = tryOpenDb();
  if (!db) {
    return NextResponse.json(
      {
        ok: true,
        symbol,
        inputs: null,
        source: "unconfigured",
        notice:
          "INSTITUTIONAL database not configured — apply 20260710000011_modeling_input_c.sql and set INSTITUTIONAL_SUPABASE_* env.",
        fallback: "localStorage",
      },
      { status: 200 },
    );
  }

  try {
    const { data, error } = await db
      .from("modeling_input_c")
      .select(
        "id, user_id, symbol, growth_pct, years, risk_free_pct, market_premium_pct, beta, cost_of_debt_pct, exit_multiple, inputs, updated_at",
      )
      .eq("user_id", auth.ctx.email)
      .eq("symbol", symbol)
      .maybeSingle();
    if (error) {
      if (isSupabaseSchemaMissing(error)) {
        return NextResponse.json(
          {
            ok: true,
            symbol,
            inputs: null,
            source: "missing_table",
            notice:
              "modeling_input_c table not migrated yet — apply supabase/migrations/20260710000011_modeling_input_c.sql.",
            fallback: "localStorage",
          },
          { status: 200 },
        );
      }
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ ok: true, symbol, inputs: null, source: "supabase" });
    }
    return NextResponse.json({
      ok: true,
      symbol,
      inputs: data as ModelingInputRow,
      source: "supabase",
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
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

  const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const rawSymbol = typeof body.symbol === "string" ? body.symbol : "";
  const symbol = normaliseSymbol(rawSymbol);
  if (!symbol) {
    return NextResponse.json({ ok: false, error: "symbol is required" }, { status: 400 });
  }

  const db = tryOpenDb();
  if (!db) {
    return NextResponse.json(
      {
        ok: false,
        error: "INSTITUTIONAL database not configured",
        fallback: "localStorage",
      },
      { status: 503 },
    );
  }

  const row = {
    user_id: auth.ctx.email,
    symbol,
    growth_pct: asNumberOrNull(body.growth),
    years: asNumberOrNull(body.years),
    risk_free_pct: asNumberOrNull(body.riskFree),
    market_premium_pct: asNumberOrNull(body.mrp),
    beta: asNumberOrNull(body.beta),
    cost_of_debt_pct: asNumberOrNull(body.costOfDebt),
    exit_multiple: asNumberOrNull(body.exitMult),
    inputs:
      body.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs)
        ? (body.inputs as Record<string, unknown>)
        : null,
    updated_at: new Date().toISOString(),
  };

  try {
    const { data, error } = await db
      .from("modeling_input_c")
      .upsert(row, { onConflict: "user_id,symbol", ignoreDuplicates: false })
      .select(
        "id, user_id, symbol, growth_pct, years, risk_free_pct, market_premium_pct, beta, cost_of_debt_pct, exit_multiple, inputs, updated_at",
      )
      .single();
    if (error) {
      if (isSupabaseSchemaMissing(error)) {
        return NextResponse.json(
          {
            ok: false,
            error: "modeling_input_c table not migrated yet — apply 20260710000011_modeling_input_c.sql.",
            fallback: "localStorage",
          },
          { status: 503 },
        );
      }
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, inputs: data as ModelingInputRow });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
