import { createRetailServiceRoleClient } from "../src/lib/supabase/server";

const STRATEGY_NAME = "ETF Basket";
const START_DATE = "2026-03-20";
const END_DATE = "2026-08-14";
const EXPECTED_VERSION = "excel-static-lot-v1";
const db = createRetailServiceRoleClient();

async function rows<T>(label: string, query: PromiseLike<{ data: T | null; error: { message: string } | null }>) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

const strategies = await rows(
  "ETF strategy",
  db.from("strategies_c").select("id, name").eq("name", STRATEGY_NAME),
);
if (strategies.length !== 1) throw new Error(`expected one ${STRATEGY_NAME} strategy`);
const strategyId = strategies[0].id;

const [ledger, sessions] = await Promise.all([
  rows(
    "ETF canonical rows",
    db
      .from("strategy_canonical_daily_ledger_c")
      .select("as_of_date, ledger_version, certification_status, securities_value_cents, continuity_cash_cents, complete_value_cents, period_metrics, source_evidence, source_evidence_sha256")
      .eq("strategy_id", strategyId)
      .order("as_of_date"),
  ),
  rows(
    "JSE sessions",
    db
      .from("jse_trading_calendar")
      .select("trading_date")
      .eq("market", "JSE_EQUITIES")
      .eq("is_trading_day", true)
      .gte("trading_date", START_DATE)
      .lte("trading_date", END_DATE)
      .order("trading_date"),
  ),
]);

const ledgerDates = ledger.map((row) => row.as_of_date);
const sessionDates = sessions.map((row) => row.trading_date);
const identitiesPassed = ledger.every(
  (row) =>
    Number(row.complete_value_cents) ===
    Number(row.securities_value_cents) + Number(row.continuity_cash_cents),
);
const draftOnly = ledger.every(
  (row) => row.certification_status === "DRAFT" && row.ledger_version === EXPECTED_VERSION,
);
const providerBlocked = ledger.every(
  (row) => row.source_evidence?.independent_provider_check === "UNAVAILABLE_2026_SERIES",
);
const dateCoveragePassed = JSON.stringify(ledgerDates) === JSON.stringify(sessionDates);
const uniqueHashes = [...new Set(ledger.map((row) => row.source_evidence_sha256))];
const latest = ledger.at(-1) ?? null;
const checks = {
  row_count: ledger.length,
  expected_session_count: sessions.length,
  date_coverage_passed: dateCoveragePassed,
  complete_value_identities_passed: identitiesPassed,
  draft_only: draftOnly,
  independent_provider_block_recorded: providerBlocked,
  one_evidence_hash: uniqueHashes.length === 1 && Boolean(uniqueHashes[0]),
  first_date: ledger.at(0)?.as_of_date ?? null,
  last_date: latest?.as_of_date ?? null,
  latest_complete_value_cents: latest?.complete_value_cents ?? null,
  latest_period_metrics: latest?.period_metrics ?? null,
};
const passed =
  ledger.length === 100 &&
  ledger.length === sessions.length &&
  dateCoveragePassed &&
  identitiesPassed &&
  draftOnly &&
  providerBlocked &&
  uniqueHashes.length === 1 &&
  latest?.as_of_date === END_DATE &&
  Number(latest?.complete_value_cents) === 237139;

console.log(JSON.stringify({ strategy: STRATEGY_NAME, passed, checks }, null, 2));
if (!passed) process.exitCode = 1;
