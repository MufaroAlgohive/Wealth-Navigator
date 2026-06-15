// Live IRESS V4 SOAP client.
//
// Implements the `IressClient` interface from `./client.ts` against the real
// IRESS V4 web-services endpoint (SOAP 1.1 over HTTPS). Selected by
// `IRESS_MODE=live` or `IRESS_MODE=wsdl-stub` in `index.ts`.
//
// ## SOAP client choice
//
// We hand-rolled a small SOAP 1.1 transport in `./transport.ts` (Option C in
// the build brief) rather than pulling in the heavy `soap` / `strong-soap`
// npm packages. The V4 WSDLs aren't on disk — the docs are narrative — and
// the typed `IressClient` interface is the contract the UI depends on. A
// hand-rolled transport is ~250 lines, has zero new dependencies beyond
// `fast-xml-parser`, and gives us full control over envelope construction,
// fault translation, and per-call timeouts. The transport is injected so
// tests can swap in a fake `fetch` and assert envelope shape without making
// any network calls.
//
// ## Auth + endpoints
//
// - `IRESS_BASE_URL` (default `https://webservices-ct.iress.co.za/v4`) — the
//   dev / sandbox CT endpoint Charles Ntjana's `DFM@Mint` credential lives on.
// - `IRESS_PROD_URL` (default `https://webservices.iress.co.za/v4`) — the
//   production endpoint. The adapter always hits the dev URL unless the env
//   is explicitly pointed elsewhere.
//
// All V4 SOAP methods are POSTs to `${baseUrl}/SOAP.aspx` with a SOAPAction
// header of `"http://webservices.iress.com.au/v4/${method}"`.

import { IressError } from "@/lib/iress/errors";
import type {
  IressClient,
  IressHeader,
  IressResponse,
  IressSessionStartRequest,
  IressSessionStartResponse,
  OrderCreate3Request,
  OrderCreate3Response,
  OrderAmend2Request,
  PricingQuoteGetRequest,
  ServiceSessionStartRequest,
  ServiceSessionStartResponse,
  TimeSeriesGet2Request,
  IPSTransactionGetByAccount5Request,
  IPSAccountGetAll1Request,
  IPSAccountRow,
  IPSPositionGetAll1Request,
  IPSPositionRow,
  NewOrder,
} from "@/lib/iress/client";
import type { Order, OrderSide, Quote } from "@/types/iress";
import { createSoapTransport, makeHeader, readResultHeaderNumber, readResultRowString, type SoapTransport } from "@/lib/iress/transport";

// ─── Validation helpers ───────────────────────────────────────────────────

/** Throws `IressError(25018, ...)` if the request is missing a required field. */
function require(value: string | number | undefined | null, field: string, method: string): asserts value is string | number {
  if (value === undefined || value === null || value === "") {
    throw new IressError(25018, method, `${method}: missing required field \`${field}\``);
  }
}

function requireObject<T extends object>(value: T | undefined | null, field: string, method: string): asserts value is T {
  if (!value || typeof value !== "object") {
    throw new IressError(25018, method, `${method}: missing required field \`${field}\``);
  }
}

function requireSessionKey(header: IressHeader | undefined, method: string): asserts header is IressHeader {
  if (!header || typeof header !== "object") {
    throw new IressError(25018, method, `${method}: missing \`Header\``);
  }
  require(header.SessionKey, "Header.SessionKey", method);
  require(header.RequestID, "Header.RequestID", method);
}

function newRequestID(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Result mapping helpers ───────────────────────────────────────────────

/** Standard V4 response: Header.StatusCode / ErrorNumber, DataRows. */
function mapResponse<T>(raw: { header: Record<string, unknown>; dataRows: Array<unknown> }): IressResponse<T> {
  const errNo = readResultHeaderNumber(raw.header, "ErrorNumber");
  return {
    Header: {
      StatusCode: ((): 1 | 2 | 3 => {
        const sc = readResultHeaderNumber(raw.header, "StatusCode");
        if (sc === 1 || sc === 3) return sc;
        return 2;
      })(),
      PagingBookmark: readResultRowString(raw.header, "PagingBookmark") || undefined,
      ErrorNumber: errNo,
      ErrorDescription: readResultRowString(raw.header, "ErrorDescription") || undefined,
    },
    DataRows: raw.dataRows as T[],
  };
}

type QuoteNumReader = (...keys: string[]) => number;
type QuoteStrReader = (...keys: string[]) => string;

/** Close / settlement field aliases seen across IRESS V4 CT quote rows. */
const CLOSE_KEYS = [
  "Close",
  "ClosePrice",
  "ClosingPrice",
  "TodayClose",
  "SessionClose",
  "SettlementPrice",
  "OfficialClose",
  "LastClose",
  "IndicativeClose",
  "AdjustedClose",
  "ReferencePrice",
] as const;

const PREV_CLOSE_KEYS = [
  "PrevClose",
  "PreviousClose",
  "PreviousClosePrice",
  "PreviousSettlement",
  "PriorClose",
  "YesterdayClose",
] as const;

/** OHLC / book fields used to infer integer-cent scaling when LastPrice is ambiguous. */
const OHLC_PRICE_KEYS = [
  "Open",
  "OpenPrice",
  "High",
  "HighPrice",
  "DayHigh",
  "Low",
  "LowPrice",
  "DayLow",
  "Close",
  "ClosePrice",
  "PreviousClosePrice",
  "PreviousClose",
  "PrevClose",
  "SettlementPrice",
  "BidPrice",
  "Bid",
  "AskPrice",
  "Ask",
  "VWAP",
  "Vwap",
  "MatchPrice",
] as const;

function rawNumericFields(row: Record<string, unknown>, keys: readonly string[]): number[] {
  return keys
    .map((k) => Number(row[k]))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * CT returns bare `<Last>` in ZAR for some names and `<LastPrice>` integer cents
 * for others. BHG can send `LastPrice=2445` (bogus / wrong scale) while
 * `OpenPrice`/`PreviousClosePrice` cluster at ~52800 cents — detect via OHLC.
 */
export function iressQuotePriceScale(row: Record<string, unknown>): number {
  const ohlcCluster = clusterAnchor(rawNumericFields(row, OHLC_PRICE_KEYS));
  const lastRaw = hasLastField(row)
    ? Number(row["Last"])
    : row["LastPrice"] !== undefined &&
        row["LastPrice"] !== null &&
        row["LastPrice"] !== ""
      ? Number(row["LastPrice"])
      : NaN;
  const lastPositive = Number.isFinite(lastRaw) && lastRaw > 0 ? lastRaw : 0;

  if (ohlcCluster > 4500) {
    // OHLC/book cluster in integer cents — scale when Last is absent, above
    // threshold, or inconsistent with the cluster (e.g. BHG Last=2445 vs Open=52800).
    if (!hasLastField(row) && lastPositive > 4500) return 0.01;
    if (lastPositive > 0 && lastPositive < ohlcCluster / 10) return 0.01;
    if (lastPositive === 0) return 0.01;
  }

  if (hasLastField(row)) return 1;

  if (lastPositive > 4500) return 0.01;
  return 1;
}

function hasLastField(row: Record<string, unknown>): boolean {
  return row["Last"] !== undefined && row["Last"] !== null && row["Last"] !== "";
}

/** Median of price candidates that cluster within 3× of each other. */
function clusterAnchor(candidates: number[]): number {
  const positive = candidates.filter((p) => p > 0);
  if (positive.length === 0) return 0;
  const sorted = [...positive].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)]!;
  const consistent = sorted.filter((p) => p >= med / 3 && p <= med * 3);
  if (consistent.length === 0) return med;
  return consistent.reduce((sum, p) => sum + p, 0) / consistent.length;
}

