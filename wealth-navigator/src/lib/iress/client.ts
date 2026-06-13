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
  From?: string; // ISO date
  To?: string;
  Interval?: "tick" | "1m" | "5m" | "1h" | "1d";
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
