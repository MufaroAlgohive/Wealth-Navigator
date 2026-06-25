// IRESS V4 client — typed interface that mirrors the real SOAP method shapes.
// The mock implementation lives at `lib/iress/mock.ts`; the live SOAP client
// would live at `lib/iress/live.ts` and implement the same interface.
//
// See `Documentation & Vision/iress-v4-docs/` for the authoritative shape of
// every method below. The signatures here are deliberately close to the doc
// (verb names, parameter names, ordering) so the swap from mock → live is a
// 1-line config change.

import type {
  Bond,
  IressService,
  MoneyMarketInstrument,
  NewsItem,
  Order,
  OrderSide,
  OrderState,
  OrderType,
  OrderTIF,
  OrderDestination,
  Quote,
  SensItem,
  Strategy,
} from "@/types/iress";

/** Common request header (every V4 method takes one). */
export interface IressHeader {
  SessionKey: string;
  RequestID: string; // globally unique per active request
  Updates?: boolean;
  Timeout?: number; // seconds
  PageSize?: number;
  PagingBookmark?: string;
  PagingDirection?: 0 | 1 | 2; // 0=next, 1=prev, 2=first
  WaitForResponse?: boolean;
}

/** Standard response envelope. */
export interface IressResponse<T> {
  Header: {
    StatusCode: 1 | 2 | 3; // 1=more pages, 2=finished, 3=watching
    PagingBookmark?: string;
    ErrorNumber: number;
    ErrorDescription?: string;
  };
  HeaderRow?: Record<string, unknown>;
  DataRows: T[];
  /**
   * Raw, untyped rows as parsed from the SOAP body, parallel to `DataRows`.
   * Populated by the live adapter for `PricingQuoteGet` so the worker can
   * inspect the raw `LastPrice` / `PreviousClosePrice` fields when
   * deciding whether to write through a closed-market row whose mapped
   * `last` collapsed to 0.
   */
  RawDataRows?: Array<Record<string, unknown>>;
}

// ─── Session ─────────────────────────────────────────────────────────────

export interface IressSessionStartRequest {
  UserName: string;
  CompanyName: string;
  Password: string;
  ApplicationID: string; // Mint-OEMS-<env>-<node>-<guid>
  ApplicationLabel?: string;
  AuthenticationType?: "native" | "ldap" | "sso";
  SessionTimeout?: number; // minutes, max 1440
  SessionNumberToKick?: number; // -1 = force-close all
  KickLikeSessions?: boolean;
  Locale?: string; // en-ZA
}

export interface IressSessionStartResponse {
  IRESSSessionKey: string;
  SessionNumber: number;
  SessionTimeout: number;
  ApplicationID: string;
}

export interface ServiceSessionStartRequest {
  IRESSSessionKey: string;
  Service: IressService;
  Server: string; // e.g. IOSPLUSAPI, IPSAPI, FIXPLUSAPI
}

export interface ServiceSessionStartResponse {
  ServiceSessionKey: string;
  Service: IressService;
  Server: string;
}

// ─── Market data ─────────────────────────────────────────────────────────

export interface PricingQuoteGetRequest {
  Header: IressHeader;
  SecurityCode: string;
  Exchange: string;
  [k: string]: unknown;
}

