import { NextResponse } from "next/server";

import { getAdminContext } from "@/lib/admin/rbac";
import { discoverAffectedStrategies } from "@/lib/returns/find-rebalanced-strategies";
import {
  CANONICAL_LEDGER_REPAIR_SHADOW_TABLE,
  runFullPlatformRepair,
} from "@/lib/returns/repair-canonical-ledger-historical";
import { createRetailServiceRoleClient } from "@/lib/supabase/server";

/**
 * Phase 2 canonical-ledger historical repair - admin surface.
 *
 * GET  ?action=discover   -> which strategies the discovery query finds affected (read-only).
 * GET  ?action=runs       -> summary of prior repair runs already sitting in the shadow table.
 * POST { action: "run", apply, strategyId?, asOfDate? } -> compute a fresh repair run.
 *   apply=false (default): compute only, nothing written anywhere - safe to call freely.
 *   apply=true: writes the computed rows into strategy_canonical_daily_ledger_repair_c (the
 *   SHADOW table). This never writes to strategy_canonical_daily_ledger_c and never certifies or
 *   promotes anything - promotion is a separate, explicit action a master-admin takes elsewhere
 *   (via promote_canonical_ledger_repair_row_c), which this route does not expose.
 *
 * Gated the same way canManageCommittee() gates other master-owner-only governance actions
 * (approverTier "master"/"dev" or role "superadmin") - this repair tooling can rewrite how a
 * strategy's entire public performance history is later reviewed, so it is not a general-staff
 * action.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function canRunRepair(ctx: { approverTier: string | null; role: string }) {
  return ctx.approverTier === "master" || ctx.approverTier === "dev" || ctx.role === "superadmin";
}

async function requireGate() {
  const auth = await getAdminContext();
  if (auth.status === "no-session")
    return { response: NextResponse.json({ ok: false, error: "no-session" }, { status: 401 }) };
  if (auth.status !== "ok")
    return { response: NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 }) };
  if (!canRunRepair(auth.ctx))
    return {
      response: NextResponse.json(
        { ok: false, error: "master-admin, dev or superadmin required" },
        { status: 403 },
      ),
    };
  return { ctx: auth.ctx };
}

export async function GET(req: Request) {
  const gate = await requireGate();
  if (gate.response) return gate.response;
  const action = new URL(req.url).searchParams.get("action") ?? "discover";

  if (action === "runs") {
    try {
      const db = createRetailServiceRoleClient();
      const { data, error } = await db
        .from(CANONICAL_LEDGER_REPAIR_SHADOW_TABLE)
        .select(
          "repair_run_id,strategy_id,as_of_date,complete_value_cents,promoted_at,reviewed_at,created_at",
        )
        .order("created_at", { ascending: false })
        .limit(5000);
      if (error) throw new Error(error.message);
      const rows = data ?? [];
      const byRun = new Map<
        string,
        {
          repairRunId: string;
          strategyIds: Set<string>;
          rowCount: number;
          promotedCount: number;
          reviewedCount: number;
          earliestCreatedAt: string;
          latestAsOf: string;
        }
      >();
      for (const row of rows) {
        const key = String(row.repair_run_id);
        const bucket = byRun.get(key) ?? {
          repairRunId: key,
          strategyIds: new Set<string>(),
          rowCount: 0,
          promotedCount: 0,
          reviewedCount: 0,
          earliestCreatedAt: String(row.created_at),
          latestAsOf: String(row.as_of_date),
        };
        bucket.strategyIds.add(String(row.strategy_id));
        bucket.rowCount += 1;
        if (row.promoted_at) bucket.promotedCount += 1;
        if (row.reviewed_at) bucket.reviewedCount += 1;
        if (String(row.created_at) < bucket.earliestCreatedAt)
          bucket.earliestCreatedAt = String(row.created_at);
        if (String(row.as_of_date) > bucket.latestAsOf) bucket.latestAsOf = String(row.as_of_date);
        byRun.set(key, bucket);
      }
      const runs = [...byRun.values()]
        .map((bucket) => ({
          repairRunId: bucket.repairRunId,
          strategyCount: bucket.strategyIds.size,
          rowCount: bucket.rowCount,
          promotedCount: bucket.promotedCount,
          reviewedCount: bucket.reviewedCount,
          createdAt: bucket.earliestCreatedAt,
          latestAsOf: bucket.latestAsOf,
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return NextResponse.json({ ok: true, runs });
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }

  const discovery = await discoverAffectedStrategies();
  return NextResponse.json(discovery);
}

export async function POST(req: Request) {
  const gate = await requireGate();
  if (gate.response) return gate.response;
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    apply?: boolean;
    strategyId?: string;
    asOfDate?: string;
  };
  if (body.action !== "run") {
    return NextResponse.json({ ok: false, error: "unsupported action" }, { status: 400 });
  }
  const result = await runFullPlatformRepair({
    apply: body.apply === true,
    strategyId: body.strategyId,
    asOfDate: body.asOfDate,
  });
  return NextResponse.json(result);
}
