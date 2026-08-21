import type { SupabaseClient } from "@supabase/supabase-js";

import { createRetailServiceRoleClient, isRetailSupabaseConfigured } from "../supabase/server";

type JsonObject = Record<string, unknown>;
type CanonicalDraftRow = {
  strategy_id: string;
  as_of_date: string;
  certification_status: string;
  securities_value_cents: number;
  continuity_cash_cents: number;
  complete_value_cents: number;
  leg_snapshot: unknown;
  period_metrics: JsonObject;
  source_evidence: JsonObject;
  source_evidence_sha256: string;
  calculation_notes: JsonObject;
};

const REQUIRED_PERIODS = ["1D", "1W", "WTD", "1M", "3M", "YTD", "SI"] as const;
export const AUTOMATIC_CERTIFICATION_ACTOR = "SYSTEM:WEALTH_NAVIGATOR_DAILY_V1";

export type CanonicalCertificationResultRow = {
  strategy: string;
  action: "certified" | "already-certified" | "failed";
  reason?: string;
  asOf: string;
};
export type CanonicalCertificationResult = {
  ok: boolean;
  asOf: string;
  summary: { certified: number; alreadyCertified: number; failed: number; total: number };
  results: CanonicalCertificationResultRow[];
  note?: string;
};

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Cheap diagnostics only. The promotion RPC repeats material checks under a row lock. */
export function canonicalDraftShapeBlockers(row: CanonicalDraftRow): string[] {
  const blockers: string[] = [];
  if (row.certification_status !== "DRAFT") blockers.push("ROW_NOT_DRAFT");
  if (
    !Number.isSafeInteger(Number(row.securities_value_cents)) ||
    !Number.isSafeInteger(Number(row.continuity_cash_cents)) ||
    !Number.isSafeInteger(Number(row.complete_value_cents)) ||
    Number(row.securities_value_cents) < 0 ||
    Number(row.continuity_cash_cents) < 0 ||
    Number(row.complete_value_cents) <= 0
  )
    blockers.push("INVALID_VALUE_IDENTITY_INPUT");
  if (
    Number(row.complete_value_cents) !==
    Number(row.securities_value_cents) + Number(row.continuity_cash_cents)
  )
    blockers.push("COMPLETE_VALUE_IDENTITY_FAILED");
  if (!Array.isArray(row.leg_snapshot) || row.leg_snapshot.length === 0)
    blockers.push("LEG_SNAPSHOT_MISSING");
  if (!row.source_evidence_sha256 || !/^[a-f0-9]{64}$/i.test(row.source_evidence_sha256))
    blockers.push("EVIDENCE_HASH_INVALID");

  const evidence = row.source_evidence ?? {};
  for (const key of [
    "opening_model_snapshot",
    "ordered_settled_batches",
    "price_coverage",
    "reconciliation",
  ]) {
    if (!(key in evidence)) blockers.push(`EVIDENCE_${key.toUpperCase()}_MISSING`);
  }
  const writer = String(row.calculation_notes?.daily_writer ?? "");
  if (
    !["canonical-draft-stable-composition-v1", "canonical-draft-evidence-backed-boundary-v2"].includes(writer)
  )
    blockers.push("AUTOMATIC_SEED_FORBIDDEN");

  for (const period of REQUIRED_PERIODS) {
    const metric = row.period_metrics?.[period] as JsonObject | undefined;
    if (!metric || typeof metric !== "object") {
      blockers.push(`PERIOD_${period}_MISSING`);
      continue;
    }
    if (!finiteNumber(metric.return_pct)) blockers.push(`PERIOD_${period}_RETURN_INVALID`);
    if (!finiteNumber(metric.denominator_cents) || Number(metric.denominator_cents) <= 0)
      blockers.push(`PERIOD_${period}_DENOMINATOR_INVALID`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(metric.reference_date ?? "")))
      blockers.push(`PERIOD_${period}_REFERENCE_DATE_INVALID`);
  }
  return blockers;
}

