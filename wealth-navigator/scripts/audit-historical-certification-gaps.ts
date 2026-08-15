import { createClient } from "@supabase/supabase-js";

const TARGETS = ["Yield Basket", "ETF Basket"];
const url = process.env.RETAIL_SUPABASE_URL ?? process.env.SUPABASE_URL;
const key = process.env.RETAIL_SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.service_role_key;
if (!url || !key) throw new Error("Retail Supabase service configuration is missing");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

async function rows<T>(label: string, query: PromiseLike<{ data: T | null; error: { message: string } | null }>) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

const strategies = await rows(
  "strategies",
  db.from("strategies_c").select("id, name, status, created_at, holdings, min_investment").in("name", TARGETS),
);
const strategyIds = strategies.map((strategy) => strategy.id);

const [compositions, rules, publications, effectiveReturns, rawReturns, draftLedger, ledgerSample, stxidPrices] =
  await Promise.all([
    rows(
      "composition logs",
      db
        .from("strategy_composition_log_c")
        .select("strategy_id, effective_from, effective_to, holdings, created_at")
        .in("strategy_id", strategyIds)
        .order("effective_from"),
    ),
    rows(
      "valuation rules",
      db
        .from("strategy_valuation_rules_c")
        .select("strategy_id, effective_from, status, securities_value_per_lot_cents, continuity_cash_per_lot_cents, complete_value_per_lot_cents, methodology_version, source_evidence, approved_at")
        .in("strategy_id", strategyIds)
        .order("effective_from"),
    ),
    rows(
      "publication audit",
      db
        .from("strategy_return_publication_audit_c")
        .select("strategy_id, as_of_date, securities_value_cents, continuity_cash_cents, complete_value_cents, chain_factor, ytd_pct, composition_effective_from, checks, published_at")
        .in("strategy_id", strategyIds)
        .order("as_of_date"),
    ),
    rows(
      "effective returns",
      db
        .from("strategy_returns_effective_c")
        .select('strategy_id, as_of_date, securities_value_cents, continuity_cash_cents, complete_value_cents, ytd_pct, all_pct, "1d_pct", source_kind')
        .in("strategy_id", strategyIds)
        .order("as_of_date"),
    ),
    rows(
      "raw returns",
      db
        .from("strategies_returns_c")
        .select("strategy_id, as_of_date, basket_value, ytd_pct")
        .in("strategy_id", strategyIds)
        .order("as_of_date"),
    ),
    rows(
      "canonical draft ledger",
      db
        .from("strategy_canonical_daily_ledger_c")
        .select("strategy_id, as_of_date, certification_status, securities_value_cents, continuity_cash_cents, complete_value_cents, leg_snapshot, period_metrics, source_evidence, calculation_notes")
        .in("strategy_id", strategyIds)
        .order("as_of_date"),
    ),
    rows("canonical ledger shape", db.from("strategy_canonical_daily_ledger_c").select("*").limit(1)),
    rows(
      "STXID prices",
      db
        .from("stock_returns_c")
        .select("symbol, as_of_date, current_price, fetched_at")
        .in("symbol", ["STXID", "STXID.JO"])
        .gte("as_of_date", "2025-12-01")
        .order("as_of_date"),
    ),
  ]);

const summarizeRange = <T extends { as_of_date: string }>(allRows: T[]) => ({
  count: allRows.length,
  first: allRows.at(0) ?? null,
  last: allRows.at(-1) ?? null,
});