export interface TimeSeriesGet2Request {
  Header: IressHeader;
  Code: string;
  Exchange?: string;
  /**
   * The IRESS data feed for this instrument's exchange. CONFIRMED live
   * (2026-06-16): the DataSource is exchange-specific, NOT account-global —
   * JSE equities/ETFs use `JSED`, but YFX bonds / bond indices (R2030, GOVI,
   * the ZAR govt yield curve) use `YFXD`. Sending `JSED` for a YFX instrument
   * returns "Invalid access" (error 5) — which we'd previously misread as an
   * entitlement wall. When omitted, the live client falls back to
   * `IRESS_TS_DATASOURCE` (default `JSED`).
   */
  DataSource?: string;
  From?: string; // ISO date
  To?: string;
  /**
   * V4 Frequency field as a Long. The empirical truth (June 2026) is
   * that the **live CT server** honours `<Frequency>` (Long) on the
   * wire — not the `<Interval>` string the V4 WSDL sample documents.
   * Earlier code that sent `Frequency: 0` / `Frequency: 8` was
   * rejected with `soap:Receiver — Invalid Parameter Value: <n> as
   * Frequency` only because those specific Long values were wrong; the
   * actual daily-bucket Long is documented in
   * `wealth-navigator/docs/TIMESERIES_PROBE_REPORT_FINAL.md` (and
   * surfaced via the worker's `timeSeriesFrequencyLong()` mapper).
   *
   * The V4 WSDL sample payload — kept for reference — is:
   *
   *   <Parameters>
   *     <Code>SHP</Code>
   *     <Exchange>JSE</Exchange>
   *     <DateFrom>2025-01-01</DateFrom>
   *     <DateTo>2025-12-12</DateTo>
   *     <Interval>Daily</Interval>
   *   </Parameters>
   *
   * When `Frequency` is set, the live client sends `<Frequency>N</Frequency>`.
   * When `Interval` is set, the live client sends `<Interval>Daily</Interval>`
   * (etc.). If both are set, `Frequency` wins. If neither is set, the live
   * client throws 25018 (missing required field). Worker-friendly tokens
   * ("1d" | "1h" | "5m" | "1m" | "tick" | "1w" | "1mo" | "1q" | "1y") are
   * converted to the wire Long by `timeSeriesFrequencyLong()` in the worker
   * before sending.
   *
   * Spec: `Documentation & Vision/iress-v4-docs/05-services/market-data/02-time-series-get-2.md`.
   */
  Frequency?: number;
  /**
   * Legacy V4 string-enum form of the period selector. The WSDL sample
   * uses `<Interval>Daily</Interval>`, and some IRESS server builds may
   * still require it (kept as a fallback for the worker + probe). On the
   * live CT server the `Frequency` Long is the accepted shape — this
   * field is only sent when `Frequency` is unset.
   */
  Interval?: string;
  /** Optional point cap — fetch the last N points when no date range is given. */
  NumberOfPoints?: number;
  /** Optional single point-in-time (doc lists `Date` as an alternative to From/To). */
  Date?: string;
}

export interface SecuritySearchGetRequest {
  Header: IressHeader;
  /** Free-text search; do NOT combine with a SecurityCode (faults 10065). */
  SearchText: string;
}

// ─── News (Iress Pro) ────────────────────────────────────────────────────

/**
 * Known `NewsVendorGet` vendor codes (per V4 spec).
 *
 * Charles confirmed 2026-06-25 that `NewsVendorGet` is the correct method for
 * Market Data / News; the vendor parameter selects which vendor's feed to
 * query. The SA-flavoured OEMS mostly cares about `SENS` (JSE Stock Exchange
 * News Service) and `IRESS` (broker-sourced general news). Defaults to
 * `SENS` in the live client; the mock + probe accept any of these.
 *
 * Note: this is the V4 vendor *enum*, NOT the `NewsItem.source` taxonomy on
 * the typed `NewsItem` interface (`Reuters | Bloomberg | Moneyweb | ...`).
 * The mapper below collapses whatever the row reports into the matching
 * `NewsItem.source` value where possible, falling back to `IRESS`.
 */
export type NewsVendor =
  | "SENS"
  | "IRESS"
  | "Reuters"
  | "Bloomberg"
  | "Moneyweb"
  | "Dow Jones"
  | "Business Day";

export interface NewsVendorGetRequest {
  Header: IressHeader;
  /** Vendor code — e.g. "SENS", "IRESS", "Reuters". Required; "" faults 25018. */
  Vendor: NewsVendor | string;
  /**
   * Optional per-vendor parameters. V4 spec accepts a free-form `<Parameters>`
   * block (Charles' example was empty). Common sub-keys:
   *   - `Category`      — narrow to a SENS category (RESULTS, DIVIDEND, …)
   *   - `SecurityCode`  — single-symbol filter (RIC or IRESS code)
   *   - `From` / `To`   — ISO timestamp range
   *   - `MaxResults`    — cap; the global `<PageSize>` also applies
   * The live client sends whatever the caller supplies — no server-side
   * validation here (the SOAP layer is the source of truth).
   */
  Parameters?: Record<string, unknown>;
}

