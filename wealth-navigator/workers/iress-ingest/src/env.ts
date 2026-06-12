/**
 * A symbol on the worker watchlist. `exchange` lets us mix JSE equities with
 * rate codes on a vendor-specific exchange (e.g. "FX" for cross-currency
 * pairs, "MM" for money-market rates) without forcing every watchlist entry
 * to declare its own. Defaults to `defaultExchange` when omitted.
 */
export interface WatchlistEntry {
  symbol: string;
  /** Optional per-symbol exchange override. */
  exchange?: string;
  /**
   * Semantic kind — used by the BFF / UI to render the row in the right
   * place (equity tile, FX rate, MM rate, etc.) when the symbol's IRESS
   * code is opaque. Pure metadata; the worker doesn't branch on it.
   */
  kind?: "equity" | "fx" | "money-market" | "index" | "sector" | "bond";
}

export interface WorkerEnv {
  workerId: string;
  iressMode: string;
  dryRun: boolean;
  allowWrites: boolean;
  heartbeatSec: number;
  quoteIntervalSec: number;
  orderPollIntervalSec: number;
  watchlistSymbols: string[];
  watchlistEntries: WatchlistEntry[];
  watchlistExchanges: Record<string, string>;
  instrumentSync: boolean;
  supabaseUrl: string;
  supabaseServiceKey: string;
  iressAccountCode: string;
  applicationLabel: string;
  /** Default exchange passed to PricingQuoteGet (default "JSE"). */
  defaultExchange: string;
  /** Exchange for FX rate codes (default "FX"). */
  fxExchange: string;
  /** Exchange for money-market rate codes (default "MM"). */
  moneyMarketExchange: string;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  return value === "1" || value.toLowerCase() === "true";
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  const raw = (value ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  return raw.length > 0 ? raw : fallback;
}

/**
 * Parse a JSON-style overrides map. Supports:
 *   - "USDZAR=FX,JIBAR_3M=MM"
 *   - "USDZAR:FX,JIBAR_3M:MM"
 *   - "USDZAR FX,JIBAR_3M MM"
 * Anything not parseable as `SYM=EXCHANGE` is silently dropped.
 */
function parseExchangeMap(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const out: Record<string, string> = {};
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^([A-Z0-9._-]+)\s*[:=]\s*([A-Z0-9_]+)$/i);
    if (!m || !m[1] || !m[2]) continue;
    out[m[1].toUpperCase()] = m[2].toUpperCase();
  }
  return out;
}

/**
 * Default watchlist for a production deploy.
 *
 * - 20-name JSE Top-40 subset (matches what the Cockpit quotes tile
 *   polls with `useLiveQuotes`).
 * - `USDZAR` cross-currency rate (IRESS reference-data; exchange `FX`).
 * - `JIBAR_3M` 3-month Johannesburg Interbank Agreed Rate (IRESS
 *   reference-data; exchange `MM` for money-market).
 *
 * Both `USDZAR` and `JIBAR_3M` are real IRESS code strings the worker can
 * call `PricingQuoteGet` on; the vendor maps them to the correct
 * rate-feed behind the scenes. We do NOT need `TimeSeriesGet2` for the
 * L1 spot fix — that's only needed for EOD history (curves, ALSI
 * intraday), which is a Tier 2 wiring item.
 *
 * The user can override this list with `IRESS_WATCHLIST_SYMBOLS` and
 * the per-symbol exchange with `IRESS_WATCHLIST_EXCHANGES`.
 */
const DEFAULT_WATCHLIST: WatchlistEntry[] = [
  { symbol: "NPN", kind: "equity" },
  { symbol: "PRX", kind: "equity" },
  { symbol: "FSR", kind: "equity" },
  { symbol: "SBK", kind: "equity" },
  { symbol: "AGL", kind: "equity" },
  { symbol: "BHG", kind: "equity" },
  { symbol: "MTN", kind: "equity" },
  { symbol: "SOL", kind: "equity" },
  { symbol: "SHP", kind: "equity" },
  { symbol: "CPI", kind: "equity" },
  { symbol: "REM", kind: "equity" },
  { symbol: "BID", kind: "equity" },
  { symbol: "ABG", kind: "equity" },
  { symbol: "SLM", kind: "equity" },
  { symbol: "AMS", kind: "equity" },
  { symbol: "WHL", kind: "equity" },
  { symbol: "TBS", kind: "equity" },
  { symbol: "GRT", kind: "equity" },
  { symbol: "CLS", kind: "equity" },
  { symbol: "MNP", kind: "equity" },
  { symbol: "USDZAR", kind: "fx", exchange: "FX" },
  { symbol: "JIBAR_3M", kind: "money-market", exchange: "MM" },
];