async function one<T>(
  label: string,
  query: PromiseLike<{ data: T | null; error: { message: string } | null }>,
) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}:${error.message}`);
  return data;
}

async function certifyOne(
  db: SupabaseClient,
  strategy: { id: string; name: string },
  asOf: string,
  certificationActor: string,
): Promise<CanonicalCertificationResultRow> {
  const row = await one<CanonicalDraftRow>(
    "canonical row",
    db
      .from("strategy_canonical_daily_ledger_c")
      .select(
        "strategy_id,as_of_date,certification_status,securities_value_cents,continuity_cash_cents,complete_value_cents,leg_snapshot,period_metrics,source_evidence,source_evidence_sha256,calculation_notes",
      )
      .eq("strategy_id", strategy.id)
      .eq("as_of_date", asOf)
      .maybeSingle(),
  );
  if (!row) return { strategy: strategy.name, action: "failed", reason: "DRAFT_MISSING", asOf };
  if (row.certification_status === "CERTIFIED")
    return { strategy: strategy.name, action: "already-certified", asOf };
  const blockers = canonicalDraftShapeBlockers(row);
  if (blockers.length) return { strategy: strategy.name, action: "failed", reason: blockers.join(","), asOf };

  const rpc = await db.rpc("certify_strategy_canonical_daily_ledger_c", {
    p_strategy_id: strategy.id,
    p_as_of_date: asOf,
    p_certification_actor: certificationActor,
    p_expected_evidence_sha256: row.source_evidence_sha256,
  });
  if (rpc.error) return { strategy: strategy.name, action: "failed", reason: rpc.error.message, asOf };
  return { strategy: strategy.name, action: "certified", asOf };
}

export async function publishCanonicalLedgerCertification(
  options: { asOfDate?: string; strategyName?: string; certificationActor?: string } = {},
): Promise<CanonicalCertificationResult> {
  const asOf = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  const certificationActor = options.certificationActor ?? AUTOMATIC_CERTIFICATION_ACTOR;
  const empty = { certified: 0, alreadyCertified: 0, failed: 0, total: 0 };
  if (!isRetailSupabaseConfigured())
    return { ok: false, asOf, summary: empty, results: [], note: "retail supabase not configured" };
  const db = createRetailServiceRoleClient();
  const calendar = await one<{ is_trading_day: boolean }>(
    "JSE calendar",
    db
      .from("jse_trading_calendar")
      .select("is_trading_day")
      .eq("market", "JSE_EQUITIES")
      .eq("trading_date", asOf)
      .maybeSingle(),
  );
  if (!calendar?.is_trading_day)
    return { ok: true, asOf, summary: empty, results: [], note: "not a JSE trading day" };

  let strategyQuery = db
    .from("strategies_c")
    .select("id,name")
    .eq("status", "active")
    .neq("name", "Test Strategy");
  if (options.strategyName) strategyQuery = strategyQuery.eq("name", options.strategyName);
  const strategyResult = await strategyQuery;
  if (strategyResult.error)
    return { ok: false, asOf, summary: empty, results: [], note: strategyResult.error.message };
  const strategies = strategyResult.data ?? [];
  const results: CanonicalCertificationResultRow[] = [];
  for (const strategy of strategies) {
    try {
      results.push(await certifyOne(db, strategy, asOf, certificationActor));
    } catch (error) {
      results.push({
        strategy: strategy.name,
        action: "failed",
        reason: error instanceof Error ? error.message : String(error),
        asOf,
      });
    }
  }
  const certified = results.filter((row) => row.action === "certified").length;
  const alreadyCertified = results.filter((row) => row.action === "already-certified").length;
  const failed = results.filter((row) => row.action === "failed").length;
  return {
    ok: failed === 0 && certified + alreadyCertified === strategies.length,
    asOf,
    summary: { certified, alreadyCertified, failed, total: strategies.length },
    results,
  };
}
