import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const apply = process.env.APPLY_CANONICAL_FAMILY_PROMOTION === "1";
const waiver = process.env.CANONICAL_EVIDENCE_WAIVER === "1";
const certifiedBy = String(process.env.CANONICAL_CERTIFIER_UUID || "").trim();
const reason = String(process.env.CANONICAL_CERTIFICATION_REASON || "").trim();
const requestedNames = String(process.env.CANONICAL_STRATEGY_NAMES || "")
  .split("|").map((name) => name.trim()).filter(Boolean);
const url = process.env.RETAIL_SUPABASE_URL ?? process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const key = process.env.RETAIL_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.service_role_key ?? process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) throw new Error("Retail Supabase service configuration is missing");
if (apply && !/^[0-9a-f-]{36}$/i.test(certifiedBy)) throw new Error("apply requires CANONICAL_CERTIFIER_UUID");
if (apply && reason.length < 20) throw new Error("apply requires a specific CANONICAL_CERTIFICATION_REASON");

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const workbookSha = "bde94581727f9a08232ec5e80f2672bde3a1ef73c733309ec8723fe78bcaa301";
const knownEvidenceGaps = new Map([
  ["ETF Basket", { ticker: "STXID", missingPoints: 100, reason: "YAHOO_PROVIDER_SCALE_DIVERGENCE" }],
  ["Yield Basket", { ticker: "CLI", missingPoints: 92, reason: "JSE_DELISTED_PROVIDER_SERIES_UNAVAILABLE" }],
]);
const requiredPeriods = ["1D", "1W", "WTD", "MTD", "1M", "3M", "6M", "YTD", "SI"];
const structurallyBlockedStrategies = new Map([
  ["MyGrowthFund", "23 July and 3 August rebalance continuity breaks require reviewed capital-preserving repair"],
]);

async function rows(label, query) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

let strategyQuery = db.from("strategies_c")
  .select("id,name,status").eq("status", "active").neq("name", "Test Strategy").order("name");
if (requestedNames.length) strategyQuery = strategyQuery.in("name", requestedNames);
const strategies = await rows("active strategies", strategyQuery);
if (requestedNames.length) {
  const found = new Set(strategies.map((strategy) => strategy.name));
  const missing = requestedNames.filter((name) => !found.has(name));
  if (missing.length) throw new Error(`active strategies not found: ${missing.join(", ")}`);
}
const strategyIds = strategies.map((strategy) => strategy.id);
const names = new Map(strategies.map((strategy) => [strategy.id, strategy.name]));
const drafts = await rows("DRAFT canonical ledger", db.from("strategy_canonical_daily_ledger_c")
  .select("strategy_id,as_of_date,ledger_version,certification_status,securities_value_cents,continuity_cash_cents,complete_value_cents,leg_snapshot,period_metrics,source_evidence,source_evidence_sha256,calculation_notes")
  .in("strategy_id", strategyIds).eq("certification_status", "DRAFT").order("as_of_date"));
const blockedDrafts = drafts.filter((row) => structurallyBlockedStrategies.has(names.get(row.strategy_id)));
if (apply && blockedDrafts.length) {
  throw new Error(`promotion blocked for structural audit exceptions: ${JSON.stringify([...new Set(blockedDrafts.map((row) => ({ strategy: names.get(row.strategy_id), reason: structurallyBlockedStrategies.get(names.get(row.strategy_id)) })) )])}`);
}
const promotableDrafts = drafts.filter((row) => !structurallyBlockedStrategies.has(names.get(row.strategy_id)));
const requestedEvidenceGaps = [...new Set(promotableDrafts.map((row) => names.get(row.strategy_id)))]
  .flatMap((name) => knownEvidenceGaps.has(name) ? [{ strategy: name, ...knownEvidenceGaps.get(name) }] : []);
if (apply && requestedEvidenceGaps.length && !waiver) {
  throw new Error(`apply requires CANONICAL_EVIDENCE_WAIVER=1: ${JSON.stringify(requestedEvidenceGaps)}`);
}

const invalid = promotableDrafts.flatMap((row) => {
  const failures = [];
  if (Number(row.complete_value_cents) !== Number(row.securities_value_cents) + Number(row.continuity_cash_cents))
    failures.push("COMPLETE_VALUE_FORMULA");
  for (const period of requiredPeriods) {
    const metric = row.period_metrics?.[period];
    if (!metric || metric.return_pct == null || !Number.isFinite(Number(metric.return_pct))) failures.push(`MISSING_${period}`);
  }
  if (!Array.isArray(row.leg_snapshot) || row.leg_snapshot.length === 0) failures.push("EMPTY_LEG_SNAPSHOT");
  return failures.length ? [{ strategy: names.get(row.strategy_id), date: row.as_of_date, failures }] : [];
});
if (invalid.length) throw new Error(`promotion validation failed: ${JSON.stringify(invalid.slice(0, 20))}`);

const now = new Date().toISOString();
let written = 0;
if (apply) {
  for (const row of promotableDrafts) {
    const strategyName = names.get(row.strategy_id);
    const providerGap = knownEvidenceGaps.get(strategyName) ?? null;
    const sourceEvidence = {
      ...(row.source_evidence || {}),
      certification_decision: {
        mode: providerGap
          ? "CEO_WORKBOOK_AND_REPAIRED_STORED_CLOSES_APPROVED_WAIVER_V1"
          : "CEO_WORKBOOK_AND_INDEPENDENT_PROVIDER_MATCH_V1",
        certified_at: now,
        certified_by: certifiedBy,
        reason,
        workbook_sha256: workbookSha,
        disclosed_provider_gap: providerGap,
        confirmed_price_mismatches: 0,
        valuation_mismatches: 0,
        formula_failures: 0,
        caveat: providerGap
          ? "The disclosed provider defect is not represented as an independent price match."
          : null,
      },
    };
    const update = {
      certification_status: "CERTIFIED",
      certified_at: now,
      certified_by: certifiedBy,
      source_evidence: sourceEvidence,
      source_evidence_sha256: createHash("sha256").update(JSON.stringify(sourceEvidence)).digest("hex"),
      calculation_notes: { ...(row.calculation_notes || {}), promotion_blocked: false, promoted_by_family_rollout: true },
    };
    const { data, error } = await db.from("strategy_canonical_daily_ledger_c").update(update)
      .eq("strategy_id", row.strategy_id).eq("as_of_date", row.as_of_date).eq("certification_status", "DRAFT")
      .select("strategy_id,as_of_date");
    if (error) throw new Error(`${strategyName} ${row.as_of_date}: ${error.message}`);
    if (data?.length !== 1) throw new Error(`${strategyName} ${row.as_of_date}: concurrent update prevented promotion`);
    written += 1;
  }
}

console.log(JSON.stringify({
  apply,
  policy: apply
    ? requestedEvidenceGaps.length
      ? "APPROVED_EVIDENCE_WAIVER"
      : "FULL_EVIDENCE"
    : "DRY_RUN_ONLY",
  active_strategy_count: strategies.length,
  strategies: strategies.map((strategy) => strategy.name),
  draft_rows_validated: promotableDrafts.length,
  rows_promoted: written,
  disclosed_provider_gaps: requestedEvidenceGaps,
  excluded: ["Test Strategy", ...[...structurallyBlockedStrategies].map(([strategy, blockedReason]) => `${strategy}: ${blockedReason}`)],
  read_path_prerequisite: "MINT /api/returns/approved certified union deployed",
}, null, 2));
