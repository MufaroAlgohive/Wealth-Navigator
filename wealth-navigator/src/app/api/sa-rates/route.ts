/**
 * GET /api/sa-rates
 *
 * Official South African rates + macro from the SARB public Web API
 * (HomePageRates — free JSON, no key). IRESS V4 on DFM@MINT has no rates/macro
 * feed, so this is the "real alternative source" for the Money Market, Macro,
 * and rate-KPI modules: SARB policy (repo) rate, prime, ZARONIA, Sabor, CPI,
 * PPI, and the official ZAR exchange rates.
 *
 * Server-side fetch + a shared five-minute cache. SARB publishes most values
 * daily (CPI/PPI monthly), so this stays current without hammering upstream.
 * Observation time and OEM fetch time are returned separately.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SarbRate {
  Name?: string;
  SectionName?: string;
  TimeseriesCode?: string;
  Value?: number;
  Date?: string;
}

type Freshness = "current" | "delayed" | "stale" | "unavailable";

interface Indicator {
  label: string;
  value: number | null;
  asOf: string | null;
  code: string | null;
  freshness: Freshness;
  ageDays: number | null;
}

const SARB_URL = "https://custom.resbank.co.za/SarbWebApi/WebIndicators/HomePageRates";
const DAILY_CODES = new Set([
  "MMRD002A",
  "MMRD000A",
  "MMRD855A",
  "MMRD851A",
  "EXCX135D",
  "EXCZ001D",
  "EXCZ002D",
  "EER4504A",
]);

export function ageInCalendarDays(asOf: string | null, now: Date): number | null {
  if (!asOf) return null;
  const observed = new Date(`${asOf.slice(0, 10)}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(observed)) return null;
  return Math.max(0, Math.floor((now.getTime() - observed) / 86_400_000));
}

export function classifyFreshness(
  code: string | null,
  asOf: string | null,
  now: Date,
): Pick<Indicator, "freshness" | "ageDays"> {
  const ageDays = ageInCalendarDays(asOf, now);
  if (ageDays == null) return { freshness: "unavailable", ageDays: null };
  if (code && DAILY_CODES.has(code)) {
    return { freshness: ageDays <= 4 ? "current" : ageDays <= 7 ? "delayed" : "stale", ageDays };
  }
  return { freshness: ageDays <= 45 ? "current" : ageDays <= 75 ? "delayed" : "stale", ageDays };
}

export async function GET() {
  const fetchedAt = new Date();
  let rows: SarbRate[];
  try {
    const r = await fetch(SARB_URL, {
      next: { revalidate: 300 },
      headers: { Accept: "application/json", "User-Agent": "MintOEM/SA-Rates/1.0" },
    });
    if (!r.ok) throw new Error(`sarb ${r.status}`);
    rows = (await r.json()) as SarbRate[];
    if (!Array.isArray(rows)) throw new Error("sarb invalid response");
  } catch (err) {
    return Response.json(
      {
        source: "unavailable",
        fetchedAt: fetchedAt.toISOString(),
        error: err instanceof Error ? err.message : String(err),
        message: "SARB Web API unreachable.",
      },
      { status: 200 },
    );
  }

  // Match by code first (stable), then by name substring.
  const find = (codes: string[], nameRe: RegExp): Indicator | null => {
    const row = rows.find((x) => (x.TimeseriesCode && codes.includes(x.TimeseriesCode)) || (x.Name && nameRe.test(x.Name)));
    if (!row || row.Value == null) return null;
    const code = row.TimeseriesCode ?? null;
    const asOf = row.Date ?? null;
    return {
      label: row.Name ?? "",
      value: Number(row.Value),
      asOf,
      code,
      ...classifyFreshness(code, asOf, fetchedAt),
    };
  };

  const rates = {
    repo: find(["MMRD002A"], /policy rate|repo/i),
    prime: find(["MMRD000A"], /prime/i),
    zaronia: find(["MMRD855A"], /zaronia/i),
    sabor: find(["MMRD851A"], /sabor/i),
    cpi: find(["CPI1000F"], /^cpi\b/i),
    ppi: find(["PPI1000F"], /^ppi\b/i),
    usdzar: find(["EXCX135D"], /rand per us dollar/i),
    gbpzar: find(["EXCZ001D"], /rand per british pound/i),
    eurzar: find(["EXCZ002D"], /rand per euro/i),
    neer: find(["EER4504A"], /nominal effective/i),
  };

  const anyValue = Object.values(rates).some((v) => v && v.value != null);
  return Response.json({
    source: anyValue ? "sarb" : "unavailable",
    sourceLabel: "SARB (resbank.co.za)",
    fetchedAt: fetchedAt.toISOString(),
    refreshSeconds: 300,
    rates,
    asOf: rates.repo?.asOf ?? rates.zaronia?.asOf ?? null,
  });
}
