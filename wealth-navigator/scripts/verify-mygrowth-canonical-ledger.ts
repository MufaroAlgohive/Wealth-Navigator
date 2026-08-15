import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const STRATEGY_NAME = "MyGrowthFund";
const EXPECTED_VERSION = "excel-multi-boundary-leg-pnl-v1";
const EXPECTED_FIRST_DATE = "2026-04-20";
const EXPECTED_LAST_DATE = "2026-08-14";
const EXPECTED_LATEST_COMPLETE_CENTS = 104737;
const db = createRetailServiceRoleClient();

async function rows<T>(
  label: string,
  query: PromiseLike<{ data: T | null; error: { message: string } | null }>,
) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

const strategies = await rows<{ id: string; name: string }>(
  "MyGrowth strategy",
  db.from("strategies_c").select("id,name").eq("name", STRATEGY_NAME),
);
if (strategies.length !== 1) throw new Error(`expected one ${STRATEGY_NAME}`);
const strategyId = strategies[0].id;

const [ledger, sessions] = await Promise.all([
  rows<{
    as_of_date: string;
    ledger_version: string;
    certification_status: string;
    securities_value_cents: number;
    continuity_cash_cents: number;
    complete_value_cents: number;
    period_metrics: Record<
      string,
      {
        numerator_value_cents: number;
        numerator_cents: number;
        denominator_cents: number;
        pnl_cents: number;
        return_pct: number | null;
        leg_trace: Array<{ benchmark_cents: number; numerator_cents: number; pnl_cents: number }>;
      }
    >;
    source_evidence: Record<string, unknown>;
    source_evidence_sha256: string;
  }>(
    "MyGrowth canonical ledger",
    db
      .from("strategy_canonical_daily_ledger_c")
      .select(
        "as_of_date,ledger_version,certification_status,securities_value_cents,continuity_cash_cents,complete_value_cents,period_metrics,source_evidence,source_evidence_sha256",
      )
      .eq("strategy_id", strategyId)
      .order("as_of_date"),
  ),
  rows<{ trading_date: string }>(
    "JSE sessions",
    db
      .from("jse_trading_calendar")
      .select("trading_date")
      .eq("market", "JSE_EQUITIES")
      .eq("is_trading_day", true)
      .gte("trading_date", EXPECTED_FIRST_DATE)
      .lte("trading_date", EXPECTED_LAST_DATE)
      .order("trading_date"),
  ),
]);

const metricFailures: Array<{ date: string; period: string; reason: string }> = [];
for (const row of ledger) {
  for (const [period, metric] of Object.entries(row.period_metrics ?? {})) {
    const benchmark = metric.leg_trace.reduce((sum, leg) => sum + Number(leg.benchmark_cents), 0);
    const numeratorValue = metric.leg_trace.reduce((sum, leg) => sum + Number(leg.numerator_cents), 0);
    const pnl = metric.leg_trace.reduce((sum, leg) => sum + Number(leg.pnl_cents), 0);
    const expectedReturn = benchmark > 0 ? (pnl / benchmark) * 100 : null;
    if (benchmark !== Number(metric.denominator_cents)) {
      metricFailures.push({
        date: row.as_of_date,
        period,
        reason: "denominator does not sum leg benchmarks",
      });
    }
    if (numeratorValue !== Number(metric.numerator_value_cents)) {
      metricFailures.push({
        date: row.as_of_date,
        period,
        reason: "numerator value does not sum leg numerators",
      });
    }
    if (pnl !== Number(metric.pnl_cents) || pnl !== Number(metric.numerator_cents)) {
      metricFailures.push({ date: row.as_of_date, period, reason: "P/L does not sum leg P/L" });
    }
    if (
      expectedReturn == null
        ? metric.return_pct != null
        : Math.abs(expectedReturn - Number(metric.return_pct)) > 1e-12
    ) {
      metricFailures.push({ date: row.as_of_date, period, reason: "return is not P/L divided by benchmark" });
    }
  }
}

const latest = ledger.at(-1) ?? null;
const dateCoveragePassed =
  JSON.stringify(ledger.map((row) => row.as_of_date)) ===
  JSON.stringify(sessions.map((row) => row.trading_date));
const oneEvidenceHash = new Set(ledger.map((row) => row.source_evidence_sha256)).size === 1;
const sourceEvidence = latest?.source_evidence ?? {};
const providerCheck = sourceEvidence.independent_provider_check as
  | { certification_effect?: string }
  | undefined;
const workbook = sourceEvidence.workbook_reference as { sha256?: string; formula_match?: string } | undefined;
const checks = {
  row_count: ledger.length,
  expected_session_count: sessions.length,
  date_coverage_passed: dateCoveragePassed,
  draft_only: ledger.every(
    (row) => row.certification_status === "DRAFT" && row.ledger_version === EXPECTED_VERSION,
  ),
  complete_value_identities_passed: ledger.every(
    (row) =>
      Number(row.complete_value_cents) ===
      Number(row.securities_value_cents) + Number(row.continuity_cash_cents),
  ),
  metric_identity_failure_count: metricFailures.length,
  metric_failure_sample: metricFailures.slice(0, 20),
  one_evidence_hash: oneEvidenceHash,
  workbook_sha256: workbook?.sha256 ?? null,
  workbook_formula_match: workbook?.formula_match ?? null,
  provider_certification_effect: providerCheck?.certification_effect ?? null,
  first_date: ledger.at(0)?.as_of_date ?? null,
  last_date: latest?.as_of_date ?? null,
  latest_complete_value_cents: latest?.complete_value_cents ?? null,
  latest_period_metrics: latest?.period_metrics ?? null,
};
const structurallyPassed =
  ledger.length === sessions.length &&
  dateCoveragePassed &&
  checks.draft_only &&
  checks.complete_value_identities_passed &&
  metricFailures.length === 0 &&
  oneEvidenceHash &&
  checks.first_date === EXPECTED_FIRST_DATE &&
  checks.last_date === EXPECTED_LAST_DATE &&
  Number(checks.latest_complete_value_cents) === EXPECTED_LATEST_COMPLETE_CENTS &&
  workbook?.sha256 === "bde94581727f9a08232ec5e80f2672bde3a1ef73c733309ec8723fe78bcaa301";

console.log(
  JSON.stringify(
    {
      strategy: STRATEGY_NAME,
      structurally_passed: structurallyPassed,
      certification_ready: structurallyPassed && providerCheck?.certification_effect !== "BLOCKED",
      checks,
    },
    null,
    2,
  ),
);
if (!structurallyPassed) process.exitCode = 1;
