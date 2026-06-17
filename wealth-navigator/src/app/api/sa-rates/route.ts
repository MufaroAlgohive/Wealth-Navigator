/**
 * GET /api/sa-rates
 *
 * Official South African rates + macro from the SARB public Web API
 * (HomePageRates — free JSON, no key). IRESS V4 on DFM@MINT has no rates/macro
 * feed, so this is the "real alternative source" for the Money Market, Macro,
 * and rate-KPI modules: SARB policy (repo) rate, prime, ZARONIA, Sabor, CPI,
 * PPI, and the official ZAR exchange rates.
 *
 * Server-side fetch + Next data cache (1h — SARB publishes ~daily). Each value
 * carries SARB's own observation date so the UI can show "as of".
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

interface Indicator { label: string; value: number | null; asOf: string | null; code: string | null }

const SARB_URL = "https://custom.resbank.co.za/SarbWebApi/WebIndicators/HomePageRates";

export async function GET() {
  let rows: SarbRate[];
  try {
    const r = await fetch(SARB_URL, { next: { revalidate: 3600 }, headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`sarb ${r.status}`);
    rows = (await r.json()) as SarbRate[];
  } catch (err) {
    return Response.json(
      { source: "unavailable", error: err instanceof Error ? err.message : String(err), message: "SARB Web API unreachable." },
      { status: 200 },
    );
  }

  // Match by code first (stable), then by name substring.
  const find = (codes: string[], nameRe: RegExp): Indicator | null => {
    const row = rows.find((x) => (x.TimeseriesCode && codes.includes(x.TimeseriesCode)) || (x.Name && nameRe.test(x.Name)));
    if (!row || row.Value == null) return null;
    return { label: row.Name ?? "", value: Number(row.Value), asOf: row.Date ?? null, code: row.TimeseriesCode ?? null };
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
    rates,
    asOf: rates.repo?.asOf ?? rates.zaronia?.asOf ?? null,
  });
}