/** *Price-schema row with only LastPrice/PreviousClosePrice and no session/book/volume. */
function isStaleLastPriceOnlyRow(row: Record<string, unknown>): boolean {
  if (hasLastField(row)) return false;
  if (row["LastTrade"] !== undefined && row["LastTrade"] !== null && row["LastTrade"] !== "") {
    return false;
  }
  const hasSessionClose = CLOSE_KEYS.some((k) => Number(row[k]) > 0);
  if (hasSessionClose) return false;
  // Previous-day close anchors are real data too — `PreviousClosePrice` is
  // the canonical field the JSE returns for `marketState=CLOSED` rows.
  // Without this carve-out, a SOL row with `LastPrice=17500` (cents) and
  // `PreviousClosePrice=17500` and no other fields would be mis-classified
  // as stale and the worker would skip the write — leaving the weekend /
  // holiday UI blank when the data is in fact present.
  const hasPrevClose = PREV_CLOSE_KEYS.some((k) => Number(row[k]) > 0);
  if (hasPrevClose) return false;
  const sessionKeys = [
    "Open", "OpenPrice", "High", "HighPrice", "DayHigh", "Low", "LowPrice", "DayLow",
    "Bid", "BidPrice", "Ask", "AskPrice", "TotalVolume", "Volume", "CumVolume",
    "TotalValue", "MarketValue", "TotalTradedValue",
  ];
  if (sessionKeys.some((k) => Number(row[k]) > 0)) return false;
  // Last-resort: a "stale-only" row is one whose only non-zero price field
  // is `LastPrice` AND that value is implausibly small. Real closed-market
  // rows the JSE returns carry a cents-scale LastPrice (> 4500); a value
  // like 2445 with nothing else is the BHG bogus-scale pattern and we
  // should still skip it.
  const lastPrice = Number(row["LastPrice"]);
  if (lastPrice > 0 && lastPrice < 4500) return true;
  return false;
}

/**
 * Pick the display price from a PricingQuoteGet row.
 *
 * Real CT responses may expose `<Last>` (live) alongside a stale `<LastTrade>`
 * (often a bogus cumulative value when the JSE is closed). When `<Last>` is
 * absent or zero, prefer session `<Close>` / OHLC cluster / book mid before
 * `<LastTrade>`. When no anchor exists and `Last` looks like volume or an
 * outlier, return 0 so callers skip the write.
 */
export function resolveQuoteLast(
  num: QuoteNumReader,
  str: QuoteStrReader,
): number {
  const liveLast = num("Last", "LastPrice");
  const close = num(...CLOSE_KEYS);
  const prevClose = num(...PREV_CLOSE_KEYS);
  const open = num("Open", "OpenPrice");
  const high = num("High", "HighPrice", "DayHigh");
  const low = num("Low", "LowPrice", "DayLow");
  const vwap = num("VWAP", "Vwap", "AveragePrice", "AvgPrice");
  const bid = num("Bid", "BidPrice", "BuyPrice");
  const ask = num("Ask", "AskPrice", "SellPrice");
  const lastTrade = num("LastTrade", "LastPrice", "PxLast", "TradePrice", "MatchPrice");
  const volume = num("Volume", "TotalVolume", "CumVolume", "TotalTradedVolume");
  const totalValue = num("TotalValue", "TotalTradedValue", "Turnover", "MarketValue");
  const tradedVwap =
    volume > 0 && totalValue > 0 && totalValue / volume > 0
      ? totalValue / volume
      : 0;
  const state = str("MarketState", "QuoteState", "State", "Status", "TradingStatus");
  const closed = /CLOSED|CLOSE|HALT|PRE[_-]?OPEN|SUSPEND/i.test(state);

  const bookMid =
    bid > 0 && ask > 0 ? (bid + ask) / 2 : bid > 0 ? bid : ask > 0 ? ask : 0;
  const officialClose = close > 0 ? close : prevClose > 0 ? prevClose : 0;
  const sessionMid = high > 0 && low > 0 ? (high + low) / 2 : 0;
  const ohlcAnchor = clusterAnchor([open, high, low, vwap, close, prevClose, tradedVwap]);
  const anchor =
    officialClose > 0
      ? officialClose
      : sessionMid > 0
        ? sessionMid
        : ohlcAnchor > 0
          ? ohlcAnchor
          : bookMid;

  const isBogusVsAnchor = (price: number) =>
    anchor > 0 && (price > anchor * 3 || price < anchor / 3);

  const looksLikeVolume = (price: number) =>
    volume > 0 &&
    price > 100 &&
    Math.abs(price - volume) / Math.max(volume, 1) < 0.05;

  const noAnchorSuspicious = (price: number) => {
    if (price <= 0) return false;
    if (looksLikeVolume(price)) return true;
    const ohlcOnly = clusterAnchor([open, high, low, vwap, close, prevClose, tradedVwap]);
    if (ohlcOnly > 0 && (price > ohlcOnly * 3 || price < ohlcOnly / 3)) return true;
    // Watchlist JSE names: no anchor at all and Last above plausible single-name range.
    // Skip this guard when the market is closed — the real IRESS row only ships a
    // scaled LastPrice / PreviousClosePrice at the close, no OHLC cluster. Trusting
    // the raw Last/LastPrice is the right move for the weekend/holiday display case.
    if (anchor === 0 && bookMid === 0 && price > 4500 && !closed) return true;
    return false;
  };

  const rejectOrAnchor = (price: number) => {
    if (isBogusVsAnchor(price) || noAnchorSuspicious(price)) {
      return anchor > 0 ? anchor : 0;
    }
    return price;
  };

  if (liveLast > 0) {
    const resolved = rejectOrAnchor(liveLast);
    if (resolved > 0) return resolved;
    if (closed) {
      if (officialClose > 0) return officialClose;
      if (sessionMid > 0) return sessionMid;
      if (ohlcAnchor > 0) return ohlcAnchor;
      if (bookMid > 0) return bookMid;
    }
    return 0;
  }

  if (closed || liveLast <= 0) {
    if (officialClose > 0) return officialClose;
    if (sessionMid > 0) return sessionMid;
    if (ohlcAnchor > 0) return ohlcAnchor;
    if (bookMid > 0) return bookMid;
  }

  if (lastTrade > 0) {
    const resolved = rejectOrAnchor(lastTrade);
    if (resolved > 0) return resolved;
    return anchor > 0 ? anchor : 0;
  }

  return officialClose || sessionMid || ohlcAnchor || bookMid;
}

