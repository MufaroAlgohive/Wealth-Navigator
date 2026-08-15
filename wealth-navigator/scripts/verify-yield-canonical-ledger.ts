import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const STRATEGY_NAME = "Yield Basket";
const EXPECTED_VERSION = "excel-yield-execution-leg-pnl-v1";
const EXPECTED_FIRST_DATE = "2026-01-30";
const EXPECTED_LAST_DATE = "2026-08-14";
const EXPECTED_LATEST_COMPLETE_CENTS = 233_941;
const EXPECTED_ACTIVE_CA_CENTS = 49_194;
const EXPECTED_GROSS_FILL_RESIDUAL_CENTS = 50_390;
const EXPECTED_EXECUTION_COST_CENTS = 1_196;
const db = createRetailServiceRoleClient();

async function rows<T>(
  label: string,
  query: PromiseLike<{ data: T | null; error: { message: string } | null }>,
) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

const strategies = await rows<{ id: string }>(
  "Yield strategy",
  db.from("strategies_c").select("id").eq("name", STRATEGY_NAME),
);
if (strategies.length !== 1) throw new Error(`expected one ${STRATEGY_NAME}`);

type Metric = {
  numerator_value_cents: number;
  numerator_cents: number;
  denominator_cents: number;
  pnl_cents: number;
  return_pct: number | null;
  leg_trace: Array<{ benchmark_cents: number; numerator_cents: number; pnl_cents: number }>;
};
type Evidence = {
  workbook_reference?: { sha256?: string; formula_match?: string };
  independent_provider_check?: { certification_effect?: string };
  cash_bridge?: {
    gross_fill_residual_cents?: number;
    active_rule_cash_cents?: number;
    cumulative_execution_cost_cents?: number;
    status?: string;
  };
  settled_boundaries?: Array<{ id?: string; owner_scale?: number }>;
  excluded_reversed_batches?: string[];
};

const [ledger, sessions] = await Promise.all([
  rows<{
    as_of_date: string;
    ledger_version: string;
    certification_status: string;
    securities_value_cents: number;
    continuity_cash_cents: number;
    complete_value_cents: number;
    period_metrics: Record<string, Metric>;
    source_evidence: Evidence;
    source_evidence_sha256: string;
  }>(
    "Yield canonical ledger",
    db
      .from("strategy_canonical_daily_ledger_c")
      .select(
        "as_of_date,ledger_version,certification_status,securities_value_cents,continuity_cash_cents,complete_value_cents,period_metrics,source_evidence,source_evidence_sha256",
      )
      .eq("strategy_id", strategies[0].id)
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
      metricFailures.push({ date: row.as_of_date, period, reason: "denominator identity failed" });
    }
    if (numeratorValue !== Number(metric.numerator_value_cents)) {
      metricFailures.push({ date: row.as_of_date, period, reason: "numerator identity failed" });
    }
    if (pnl !== Number(metric.pnl_cents) || pnl !== Number(metric.numerator_cents)) {
      metricFailures.push({ date: row.as_of_date, period, reason: "P/L identity failed" });
    }
    if (
      expectedReturn == null
        ? metric.return_pct != null
        : Math.abs(expectedReturn - Number(metric.return_pct)) > 1e-12
    ) {
      metricFailures.push({ date: row.as_of_date, period, reason: "return identity failed" });
    }
  }
}

const latest = ledger.at(-1) ?? null;
const evidence = latest?.source_evidence ?? {};
const bridge = evidence.cash_bridge ?? {};
const workbook = evidence.workbook_reference ?? {};
const provider = evidence.independent_provider_check ?? {};
const checks = {
  row_count: ledger.length,
  expected_session_count: sessions.length,
  date_coverage_passed:
    JSON.stringify(ledger.map((row) => row.as_of_date)) ===
    JSON.stringify(sessions.map((row) => row.trading_date)),
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
  one_evidence_hash: new Set(ledger.map((row) => row.source_evidence_sha256)).size === 1,
  first_date: ledger.at(0)?.as_of_date ?? null,
  last_date: latest?.as_of_date ?? null,
  latest_complete_value_cents: latest?.complete_value_cents ?? null,
  settled_boundary_count: evidence.settled_boundaries?.length ?? 0,
  settled_owner_scales: evidence.settled_boundaries?.map((boundary) => boundary.owner_scale) ?? [],
  excluded_reversed_batch_count: evidence.excluded_reversed_batches?.length ?? 0,
  gross_fill_residual_cents: bridge.gross_fill_residual_cents ?? null,
  active_rule_cash_cents: bridge.active_rule_cash_cents ?? null,
  cumulative_execution_cost_cents: bridge.cumulative_execution_cost_cents ?? null,
  cash_bridge_status: bridge.status ?? null,
  workbook_sha256: workbook.sha256 ?? null,
  workbook_formula_match: workbook.formula_match ?? null,
  provider_certification_effect: provider.certification_effect ?? null,
};
const structurallyPassed =
  ledger.length === sessions.length &&
  checks.date_coverage_passed &&
  checks.draft_only &&
  checks.complete_value_identities_passed &&
  checks.metric_identity_failure_count === 0 &&
  checks.one_evidence_hash &&
  checks.first_date === EXPECTED_FIRST_DATE &&
  checks.last_date === EXPECTED_LAST_DATE &&
  Number(checks.latest_complete_value_cents) === EXPECTED_LATEST_COMPLETE_CENTS &&
  checks.settled_boundary_count === 3 &&
  checks.excluded_reversed_batch_count === 1 &&
  Number(checks.gross_fill_residual_cents) === EXPECTED_GROSS_FILL_RESIDUAL_CENTS &&
  Number(checks.active_rule_cash_cents) === EXPECTED_ACTIVE_CA_CENTS &&
  Number(checks.cumulative_execution_cost_cents) === EXPECTED_EXECUTION_COST_CENTS &&
  workbook.sha256 === "bde94581727f9a08232ec5e80f2672bde3a1ef73c733309ec8723fe78bcaa301";
const providerBlocksCertification = String(
  provider.certification_effect ?? "BLOCKED_MISSING_STATUS",
).startsWith("BLOCKED");

console.log(
  JSON.stringify(
    {
      strategy: STRATEGY_NAME,
      structurally_passed: structurallyPassed,
      certification_ready: structurallyPassed && !providerBlocksCertification,
      checks,
    },
    null,
    2,
  ),
);
if (!structurallyPassed) process.exitCode = 1;
