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
  /** OrderPadGetByAccount OrderFilter. See the note beside the parse below. */
  iressOrderFilter: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /**
   * Push executed fills into the RETAIL database — debit/credit
   * `wallets.balance` and write `stock_holdings_c` lots. Default OFF: this is
   * the only worker path that moves client money, so it must be turned on
   * deliberately, never inherited from a generic write flag.
   */
  retailSettlementEnabled: boolean;
  /**
   * Default ON whenever settlement is enabled. Computes and logs the exact
   * per-order deltas (wallet before/after, lots opened/closed) and writes
   * nothing — so the real effect on live client data can be read off the logs
   * before a single balance moves. Set RETAIL_SETTLEMENT_DRY_RUN=0 to arm it.
   */
  retailSettlementDryRun: boolean;
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
  /** Cadence (seconds) of the research-trigger alert evaluator. Default 60. */
  alertEvalSec: number;
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
  /**
   * Per-loop pilot-write gate for the SENS / news ingest loop. Defaults to
   * `dryRun=true / allowWrites=false` so the worker-wide posture
   * (`IRESS_WORKER_DRY_RUN=1` + `SUPABASE_ALLOW_WRITES=0` for production)
   * is the resting state — only an explicit `IRESS_NEWS_DRY_RUN=0`
   * + `IRESS_NEWS_ALLOW_WRITES=1` on the prod worker unlocks
   * `news_item_c` writes, with the rest of the worker (quotes / orders /
   * IPS / retail) staying dry-run exactly as `AGENTS.md` requires.
   *
   * Single-seat (2026-08-07): the news loop uses the SAME coordinator
   * session as orders and market data. The base URL the news loop
   * targets is `IRESS_MARKETDATA_BASE_URL` (defaulting to the prod
   * endpoint) — set this on the prod worker so `NewsHeadlineGet` and
   * `NewsVendorGet` hit `webservices.iress.co.za/v4`. There is no
   * longer a separate `IRESS_MARKET_DATA_PROD` switch; the prod
   * worker is the prod endpoint by default.
   */
  newsDryRun: boolean;
  /** Per-loop opt-in for writes to `news_item_c`. Default `false`. */
  newsAllowWrites: boolean;
  /**
   * Vendor code passed to `NewsHeadlineGet`. Defaults to `"SENSD"`
   * (delayed) — the prod seat is entitled to `SENSD` only;
   * `SENS` real-time is not on the prod entitlement. The CT/UAT
   * worker still defaults to `SENS` for the same shape it has
   * always used. The loop auto-falls-back to `SENSD` on 25010 /
   * 25018 with `payload.scope.vendor_fallback=true`. Override per
   * deployment with `IRESS_NEWS_VENDOR` if a non-SENS vendor is
   * the target (e.g. `IRDN`, `JSEN`).
   */
  newsVendorCode: string;
  /**
   * Per-loop maximum rows. The CT build returned 894 in a single
   * `NewsHeadlineGet` trading-day window with `Count=1000` (Andre
   * capture 2026-07-22), so 500 is below real load. `2000` floors at
   * 500 so a typo can't under-size the loop. The paging loop in
   * `news-ingest.ts` handles the >pageSize case via `PagingBookmark`
   * up to a 5-page cap.
   */
  newsMaxRows: number;
}

/* OrderFilter. We do NOT have an authoritative meaning for these values. This
   repo carried two mutually inconsistent guesses — client.ts said
   "3=all, 4=inactive, 5=active" while http-api.ts said
   "3=ALL, 4=AMENDED, 5=HISTORICAL" — and neither was sourced from IRESS.
   Andre Pietersen (IRESS) ran OrderPadGetByAccount against our production
   account 43448 on 2026-07-27 using OrderFilter=7, a value outside both
   guesses, which strongly suggests a bitmask rather than an enum
   (1|2|4 = 7 = everything) and means our long-standing "3 = ALL" comment is
   probably wrong.

   This matters now that fills settle real money: if 3 is not actually ALL, an
   order that filled and went inactive before we polled is never seen, and the
   client is never debited. So the range is widened to accept what the vendor
   demonstrably uses. Confirm the semantics with Andre before relying on any
   single value. */
function parseOrderFilter(value: string | undefined): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 7) return n as 1 | 2 | 3 | 4 | 5 | 6 | 7;
  return 7;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  return value === "1" || value.toLowerCase() === "true";
}