function mapQuote(row: Record<string, unknown> | undefined): Quote {
  if (!row) {
    return emptyQuote();
  }
  if (isStaleLastPriceOnlyRow(row)) {
    return {
      ...emptyQuote(),
      symbol: String(row["SecurityCode"] ?? row["Code"] ?? row["Symbol"] ?? ""),
      marketState: (String(row["TradingStatus"] ?? row["QuoteState"] ?? row["MarketState"] ?? "HALT")) as Quote["marketState"],
    };
  }
  const scale = iressQuotePriceScale(row);
  // Real IRESS V4 market-data responses use the bare field names (`<Last>`,
  // `<Bid>`, `<Ask>`, `<QuoteState>`, etc.). Our internal mock + WSDL samples
  // historically used the longer camelCase names. Read the doc-canonical name
  // first, then fall back to the real-server short names so the same mapper
  // works against both shapes. Keys are case-sensitive — IRESS returns the
  // exact element name as written in the WSDL.
  const num = (...keys: string[]) => {
    for (const k of keys) {
      const v = row[k];
      if (v !== undefined && v !== null && v !== "") {
        const n = Number(v);
        if (Number.isFinite(n)) return n * scale;
      }
    }
    return 0;
  };
  const str = (...keys: string[]) => {
    for (const k of keys) {
      const v = row[k];
      if (v !== undefined && v !== null && v !== "") return String(v);
    }
    return "";
  };
  return {
    symbol: str("SecurityCode", "Code", "Symbol", "symbol"),
    last: resolveQuoteLast(num, str),
    bid: num("Bid", "BidPrice", "BuyPrice"),
    ask: num("Ask", "AskPrice", "SellPrice"),
    bidSize: num("BidSize", "BidQty", "BuySize"),
    askSize: num("AskSize", "AskQty", "SellSize"),
    open: num("Open", "OpenPrice"),
    high: num("High", "HighPrice", "DayHigh"),
    low: num("Low", "LowPrice", "DayLow"),
    close: num(...CLOSE_KEYS, ...PREV_CLOSE_KEYS),
    prevClose: num(...PREV_CLOSE_KEYS, ...CLOSE_KEYS),
    change: num("NetChange", "Change"),
    changePct: num("PercentChange", "ChangePct"),
    volume: num("Volume", "TotalVolume", "CumVolume"),
    vwap: num("VWAP", "Vwap"),
    marketCap: row["MarketCap"] === undefined ? undefined : num("MarketCap"),
    currency: str("Currency") || "ZAR",
    marketState: (str("MarketState", "QuoteState", "State", "Status", "TradingStatus") || "OPEN") as Quote["marketState"],
    ts: row["LastTradeDateTime"] || row["LastTradeTime"] || row["UpdateTime"]
      ? Date.parse(String(row["LastTradeDateTime"] ?? row["LastTradeTime"] ?? row["UpdateTime"])) || Date.now()
      : Date.now(),
  };
}

/**
 * Surface an `unknown field set` warning when a parsed quote has `last=0`.
 *
 * The recent Railway deploy (June 2026) was silently returning `last=0` for
 * every NPN / watchlist symbol because the real IRESS V4 server uses bare
 * element names (`<Last>`, `<QuoteState>`) while our mapper only knew the
 * longer camelCase keys (`<LastTrade>`, `<MarketState>`). Now that `mapQuote`
 * falls back to the real-server names, this helper is the safety net: if we
 * ever land in the same situation again, the row's available keys are logged
 * in one structured event so the next fix is a one-line addition to the
 * `num` / `str` helper above.
 */
export function describeQuoteRowKeys(row: unknown): string {
  if (!row || typeof row !== "object") return "<missing row>";
  return Object.keys(row as Record<string, unknown>).sort().join(",") || "<empty row>";
}

/**
 * Worker-side write-through check: a raw IRESS row carries real price data
 * if any of the canonical price fields are non-zero. Used by the ingest
 * loop to decide whether to write a `stock_intraday_c` row when the
 * mapper collapsed `last` to 0 (e.g. a SOL row with `LastPrice=17500`
 * cents, `QuoteState=CLOSED`, no other fields).
 *
 * A row whose ONLY non-zero price field is a small (< 4500) `LastPrice`
 * is the BHG bogus-scale pattern — the worker should still drop it.
 */
export function quoteRawRowHasPriceData(row: unknown): boolean {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  const numeric = describeQuoteRowNumericFields(r);
  // Canonical price fields we trust as "real" when present.
  const priceKeys = [
    "Last",
    "LastTrade",
    "LastPrice",
    "Close",
    "ClosePrice",
    "ClosingPrice",
    "SessionClose",
    "SettlementPrice",
    "OfficialClose",
    "IndicativeClose",
    "ReferencePrice",
    "PrevClose",
    "PreviousClose",
    "PreviousClosePrice",
    "PreviousSettlement",
    "PriorClose",
    "YesterdayClose",
    "AdjustedClose",
    "Open",
    "OpenPrice",
    "High",
    "HighPrice",
    "DayHigh",
    "Low",
    "LowPrice",
    "DayLow",
    "VWAP",
    "Vwap",
    "MatchPrice",
    "BidPrice",
    "AskPrice",
    "TradePrice",
    "PxLast",
    "AveragePrice",
    "AvgPrice",
  ];
  for (const k of priceKeys) {
    const v = numeric[k] ?? 0;
    if (v > 0) return true;
  }
  return false;
}

/**
 * Extract the best-effort `last` value from a raw row using the same
 * field order the mapper uses (`Last` first, then `LastPrice`, then
 * `LastTrade`, etc.). Returns 0 if the row carries no usable price.
 * Intended for the worker's write-through path when the mapped
 * `last` is 0 but the raw row has data.
 */
export function quoteRawRowLast(row: unknown): number {
  if (!row || typeof row !== "object") return 0;
  const r = row as Record<string, unknown>;
  const numeric = describeQuoteRowNumericFields(r);
  const last = numeric["Last"] ?? 0;
  if (last > 0) return last;
  const lastPrice = numeric["LastPrice"] ?? 0;
  if (lastPrice > 0) return lastPrice;
  const lastTrade = numeric["LastTrade"] ?? 0;
  if (lastTrade > 0) return lastTrade;
  // Fall back to previous close as a last resort.
  for (const k of [
    "PrevClose",
    "PreviousClose",
    "PreviousClosePrice",
    "PreviousSettlement",
    "PriorClose",
    "YesterdayClose",
  ]) {
    const v = numeric[k] ?? 0;
    if (v > 0) return v;
  }
  return 0;
}