const report = strategies.map((strategy) => {
  const own = <T extends { strategy_id: string }>(allRows: T[]) =>
    allRows.filter((row) => row.strategy_id === strategy.id);
  const ownPublications = own(publications);
  const ownEffective = own(effectiveReturns);
  const ownRaw = own(rawReturns);
  const ownLedger = own(draftLedger);
  const ledgerEvidence = ownLedger.map((ledger) => ({
    as_of_date: ledger.as_of_date,
    certification_status: ledger.certification_status,
    securities_value_cents: ledger.securities_value_cents,
    continuity_cash_cents: ledger.continuity_cash_cents,
    complete_value_cents: ledger.complete_value_cents,
    calculation_notes: ledger.calculation_notes,
    source_evidence: ledger.source_evidence,
    legs: (Array.isArray(ledger.leg_snapshot) ? ledger.leg_snapshot : []).map((leg) => ({
      ticker: leg.ticker,
      units: leg.units,
      entry_date: leg.entry_date,
      entry_price_cents: leg.entry_price_cents,
      exit_date: leg.exit_date,
      exit_price_cents: leg.exit_price_cents,
      source: leg.source,
    })),
    periods: Object.fromEntries(
      Object.entries((ledger.period_metrics ?? {}) as Record<string, Record<string, unknown>>).map(
        ([period, metric]) => [
        period,
        {
          reference_date: metric?.reference_date,
          return_pct: metric?.return_pct,
          numerator_cents: metric?.numerator_cents,
          denominator_cents: metric?.denominator_cents,
        },
      ],
      ),
    ),
  }));
  return {
    strategy,
    compositions: own(compositions),
    valuation_rules: own(rules),
    publication_range: summarizeRange(ownPublications),
    effective_return_range: summarizeRange(ownEffective),
    raw_return_range: summarizeRange(ownRaw),
    canonical_ledger_range: summarizeRange(
      ownLedger.map((ledger) => ({
        as_of_date: ledger.as_of_date,
        certification_status: ledger.certification_status,
      })),
    ),
    canonical_ledger_evidence: ledgerEvidence,
  };
});

const requiredStxidDates = new Set<string>();
for (const ledger of draftLedger) {
  const legs = Array.isArray(ledger.leg_snapshot) ? ledger.leg_snapshot : [];
  const containsStxid = legs.some((leg) => String(leg.ticker ?? "").toUpperCase() === "STXID");
  if (!containsStxid) continue;
  for (const leg of legs) {
    if (String(leg.ticker ?? "").toUpperCase() !== "STXID") continue;
    if (leg.entry_date) requiredStxidDates.add(String(leg.entry_date));
    if (leg.exit_date) requiredStxidDates.add(String(leg.exit_date));
  }
  for (const metric of Object.values(
    (ledger.period_metrics ?? {}) as Record<string, Record<string, unknown>>,
  )) {
    if (metric?.reference_date) requiredStxidDates.add(String(metric.reference_date));
  }
  if (ledger.as_of_date) requiredStxidDates.add(String(ledger.as_of_date));
}
const etf = strategies.find((strategy) => strategy.name === "ETF Basket");
if (etf?.created_at) requiredStxidDates.add(String(etf.created_at).slice(0, 10));
const etfLatestPublication = publications
  .filter((publication) => publication.strategy_id === etf?.id)
  .at(-1);
if (etfLatestPublication?.as_of_date) requiredStxidDates.add(etfLatestPublication.as_of_date);
const stxidByDate = new Map(stxidPrices.map((price) => [price.as_of_date, price] as const));

console.log(
  JSON.stringify(
    process.env.AUDIT_SUMMARY_ONLY === "1" ? {
      generated_at: new Date().toISOString(),
      report: report.map((entry) => ({
        strategy: {
          id: entry.strategy.id,
          name: entry.strategy.name,
          status: entry.strategy.status,
          created_at: entry.strategy.created_at,
          holdings: (Array.isArray(entry.strategy.holdings) ? entry.strategy.holdings : []).map((holding) => ({
            ticker: holding.ticker ?? holding.symbol,
            units: holding.units ?? holding.quantity ?? holding.shares,
          })),
        },
        compositions: entry.compositions.map((composition) => ({
          effective_from: composition.effective_from,
          effective_to: composition.effective_to,
          holdings: (Array.isArray(composition.holdings) ? composition.holdings : []).map((holding) => ({
            ticker: holding.ticker ?? holding.symbol,
            units: holding.units ?? holding.quantity ?? holding.shares,
          })),
        })),
        valuation_rules: entry.valuation_rules,
        canonical_ledger_range: entry.canonical_ledger_range,
      })),
      stxid_price_range: summarizeRange(stxidPrices),
      missing_required_stxid_dates: [...requiredStxidDates].sort().filter((date) => !stxidByDate.has(date)),
    } : {
      generated_at: new Date().toISOString(),
      canonical_ledger_columns: Object.keys(ledgerSample[0] ?? {}).sort(),
      report,
      stxid_price_range: summarizeRange(stxidPrices),
      required_stxid_dates: [...requiredStxidDates].sort().map((date) => ({
        date,
        stored_close: stxidByDate.get(date) ?? null,
      })),
      missing_required_stxid_dates: [...requiredStxidDates].sort().filter((date) => !stxidByDate.has(date)),
    },
    null,
    2,
  ),
);