/**
 * `IRESS_FORCE_KICK_ALL=1` — optional Railway recovery flag. Retries `IRESSSessionStart`
 * with `SessionNumberToKick=-1` after 25008. Set only for first deploy / orphan recovery,
 * then unset. The worker also auto-kicks on first-boot 25008 when no `iress_session_key`
 * exists in `worker_session_metadata`.
 */
export function loadWorkerEnv(): WorkerEnv {
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const defaultExchange = (process.env.IRESS_DEFAULT_EXCHANGE ?? "JSE").toUpperCase().trim();
  const fxExchange = (process.env.IRESS_FX_EXCHANGE ?? "FX").toUpperCase().trim();
  const mmExchange = (process.env.IRESS_MM_EXCHANGE ?? "MM").toUpperCase().trim();

  // Build entries. If the user pinned `IRESS_WATCHLIST_SYMBOLS`, honour the
  // comma list verbatim and apply kind defaults based on the symbol string.
  // The per-symbol exchange map always wins over the kind default.
  const overridesRaw = process.env.IRESS_WATCHLIST_SYMBOLS;
  const baseEntries: WatchlistEntry[] = (() => {
    if (!overridesRaw) return DEFAULT_WATCHLIST;
    const list = parseList(overridesRaw, DEFAULT_WATCHLIST.map((e) => e.symbol));
    return list.map<WatchlistEntry>((sym) => {
      const def = DEFAULT_WATCHLIST.find((d) => d.symbol === sym);
      return def ?? { symbol: sym, kind: "equity" };
    });
  })();
  const exchangesFromEnv = parseExchangeMap(process.env.IRESS_WATCHLIST_EXCHANGES);
  const entries: WatchlistEntry[] = baseEntries.map((e) => {
    const overrideExchange = exchangesFromEnv[e.symbol];
    const kindExchange = e.kind === "fx" ? fxExchange : e.kind === "money-market" ? mmExchange : undefined;
    const exchange = overrideExchange ?? e.exchange ?? kindExchange;
    return { ...e, exchange };
  });
  const exchanges: Record<string, string> = {};
  for (const e of entries) {
    if (e.exchange) exchanges[e.symbol] = e.exchange;
  }
  const symbols = entries.map((e) => e.symbol);

  return {
    workerId: process.env.WORKER_ID ?? "iress-ingest-1",
    iressMode: process.env.IRESS_MODE ?? "mock",
    dryRun: parseBool(process.env.IRESS_WORKER_DRY_RUN, true),
    allowWrites: parseBool(process.env.SUPABASE_ALLOW_WRITES, false),
    heartbeatSec: Number(process.env.IRESS_WORKER_HEARTBEAT_SEC ?? "30"),
    quoteIntervalSec: Number(process.env.IRESS_WORKER_QUOTE_INTERVAL_SEC ?? "15"),
    orderPollIntervalSec: Number(process.env.IRESS_WORKER_ORDER_POLL_SEC ?? "60"),
    watchlistSymbols: symbols,
    watchlistEntries: entries,
    watchlistExchanges: exchanges,
    instrumentSync: parseBool(process.env.IRESS_WORKER_INSTRUMENT_SYNC, false),
    supabaseUrl,
    supabaseServiceKey,
    iressAccountCode: process.env.IRESS_ACCOUNT_CODE ?? "",
    applicationLabel: process.env.IRESS_APPLICATION_LABEL ?? "Mint-OEMS-Worker",
    defaultExchange: defaultExchange || "JSE",
    fxExchange: fxExchange || "FX",
    moneyMarketExchange: mmExchange || "MM",
  };
}
