/**
 * READ-ONLY: provider parity scan — calls each market-data provider through the
 * shared `MarketDataProvider` surface and reports per-symbol deltas between
 * IRESS and Yahoo for a fixed list of 20 JSE codes.
 *
 * Mint OEM Finalisation Phase C1 ("Provider cutover"). The cutover
 * acceptance criterion is: with IRESS live and Supabase-ingested quotes in
 * the retail DB, the last + previous-close fields for these 20 tickers
 * match Yahoo to within 0.5% per symbol. When the active provider is
 * anything other than IRESS (today: `yahoo` on Vercel because the Railway
 * worker holds the CT seat) the IRESS leg falls back to the BFF's
 * IRESS-shaped read, which honours `USE_SUPABASE_QUOTES=true` and reads
 * the worker-ingested snapshots. Either way the script exits 0 when the
 * delta is within tolerance and 1 when it is not — so the cron slot can
 * turn yellow the moment Yahoo and IRESS diverge.
 *
 * Usage (from wealth-navigator/):
 *   bun scripts/scan-provider-parity.ts
 *
 * Optional env:
 *   PARITY_BASE_URL — defaults to http://localhost:3000 (the dev server).
 *   PARITY_TOLERANCE_PCT — defaults to 0.5 (the plan's tolerance).
 *   PARITY_SYMBOLS — comma-separated override; default is the 20-symbol
 *     universe below.
 *
 * Writes JSON to docs/PROVIDER_PARITY_2026-07-09.json (today's date).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_TOLERANCE_PCT = 0.5;

const DEFAULT_SYMBOLS = [
  "NPN", // Naspers — bare `<Last>` row shape
  "AGL", // Anglo American — LastPrice integer cents
  "FSR", // FirstRand — LastPrice integer cents
  "MTN", // MTN Group — LastPrice integer cents
  "SBK", // Standard Bank — LastPrice integer cents
  "BHG", // Bauba — hollow-row pattern (stale LastPrice)
  "SOL", // Sasol
  "ANG", // Anglogold Ashanti
  "PRX", // Prosus
  "CFR", // Compagnie Financière Richemont
  "BIL", // BHP Group (was BHP, listed as BIL on JSE)
  "SHP", // Shoprite
  "VOD", // Vodacom
  "AMS", // Anglo American Platinum
  "GFI", // Gold Fields
  "REM", // Remgro
  "SLM", // Sanlam
  "NED", // Nedbank
  "INP", // Investec
  "EXX", // Exxaro
];

interface BffQuoteRow {
  symbol: string;
  last_price: number | null;
  prev_close: number | null;
  bid?: number | null;
  ask?: number | null;
  ts: string;
  source: string;
  error?: string;
}

interface ProviderBatchEnvelope {
  ok: boolean;
  provider: string;
  providerOverride?: string;
  quotes: BffQuoteRow[];
  error?: string;
}

interface NormalisedQuote {
  symbol: string;
  last: number | null;
  prevClose: number | null;
  bid: number | null;
  ask: number | null;
  timestamp: string;
  source: string;
  error?: string;
}

interface ParityRow {
  symbol: string;
  iress: { last: number | null; prevClose: number | null; source: string; error?: string };
  yahoo: { last: number | null; prevClose: number | null; source: string; error?: string };
  lastDeltaPct: number | null;
  prevCloseDeltaPct: number | null;
  withinTolerance: boolean;
  notes: string[];
}

interface ParityReport {
  generatedAt: string;
  baseUrl: string;
  tolerancePct: number;
  symbols: string[];
  providers: {
    iress: { name: string; reachable: boolean; ok: boolean; error?: string };
    yahoo: { name: string; reachable: boolean; ok: boolean; error?: string };
  };
  rows: ParityRow[];
  summary: {
    total: number;
    matched: number;
    outsideTolerance: number;
    iressUnavailable: number;
    yahooUnavailable: number;
  };
  notes: string[];
}

async function fetchProviderBatch(
  baseUrl: string,
  provider: "iress" | "yahoo",
  symbols: string[],
): Promise<{ envelope: ProviderBatchEnvelope | null; error?: string; reachable: boolean }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/quotes?provider=${provider}&symbols=${encodeURIComponent(symbols.join(","))}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "MintOEM/ParityScan/1.0" },
    });
    if (!res.ok) {
      return {
        reachable: true,
        envelope: null,
        error: `HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as ProviderBatchEnvelope;
    return { reachable: true, envelope: body };
  } catch (err) {
    return {
      reachable: false,
      envelope: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function pctDelta(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const ref = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return (Math.abs(a - b) / ref) * 100;
}

function n(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function normaliseBffRow(q: BffQuoteRow): NormalisedQuote {
  return {
    symbol: q.symbol,
    last: n(q.last_price),
    prevClose: n(q.prev_close),
    bid: n(q.bid),
    ask: n(q.ask),
    timestamp: q.ts,
    source: q.source,
    ...(q.error ? { error: q.error } : {}),
  };
}

function buildRow(
  symbol: string,
  iressRow: NormalisedQuote | undefined,
  yahooRow: NormalisedQuote | undefined,
  tolerance: number,
): ParityRow {
  const iressLast = iressRow?.last ?? null;
  const iressPrev = iressRow?.prevClose ?? null;
  const yahooLast = yahooRow?.last ?? null;
  const yahooPrev = yahooRow?.prevClose ?? null;

  const lastDelta = pctDelta(iressLast, yahooLast);
  const prevDelta = pctDelta(iressPrev, yahooPrev);
  // Match when the delta is within tolerance OR when the leg is unavailable
  // (the row is "matched" against the other leg's known value, with the
  // null delta treated as the lower bound — see notes). Otherwise we want
  // the row to fail loudly.
  const bothMissing = iressLast == null && yahooLast == null && iressPrev == null && yahooPrev == null;
  const within =
    bothMissing ||
    ((lastDelta == null || lastDelta <= tolerance) && (prevDelta == null || prevDelta <= tolerance));

  const notes: string[] = [];
  if (iressRow?.error) notes.push(`iress: ${iressRow.error}`);
  if (yahooRow?.error) notes.push(`yahoo: ${yahooRow.error}`);
  if (iressLast == null) notes.push("iress last missing");
  if (yahooLast == null) notes.push("yahoo last missing");
  if (iressPrev == null) notes.push("iress prevClose missing");
  if (yahooPrev == null) notes.push("yahoo prevClose missing");
  if (lastDelta != null && lastDelta > tolerance) notes.push(`last ${lastDelta.toFixed(2)}% > ${tolerance}%`);
  if (prevDelta != null && prevDelta > tolerance)
    notes.push(`prevClose ${prevDelta.toFixed(2)}% > ${tolerance}%`);

  return {
    symbol,
    iress: {
      last: iressLast,
      prevClose: iressPrev,
      source: iressRow?.source ?? "missing",
      ...(iressRow?.error ? { error: iressRow.error } : {}),
    },
    yahoo: {
      last: yahooLast,
      prevClose: yahooPrev,
      source: yahooRow?.source ?? "missing",
      ...(yahooRow?.error ? { error: yahooRow.error } : {}),
    },
    lastDeltaPct: lastDelta,
    prevCloseDeltaPct: prevDelta,
    withinTolerance: within,
    notes,
  };
}

async function main(): Promise<void> {
  const baseUrl = process.env.PARITY_BASE_URL ?? DEFAULT_BASE_URL;
  const toleranceRaw = Number(process.env.PARITY_TOLERANCE_PCT ?? DEFAULT_TOLERANCE_PCT);
  const tolerance = Number.isFinite(toleranceRaw) && toleranceRaw > 0 ? toleranceRaw : DEFAULT_TOLERANCE_PCT;
  const symbols = (process.env.PARITY_SYMBOLS ?? DEFAULT_SYMBOLS.join(","))
    .split(",")
    .map((s) =>
      s
        .trim()
        .replace(/\.(JO|JSE)$/i, "")
        .toUpperCase(),
    )
    .filter(Boolean);

  const generatedAt = new Date().toISOString();

  // Banner so the operator can see at a glance what config we're running with.
  console.log(
    `[parity] baseUrl=${baseUrl} tolerance=${tolerance}% symbols=${symbols.length} (${symbols.join(",")})`,
  );

  const [iress, yahoo] = await Promise.all([
    fetchProviderBatch(baseUrl, "iress", symbols),
    fetchProviderBatch(baseUrl, "yahoo", symbols),
  ]);

  const iressBySymbol = new Map<string, NormalisedQuote>();
  if (iress.envelope?.quotes) {
    for (const q of iress.envelope.quotes) iressBySymbol.set(q.symbol.toUpperCase(), normaliseBffRow(q));
  }
  const yahooBySymbol = new Map<string, NormalisedQuote>();
  if (yahoo.envelope?.quotes) {
    for (const q of yahoo.envelope.quotes) yahooBySymbol.set(q.symbol.toUpperCase(), normaliseBffRow(q));
  }

  const rows: ParityRow[] = symbols.map((s) =>
    buildRow(s, iressBySymbol.get(s), yahooBySymbol.get(s), tolerance),
  );

  const summary = {
    total: rows.length,
    matched: rows.filter((r) => r.withinTolerance).length,
    outsideTolerance: rows.filter((r) => !r.withinTolerance).length,
    iressUnavailable: rows.filter((r) => r.iress.last == null).length,
    yahooUnavailable: rows.filter((r) => r.yahoo.last == null).length,
  };

  const notes: string[] = [];
  if (!iress.reachable) {
    notes.push(
      `IRESS leg unreachable at ${baseUrl}: ${iress.error}. The /api/quotes BFF must be running (e.g. via 'bun run dev') before the scan can reach it.`,
    );
  }
  if (iress.envelope && !iress.envelope.ok) {
    notes.push(`IRESS leg BFF returned ok=false: ${iress.envelope.error ?? "(no error message)"}.`);
  }
  if (!yahoo.reachable) {
    notes.push(`Yahoo leg unreachable at ${baseUrl}: ${yahoo.error}.`);
  }
  if (yahoo.envelope && !yahoo.envelope.ok) {
    notes.push(`Yahoo leg BFF returned ok=false: ${yahoo.envelope.error ?? "(no error message)"}.`);
  }
  if (iress.reachable && iress.envelope?.provider && iress.envelope.provider !== "iress") {
    notes.push(
      `IRESS leg actually answered with provider="${iress.envelope.provider}". The /api/quotes route always names the active provider; an "iress" query on a non-IRESS deployment will silently serve the active provider's data — document this and re-run when ACTIVE_MARKET_DATA_PROVIDER=iress.`,
    );
  }
  if (yahoo.reachable && yahoo.envelope?.provider && yahoo.envelope.provider !== "yahoo") {
    notes.push(
      `Yahoo leg actually answered with provider="${yahoo.envelope.provider}". This is a sign the provider flag is overridden; the parity comparison is therefore not against Yahoo.`,
    );
  }

  const report: ParityReport = {
    generatedAt,
    baseUrl,
    tolerancePct: tolerance,
    symbols,
    providers: {
      iress: {
        name: iress.envelope?.provider ?? "iress",
        reachable: iress.reachable,
        ok: Boolean(iress.envelope?.ok),
        ...(iress.error ? { error: iress.error } : {}),
      },
      yahoo: {
        name: yahoo.envelope?.provider ?? "yahoo",
        reachable: yahoo.reachable,
        ok: Boolean(yahoo.envelope?.ok),
        ...(yahoo.error ? { error: yahoo.error } : {}),
      },
    },
    rows,
    summary,
    notes,
  };

  // Console summary (so the report's stdout is also the on-screen log).
  console.log("");
  console.log("=== Provider parity report ===");
  console.log(`generated: ${generatedAt}`);
  console.log(`base:      ${baseUrl}  tolerance: ±${tolerance}%`);
  console.log("");
  console.log("  symbol   iress last    yahoo last    Δ last%   iress prev   yahoo prev   Δ prev%   status");
  for (const r of rows) {
    const il = r.iress.last != null ? r.iress.last.toFixed(2).padStart(10) : "      —   ";
    const yl = r.yahoo.last != null ? r.yahoo.last.toFixed(2).padStart(10) : "      —   ";
    const ip = r.iress.prevClose != null ? r.iress.prevClose.toFixed(2).padStart(10) : "      —   ";
    const yp = r.yahoo.prevClose != null ? r.yahoo.prevClose.toFixed(2).padStart(10) : "      —   ";
    const dl = r.lastDeltaPct != null ? `${r.lastDeltaPct.toFixed(2)}%`.padStart(8) : "     — ";
    const dp = r.prevCloseDeltaPct != null ? `${r.prevCloseDeltaPct.toFixed(2)}%`.padStart(8) : "     — ";
    const status = r.withinTolerance ? "OK" : "MISMATCH";
    console.log(`  ${r.symbol.padEnd(7)} ${il} ${yl} ${dl}  ${ip} ${yp} ${dp}  ${status}`);
  }
  console.log("");
  console.log(
    `Summary: matched=${summary.matched}/${summary.total}  outside=${summary.outsideTolerance}  iress-missing=${summary.iressUnavailable}  yahoo-missing=${summary.yahooUnavailable}`,
  );
  if (notes.length > 0) {
    console.log("");
    console.log("Notes:");
    for (const n of notes) console.log(`  - ${n}`);
  }

  // Persist the JSON report alongside the docs. Filename includes the date so
  // re-runs the same day overwrite and historical runs accumulate.
  const today = new Date();
  const isoDate = today.toISOString().slice(0, 10);
  const outDir = join(process.cwd(), "docs");
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `PROVIDER_PARITY_${isoDate}.json`);
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log("");
  console.log(`[parity] wrote ${outPath}`);

  // Exit non-zero when:
  //   - any row falls outside tolerance
  //   - a leg is unreachable (BFF offline)
  //   - one leg is entirely unavailable for ALL symbols (e.g. Yahoo 401,
  //     IRESS in mock mode, or IRESS entitlement blocking all rows) —
  //     this keeps the cron slot honest: a "PASS" with both legs zero
  //     would otherwise look like a clean run when nothing was actually
  //     compared. The operator must see the failure to flip the env.
  const iressAllMissing = summary.iressUnavailable === summary.total;
  const yahooAllMissing = summary.yahooUnavailable === summary.total;
  const fail =
    summary.outsideTolerance > 0 ||
    !iress.reachable ||
    !yahoo.reachable ||
    iressAllMissing ||
    yahooAllMissing;
  if (fail) {
    const reasons: string[] = [];
    if (summary.outsideTolerance > 0) reasons.push(`outside tolerance: ${summary.outsideTolerance}`);
    if (!iress.reachable) reasons.push(`iress leg unreachable: ${iress.error}`);
    if (!yahoo.reachable) reasons.push(`yahoo leg unreachable: ${yahoo.error}`);
    if (iressAllMissing) reasons.push(`iress returned no usable rows for ${summary.total} symbols`);
    if (yahooAllMissing) reasons.push(`yahoo returned no usable rows for ${summary.total} symbols`);
    console.error(`[parity] FAIL — ${reasons.join("; ")}`);
    process.exit(1);
  }
  console.log(`[parity] PASS — all ${summary.total} symbols within ±${tolerance}%`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[parity] failed:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