/**
 * Normalised `NewsVendorGet` row. Only fields the schema is known to
 * return are surfaced; entitlement-blocked fields (story body, RIC list,
 * etc.) are TODO-marked and surfaced as `null` until a live probe confirms
 * what the CT build returns.
 */
export interface NewsStory {
  /** IRESS story id (string — V4 doesn't pin a numeric type). */
  StoryId: string;
  /** Headline text. Confirmed live on every IRESS Pro build. */
  Headline: string;
  /** Vendor code as reported by the row (often "SENS", "Reuters", …). */
  Source: string;
  /** Story timestamp (ISO 8601 string from V4, parsed to ms). */
  Timestamp: string;
  /** ISO → epoch ms convenience copy; 0 when unparseable. */
  ts: number;
  /**
   * Full story body. ENTITLEMENT-DEPENDENT — the DFM@Mint profile may only
   * return headlines; we keep the field but emit `null` until a live probe
   * confirms. See worker `/debug/news-vendor-probe` for verification.
   */
  Story?: string | null;
  /**
   * RICs / IRESS codes the story is attached to (free-form string list).
   * TODO(entitlement): confirm with a probe; expected empty on CT headine-only.
   */
  RelatedCodes?: string[];
  /** Vendor-specific category label (e.g. SENS category). TODO: typed map. */
  Category?: string | null;
  /** Free-form pass-through for any field we haven't normalised. */
  [k: string]: unknown;
}

export interface SecuritySearchRow {
  SecurityCode: string;
  Exchange: string;
  /** e.g. "REPUBLIC OF SA 8% 31.01.2030" — carries coupon + maturity for bonds. */
  SecurityDescription?: string;
  /** 100=equity, 112=ETF, 401=bond, 606=spot-bond, 700=index, … */
  SecurityType?: number;
  ISIN?: string;
  IssuerName?: string;
  [k: string]: unknown;
}

// ─── Trading (IOS+) ─────────────────────────────────────────────────────

export interface NewOrder {
  AccountCode: string;
  SecurityCode: string;
  Exchange: string;
  BuySell: 1 | 2; // 1=BUY, 2=SELL
  OrderType: "MKT" | "LMT" | "STP" | "STP_LMT";
  Volume: number;
  Price?: number;
  TriggerPrice?: number;
  Destination: string;
  TimeInForce: "DAY" | "IOC" | "FOK" | "GTC";
  // Extras (contingent / algo) omitted for v2.0
  ExpiryDate?: string;
}

export interface OrderCreate3Request {
  ServiceSessionKey: string;
  Order: NewOrder;
  OrderTag: string; // IDEMPOTENCY — UUID, mandatory
}

export interface OrderCreate3Response {
  OrderNumber: string;
  Status: "WORKING" | "REJECTED";
  ErrorNumber?: number;
  ErrorDescription?: string;
}

export interface OrderAmend2Request {
  ServiceSessionKey: string;
  OrderNumber: string;
  Volume?: number;
  Price?: number;
  TriggerPrice?: number;
  TimeInForce?: "DAY" | "IOC" | "FOK" | "GTC";
}

export interface OrderDeleteRequest {
  ServiceSessionKey: string;
  OrderNumber: string;
}

export interface OrderPadFilter {
  AccountCode: string;
  OrderFilter: 1 | 2 | 3 | 4 | 5; // 1=working, 2=filled today, 3=all, 4=inactive, 5=active
}

// ─── Portfolio (IPS) ────────────────────────────────────────────────────

export interface IPSTransactionGetByAccount5Request {
  ServiceSessionKey: string;
  AccountCode: string;
  DateFrom: string;
  DateTo: string;
}

