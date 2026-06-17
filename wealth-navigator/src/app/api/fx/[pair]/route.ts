/**
 * GET /api/fx/[pair]   e.g. /api/fx/USDZAR
 *
 * Real FX rates from Frankfurter (ECB reference rates — free, no key). IRESS
 * V4 on the DFM@MINT account has no FX feed (confirmed: USDZAR resolves to no
 * DataSource), so this is the "real alternative source" for the FX module.
 *
 * Returns spot + 1-day change + ~30 trading-day history (for a sparkline).
 * Cached for an hour via the Next data cache (ECB publishes once per business
 * day, ~16:00 CET), so this never hammers the upstream.
 *
 * `pair` is a 6-letter code: first 3 = base, last 3 = quote (default USDZAR).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FrankfurterRange {
  base: string;
  start_date: string;
  end_date: string;
  rates: Record<string, Record<string, number>>;
}

export async function GET(_req: Request, { params }: { params: Promise<{ pair: string }> }) {
  const { pair: rawPair } = await params;
  const pair = (rawPair || "USDZAR").toUpperCase().replace(/[^A-Z]/g, "");
  if (pair.length !== 6) {
    return Response.json({ error: "pair must be 6 letters, e.g. USDZAR" }, { status: 400 });
  }
  const base = pair.slice(0, 3);
  const quote = pair.slice(3);

  // ~45 calendar days back to guarantee ≥2 business days even across long breaks.
  const end = new Date();
  const start = new Date(end.getTime() - 45 * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const url = `https://api.frankfurter.dev/v1/${iso(start)}..${iso(end)}?base=${base}&symbols=${quote}`;

  let data: FrankfurterRange;
  try {
    const r = await fetch(url, { next: { revalidate: 3600 } });
    if (!r.ok) throw new Error(`frankfurter ${r.status}`);
    data = (await r.json()) as FrankfurterRange;
  } catch (err) {
    return Response.json(
      { pair, rate: null, source: "unavailable", error: err instanceof Error ? err.message : String(err) },
      { status: 200 },
    );
  }

  const dates = Object.keys(data.rates ?? {}).sort();
  const series = dates
    .map((d) => ({ t: Date.parse(d), v: data.rates[d]?.[quote] ?? null }))
    .filter((p): p is { t: number; v: number } => p.v != null);
  if (series.length === 0) {
    return Response.json({ pair, base, quote, rate: null, source: "unavailable", reason: "no_data" });
  }

  const spot = series[series.length - 1]!.v;
  const prev = series.length > 1 ? series[series.length - 2]!.v : spot;
  const change = Number((spot - prev).toFixed(4));
  const changePct = prev ? Number(((change / prev) * 100).toFixed(2)) : 0;

  return Response.json({
    pair,
    base,
    quote,
    rate: spot,
    prev,
    change,
    changePct,
    asOf: series[series.length - 1]!.t,
    history: series.slice(-30),
    source: "frankfurter",
    sourceLabel: "ECB / Frankfurter",
  });
}
