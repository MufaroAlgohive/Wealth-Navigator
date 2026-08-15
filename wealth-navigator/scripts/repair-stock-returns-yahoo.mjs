import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@supabase/supabase-js";

const url = process.env.RETAIL_SUPABASE_URL ?? process.env.SUPABASE_URL;
const key = process.env.RETAIL_SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? process.env.service_role_key;
if (!url || !key) throw new Error("Retail Supabase service configuration is missing");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const APPLY = process.env.APPLY_YAHOO_CLOSE_REPAIR === "1";
const ALLOW_PARTIAL_HISTORY = process.env.ALLOW_PARTIAL_YAHOO_HISTORY === "1";
const REPAIR_DERIVED_FIELDS = process.env.REPAIR_DERIVED_STOCK_RETURNS === "1";
const bare = (value) => String(value ?? "").trim().toUpperCase().replace(/\.(JO|JSE)$/i, "");
const iso = (value) => value.toISOString().slice(0, 10);
const addDays = (date, amount) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return iso(value);
};
const addMonths = (date, amount) => {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + amount);
  value.setUTCDate(Math.min(day, new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate()));
  return iso(value);
};
const addYears = (date, amount) => addMonths(date, amount * 12);
const epoch = (date) => Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const query = `interval=1d&period1=${epoch(startDate) - 7 * 86400}&period2=${epoch(endDate) + 2 * 86400}&events=history`;
  let finalError = "unknown Yahoo failure";
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`, {
          headers: { "User-Agent": "Mozilla/5.0 MINT close repair" },
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const payload = await response.json();
        const result = payload?.chart?.result?.[0];
        if (!result || payload?.chart?.error) throw new Error(JSON.stringify(payload?.chart?.error ?? "empty chart"));
        const currency = String(result.meta?.currency ?? "").toUpperCase();
        const multiplier = currency === "ZAC" ? 1 : currency === "ZAR" ? 100 : null;
        if (multiplier == null) throw new Error(`unsupported Yahoo currency ${currency || "missing"}`);
        const history = new Map();
        const timestamps = result.timestamp ?? [];
        const closes = result.indicators?.quote?.[0]?.close ?? [];
        for (let index = 0; index < timestamps.length; index += 1) {
          const close = Number(closes[index]);
          if (Number.isFinite(close) && close > 0) {
            history.set(new Date(timestamps[index] * 1000).toISOString().slice(0, 10), Math.round(close * multiplier));
          }
        }
        return { ticker: bare(ticker), yahooSymbol: symbol, currency, history };
      } catch (error) {
        finalError = error instanceof Error ? error.message : String(error);
        await sleep(attempt * 250);
      }
    }
  }
  throw new Error(`${symbol}: ${finalError}`);
}

function pointOnOrBefore(history, target) {
  const dates = [...history.keys()].filter((date) => date <= target).sort();
  const date = dates.at(-1);
  return date ? { date, close: history.get(date) } : null;
}

function metric(current, reference) {
  if (!reference || !(reference.close > 0)) return { pct: null, abs: null };
  return {
    pct: ((current - reference.close) / reference.close) * 100,
    abs: current - reference.close,
  };
}

function buildReturnFields(history, date) {
  const ordered = [...history.keys()].filter((candidate) => candidate <= date).sort();
  const index = ordered.indexOf(date);
  const current = history.get(date);
  const prior = index > 0 ? { date: ordered[index - 1], close: history.get(ordered[index - 1]) } : null;
  const fiveDay = pointOnOrBefore(history, addDays(date, -7));
  const oneMonth = pointOnOrBefore(history, addMonths(date, -1));
  const sixMonth = pointOnOrBefore(history, addMonths(date, -6));
  const ytd = pointOnOrBefore(history, `${Number(date.slice(0, 4)) - 1}-12-31`);
  const oneYear = pointOnOrBefore(history, addYears(date, -1));
  const fiveYear = pointOnOrBefore(history, addYears(date, -5));
  const all = ordered.length ? { date: ordered[0], close: history.get(ordered[0]) } : null;
  const values = {
    "1d": metric(current, prior),
    "5d": metric(current, fiveDay),
    "1m": metric(current, oneMonth),
    "6m": metric(current, sixMonth),
    ytd: metric(current, ytd),
    "1y": metric(current, oneYear),
    "5y": metric(current, fiveYear),
    all: metric(current, all),
  };
  return Object.fromEntries(Object.entries(values).flatMap(([period, value]) => [
    [`${period}_pct`, value.pct],
    [`${period}_abs`, value.abs],
  ]));
}

const ledger = await paged("canonical ledger", (offset) => db
  .from("strategy_canonical_daily_ledger_c")
  .select("as_of_date,leg_snapshot")
  .eq("certification_status", "DRAFT")
  .order("as_of_date")
  .range(offset, offset + 999));
if (!ledger.length) throw new Error("No DRAFT canonical ledger rows found");
const firstDate = ledger[0].as_of_date;
const lastDate = ledger.at(-1).as_of_date;
const historyStart = addYears(firstDate, -6);
const tickers = [...new Set(ledger.flatMap((row) => Array.isArray(row.leg_snapshot) ? row.leg_snapshot : [])
  .map((leg) => bare(leg.ticker ?? leg.symbol))
  .filter((ticker) => ticker && ticker !== "CASH" && ticker !== "EXECUTION_COST"))].sort();

const [securities, stored] = await Promise.all([
  rows("securities", db.from("securities_c").select("id,symbol").in("symbol", tickers.flatMap((ticker) => [ticker, `${ticker}.JO`]))),
  paged("stored returns", (offset) => db.from("stock_returns_c").select("*")
    .in("symbol", tickers.flatMap((ticker) => [ticker, `${ticker}.JO`]))
    .gte("as_of_date", firstDate).lte("as_of_date", lastDate)
    .order("symbol").order("as_of_date").order("fetched_at").range(offset, offset + 999)),
]);
const securityByTicker = new Map(securities.map((security) => [bare(security.symbol), security]));
const storedByKey = new Map(stored.map((row) => [`${bare(row.symbol)}:${row.as_of_date}`, row]));

const provider = new Map();
const providerErrors = [];
for (let index = 0; index < tickers.length; index += 4) {
  const group = tickers.slice(index, index + 4);
  const outcomes = await Promise.allSettled(group.map((ticker) => yahooHistory(ticker, historyStart, lastDate)));
  outcomes.forEach((outcome, item) => {
    if (outcome.status === "fulfilled") provider.set(group[item], outcome.value);
    else providerErrors.push({ ticker: group[item], error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
  });
}
if (providerErrors.length) throw new Error(`Provider failures: ${JSON.stringify(providerErrors)}`);

const unsupported = [];
const changes = [];
for (const ticker of tickers) {
  const security = securityByTicker.get(ticker);
  if (!security) {
    unsupported.push({ ticker, reason: "SECURITY_MASTER_MISSING" });
    continue;
  }
  const history = provider.get(ticker)?.history ?? new Map();
  const providerDates = [...history.keys()].filter((date) => date >= firstDate && date <= lastDate).sort();
  const firstProviderDate = providerDates[0] ?? null;
  if (!firstProviderDate) {
    unsupported.push({ ticker, reason: "NO_PROVIDER_HISTORY" });
    continue;
  }
  const overlapRatios = providerDates.flatMap((date) => {
    const existing = storedByKey.get(`${ticker}:${date}`);
    const providerClose = history.get(date);
    return existing && Number(existing.current_price) > 0 && providerClose > 0
      ? [providerClose / Number(existing.current_price)]
      : [];
  }).sort((left, right) => left - right);
  const medianRatio = overlapRatios.length ? overlapRatios[Math.floor(overlapRatios.length / 2)] : null;
  if (medianRatio != null && (medianRatio < 0.2 || medianRatio > 5)) {
    unsupported.push({ ticker, reason: "PROVIDER_SCALE_DIVERGENCE", medianRatio, overlapCount: overlapRatios.length });
    continue;
  }
  if (firstProviderDate > firstDate) unsupported.push({ ticker, reason: "PARTIAL_PROVIDER_HISTORY", firstProviderDate });
  for (const date of providerDates) {
    const existing = storedByKey.get(`${ticker}:${date}`);
    const currentPrice = history.get(date);
    const fields = buildReturnFields(history, date);
    const next = {
      security_id: security.id,
      symbol: security.symbol,
      as_of_date: date,
      current_price: currentPrice,
      ...(REPAIR_DERIVED_FIELDS ? fields : {}),
      fetched_at: new Date().toISOString(),
    };
    const priceChanged = !existing || Math.abs(Number(existing.current_price) - currentPrice) > 0;
    const derivedChanged = REPAIR_DERIVED_FIELDS && Object.entries(fields).some(([field, value]) => {
      const old = existing?.[field];
      return value == null ? old != null : old == null || Math.abs(Number(old) - value) > 1e-8;
    });
    if (priceChanged || derivedChanged) changes.push({ ticker, date, existing: existing ?? null, next });
  }
}

const partial = unsupported.filter((item) => item.reason === "PARTIAL_PROVIDER_HISTORY");
if (APPLY && partial.length && !ALLOW_PARTIAL_HISTORY) {
  throw new Error(`Partial Yahoo histories require explicit ALLOW_PARTIAL_YAHOO_HISTORY=1: ${JSON.stringify(partial)}`);
}

const manifest = {
  generatedAt: new Date().toISOString(),
  apply: APPLY,
  derivedFieldsIncluded: REPAIR_DERIVED_FIELDS,
  scope: { firstDate, lastDate, historyStart, tickerCount: tickers.length },
  unsupported,
  changeCount: changes.length,
  insertCount: changes.filter((change) => !change.existing).length,
  updateCount: changes.filter((change) => change.existing).length,
  priceChangeCount: changes.filter((change) => !change.existing || Math.abs(Number(change.existing.current_price) - change.next.current_price) > 0).length,
  changesByTicker: Object.fromEntries([...changes.reduce(
    (counts, change) => counts.set(change.ticker, (counts.get(change.ticker) ?? 0) + 1),
    new Map(),
  )].sort((left, right) => right[1] - left[1])),
  evidenceSha256: createHash("sha256").update(JSON.stringify(
    [...provider.values()]
      .flatMap((item) => [...item.history].map(([date, close]) => ({ ticker: item.ticker, date, close })))
      .sort((a, b) => `${a.ticker}:${a.date}`.localeCompare(`${b.ticker}:${b.date}`)),
  )).digest("hex"),
};

if (APPLY && changes.length) {
  const backup = changes.filter((change) => change.existing).map((change) => change.existing);
  const backupPath = join(tmpdir(), `mint-stock-returns-backup-${Date.now()}.json`);
  await writeFile(backupPath, JSON.stringify({ manifest, rows: backup }, null, 2));
  for (let index = 0; index < changes.length; index += 250) {
    const chunk = changes.slice(index, index + 250).map((change) => change.next);
    const { error } = await db.from("stock_returns_c").upsert(chunk, { onConflict: "symbol,as_of_date" });
    if (error) throw new Error(`Repair upsert failed after ${index} rows: ${error.message}; backup=${backupPath}`);
  }
  manifest.backupPath = backupPath;
  manifest.backupSha256 = createHash("sha256").update(JSON.stringify(backup)).digest("hex");
}

console.log(JSON.stringify(manifest, null, 2));