/**
 * Legacy IPS methods (`IPSAccountGetAll1`, `IPSPositionGetAll1`) expose their
 * paging cursor inside the `<Parameters>` block (`PreviousAccountCode` /
 * `PreviousSecurityCode`) rather than the standard V4 header. See
 * `Documentation & Vision/iress-v4-docs/03-paging-and-updates/04-paging-in-ips.md`.
 * The live SOAP client handles the cursor dance in a `pagedFetch` wrapper —
 * callers just see a flat `DataRows` array.
 */
export interface IPSAccountGetAll1Request {
  ServiceSessionKey: string;
  /** Max rows per page. CT accepts up to 500. */
  PageSize?: number;
  /** Cursor from the previous page's last `AccountCode`. Empty / "?" starts. */
  PreviousAccountCode?: string;
}

export interface IPSAccountRow {
  AccountCode: string;
  AccountName?: string;
  AccountType?: string;
  Currency?: string;
  BaseCurrency?: string;
  Beneficiary?: string;
  /** Free-form V4 row payload — kept so the worker can persist the full IRESS response. */
  [k: string]: unknown;
}

export interface IPSPositionGetAll1Request {
  ServiceSessionKey: string;
  /** Max rows per page. CT accepts up to 500. */
  PageSize?: number;
  /** Cursor from the previous page's last `SecurityCode`. Empty / "?" starts. */
  PreviousSecurityCode?: string;
  /** Optional AccountCode filter — when set, only positions for that account are returned. */
  AccountCode?: string;
}

export interface IPSPositionRow {
  AccountCode: string;
  SecurityCode: string;
  Exchange?: string;
  Quantity?: number;
  /** Average open cost (currency-native, not cents). */
  OpenAveragePrice?: number;
  /** Mark-to-market value, currency-native. */
  MarketValue?: number;
  Currency?: string;
  /** Trade date of the opening lot, ISO. */
  OpenDate?: string;
  [k: string]: unknown;
}

export interface IressClient {
  // ── session ──────────────────────────────────────────────────────
  iressSessionStart(req: IressSessionStartRequest): Promise<IressSessionStartResponse>;
  iressSessionEnd(req: { IRESSSessionKey: string }): Promise<void>;
  serviceSessionStart(req: ServiceSessionStartRequest): Promise<ServiceSessionStartResponse>;
  serviceSessionEnd(req: { ServiceSessionKey: string }): Promise<void>;

  // ── market data ─────────────────────────────────────────────────
  pricingQuoteGet(req: PricingQuoteGetRequest): Promise<IressResponse<Quote>>;
  pricingQuoteGetUpdates(req: { RequestID: string }): Promise<IressResponse<Quote>>;
  timeSeriesGet2(req: TimeSeriesGet2Request): Promise<IressResponse<{ t: number; v: number }>>;
  timeSeriesGet2Updates(req: { RequestID: string }): Promise<IressResponse<{ t: number; v: number }>>;
  /**
   * Security reference-data search. CONFIRMED callable on the CT build
   * (2026-06-16) — it's how we discover the IRESS code / Exchange / SecurityType
   * for an instrument (e.g. govt bonds on YFX, ETFs on JSE) and read the
   * `SecurityDescription` (coupon + maturity for bonds). `SearchText` only —
   * combining it with `SecurityCode` faults (10065). Base IRIS session.
   */
  securitySearchGet(req: SecuritySearchGetRequest): Promise<IressResponse<SecuritySearchRow>>;

  /**
   * Market data / news headlines & bodies via the IRESS Pro News service.
   * Charles Ntjana confirmed 2026-06-25 that `NewsVendorGet` is the V4 verb
   * for Market Data and News. Runs on the base IRIS session (no IOS+/IPS/
   * FIX+ service session needed).
   *
   * Entitlement gate: the user's IRESS profile must include `NewsVendorGet`
   * (Charles has to enable). 25010 / 25034 → `IressError(…)` bubbles up;
   * the BFF surfaces it as an `unconfigured` empty state.
   *
   * T5 (vendor content) policy: this client is **read-only** — the worker
   * does NOT persist the response to Supabase. The BFF proxies the response
   * through as a Path B passthrough; news panels show `UNCONFIGURED` when
   * the source is unconfigured and never fall back to seed.
   *
   * Spec: `Documentation & Vision/iress-v4-docs/05-services/market-data/03-news-vendor-get.md`
   * (to be created on first probe confirmation).
   */
  newsVendorGet(req: NewsVendorGetRequest): Promise<IressResponse<NewsStory>>;

