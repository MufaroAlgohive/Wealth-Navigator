import {
  JSE_RATE_CODES,
  JSE_TRACKED_UNIVERSE,
  type UniverseEntry as SharedUniverseEntry,
} from "../../../src/lib/iress/universe";

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
  kind?: SharedUniverseEntry["kind"];
}

export interface WorkerEnv {
  workerId: string;
  iressMode: string;
  dryRun: boolean;
  allowWrites: boolean;
  /** UAT phase: IRESS_PRICE_OVERLAY=0 means IRESS returns TEST prices, so the
   *  worker must not write IRESS-sourced prices into any table a live consumer
   *  reads (quote_snapshot_c, securities_c via instrument-sync). True = UAT. */
  priceOverlayOff: boolean;
  heartbeatSec: number;
  quoteIntervalSec: number;
  orderPollIntervalSec: number;
  watchlistSymbols: string[];
  watchlistEntries: WatchlistEntry[];
  watchlistExchanges: Record<string, string>;
  instrumentSync: boolean;
  supabaseUrl: string;
  supabaseServiceKey: string;
  /** RETAIL prod (mfxng…) — shared price tables securities_c / stock_intraday_c. */
  retailSupabaseUrl: string;
  retailSupabaseKey: string;
  /** INSTITUTIONAL prod (nnwz…) — desk trading book + analytics + worker ops. */
  institutionalSupabaseUrl: string;
  institutionalSupabaseKey: string;
  iressAccountCode: string;
  /**
   * UAT phase (Mint OEM Finalisation): a separate broker AccountCode that the
   * worker uses when `uatMode=true`. Lets UAT users exercise the full order
   * pipeline against the MINT_CT IOS seat without touching real client books.
   * When unset and `uatMode=true`, the worker rejects `/uat/send-to-market` so
   * a missed config can never default to the production account.
   */
  uatAccountCode: string;
  /** When true, `/uat/send-to-market` + the UAT order poll loop are enabled. */
  uatMode: boolean;
  /** Cadence (seconds) of the UAT order-pad fill poll. Default 30. */
  uatOrderPollSec: number;
  applicationLabel: string;
  /** Default exchange passed to PricingQuoteGet (default "JSE"). */
  defaultExchange: string;
  /** Exchange for FX rate codes (default "FX"). */
  fxExchange: string;
  /** Exchange for money-market rate codes (default "MM"). */
  moneyMarketExchange: string;
  /**
   * `Server` argument passed to `ServiceSessionStart(Service="IPS", …)`.
   * Per the V4 docs the value is "environment-specific" — `IPSAPI` is
   * the common default but the SA prod-test build may use a different
   * identifier. Override with `IRESS_IPS_SERVER` once Charles confirms
   * the canonical value.
   */
  ipsServer: string;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  return value === "1" || value.toLowerCase() === "true";
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  const raw = (value ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
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
 * Sourced from `src/lib/iress/universe.ts` so the worker and the Next.js
 * UI always quote the same 10-name JSE equity baseline + 2 rate codes
 * (12 total). The operator can override the symbol set at runtime with
 * `IRESS_WATCHLIST_SYMBOLS` and the per-symbol exchange with
 * `IRESS_WATCHLIST_EXCHANGES` — the env wins, but the module is the
 * resting state.
 */
const DEFAULT_WATCHLIST: WatchlistEntry[] = [
  ...JSE_TRACKED_UNIVERSE.map<WatchlistEntry>((e) => ({
    symbol: e.symbol,
    kind: e.kind,
  })),
  ...JSE_RATE_CODES.map<WatchlistEntry>((e) => ({
    symbol: e.symbol,
    kind: e.kind,
    exchange: e.kind === "fx" ? "FX" : "MM",
  })),
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
  // 3-DB topology (docs/DB_TOPOLOGY_DECISION.md): prices → RETAIL prod (mfxng…),
  // everything else → INSTITUTIONAL prod (nnwz…). Both fall back to the legacy
  // single pair, so behaviour is unchanged until the split vars are set on Railway.
  const institutionalSupabaseUrl = process.env.INSTITUTIONAL_SUPABASE_URL ?? supabaseUrl;
  const institutionalSupabaseKey = process.env.INSTITUTIONAL_SUPABASE_SERVICE_ROLE_KEY ?? supabaseServiceKey;
  const retailSupabaseUrl = process.env.RETAIL_SUPABASE_URL ?? supabaseUrl;
  const retailSupabaseKey = process.env.RETAIL_SUPABASE_SERVICE_ROLE_KEY ?? supabaseServiceKey;
  const defaultExchange = (process.env.IRESS_DEFAULT_EXCHANGE ?? "JSE").toUpperCase().trim();
  const fxExchange = (process.env.IRESS_FX_EXCHANGE ?? "FX").toUpperCase().trim();
  const mmExchange = (process.env.IRESS_MM_EXCHANGE ?? "MM").toUpperCase().trim();

  // Build entries. If the user pinned `IRESS_WATCHLIST_SYMBOLS`, honour the
  // comma list verbatim and apply kind defaults based on the symbol string.
  // The per-symbol exchange map always wins over the kind default.
  const overridesRaw = process.env.IRESS_WATCHLIST_SYMBOLS;
  const baseEntries: WatchlistEntry[] = (() => {
    if (!overridesRaw) return DEFAULT_WATCHLIST;
    const list = parseList(
      overridesRaw,
      DEFAULT_WATCHLIST.map((e) => e.symbol),
    );
    return list.map<WatchlistEntry>((sym) => {
      const def = DEFAULT_WATCHLIST.find((d) => d.symbol === sym);
      return def ?? { symbol: sym, kind: "equity" };
    });
  })();
  const exchangesFromEnv = parseExchangeMap(process.env.IRESS_WATCHLIST_EXCHANGES);
  const entries: WatchlistEntry[] = baseEntries.map((e) => {
    const overrideExchange = exchangesFromEnv[e.symbol];
    const kindExchange = e.kind === "fx" ? fxExchange : e.kind === "mm" ? mmExchange : undefined;
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
    priceOverlayOff: process.env.IRESS_PRICE_OVERLAY === "0",
    heartbeatSec: Number(process.env.IRESS_WORKER_HEARTBEAT_SEC ?? "30"),
    quoteIntervalSec: Number(process.env.IRESS_WORKER_QUOTE_INTERVAL_SEC ?? "15"),
    orderPollIntervalSec: Number(process.env.IRESS_WORKER_ORDER_POLL_SEC ?? "60"),
    watchlistSymbols: symbols,
    watchlistEntries: entries,
    watchlistExchanges: exchanges,
    instrumentSync: parseBool(process.env.IRESS_WORKER_INSTRUMENT_SYNC, false),
    supabaseUrl,
    supabaseServiceKey,
    retailSupabaseUrl,
    retailSupabaseKey,
    institutionalSupabaseUrl,
    institutionalSupabaseKey,
    iressAccountCode: process.env.IRESS_ACCOUNT_CODE ?? "",
    // UAT mode: when IRESS_UAT_MODE=1, the worker accepts /uat/send-to-market
    // and the UAT order poll loop. Orders tagged uat_test=true go to the UAT
    // account. On a prod deployment this should be a SEPARATE account from
    // IRESS_ACCOUNT_CODE; on the CT test endpoint (webservices-ct) the whole
    // environment is UAT, so it defaults to the trading account when unset.
    uatAccountCode: process.env.IRESS_UAT_ACCOUNT_CODE?.trim() || process.env.IRESS_ACCOUNT_CODE || "",
    uatMode: parseBool(process.env.IRESS_UAT_MODE, false),
    uatOrderPollSec: Math.max(5, Number(process.env.IRESS_UAT_ORDER_POLL_SEC ?? "30")),
    applicationLabel: process.env.IRESS_APPLICATION_LABEL ?? "Mint-OEMS-Worker",
    defaultExchange: defaultExchange || "JSE",
    fxExchange: fxExchange || "FX",
    moneyMarketExchange: mmExchange || "MM",
    ipsServer: (process.env.IRESS_IPS_SERVER ?? "IPSAPI").trim() || "IPSAPI",
  };
}