/**
 * `IRESS_PRODUCTION_ORDERS=1` — the production order lane is switched on.
 *
 * Shared by the HTTP API's readiness gate and the fill poller so the two can
 * never disagree about which lane the worker is on. Sending orders you cannot
 * track is worse than not sending them, so the poller keys off the SAME flag
 * that permits sending.
 */
export function productionOrdersEnabled(): boolean {
  return parseBool(process.env.IRESS_PRODUCTION_ORDERS, false);
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
    // Clamp loop intervals so NaN/0/negative can't turn sleep(sec*1000) into a
    // seat-hammering busy loop. `Number(...) || default` neutralizes NaN and 0;
    // Math.max floors negatives. Neither of these two loops has a disable
    // sentinel, so collapsing 0/neg to the floor is correct.
    heartbeatSec: Math.max(5, Number(process.env.IRESS_WORKER_HEARTBEAT_SEC ?? "30") || 30),
    quoteIntervalSec: Math.max(5, Number(process.env.IRESS_WORKER_QUOTE_INTERVAL_SEC ?? "15") || 15),
    // orderPollIntervalSec: <= 0 is a DELIBERATE disable sentinel (main.ts
    // orderLoop: `if (env.orderPollIntervalSec <= 0) return;`). Preserve it —
    // convert only NaN to the default, keep <= 0 as "disabled", floor positives.
    orderPollIntervalSec: (() => {
      const n = Number(process.env.IRESS_WORKER_ORDER_POLL_SEC ?? "60");
      return Number.isFinite(n) ? (n <= 0 ? n : Math.max(5, n)) : 60;
    })(),
    watchlistSymbols: symbols,
    watchlistEntries: entries,
    watchlistExchanges: exchanges,
    instrumentSync: parseBool(process.env.IRESS_WORKER_INSTRUMENT_SYNC, false),
    iressOrderFilter: parseOrderFilter(process.env.IRESS_ORDER_FILTER),
    retailSettlementEnabled: parseBool(process.env.RETAIL_SETTLEMENT_ENABLED, false),
    retailSettlementDryRun: parseBool(process.env.RETAIL_SETTLEMENT_DRY_RUN, true),
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
  /** Cadence (seconds) of the research-trigger alert evaluator. Default 60. */
  alertEvalSec: Math.max(15, Number(process.env.IRESS_ALERT_EVAL_SEC ?? "60")),
    applicationLabel: process.env.IRESS_APPLICATION_LABEL ?? "Mint-OEMS-Worker",
    defaultExchange: defaultExchange || "JSE",
    fxExchange: fxExchange || "FX",
    moneyMarketExchange: mmExchange || "MM",
    ipsServer: (process.env.IRESS_IPS_SERVER ?? "IPSAPI").trim() || "IPSAPI",
    // Per-loop pilot-write gate for news — defaults match the worker-wide
    // posture (dry-run / no writes) so a missed flip stays safe. Flipping
    // BOTH to (0, 1) on the prod worker is the explicit prod go-live step
    // (NEWS pilot opt-in per the 2026-07-22 plan).
    newsDryRun: parseBool(process.env.IRESS_NEWS_DRY_RUN, true),
    newsAllowWrites: parseBool(process.env.IRESS_NEWS_ALLOW_WRITES, false),
    // Prod default = "SENSD" (SENS NEWS DELAYED) — the only vendor the IRESS
    // production market-data seat carries (Charles-confirmed 2026-07-23;
    // `NewsVendorGet` returns a single row on the prod session). Override
    // with `IRESS_NEWS_VENDOR=SENS` for the rare seat where real-time is
    // entitled. The sync loop still retries once with the alternate vendor
    // on 25010/25018 entitlement faults — see news-ingest.ts vendor_fallback.
    newsVendorCode: (process.env.IRESS_NEWS_VENDOR ?? "SENSD").trim().toUpperCase() || "SENSD",
    // 2000 floor at 500: the CT build returned 894 rows in one trading
    // day's window with Count=1000, so the legacy 500 cap silently
    // truncated. Paging kicks in above the per-page size.
    newsMaxRows: Math.max(500, Number(process.env.IRESS_NEWS_MAX_ROWS ?? "2000") || 2000),
  };
}
