import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const apply = process.env.APPLY_CANONICAL_SCOPED_PROMOTION === "1";
const certifiedBy = String(process.env.CANONICAL_CERTIFIER_UUID || "").trim();
const reason = String(process.env.CANONICAL_CERTIFICATION_REASON || "").trim();
const requestedNames = String(process.env.CANONICAL_STRATEGY_NAMES || "")
  .split("|").map((name) => name.trim()).filter(Boolean);
const evidenceWaiver = process.env.CANONICAL_EVIDENCE_WAIVER === "1";
const url = process.env.RETAIL_SUPABASE_URL ?? process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const key = process.env.RETAIL_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.service_role_key ?? process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) throw new Error("Retail Supabase service configuration is missing");
if (!requestedNames.length) throw new Error("CANONICAL_STRATEGY_NAMES must contain one or more exact names separated by |");
if (apply && !/^[0-9a-f-]{36}$/i.test(certifiedBy)) throw new Error("apply requires CANONICAL_CERTIFIER_UUID");
if (apply && reason.length < 20) throw new Error("apply requires a specific CANONICAL_CERTIFICATION_REASON");

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const workbookSha = "bde94581727f9a08232ec5e80f2672bde3a1ef73c733309ec8723fe78bcaa301";
const requiredPeriods = ["1D", "1W", "WTD", "MTD", "1M", "3M", "6M", "YTD", "SI"];
const disclosedProviderGaps = new Map([
  ["Yield Basket", { ticker: "CLI", missingPoints: 92, reason: "JSE_DELISTED_PROVIDER_SERIES_UNAVAILABLE" }],
]);

async function rows(label, query) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

const strategies = await rows("requested strategies", db.from("strategies_c")
  .select("id,name,status").in("name", requestedNames).eq("status", "active"));
const found = new Set(strategies.map((strategy) => strategy.name));
const missingNames = requestedNames.filter((name) => !found.has(name));
if (missingNames.length) throw new Error(`active strategies not found: ${missingNames.join(", ")}`);
const names = new Map(strategies.map((strategy) => [strategy.id, strategy.name]));
const drafts = await rows("scoped DRAFT canonical ledger", db.from("strategy_canonical_daily_ledger_c")
  .select("strategy_id,as_of_date,ledger_version,certification_status,securities_value_cents,continuity_cash_cents,complete_value_cents,leg_snapshot,period_metrics,source_evidence,source_evidence_sha256,calculation_notes")
  .in("strategy_id", strategies.map((strategy) => strategy.id))
  .eq("certification_status", "DRAFT").order("as_of_date"));

for (const strategy of strategies) {
  if (!drafts.some((row) => row.strategy_id === strategy.id)) throw new Error(`${strategy.name} has no DRAFT ledger rows`);
  if (disclosedProviderGaps.has(strategy.name) && !evidenceWaiver) {
    throw new Error(`${strategy.name} requires CANONICAL_EVIDENCE_WAIVER=1 for its disclosed provider gap`);
  }
}

const invalid = drafts.flatMap((row) => {
  const failures = [];
  if (Number(row.complete_value_cents) !== Number(row.securities_value_cents) + Number(row.continuity_cash_cents)) {
    failures.push("COMPLETE_VALUE_FORMULA");
  }
  for (const period of requiredPeriods) {
    const value = Number(row.period_metrics?.[period]?.return_pct);
    if (!Number.isFinite(value)) failures.push(`MISSING_${period}`);
  }
  if (!Array.isArray(row.leg_snapshot) || row.leg_snapshot.length === 0) failures.push("EMPTY_LEG_SNAPSHOT");
  return failures.length ? [{ strategy: names.get(row.strategy_id), date: row.as_of_date, failures }] : [];
});
if (invalid.length) throw new Error(`promotion validation failed: ${JSON.stringify(invalid.slice(0, 20))}`);

const now = new Date().toISOString();
let written = 0;
if (apply) {
  for (const row of drafts) {
    const strategyName = names.get(row.strategy_id);
    const providerGap = disclosedProviderGaps.get(strategyName) ?? null;
    const sourceEvidence = {
      ...(row.source_evidence || {}),
      certification_decision: {
        mode: providerGap ? "SCOPED_STORED_CLOSE_EVIDENCE_WAIVER_V1" : "SCOPED_FULL_EVIDENCE_V1",
        certified_at: now,
        certified_by: certifiedBy,
        reason,
        workbook_sha256: workbookSha,
        disclosed_provider_gap: providerGap,
        confirmed_price_mismatches: 0,
        valuation_mismatches: 0,
        formula_failures: 0,
        caveat: providerGap
          ? "The missing delisted provider series is disclosed and is not represented as an independent match."
          : null,
      },
    };
    const update = {
      certification_status: "CERTIFIED",
      certified_at: now,
      certified_by: certifiedBy,
      source_evidence: sourceEvidence,
      source_evidence_sha256: createHash("sha256").update(JSON.stringify(sourceEvidence)).digest("hex"),
      calculation_notes: { ...(row.calculation_notes || {}), promotion_blocked: false, promoted_by_scoped_rollout: true },
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
  strategies: requestedNames,
  draft_rows_validated: drafts.length,
  rows_promoted: written,
  evidence_waiver: evidenceWaiver,
  disclosed_provider_gaps: Object.fromEntries(requestedNames.map((name) => [name, disclosedProviderGaps.get(name) ?? null])),
}, null, 2));
