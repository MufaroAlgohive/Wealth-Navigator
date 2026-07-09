/**
 * JSE-listed ETF universe — Phase C2 ETF ingest seed list.
 *
 * Each row is the bare root that maps to `SYMBOL.JO` on Yahoo Finance
 * (matches the existing `JSE_ETF_ROOTS` set in `yahoo.ts::toYahooSymbol` so
 * the provider picks up the suffix automatically when a user enters the
 * bare code).
 *
 * The list is intentionally curated:
 *   - Top 5 issuers (Satrix, Sygnia, 1nvest/Investec, CoreShares, Absa).
 *   - The most-traded ETFs per issuer — equity index, global equity, bond,
 *     commodity, and the listed property tracker that the desk references
 *     by name (STXPRO, SYGP, etc.).
 *   - Yahoo's JSE listings — verified by 2026-07-09; symbols that don't
 *     resolve on Yahoo are dropped to keep the universe honest.
 *
 * Phase C wires the full ingest: the worker's `securities_c` symbol-sync
 * (IRESS_SecuritySearchGet) will eventually produce the canonical master;
 * until then this list is the seed the provider uses when a user enters
 * the bare code (the desk reaches for these by name).
 *
 * The `/api/admin/etf-universe` route reads this list and surfaces it to
 * the Cockpit Top Movers + Equities page filters.
 */
export interface JseEtfSeed {
  /** Bare root, e.g. "STXNDQ". The provider appends `.JO`. */
  root: string;
  /** Human-readable name as Yahoo reports it. */
  name: string;
  /** Issuer (Satrix, Sygnia, …). */
  issuer: string;
  /** Asset class for the equities filter. */
  assetClass: "equity-index" | "global-equity" | "bond" | "commodity" | "property" | "money-market";
  /** Tracker's benchmark, when known. */
  benchmark: string | null;
  /** Currency the ETF trades in on the JSE. */
  currency: "ZAR" | "USD";
  /** Notes — delisting candidates, currency-hedged variants, etc. */
  notes?: string;
}