/** All numeric fields on a raw PricingQuoteGet row (for CT field discovery). */
export function describeQuoteRowNumericFields(row: unknown): Record<string, number> {
  if (!row || typeof row !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

const quoteRawLogOnce = new Set<string>();

function maybeLogRawQuoteRow(securityCode: string, rawRow: Record<string, unknown>): void {
  const rawLogEnv = process.env.IRESS_QUOTE_RAW_LOG?.trim();
  if (!rawLogEnv) return;
  const sym = String(rawRow["SecurityCode"] ?? securityCode ?? "").toUpperCase();
  if (!sym || quoteRawLogOnce.has(sym)) return;
  const debugSymbols = rawLogEnv
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (!debugSymbols.includes(sym)) return;
  quoteRawLogOnce.add(sym);
  console.info(
    JSON.stringify({
      level: "info",
      event: "quote_raw_row",
      source: "iress-live",
      symbol: sym,
      rowKeys: describeQuoteRowKeys(rawRow),
      numerics: describeQuoteRowNumericFields(rawRow),
    }),
  );
}

function emptyQuote(): Quote {
  return {
    symbol: "",
    last: 0, bid: 0, ask: 0, bidSize: 0, askSize: 0,
    open: 0, high: 0, low: 0, close: 0, prevClose: 0,
    change: 0, changePct: 0, volume: 0, vwap: 0,
    currency: "ZAR",
    marketState: "HALT",
    ts: Date.now(),
  };
}

function mapOrder(row: Record<string, unknown>): Order {
  const str = (k: string) => String(row[k] ?? "");
  const num = (k: string) => Number(row[k] ?? 0);
  const side: OrderSide = num("BuySell") === 1 ? "BUY" : "SELL";
  const tif = str("TimeInForce") as Order["tif"];
  const type = str("OrderType") as Order["type"];
  const destination = str("Destination") as Order["destination"];
  return {
    id: str("OrderNumber"),
    parentId: row["ParentOrderNumber"] ? str("ParentOrderNumber") : undefined,
    account: str("AccountCode"),
    strategy: row["Strategy"] ? str("Strategy") : "(unspecified)",
    side,
    symbol: str("SecurityCode"),
    isin: row["ISIN"] ? str("ISIN") : "ZZZ",
    type: (["MKT", "LMT", "STP", "STP_LMT"] as const).includes(type as never) ? (type as Order["type"]) : "LMT",
    tif: (["DAY", "IOC", "FOK", "GTC"] as const).includes(tif as never) ? (tif as Order["tif"]) : "DAY",
    destination: (["JSE", "NASDAQ", "NYSE", "LSE", "OTC", "DARK"] as const).includes(destination as never) ? (destination as Order["destination"]) : "JSE",
    qty: num("Volume"),
    filled: num("FilledVolume"),
    limit: row["Price"] === undefined ? null : num("Price"),
    stop: row["TriggerPrice"] === undefined ? null : num("TriggerPrice"),
    avgPx: num("AveragePrice"),
    vwap: num("VWAP"),
    trader: row["Trader"] ? str("Trader") : "(current user)",
    ts: row["LastUpdate"] ? Date.parse(String(row["LastUpdate"])) || Date.now() : Date.now(),
    state: ((): Order["state"] => {
      const s = str("OrderState").toUpperCase();
      if (s === "WORKING" || s === "PARTIAL" || s === "FILLED" || s === "CANCELLED" || s === "REJECTED") return s;
      return "WORKING";
    })(),
    rejectReason: row["RejectReason"] ? str("RejectReason") : undefined,
    slippageBps: num("SlippageBps"),
    arrivalMid: num("ArrivalMid"),
    orderTag: str("OrderTag") || "",
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────

/**
 * Internal — pages through a legacy IPS method whose cursor lives in
 * `<Parameters>` rather than the standard V4 header. Caller passes the SOAP
 * method name + a `buildParameters(cursor, pageSize)` callback; this loop
 * drives `PreviousKey` until the server returns a short / empty page.
 *
 * Doc: `Documentation & Vision/iress-v4-docs/03-paging-and-updates/04-paging-in-ips.md`.
 *
 * - `StatusCode = 2` is NOT a stop signal on these methods. The cursor is
 *   the truth.
 * - We cap the loop at `MAX_LEGACY_IPS_PAGES` to guard against a server
 *   bug that returns the same cursor forever.
 */
const MAX_LEGACY_IPS_PAGES = 50;
const DEFAULT_LEGACY_PAGE_SIZE = 200;

interface PagedFetchOptions {
  transport: SoapTransport;
  method: string;
  serviceSessionKey: string;
  pageSize: number;
  /** Build the `<Parameters>` block for a given cursor (undefined on the first page). */
  buildParameters: (cursor: string | undefined) => Record<string, unknown>;
  /** Read the cursor key from a result row. Called on each row of the current page. */
  readCursor: (row: Record<string, unknown>) => string;
  /** Label used for log + error context (e.g. "IPSAccountGetAll1"). */
  methodLabel: string;
}

async function pagedFetchLegacyIps<T>(opts: PagedFetchOptions): Promise<{
  dataRows: T[];
  totalPages: number;
  entitlementRequired: boolean;
}> {
  let cursor: string | undefined = undefined;
  const all: T[] = [];
  let pages = 0;
  let entitlementRequired = false;
  while (pages < MAX_LEGACY_IPS_PAGES) {
    const result = await opts.transport.call({
      method: opts.method,
      header: makeHeader({
        serviceSessionKey: opts.serviceSessionKey,
        requestID: newRequestID(opts.method.toLowerCase()),
        timeout: 30,
        pageSize: 0,
        waitForResponse: true,
      }),
      parameters: opts.buildParameters(cursor),
    });
    const errorNumber = readResultHeaderNumber(result.header, "ErrorNumber");
    if (errorNumber === 25014 || errorNumber === 25008) {
      entitlementRequired = true;
      return { dataRows: all, totalPages: pages, entitlementRequired };
    }
    if (errorNumber && errorNumber !== 0) {
      const desc = readResultRowString(result.header, "ErrorDescription");
      throw new IressError(
        errorNumber,
        opts.methodLabel,
        desc || `${opts.methodLabel} error ${errorNumber}`,
      );
    }
    if (result.dataRows.length === 0) break;
    let lastCursor = "";
    for (const row of result.dataRows) {
      all.push(row as T);
      const next = opts.readCursor(row);
      if (next) lastCursor = next;
    }
    pages += 1;
    // The legacy cursor is the LAST row's key. If the page was short
    // (fewer than `PageSize`), the server is signaling end-of-results.
    if (result.dataRows.length < opts.pageSize || !lastCursor || lastCursor === cursor) {
      break;
    }
    cursor = lastCursor;
  }
  return { dataRows: all, totalPages: pages, entitlementRequired };
}

export interface LiveClientOptions {
  /** SOAP transport (defaults to one created from `IRESS_BASE_URL`). */
  transport?: SoapTransport;
  /** Override the base URL used to build the default transport. */
  baseUrl?: string;
}

export function createLiveIressClient(opts: LiveClientOptions = {}): IressClient {
  const transport = opts.transport ?? createSoapTransport({
    baseUrl: opts.baseUrl ?? process.env.IRESS_BASE_URL ?? "https://webservices-ct.iress.co.za/v4",
  });

  return {
    // ── session ────────────────────────────────────────────────────
    async iressSessionStart(req: IressSessionStartRequest): Promise<IressSessionStartResponse> {
      require(req.UserName, "UserName", "IRESSSessionStart");
      require(req.Password, "Password", "IRESSSessionStart");
      require(req.ApplicationID, "ApplicationID", "IRESSSessionStart");
      require(req.CompanyName, "CompanyName", "IRESSSessionStart");
      const result = await transport.call({
        method: "IRESSSessionStart",
        header: makeHeader({
          requestID: newRequestID("init"),
          timeout: 55,
          waitForResponse: true,
        }),
        parameters: {
          UserName: req.UserName,
          CompanyName: req.CompanyName,
          Password: req.Password,
          ApplicationID: req.ApplicationID,
          ApplicationLabel: req.ApplicationLabel,
          AuthenticationType: req.AuthenticationType,
          SessionTimeout: req.SessionTimeout,
          SessionNumberToKick: req.SessionNumberToKick,
          KickLikeSessions: req.KickLikeSessions,
          Locale: req.Locale,
        },
      });
      if (result.dataRows.length === 0 || !result.firstRow?.["IRESSSessionKey"]) {
        throw new IressError(666, "IRESSSessionStart", "No IRESSSessionKey in response");
      }
      const key = String(result.firstRow["IRESSSessionKey"]);
      // The V4 spec says the response also carries SessionNumber / SessionTimeout /
      // ApplicationID, but older servers sometimes omit them. The mock returns
      // them in the result header; map defensively.
      return {
        IRESSSessionKey: key,
        SessionNumber: Number(result.firstRow["SessionNumber"] ?? 0) || 1,
        SessionTimeout: Number(result.firstRow["SessionTimeout"] ?? req.SessionTimeout ?? 120) || 120,
        ApplicationID: String(result.firstRow["ApplicationID"] ?? req.ApplicationID),
      };
    },

    async iressSessionEnd(req: { IRESSSessionKey: string }): Promise<void> {
      require(req.IRESSSessionKey, "IRESSSessionKey", "IRESSSessionEnd");
      await transport.call({
        method: "IRESSSessionEnd",
        header: makeHeader({
          sessionKey: req.IRESSSessionKey,
          requestID: newRequestID("end-iress"),
          timeout: 10,
          waitForResponse: true,
        }),
        parameters: {},
      });
    },

    async serviceSessionStart(req: ServiceSessionStartRequest): Promise<ServiceSessionStartResponse> {
      require(req.IRESSSessionKey, "IRESSSessionKey", "ServiceSessionStart");
      require(req.Service, "Service", "ServiceSessionStart");
      require(req.Server, "Server", "ServiceSessionStart");
      const result = await transport.call({
        method: "ServiceSessionStart",
        header: makeHeader({
          sessionKey: req.IRESSSessionKey,
          requestID: newRequestID("svc-start"),
          timeout: 30,
          waitForResponse: true,
        }),
        parameters: {
          Service: req.Service,
          Server: req.Server,
        },
      });
      if (!result.firstRow?.["ServiceSessionKey"]) {
        throw new IressError(666, "ServiceSessionStart", "No ServiceSessionKey in response");
      }
      return {
        ServiceSessionKey: String(result.firstRow["ServiceSessionKey"]),
        Service: req.Service,
        Server: req.Server,
      };
    },

    async serviceSessionEnd(req: { ServiceSessionKey: string }): Promise<void> {
      require(req.ServiceSessionKey, "ServiceSessionKey", "ServiceSessionEnd");
      await transport.call({
        method: "ServiceSessionEnd",
        header: makeHeader({
          serviceSessionKey: req.ServiceSessionKey,
          requestID: newRequestID("svc-end"),
          timeout: 10,
          waitForResponse: true,
        }),
        parameters: {},
      });
    },

    // ── market data ────────────────────────────────────────────────
    async pricingQuoteGet(req: PricingQuoteGetRequest): Promise<IressResponse<Quote>> {
      requireSessionKey(req.Header, "PricingQuoteGet");
      require(req.SecurityCode, "SecurityCode", "PricingQuoteGet");
      require(req.Exchange, "Exchange", "PricingQuoteGet");
      const result = await transport.call({
        method: "PricingQuoteGet",
        header: makeHeader({
          sessionKey: req.Header.SessionKey,
          requestID: req.Header.RequestID,
          updates: req.Header.Updates,
          timeout: req.Header.Timeout ?? 25,
          pageSize: req.Header.PageSize,
          pagingBookmark: req.Header.PagingBookmark,
          pagingDirection: req.Header.PagingDirection,
          waitForResponse: req.Header.WaitForResponse ?? true,
        }),
        parameters: { SecurityCode: req.SecurityCode, Exchange: req.Exchange, ...stripHeader(req) },
      });
      for (const rawRow of result.dataRows) {
        maybeLogRawQuoteRow(req.SecurityCode, rawRow);
      }
      const mapped = mapResponse<Quote>({
        header: result.header,
        dataRows: result.dataRows.map((r) => mapQuote(r)),
      });
      // Echo the raw, untyped rows so the worker can run write-through
      // checks (`LastPrice > 0` / `PreviousClosePrice > 0`) without having
      // to re-issue the request. The mapper collapses some shapes to 0
      // (e.g. `marketState=CLOSED` rows with no OHLC), and the worker
      // needs the raw fallback to decide whether the row carries
      // anything worth persisting for the weekend / holiday UI.
      (mapped as { RawDataRows?: Array<Record<string, unknown>> }).RawDataRows = result.dataRows;
      // V4 returns 200 OK with an empty DataRows + ErrorNumber!=0 in the
      // response header when the request is refused at the application
      // layer (e.g. 25010 method not entitled, 25034 entitlement check
      // failed). Without this check those failures look like "empty
      // snapshots" and the caller silently drops the symbol.
      if (mapped.Header.ErrorNumber !== 0) {
        throw new IressError(
          mapped.Header.ErrorNumber,
          "PricingQuoteGet",
          mapped.Header.ErrorDescription ??
            `PricingQuoteGet error ${mapped.Header.ErrorNumber}`,
        );
      }
      return mapped;
    },

    async pricingQuoteGetUpdates(req: { RequestID: string }): Promise<IressResponse<Quote>> {
      require(req.RequestID, "RequestID", "PricingQuoteGetUpdates");
      const result = await transport.call({
        method: "PricingQuoteGetUpdates",
        header: makeHeader({
          sessionKey: "",
          requestID: req.RequestID,
          waitForResponse: false,
        }),
        parameters: { RequestID: req.RequestID },
      });
      return mapResponse<Quote>({
        header: result.header,
        dataRows: result.dataRows.map((r) => mapQuote(r)),
      });
    },

    async timeSeriesGet2(req: TimeSeriesGet2Request): Promise<IressResponse<{ t: number; v: number }>> {
      requireSessionKey(req.Header, "TimeSeriesGet2");
      require(req.Code, "Code", "TimeSeriesGet2");
      // Wire shape follows the V4 doc / WSDL sample EXACTLY:
      //   <Code>SHP</Code><Exchange>JSE</Exchange>
      //   <DateFrom>2025-01-01</DateFrom><DateTo>2025-12-31</DateTo>
      //   <Interval>Daily</Interval>
      // Spec: Documentation & Vision/iress-v4-docs/05-services/market-data/
      //   02-time-series-get-2.md (+ the WSDL sample payload at lines 49-55).
      //
      // An earlier build sent a speculative parameter soup (`SecurityCode`
      // alongside `Code`, `<Frequency>` instead of `<Interval>`, and four date
      // aliases each for From/To) that diverged from the doc and never got past
      // "Invalid DateFrom". We now send the documented shape and nothing else.
      // Two env escape hatches (default OFF) let ops A/B a *suspected* CT-build
      // quirk via /debug/timeseries-probe WITHOUT another rewrite — leave both
      // unset to send the documented shape:
      //   IRESS_TS_SECID_FIELD=SecurityCode   (default `Code`)
      //   IRESS_TS_PERIOD_FIELD=Frequency     (default `Interval`)
      const periodStr =
        typeof req.Interval === "string" && req.Interval.trim() !== "" ? req.Interval.trim() : undefined;
      const periodLong =
        typeof req.Frequency === "number" && Number.isFinite(req.Frequency) ? req.Frequency : undefined;
      if (periodStr === undefined && periodLong === undefined) {
        throw new IressError(
          25018,
          "TimeSeriesGet2",
          "TimeSeriesGet2: missing required field — supply `Interval` (V4 string enum, e.g. 'Daily')",
        );
      }
      const secidField = (process.env.IRESS_TS_SECID_FIELD ?? "Code").trim() || "Code";
      const periodField = (process.env.IRESS_TS_PERIOD_FIELD ?? "Interval").trim() || "Interval";
      const parameters: Record<string, unknown> = {};
      parameters[secidField] = req.Code;
      if (req.Exchange) parameters["Exchange"] = req.Exchange;
      // Documented date range: single `<DateFrom>` / `<DateTo>`, ISO `YYYY-MM-DD`.
      // No aliases. The range is optional (omit to use NumberOfPoints / Date).
      if (req.From) parameters["DateFrom"] = req.From;
      if (req.To) parameters["DateTo"] = req.To;
      if (typeof req.NumberOfPoints === "number" && Number.isFinite(req.NumberOfPoints)) {
        parameters["NumberOfPoints"] = req.NumberOfPoints;
      }
      if (typeof req.Date === "string" && req.Date.trim() !== "") {
        parameters["Date"] = req.Date.trim();
      }
      // Documented period selector is <Interval> carrying the string enum
      // ("Daily", …). Prefer the string; fall back to the Long only if that's
      // all the caller supplied.
      parameters[periodField] = periodStr ?? periodLong;
      const result = await transport.call({
        method: "TimeSeriesGet2",
        header: makeHeader({
          sessionKey: req.Header.SessionKey,
          requestID: req.Header.RequestID,
          updates: req.Header.Updates,
          timeout: req.Header.Timeout ?? 25,
          pageSize: req.Header.PageSize,
          pagingBookmark: req.Header.PagingBookmark,
          pagingDirection: req.Header.PagingDirection,
          waitForResponse: req.Header.WaitForResponse ?? true,
        }),
        parameters,
      });
      return mapResponse<{ t: number; v: number }>({
        header: result.header,
        dataRows: result.dataRows.map((r) => ({
          t: r["t"] !== undefined ? Number(r["t"]) : r["TimeStamp"] !== undefined ? Date.parse(String(r["TimeStamp"])) : Date.now(),
          v: Number(r["v"] ?? r["Value"] ?? 0),
        })),
      });
    },

    async timeSeriesGet2Updates(req: { RequestID: string }): Promise<IressResponse<{ t: number; v: number }>> {
      require(req.RequestID, "RequestID", "TimeSeriesGet2Updates");
      const result = await transport.call({
        method: "TimeSeriesGet2Updates",
        header: makeHeader({ sessionKey: "", requestID: req.RequestID, waitForResponse: false }),
        parameters: { RequestID: req.RequestID },
      });
      return mapResponse<{ t: number; v: number }>({
        header: result.header,
        dataRows: result.dataRows.map((r) => ({
          t: r["t"] !== undefined ? Number(r["t"]) : r["TimeStamp"] !== undefined ? Date.parse(String(r["TimeStamp"])) : Date.now(),
          v: Number(r["v"] ?? r["Value"] ?? 0),
        })),
      });
    },

    // ── trading (IOS+) ─────────────────────────────────────────────
    async orderCreate3(req: OrderCreate3Request): Promise<OrderCreate3Response> {
      require(req.ServiceSessionKey, "ServiceSessionKey", "OrderCreate3");
      requireObject(req.Order, "Order", "OrderCreate3");
      const order = req.Order as NewOrder;
      require(order.AccountCode, "Order.AccountCode", "OrderCreate3");
      require(order.SecurityCode, "Order.SecurityCode", "OrderCreate3");
      require(order.Exchange, "Order.Exchange", "OrderCreate3");
      require(order.Volume, "Order.Volume", "OrderCreate3");
      require(order.Destination, "Order.Destination", "OrderCreate3");
      // OrderTag is *recommended* per the docs but not strictly required —
      // for a live adapter we follow the mock and require it so the OEMS gets
      // idempotency for free. Loosen if the integration tests show that the
      // server generates its own.
      require(req.OrderTag, "OrderTag", "OrderCreate3");
      const result = await transport.call({
        method: "OrderCreate3",
        header: makeHeader({
          serviceSessionKey: req.ServiceSessionKey,
          requestID: newRequestID("ord-create"),
          timeout: 25,
          waitForResponse: true,
        }),
        parameters: {
          Order: {
            AccountCode: order.AccountCode,
            SecurityCode: order.SecurityCode,
            Exchange: order.Exchange,
            BuySell: order.BuySell,
            OrderType: order.OrderType,
            Volume: order.Volume,
            Price: order.Price,
            TriggerPrice: order.TriggerPrice,
            Destination: order.Destination,
            TimeInForce: order.TimeInForce,
            ExpiryDate: order.ExpiryDate,
          },
          OrderTag: req.OrderTag,
        },
      });
      const first = result.firstRow ?? {};
      const status = String(first["Status"] ?? "WORKING").toUpperCase() === "REJECTED" ? "REJECTED" : "WORKING";
      const errorNumber = first["ErrorNumber"] !== undefined ? Number(first["ErrorNumber"]) : undefined;
      const errorDescription = first["ErrorDescription"] !== undefined ? String(first["ErrorDescription"]) : undefined;
      if (status === "REJECTED" && errorNumber) {
        throw new IressError(errorNumber, "OrderCreate3", errorDescription ?? "Order rejected");
      }
      if (!first["OrderNumber"]) {
        throw new IressError(666, "OrderCreate3", "No OrderNumber in response");
      }
      return {
        OrderNumber: String(first["OrderNumber"]),
        Status: status,
        ErrorNumber: errorNumber,
        ErrorDescription: errorDescription,
      };
    },

    async orderAmend2(req: OrderAmend2Request): Promise<{ OrderNumber: string }> {
      require(req.ServiceSessionKey, "ServiceSessionKey", "OrderAmend2");
      require(req.OrderNumber, "OrderNumber", "OrderAmend2");
      const result = await transport.call({
        method: "OrderAmend2",
        header: makeHeader({
          serviceSessionKey: req.ServiceSessionKey,
          requestID: newRequestID("ord-amend"),
          timeout: 25,
          waitForResponse: true,
        }),
        parameters: {
          OrderNumber: req.OrderNumber,
          Volume: req.Volume,
          Price: req.Price,
          TriggerPrice: req.TriggerPrice,
          TimeInForce: req.TimeInForce,
        },
      });
      const first = result.firstRow;
      const errorNumber = first && first["ErrorNumber"] !== undefined ? Number(first["ErrorNumber"]) : 0;
      if (errorNumber) {
        throw new IressError(errorNumber, "OrderAmend2", String(first?.["ErrorDescription"] ?? ""));
      }
      if (!first?.["OrderNumber"]) {
        throw new IressError(666, "OrderAmend2", "No OrderNumber in response");
      }
      return { OrderNumber: String(first["OrderNumber"]) };
    },

    async orderDelete(req: { ServiceSessionKey: string; OrderNumber: string }): Promise<void> {
      require(req.ServiceSessionKey, "ServiceSessionKey", "OrderDelete");
      require(req.OrderNumber, "OrderNumber", "OrderDelete");
      const result = await transport.call({
        method: "OrderDelete",
        header: makeHeader({
          serviceSessionKey: req.ServiceSessionKey,
          requestID: newRequestID("ord-delete"),
          timeout: 25,
          waitForResponse: true,
        }),
        parameters: { OrderNumber: req.OrderNumber },
      });
      const first = result.firstRow;
      const errorNumber = first && first["ErrorNumber"] !== undefined ? Number(first["ErrorNumber"]) : 0;
      if (errorNumber) {
        throw new IressError(errorNumber, "OrderDelete", String(first?.["ErrorDescription"] ?? ""));
      }
    },

    async orderNoGetByOrderTag(req: { ServiceSessionKey: string; OrderTag: string }): Promise<{ OrderNumber: string; OrderTag: string }> {
      require(req.ServiceSessionKey, "ServiceSessionKey", "OrderNoGetByOrderTag");
      require(req.OrderTag, "OrderTag", "OrderNoGetByOrderTag");
      const result = await transport.call({
        method: "OrderNoGetByOrderTag",
        header: makeHeader({
          serviceSessionKey: req.ServiceSessionKey,
          requestID: newRequestID("ord-tag"),
          timeout: 25,
          waitForResponse: true,
        }),
        parameters: { OrderTag: req.OrderTag },
      });
      // V4 reports refused lookups via the response Header.ErrorNumber
      // (25010 method not entitled, 25029 order not found, 25034
      // entitlement check failed) — same shape as `PricingQuoteGet`.
      const errorNumber = readResultHeaderNumber(result.header, "ErrorNumber");
      if (errorNumber) {
        const errorDescription =
          readResultRowString(result.header, "ErrorDescription") ||
          `OrderNoGetByOrderTag error ${errorNumber}`;
        throw new IressError(errorNumber, "OrderNoGetByOrderTag", errorDescription);
      }
      const first = result.firstRow ?? {};
      const orderNumber = String(first["OrderNumber"] ?? "").trim();
      if (!orderNumber) {
        // V4 returns 200 OK with an empty DataRow + ErrorNumber=0 when the
        // tag is unknown to the broker. Bubble a typed zero-string so the
        // BFF can distinguish "tag not found" from a transport fault.
        return { OrderNumber: "", OrderTag: req.OrderTag };
      }
      return { OrderNumber: orderNumber, OrderTag: req.OrderTag };
    },

    async orderPadGetByAccount(req: {
      ServiceSessionKey: string;
      AccountCode: string;
      OrderFilter: 1 | 2 | 3 | 4 | 5;
      Updates?: boolean;
      RequestID: string;
    }): Promise<IressResponse<Order>> {
      require(req.ServiceSessionKey, "ServiceSessionKey", "OrderPadGetByAccount");
      require(req.AccountCode, "AccountCode", "OrderPadGetByAccount");
      require(req.RequestID, "RequestID", "OrderPadGetByAccount");
      const result = await transport.call({
        method: "OrderPadGetByAccount",
        header: makeHeader({
          serviceSessionKey: req.ServiceSessionKey,
          requestID: req.RequestID,
          updates: req.Updates,
          timeout: 25,
          pageSize: 500,
          waitForResponse: true,
        }),
        parameters: {
          AccountCode: req.AccountCode,
          OrderFilter: req.OrderFilter,
        },
      });
      return mapResponse<Order>({
        header: result.header,
        dataRows: result.dataRows.map((r) => mapOrder(r)),
      });
    },

    async orderPadGetByAccountUpdates(req: { RequestID: string }): Promise<IressResponse<Order>> {
      require(req.RequestID, "RequestID", "OrderPadGetByAccountUpdates");
      const result = await transport.call({
        method: "OrderPadGetByAccountUpdates",
        header: makeHeader({
          serviceSessionKey: "",
          requestID: req.RequestID,
          waitForResponse: false,
        }),
        parameters: { RequestID: req.RequestID },
      });
      return mapResponse<Order>({
        header: result.header,
        dataRows: result.dataRows.map((r) => mapOrder(r)),
      });
    },

    async bookingGetByOrganisation2(req: {
      ServiceSessionKey: string;
      From: string;
      To: string;
      AccountCode?: string;
    }): Promise<IressResponse<{
      BookingNumber: string;
      TradeNumber: string;
      Symbol: string;
      BuySell: OrderSide;
      Volume: number;
      Price: number;
      MiscFees: { Code: string; Amount: number; Currency: string }[];
    }>> {
      require(req.ServiceSessionKey, "ServiceSessionKey", "BookingGetByOrganisation2");
      require(req.From, "From", "BookingGetByOrganisation2");
      require(req.To, "To", "BookingGetByOrganisation2");
      const result = await transport.call({
        method: "BookingGetByOrganisation2",
        header: makeHeader({
          serviceSessionKey: req.ServiceSessionKey,
          requestID: newRequestID("booking"),
          timeout: 60,
          pageSize: 500,
          waitForResponse: true,
        }),
        parameters: {
          From: req.From,
          To: req.To,
          AccountCode: req.AccountCode,
        },
      });
      return mapResponse({
        header: result.header,
        dataRows: result.dataRows.map((r) => {
          const str = (k: string) => String(r[k] ?? "");
          const num = (k: string) => Number(r[k] ?? 0);
          const feesRaw = r["MiscFees"];
          const fees: { Code: string; Amount: number; Currency: string }[] = [];
          if (feesRaw && typeof feesRaw === "object" && !Array.isArray(feesRaw)) {
            const f = feesRaw as Record<string, unknown>;
            const arr = f["Fee"];
            if (Array.isArray(arr)) {
              for (const x of arr) {
                const fee = x as Record<string, unknown>;
                fees.push({ Code: String(fee["Code"] ?? ""), Amount: Number(fee["Amount"] ?? 0), Currency: String(fee["Currency"] ?? "ZAR") });
              }
            } else if (arr && typeof arr === "object") {
              const fee = arr as Record<string, unknown>;
              fees.push({ Code: String(fee["Code"] ?? ""), Amount: Number(fee["Amount"] ?? 0), Currency: String(fee["Currency"] ?? "ZAR") });
            }
          }
          return {
            BookingNumber: str("BookingNumber"),
            TradeNumber: str("TradeNumber"),
            Symbol: str("Symbol") || str("SecurityCode"),
            BuySell: (num("BuySell") === 1 ? "BUY" : "SELL") as OrderSide,
            Volume: num("Volume"),
            Price: num("Price"),
            MiscFees: fees,
          };
        }),
      });
    },

    // ── portfolio (IPS) ────────────────────────────────────────────
    async ipsTransactionGetByAccount5(req: IPSTransactionGetByAccount5Request): Promise<IressResponse<{
      TransactionNumber: string;
      Date: string;
      Type: string;
      Symbol: string;
      Quantity: number;
      Price: number;
      Amount: number;
      Currency: string;
    }>> {
      require(req.ServiceSessionKey, "ServiceSessionKey", "IPSTransactionGetByAccount5");
      require(req.AccountCode, "AccountCode", "IPSTransactionGetByAccount5");
      require(req.DateFrom, "DateFrom", "IPSTransactionGetByAccount5");
      require(req.DateTo, "DateTo", "IPSTransactionGetByAccount5");
      const result = await transport.call({
        method: "IPSTransactionGetByAccount5",
        header: makeHeader({
          serviceSessionKey: req.ServiceSessionKey,
          requestID: newRequestID("ips-tx"),
          timeout: 60,
          pageSize: 500,
          waitForResponse: true,
        }),
        parameters: {
          AccountCode: req.AccountCode,
          DateFrom: req.DateFrom,
          DateTo: req.DateTo,
        },
      });
      return mapResponse({
        header: result.header,
        dataRows: result.dataRows.map((r) => {
          const str = (k: string) => String(r[k] ?? "");
          const num = (k: string) => Number(r[k] ?? 0);
          return {
            TransactionNumber: str("TransactionNumber"),
            Date: str("Date"),
            Type: str("Type"),
            Symbol: str("Symbol") || str("SecurityCode"),
            Quantity: num("Quantity"),
            Price: num("Price"),
            Amount: num("Amount"),
            Currency: str("Currency") || "ZAR",
          };
        }),
      });
    },

    /**
     * Returns every IPS account the user is entitled to. The live SOAP
     * client transparently loops using the last `AccountCode` as the
     * `PreviousAccountCode` cursor (legacy paging, see IPS docs). The
     * response is a single flat `IressResponse` whose `DataRows` holds
     * the full account list. If the user lacks the `IPSAccountGetAll1`
     * entitlement, the call throws `IressError(25014, …)` and `DataRows`
     * is empty.
     */
    async ipsAccountGetAll1(req: IPSAccountGetAll1Request): Promise<IressResponse<IPSAccountRow>> {
      require(req.ServiceSessionKey, "ServiceSessionKey", "IPSAccountGetAll1");
      const pageSize = req.PageSize ?? DEFAULT_LEGACY_PAGE_SIZE;
      const paged = await pagedFetchLegacyIps<IPSAccountRow>({
        transport,
        method: "IPSAccountGetAll1",
        serviceSessionKey: req.ServiceSessionKey,
        pageSize,
        methodLabel: "IPSAccountGetAll1",
        buildParameters: (cursor) => ({
          PageSize: pageSize,
          PreviousAccountCode: cursor ?? req.PreviousAccountCode ?? "",
        }),
        readCursor: (row) => String(row["AccountCode"] ?? ""),
      });
      return mapResponse<IPSAccountRow>({
        header: {
          ErrorNumber: paged.entitlementRequired ? 25014 : 0,
          ErrorDescription: paged.entitlementRequired
            ? "IPSAccountGetAll1 entitlement not enabled for this user"
            : "",
          PageCount: paged.totalPages,
        },
        dataRows: paged.dataRows,
      });
    },

    /**
     * Returns every open position across the user's IPS accounts, or — when
     * `AccountCode` is set — only that account's positions. Legacy paging:
     * loops using the last `SecurityCode` as the `PreviousSecurityCode`
     * cursor. If the user lacks `IPSPositionGetAll1`, throws
     * `IressError(25014, …)`.
     */
    async ipsPositionGetAll1(req: IPSPositionGetAll1Request): Promise<IressResponse<IPSPositionRow>> {
      require(req.ServiceSessionKey, "ServiceSessionKey", "IPSPositionGetAll1");
      const pageSize = req.PageSize ?? DEFAULT_LEGACY_PAGE_SIZE;
      const paged = await pagedFetchLegacyIps<IPSPositionRow>({
        transport,
        method: "IPSPositionGetAll1",
        serviceSessionKey: req.ServiceSessionKey,
        pageSize,
        methodLabel: "IPSPositionGetAll1",
        buildParameters: (cursor) => ({
          PageSize: pageSize,
          PreviousSecurityCode: cursor ?? req.PreviousSecurityCode ?? "",
          AccountCode: req.AccountCode ?? "",
        }),
        readCursor: (row) => String(row["SecurityCode"] ?? ""),
      });
      return mapResponse<IPSPositionRow>({
        header: {
          ErrorNumber: paged.entitlementRequired ? 25014 : 0,
          ErrorDescription: paged.entitlementRequired
            ? "IPSPositionGetAll1 entitlement not enabled for this user"
            : "",
          PageCount: paged.totalPages,
        },
        dataRows: paged.dataRows,
      });
    },

    // ── FIX+ ───────────────────────────────────────────────────────
    async targetIdGet(req: { ServiceSessionKey: string }): Promise<{ TargetID: string }[]> {
      require(req.ServiceSessionKey, "ServiceSessionKey", "TargetIDGet");
      const result = await transport.call({
        method: "TargetIDGet",
        header: makeHeader({
          serviceSessionKey: req.ServiceSessionKey,
          requestID: newRequestID("fix-tgt"),
          timeout: 25,
          waitForResponse: true,
        }),
        parameters: {},
      });
      return result.dataRows.map((r) => ({ TargetID: String(r["TargetID"] ?? "") })).filter((r) => r.TargetID);
    },

    async targetIdStatusGet(req: { ServiceSessionKey: string; TargetID: string }): Promise<{
      TargetID: string;
      Status: "CONNECTED" | "DISCONNECTED" | "ERROR";
      LastSeq: number;
      LastError?: string;
    }> {
      require(req.ServiceSessionKey, "ServiceSessionKey", "TargetIDStatusGet");
      require(req.TargetID, "TargetID", "TargetIDStatusGet");
      const result = await transport.call({
        method: "TargetIDStatusGet",
        header: makeHeader({
          serviceSessionKey: req.ServiceSessionKey,
          requestID: newRequestID("fix-status"),
          timeout: 25,
          waitForResponse: true,
        }),
        parameters: { TargetID: req.TargetID },
      });
      const r = result.firstRow ?? {};
      const status = String(r["Status"] ?? "DISCONNECTED").toUpperCase();
      return {
        TargetID: String(r["TargetID"] ?? req.TargetID),
        Status: status === "CONNECTED" || status === "ERROR" ? status : "DISCONNECTED",
        LastSeq: Number(r["LastSeq"] ?? 0),
        LastError: r["LastError"] ? String(r["LastError"]) : undefined,
      };
    },
  };
}

/**
 * Default singleton — used by `index.ts` when `IRESS_MODE=live` or
 * `IRESS_MODE=wsdl-stub`. Lazy: the SOAP transport is built on first call,
 * not on module import.
 */
export const liveIressClient: IressClient = createLiveIressClient();

/** Strip the `Header` from a request (helper for spreading parameters). */
function stripHeader<T extends { Header?: unknown }>(req: T): Record<string, unknown> {
  const { Header: _, ...rest } = req;
  void _;
  return rest as Record<string, unknown>;
}
