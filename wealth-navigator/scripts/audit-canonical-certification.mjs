import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

const url = process.env.RETAIL_SUPABASE_URL ?? process.env.SUPABASE_URL;
const key = process.env.RETAIL_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.service_role_key;
if (!url || !key) throw new Error("Retail Supabase service configuration is missing");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const EXPECTED_WORKBOOK_SHA = "bde94581727f9a08232ec5e80f2672bde3a1ef73c733309ec8723fe78bcaa301";
const TOLERANCE_CENTS = 0;

const bare = (value) => String(value ?? "").trim().toUpperCase().replace(/\.(JO|JSE)$/i, "");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const epoch = (date) => Math.floor(new Date(`${date}T00:00:00+02:00`).getTime() / 1000);
const dateInJse = (timestamp) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Johannesburg",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date(timestamp * 1000));

async function rows(label, query) {
  const { data, error } = await query;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data ?? [];
}

async function paged(label, makeQuery) {
  const result = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await rows(`${label} page ${offset / 1000 + 1}`, makeQuery(offset));
    result.push(...page);
    if (page.length < 1000) return result;
  }
}

async function yahooHistory(ticker, startDate, endDate) {
  const symbol = `${bare(ticker)}.JO`;
  const query = `period1=${epoch(startDate) - 7 * 86400}&period2=${epoch(endDate) + 2 * 86400}&interval=1d&events=history`;
  let finalError = "unknown Yahoo failure";
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`, {
          headers: { "User-Agent": "Mozilla/5.0 MINT canonical certification" },
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const payload = await response.json();
        const result = payload?.chart?.result?.[0];
        if (!result || payload?.chart?.error) throw new Error(JSON.stringify(payload?.chart?.error ?? "empty chart"));
        const currency = String(result.meta?.currency ?? "");
        if (!currency) throw new Error("Yahoo currency metadata missing");
        const multiplier = currency.toUpperCase() === "ZAC" ? 1 : currency.toUpperCase() === "ZAR" ? 100 : null;
        if (multiplier == null) throw new Error(`unsupported Yahoo currency ${currency}`);
        const timestamps = result.timestamp ?? [];
        const closes = result.indicators?.quote?.[0]?.close ?? [];
        const history = new Map();
        for (let index = 0; index < timestamps.length; index += 1) {
          const close = Number(closes[index]);
          if (Number.isFinite(close) && close > 0) history.set(dateInJse(timestamps[index]), Math.round(close * multiplier));
        }
        return { symbol, currency, history };
      } catch (error) {
        finalError = error instanceof Error ? error.message : String(error);
        await sleep(250 * attempt);
      }
    }
  }
  throw new Error(`${symbol}: ${finalError}`);
}

const strategies = await rows(
  "active strategies",
  db.from("strategies_c").select("id,name,status").eq("status", "active").neq("name", "Test Strategy").order("name"),
);
const strategyIds = strategies.map((strategy) => strategy.id);
const ledger = await paged("canonical ledger", (offset) =>
  db
    .from("strategy_canonical_daily_ledger_c")
    .select("strategy_id,as_of_date,ledger_version,certification_status,securities_value_cents,continuity_cash_cents,complete_value_cents,leg_snapshot,period_metrics,source_evidence,source_evidence_sha256,calculation_notes")
    .in("strategy_id", strategyIds)
    .order("as_of_date")
    .range(offset, offset + 999),
);
if (!ledger.length) throw new Error("Canonical ledger is empty");

const allDates = ledger.map((row) => row.as_of_date).sort();
const firstDate = allDates[0];
const lastDate = allDates.at(-1);
const tickers = [...new Set(ledger.flatMap((row) => (Array.isArray(row.leg_snapshot) ? row.leg_snapshot : []))
  .map((leg) => bare(leg.ticker ?? leg.symbol))
  .filter((ticker) => ticker && ticker !== "CASH" && ticker !== "EXECUTION_COST"))].sort();

const yahoo = new Map();
const providerErrors = [];
for (let index = 0; index < tickers.length; index += 4) {
  const group = tickers.slice(index, index + 4);
  const results = await Promise.allSettled(group.map((ticker) => yahooHistory(ticker, firstDate, lastDate)));
  for (let item = 0; item < group.length; item += 1) {
    const result = results[item];
    if (result.status === "fulfilled") yahoo.set(group[item], result.value);
    else providerErrors.push({ ticker: group[item], error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
  }
}

const storedRows = await paged("stored closes", (offset) =>
  db
    .from("stock_returns_c")
    .select("symbol,as_of_date,current_price,fetched_at")
    .in("symbol", tickers.flatMap((ticker) => [ticker, `${ticker}.JO`]))
    .gte("as_of_date", firstDate)
    .lte("as_of_date", lastDate)
    .order("symbol")
    .order("as_of_date")
    .order("fetched_at")
    .range(offset, offset + 999),
);
const storedHistory = new Map();
for (const row of storedRows) {
  const close = Number(row.current_price);
  if (close > 0) {
    const ticker = bare(row.symbol);
    const history = storedHistory.get(ticker) ?? new Map();
    history.set(row.as_of_date, close);
    storedHistory.set(ticker, history);
  }
}

const providerQuarantines = [];
const quarantinedTickers = new Set();
for (const [ticker, provider] of yahoo) {
  const storedTickerHistory = storedHistory.get(ticker);
  const ratios = [...provider.history].flatMap(([date, providerClose]) => {
    const storedClose = storedTickerHistory?.get(date);
    return storedClose > 0 && providerClose > 0 ? [providerClose / storedClose] : [];
  }).sort((left, right) => left - right);
  const medianRatio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
  if (medianRatio != null && (medianRatio < 0.2 || medianRatio > 5)) {
    quarantinedTickers.add(ticker);
    providerQuarantines.push({ ticker, reason: "PROVIDER_SCALE_DIVERGENCE", medianRatio, overlapCount: ratios.length });
  }
}

function onOrBefore(history, date) {
  if (!history) return null;
  const exact = history.get(date);
  if (exact != null) return { date, closeCents: exact, exact: true };
  const priorDate = [...history.keys()].filter((candidate) => candidate < date).sort().at(-1);
  return priorDate ? { date: priorDate, closeCents: history.get(priorDate), exact: false } : null;
}

function activeHoldings(row) {
  const totals = new Map();
  for (const leg of Array.isArray(row.leg_snapshot) ? row.leg_snapshot : []) {
    const ticker = bare(leg.ticker ?? leg.symbol);
    if (!ticker || ticker === "CASH" || ticker === "EXECUTION_COST" || leg.counts_in_current_strategy === false) continue;
    const exitDate = String(leg.exit_date ?? "");
    if (exitDate && exitDate <= row.as_of_date) continue;
    const units = Number(leg.units ?? leg.quantity ?? leg.shares ?? 0);
    if (units > 0) totals.set(ticker, (totals.get(ticker) ?? 0) + units);
  }
  return [...totals].map(([ticker, units]) => ({ ticker, units }));
}

function formulaFailures(row) {
  const failures = [];
  if (Number(row.securities_value_cents) + Number(row.continuity_cash_cents) !== Number(row.complete_value_cents)) {
    failures.push("complete value identity");
  }
  for (const [period, metric] of Object.entries(row.period_metrics ?? {})) {
    const trace = Array.isArray(metric?.leg_trace) ? metric.leg_trace : [];
    if (trace.length) {
      const denominator = trace.reduce((sum, leg) => sum + Number(leg.benchmark_cents), 0);
      const numeratorValue = trace.reduce((sum, leg) => sum + Number(leg.numerator_cents), 0);
      const pnl = trace.reduce((sum, leg) => sum + Number(leg.pnl_cents), 0);
      const expectedPct = denominator > 0 ? (pnl / denominator) * 100 : null;
      if (Math.abs(denominator - Number(metric.denominator_cents)) > 1e-9) failures.push(`${period} denominator`);
      if (Math.abs(numeratorValue - Number(metric.numerator_value_cents)) > 1e-9) failures.push(`${period} numerator`);
      if (Math.abs(pnl - Number(metric.pnl_cents ?? metric.numerator_cents)) > 1e-9) failures.push(`${period} pnl`);
      if (expectedPct == null ? metric.return_pct != null : Math.abs(expectedPct - Number(metric.return_pct)) > 1e-10) failures.push(`${period} return`);
    } else {
      const denominator = Number(metric?.denominator_cents);
      const pnl = Number(metric?.numerator_cents ?? metric?.pnl_cents);
      const expectedPct = denominator > 0 ? (pnl / denominator) * 100 : null;
      if (expectedPct == null ? metric?.return_pct != null : Math.abs(expectedPct - Number(metric?.return_pct)) > 1e-10) failures.push(`${period} direct return`);
    }
  }
  return failures;
}

function countsByTicker(rows) {
  return Object.fromEntries(
    [...rows.reduce((map, row) => map.set(row.ticker, (map.get(row.ticker) ?? 0) + 1), new Map())]
      .sort((left, right) => right[1] - left[1]),
  );
}

const report = strategies.map((strategy) => {
  const history = ledger.filter((row) => row.strategy_id === strategy.id);
  const priceComparisons = [];
  const valuationComparisons = [];
  const formula = [];
  for (const row of history) {
    const holdings = activeHoldings(row);
    let yahooValue = 0;
    let valuationMissing = false;
    for (const holding of holdings) {
      const providerPoint = quarantinedTickers.has(holding.ticker)
        ? null
        : onOrBefore(yahoo.get(holding.ticker)?.history, row.as_of_date);
      const storedPoint = onOrBefore(storedHistory.get(holding.ticker), row.as_of_date);
      // A trading-session close needs same-session independent evidence. Do
      // not compare a newer stored close to Yahoo's prior-day carry-forward.
      const comparableProviderPoint = providerPoint?.date === storedPoint?.date ? providerPoint : null;
      const providerClose = comparableProviderPoint?.closeCents;
      const storedClose = storedPoint?.closeCents;
      const differenceCents = providerClose == null || storedClose == null ? null : storedClose - providerClose;
      priceComparisons.push({
        date: row.as_of_date,
        ticker: holding.ticker,
        providerDate: comparableProviderPoint?.date ?? null,
        providerClose,
        storedDate: storedPoint?.date ?? null,
        storedClose,
        differenceCents,
      });
      if (providerClose == null) valuationMissing = true;
      else yahooValue += holding.units * providerClose;
    }
    valuationComparisons.push({
      date: row.as_of_date,
      holdings,
      providerValueCents: valuationMissing ? null : yahooValue,
      canonicalValueCents: Number(row.securities_value_cents),
      differenceCents: valuationMissing ? null : Number(row.securities_value_cents) - yahooValue,
    });
    for (const failure of formulaFailures(row)) formula.push({ date: row.as_of_date, failure });
  }
  const priceMismatches = priceComparisons.filter((row) => row.differenceCents != null && Math.abs(row.differenceCents) > TOLERANCE_CENTS);
  const priceMissing = priceComparisons.filter((row) => row.differenceCents == null);
  const valuationMismatches = valuationComparisons.filter((row) => row.differenceCents != null && Math.abs(row.differenceCents) > TOLERANCE_CENTS);
  const valuationMissing = valuationComparisons.filter((row) => row.differenceCents == null);
  const latest = history.at(-1);
  const workbookSha = latest?.source_evidence?.workbook_reference?.sha256 ?? null;
  const workbookFormula = latest?.source_evidence?.workbook_reference?.formula_match ?? null;
  const pass = Boolean(history.length) && !priceMismatches.length && !priceMissing.length && !valuationMismatches.length && !valuationMissing.length && !formula.length && workbookSha === EXPECTED_WORKBOOK_SHA;
  return {
    strategy: strategy.name,
    rows: history.length,
    firstDate: history[0]?.as_of_date ?? null,
    lastDate: latest?.as_of_date ?? null,
    currentStatus: latest?.certification_status ?? null,
    workbookSha,
    workbookFormula,
    priceProof: {
      total: priceComparisons.length,
      mismatches: priceMismatches.length,
      missing: priceMissing.length,
      mismatchByTicker: countsByTicker(priceMismatches),
      missingByTicker: countsByTicker(priceMissing),
      examples: [...priceMismatches, ...priceMissing].slice(0, 10),
    },
    valuationProof: { total: valuationComparisons.length, mismatches: valuationMismatches.length, missing: valuationMissing.length, examples: [...valuationMismatches, ...valuationMissing].slice(0, 10) },
    formulaProof: { failures: formula.length, examples: formula.slice(0, 10) },
    certificationPass: pass,
  };
});

const normalizedProviderEvidence = [...yahoo.entries()].flatMap(([ticker, value]) =>
  [...value.history].map(([date, closeCents]) => ({ ticker, date, closeCents, currency: value.currency })),
).sort((a, b) => `${a.date}:${a.ticker}`.localeCompare(`${b.date}:${b.ticker}`));
const output = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  workbookShaExpected: EXPECTED_WORKBOOK_SHA,
  providerEvidenceSha256: createHash("sha256").update(JSON.stringify(normalizedProviderEvidence)).digest("hex"),
  providerTickerCount: yahoo.size,
  providerErrors,
  providerQuarantines,
  strategies: process.env.AUDIT_SUMMARY_ONLY === "1"
    ? report.map((row) => ({
        strategy: row.strategy,
        rows: row.rows,
        firstDate: row.firstDate,
        lastDate: row.lastDate,
        workbookSha: row.workbookSha,
        priceProof: {
          ...row.priceProof,
          examples: row.priceProof.examples.filter((example) => example.differenceCents != null).slice(0, 10),
        },
        valuationProof: { ...row.valuationProof, examples: row.valuationProof.examples.slice(0, 10) },
        formulaProof: row.formulaProof,
        certificationPass: row.certificationPass,
      }))
    : report,
  certificationReady: providerErrors.length === 0 && providerQuarantines.length === 0 && report.every((row) => row.certificationPass),
};
console.log(JSON.stringify(output, null, 2));