  // ── trading (IOS+) ──────────────────────────────────────────────
  orderCreate3(req: OrderCreate3Request): Promise<OrderCreate3Response>;
  orderAmend2(req: OrderAmend2Request): Promise<{ OrderNumber: string }>;
  orderDelete(req: OrderDeleteRequest): Promise<void>;
  /**
   * Recovery lookup — given the `OrderTag` (UUID the OEMS minted) we sent
   * in `OrderCreate3`, return the broker-assigned `OrderNumber`. The BFF
   * uses this after a transport-level failure (HTTP 500, timeout, TCP RST)
   * to resolve the actual broker state of a tag we may have already
   * accepted. Returns the empty `OrderNumber` when the tag is unknown to
   * IRESS — the BFF treats that as a hard reject.
   *
   * Spec: `iress-v4-docs/10-reference/quick-reference/00-master.md`.
   */
  orderNoGetByOrderTag(req: {
    ServiceSessionKey: string;
    OrderTag: string;
  }): Promise<{ OrderNumber: string; OrderTag: string }>;
  orderPadGetByAccount(req: {
    ServiceSessionKey: string;
    AccountCode: string;
    OrderFilter: 1 | 2 | 3 | 4 | 5;
    Updates?: boolean;
    RequestID: string;
  }): Promise<IressResponse<Order>>;
  orderPadGetByAccountUpdates(req: { RequestID: string }): Promise<IressResponse<Order>>;
  bookingGetByOrganisation2(req: {
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
  }>>;

  // ── portfolio (IPS) ─────────────────────────────────────────────
  ipsTransactionGetByAccount5(req: IPSTransactionGetByAccount5Request): Promise<IressResponse<{
    TransactionNumber: string;
    Date: string;
    Type: string;
    Symbol: string;
    Quantity: number;
    Price: number;
    Amount: number;
    Currency: string;
  }>>;

  /**
   * Returns every IPS account the user is entitled to see. Legacy paging —
   * the live SOAP client transparently loops using the last `AccountCode` as
   * the `PreviousAccountCode` cursor; callers receive a single flat
   * response whose `DataRows` is the full account set.
   *
   * Entitlement: the user's IRESS profile must include `IPSAccountGetAll1`
   * (Charles has to enable). 25014 → `IressError(25014, …)` bubbles up.
   */
  ipsAccountGetAll1(req: IPSAccountGetAll1Request): Promise<IressResponse<IPSAccountRow>>;

  /**
   * Returns every open position across the user's IPS accounts, or — when
   * `AccountCode` is set — only that account's positions. Legacy paging —
   * the live client loops using the last `SecurityCode` as the
   * `PreviousSecurityCode` cursor; callers see a single flat response.
   *
   * Entitlement: `IPSPositionGetAll1`. 25014 → `IressError(25014, …)`.
   */
  ipsPositionGetAll1(req: IPSPositionGetAll1Request): Promise<IressResponse<IPSPositionRow>>;

  // ── FIX+ ────────────────────────────────────────────────────────
  targetIdGet(req: { ServiceSessionKey: string }): Promise<{ TargetID: string }[]>;
  targetIdStatusGet(req: { ServiceSessionKey: string; TargetID: string }): Promise<{
    TargetID: string;
    Status: "CONNECTED" | "DISCONNECTED" | "ERROR";
    LastSeq: number;
    LastError?: string;
  }>;
}

/** Re-export common types for app code. */
export type {
  Bond,
  MoneyMarketInstrument,
  NewsItem,
  Order,
  OrderSide,
  OrderState,
  OrderType,
  OrderTIF,
  OrderDestination,
  Quote,
  SensItem,
  Strategy,
};
