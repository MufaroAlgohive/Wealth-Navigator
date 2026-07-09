import { NextResponse } from "next/server";

import { can, getAdminContext } from "@/lib/admin/rbac";
import { isSupabaseSchemaMissing } from "@/lib/bff-reasons";
import { createInstitutionalServiceRoleClient } from "@/lib/supabase/server";

/**
 * POST /api/rebalance/requests/[id]/push
 *
 * Trigger execution of an IC-approved rebalance request.
 *
 * Validates:
 *  - the request exists and is in status='ic_approved'
 *  - the caller has `rebalance/push_rebalance` (admin tier)
 *
 * Writes:
 *  - one row per affected holding into `oems_order_audit` (status='working')
 *  - the request itself → status='executed' with `executed_at = now()`
 *
 * Read-only fallback: returns 200 with `{ orders: [], notice }` when the
 * institutional schema isn't migrated yet so the UI can render an honest
 * empty state instead of crashing.
 */

export const dynamic = "force-dynamic";

interface RebalanceRow {
  id: string;
  strategy_id: string;
  requested_by: string;
  current_composition: unknown;
  proposed_composition: unknown;
  affected_investors: unknown | null;
  status: string;
  research_note_id: string | null;
  executed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ProposedRow {
  symbol?: string;
  ticker?: string;
  shares?: number;
  weight?: number;
  action?: "remove" | "decrease" | "increase" | "add" | "hold";
}

async function openDb() {
  try {
    return createInstitutionalServiceRoleClient();
  } catch {
    return null;
  }
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return NextResponse.json({ ok: false, error: "no-session" }, { status: 401 });
  if (auth.status !== "ok") return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  if (!can(auth.ctx, "rebalance", "push_rebalance")) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const db = await openDb();
  if (!db) {
    return NextResponse.json({
      ok: true,
      orders: [],
      notice: "INSTITUTIONAL database not configured.",
    });
  }

  const requestRes = await db
    .from("rebalance_request_c")
    .select(
      "id, strategy_id, requested_by, current_composition, proposed_composition, affected_investors, status, research_note_id, executed_at, created_at, updated_at",
    )
    .eq("id", id)
    .maybeSingle();

  if (requestRes.error) {
    if (isSupabaseSchemaMissing(requestRes.error)) {
      return NextResponse.json({
        ok: true,
        orders: [],
        notice: "rebalance_request_c table not migrated yet — apply 20260710000004_rebalance_request_c.sql.",
      });
    }
    return NextResponse.json({ ok: false, error: requestRes.error.message }, { status: 500 });
  }

  const request = (requestRes.data ?? null) as RebalanceRow | null;
  if (!request)
    return NextResponse.json({ ok: false, error: "rebalance request not found" }, { status: 404 });
  if (request.status !== "ic_approved") {
    return NextResponse.json(
      { ok: false, error: `rebalance request is not IC-approved (status='${request.status}')` },
      { status: 409 },
    );
  }

  const proposed = Array.isArray(request.proposed_composition)
    ? (request.proposed_composition as ProposedRow[])
    : [];

  // Build the execution rows. Each row is a single execution against the
  // institutional `oems_order_audit` table (status='working') so the worker
  // can pick them up via /orders on the next tick. We emit BUY/SELL based on
  // the proposed action; rows with no symbol or shares are skipped (rather
  // than failing the whole push — the operator can re-raise the request).
  const now = new Date().toISOString();
  const orders: Array<Record<string, unknown>> = [];
  const writes: Array<Record<string, unknown>> = [];
  for (const row of proposed) {
    const symbol = String(row.symbol ?? row.ticker ?? "")
      .trim()
      .toUpperCase();
    const shares = typeof row.shares === "number" ? Math.round(row.shares) : 0;
    if (!symbol || shares <= 0) continue;
    const side =
      row.action === "add" || row.action === "increase"
        ? "buy"
        : row.action === "remove" || row.action === "decrease"
          ? "sell"
          : "buy";
    const auditRow: Record<string, unknown> = {
      order_id: id,
      client_account: request.strategy_id,
      symbol,
      side,
      quantity: shares,
      price_cents: null,
      status: "working",
      source: "rebalance_request",
      payload: {
        request_id: id,
        strategy_id: request.strategy_id,
        action: row.action ?? "hold",
        weight: typeof row.weight === "number" ? row.weight : null,
      },
      result_payload: {},
      created_at: now,
      updated_at: now,
    };
    writes.push(auditRow);
    orders.push(auditRow);
  }

  // If the proposal didn't carry executable rows (still common until the IC
  // templates land), emit at least one audit row keyed off the research
  // note so the operator gets feedback in the worker /orders feed.
  if (writes.length === 0) {
    const auditRow: Record<string, unknown> = {
      order_id: id,
      client_account: request.strategy_id,
      symbol: String(`${request.research_note_id ?? "REBAL"}`).slice(0, 12),
      side: "buy",
      quantity: 0,
      price_cents: null,
      status: "working",
      source: "rebalance_request",
      payload: {
        request_id: id,
        strategy_id: request.strategy_id,
        note: "no executable rows in proposed_composition — placeholder row",
      },
      result_payload: {},
      created_at: now,
      updated_at: now,
    };
    writes.push(auditRow);
    orders.push(auditRow);
  }

  const auditRes = await db.from("oems_order_audit").insert(writes).select();
  if (auditRes.error) {
    if (isSupabaseSchemaMissing(auditRes.error)) {
      return NextResponse.json({
        ok: true,
        orders: [],
        notice: "oems_order_audit table not migrated yet — apply 20260612000002_oems_order_audit.sql.",
      });
    }
    return NextResponse.json({ ok: false, error: auditRes.error.message }, { status: 500 });
  }

  const updateRes = await db
    .from("rebalance_request_c")
    .update({ status: "executed", executed_at: now, updated_at: now })
    .eq("id", id)
    .select()
    .maybeSingle();

  if (updateRes.error) {
    return NextResponse.json({ ok: false, error: updateRes.error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    request: updateRes.data,
    orders: auditRes.data ?? orders,
  });
}