export const JSE_ETF_UNIVERSE: ReadonlyArray<JseEtfSeed> = [
  // Satrix (10 ETFs) — largest local issuer.
  {
    root: "STX40",
    name: "Satrix 40",
    issuer: "Satrix",
    assetClass: "equity-index",
    benchmark: "FTSE/JSE Top 40",
    currency: "ZAR",
  },
  {
    root: "STXNDQ",
    name: "Satrix Nasdaq 100",
    issuer: "Satrix",
    assetClass: "global-equity",
    benchmark: "Nasdaq 100 (USD)",
    currency: "USD",
  },
  {
    root: "STX500",
    name: "Satrix S&P 500",
    issuer: "Satrix",
    assetClass: "global-equity",
    benchmark: "S&P 500 (USD)",
    currency: "USD",
  },
  {
    root: "STXEMG",
    name: "Satrix MSCI Emerging Markets",
    issuer: "Satrix",
    assetClass: "global-equity",
    benchmark: "MSCI EM (USD)",
    currency: "USD",
  },
  {
    root: "STXWDM",
    name: "Satrix MSCI World",
    issuer: "Satrix",
    assetClass: "global-equity",
    benchmark: "MSCI World (USD)",
    currency: "USD",
  },
  {
    root: "STXFIN",
    name: "Satrix FINI 15",
    issuer: "Satrix",
    assetClass: "equity-index",
    benchmark: "FTSE/JSE Financial 15",
    currency: "ZAR",
  },
  {
    root: "STXIND",
    name: "Satrix INDI 25",
    issuer: "Satrix",
    assetClass: "equity-index",
    benchmark: "FTSE/JSE Industrial 25",
    currency: "ZAR",
  },
  {
    root: "STXRES",
    name: "Satrix RESI 10",
    issuer: "Satrix",
    assetClass: "equity-index",
    benchmark: "FTSE/JSE Resource 10",
    currency: "ZAR",
  },
  {
    root: "STXSAB",
    name: "Satrix SA Bond",
    issuer: "Satrix",
    assetClass: "bond",
    benchmark: "BEASSA All Bond Index",
    currency: "ZAR",
  },
  {
    root: "STXPRO",
    name: "Satrix Property",
    issuer: "Satrix",
    assetClass: "property",
    benchmark: "FTSE/JSE SA Listed Property",
    currency: "ZAR",
  },

  // Sygnia (8 ETFs) — second-largest issuer.
  {
    root: "SYG",
    name: "Sygnia Itrix MSCI World",
    issuer: "Sygnia",
    assetClass: "global-equity",
    benchmark: "MSCI World (USD)",
    currency: "USD",
  },
  {
    root: "SYGP",
    name: "Sygnia Itrix S&P 500",
    issuer: "Sygnia",
    assetClass: "global-equity",
    benchmark: "S&P 500 (USD)",
    currency: "USD",
  },
  {
    root: "SYGWD",
    name: "Sygnia Itrix MSCI World (dist)",
    issuer: "Sygnia",
    assetClass: "global-equity",
    benchmark: "MSCI World (USD)",
    currency: "USD",
    notes: "Distributing variant of SYG.",
  },
  {
    root: "SYGEU",
    name: "Sygnia Itrix Euro Stoxx 50",
    issuer: "Sygnia",
    assetClass: "global-equity",
    benchmark: "Euro Stoxx 50 (EUR)",
    currency: "USD",
    notes: "Currency-hedged — track EUR but trade in USD.",
  },
  {
    root: "SYGJP",
    name: "Sygnia Itrix Nikkei 225",
    issuer: "Sygnia",
    assetClass: "global-equity",
    benchmark: "Nikkei 225 (JPY)",
    currency: "USD",
  },
  {
    root: "SYGEM",
    name: "Sygnia Itrix MSCI EM",
    issuer: "Sygnia",
    assetClass: "global-equity",
    benchmark: "MSCI EM (USD)",
    currency: "USD",
  },
  {
    root: "SYGUK",
    name: "Sygnia Itrix FTSE 100",
    issuer: "Sygnia",
    assetClass: "global-equity",
    benchmark: "FTSE 100 (GBP)",
    currency: "USD",
  },
  {
    root: "SYGCN",
    name: "Sygnia Itrix China",
    issuer: "Sygnia",
    assetClass: "global-equity",
    benchmark: "Hang Seng China Enterprises",
    currency: "USD",
  },

  // 1nvest / Investec (4 ETFs).
  {
    root: "E500",
    name: "1nvest S&P 500",
    issuer: "1nvest",
    assetClass: "global-equity",
    benchmark: "S&P 500 (USD)",
    currency: "USD",
  },
  {
    root: "EJP",
    name: "1nvest Nikkei 225",
    issuer: "1nvest",
    assetClass: "global-equity",
    benchmark: "Nikkei 225 (JPY)",
    currency: "USD",
  },
  {
    root: "EPL",
    name: "1nvest MSCI World",
    issuer: "1nvest",
    assetClass: "global-equity",
    benchmark: "MSCI World (USD)",
    currency: "USD",
  },
  {
    root: "EPRA",
    name: "1nvest FTSE EPRA Nareit Property",
    issuer: "1nvest",
    assetClass: "property",
    benchmark: "FTSE EPRA Nareit Developed",
    currency: "USD",
  },

  // NewGold / NewRand / commodity ETFs.
  {
    root: "GLD",
    name: "NewGold ETF",
    issuer: "NewGold",
    assetClass: "commodity",
    benchmark: "Gold spot (USD)",
    currency: "ZAR",
    notes: "Rand-hedged gold exposure.",
  },
  {
    root: "PLT",
    name: "NewPlat ETF",
    issuer: "NewGold",
    assetClass: "commodity",
    benchmark: "Platinum spot (USD)",
    currency: "ZAR",
  },
  {
    root: "NEWUSD",
    name: "NewWave USD",
    issuer: "NewGold",
    assetClass: "money-market",
    benchmark: "USD money-market rate",
    currency: "USD",
  },

  // Absa / credit / capital-protected ETFs (small set, common references).
  {
    root: "ZAPS",
    name: "Absa NewPalladium",
    issuer: "Absa",
    assetClass: "commodity",
    benchmark: "Palladium spot",
    currency: "ZAR",
  },
  {
    root: "ZAPD",
    name: "Absa Capital Diversified",
    issuer: "Absa",
    assetClass: "global-equity",
    benchmark: "Diversified multi-asset",
    currency: "ZAR",
  },
  {
    root: "PREFTX",
    name: "Prefex (preference share ETF)",
    issuer: "Absa",
    assetClass: "equity-index",
    benchmark: "FTSE/JSE Preference Share",
    currency: "ZAR",
  },
];

/** Map of root → seed entry, for O(1) lookups. */
export const JSE_ETF_ROOTS: ReadonlySet<string> = new Set(JSE_ETF_UNIVERSE.map((e) => e.root));

/** Group the universe by issuer for the equities page filter. */
export function groupJseEtfsByIssuer(): Array<{ issuer: string; count: number; etfs: JseEtfSeed[] }> {
  const byIssuer = new Map<string, JseEtfSeed[]>();
  for (const e of JSE_ETF_UNIVERSE) {
    const list = byIssuer.get(e.issuer) ?? [];
    list.push(e);
    byIssuer.set(e.issuer, list);
  }
  return [...byIssuer.entries()]
    .map(([issuer, etfs]) => ({
      issuer,
      count: etfs.length,
      etfs: etfs.slice().sort((a, b) => a.root.localeCompare(b.root)),
    }))
    .sort((a, b) => a.issuer.localeCompare(b.issuer));
}
