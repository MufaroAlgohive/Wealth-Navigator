// Mint OEMS — Iress V4 common types
// Generated from the Iress Web Services V4 Programmer's Guide, v1.0.
// Use as a starting point; reconcile with the live WSDL.

export type StatusCode = 1 | 2 | 3;

/* ─────────── Common request header ─────────── */

export interface RequestHeader {
  SessionKey?: string;
  ServiceSessionKey?: string;
  /** Default true */
  WaitForResponse?: boolean;
  /** Default 1000 */
  PageSize?: number;
  /** GUID */
  RequestID?: string;
  /** Default 25; 55 for IRESSSessionStart */
  Timeout?: number;
  /** Default false */
  Updates?: boolean;
  PagingBookmark?: Record<string, unknown>;
  /** Default 0 (forward). Backward is not implemented. */
  PagingDirection?: 0 | 1;
  InputLocalizationType?: number;
  OutputLocalizationType?: number;
}

export interface MethodRequest<P> {
  Input: {
    Header: RequestHeader;
    Parameters: P;
  };
}

/* ─────────── Common response header ─────────── */

export interface ResponseHeader {
  RequestID: string;
  StatusCode: StatusCode;
  WebServiceTimeStamp: string;
  PagingBookmark?: Record<string, unknown>;
}

export interface IressResponse<T> {
  Input?: unknown;
  Result?: {
    Header: ResponseHeader;
    HeaderRow?: unknown;
    DataRows?: T[];
    ErrorRows?: Array<{ ErrorNumber: number; ErrorMessage?: string; [k: string]: unknown }>;
  };
}

/* ─────────── SOAP fault ─────────── */

export interface IressFaultDetail {
  Message: string;
  /** Canonical error code — match on this, not the message. */
  Number: number;
  /** Opaque CDATA. For 25008 it contains <CurrentSessions>. */
  Context?: string;
  Service?: 'IRESS' | 'IOSPlus' | 'IPS' | 'FIXPlus';
  Server?: string;
  Method?: string;
  UserName?: string;
  CompanyName?: string;
  EndPoint?: string;
  RequestID?: string;
  SessionKey?: string;
  ServiceSessionKey?: string;
  WebServiceTimeStamp?: string;
  WebServiceServer?: string;
  WebServiceConnection?: string;
}

export interface IressSoapFault {
  faultcode: string;
  faultstring: string;
  detail: {
    IRESSFaultDetail: IressFaultDetail;
  };
}

/* ─────────── Session methods ─────────── */

export interface IRESSSessionStartParameters {
  UserName: string;
  CompanyName: string;
  Password: string;
  /** Must be unique per call. */
  ApplicationID: string;
  ApplicationLabel?: string;
  SessionTimeout?: number;
  AuthenticationType?: string;
  /** When the user is out of licenses, the session number to end. */
  SessionNumberToKick?: number;
  /** Use with SessionNumberToKick. */
  KickLikeSessions?: boolean;
  Locale?: string;
  LocalePrivateUseSubtags?: string;
}

export interface IRESSSessionStartResponseRow {
  IRESSSessionKey: string;
}

export type IRESSSessionStartResponse = IressResponse<IRESSSessionStartResponseRow>;

export interface ServiceSessionStartParameters {
  Service: 'IOSPlus' | 'IPS' | 'FIXPlus';
  Server: string;
}

export interface ServiceSessionStartResponseRow {
  ServiceSessionKey: string;
}

export type ServiceSessionStartResponse = IressResponse<ServiceSessionStartResponseRow>;

/* ─────────── Current sessions (from 25008 fault) ─────────── */

export interface CurrentSession {
  SessionNumber: number;
  LoginType: string;
  LoginDateTime: string;
  LoginDuration: string;
  ConnectionDescription: string;
  PhysicalDescription: string;
}

export interface CurrentSessions {
  Session: CurrentSession[];
}

/* ─────────── Order create ─────────── */

export type Side = 'BUY' | 'SELL';
export type OrderType = 'MKT' | 'LMT' | 'STP' | 'STP_LMT' | string;
export type TimeInForce = 'DAY' | 'GTC' | 'IOC' | 'FOK' | 'GTD';

export interface OrderCreate3Parameters {
  Order: {
    AccountCode: string;
    SecurityCode: string;
    Exchange: string;
    /** 1 = BUY, 2 = SELL — confirm with WSDL. */
    BuySell: 1 | 2;
    OrderType: OrderType;
    Volume: number;
    Price?: number;
    StopPrice?: number;
    Destination: string;
    TimeInForce?: TimeInForce;
    ExpiryDate?: string;
    /** Unique per intent. Provides idempotency. */
    OrderTag?: string;
    ExecutionInstructionsArray?: string[];
    ExecutionInstructionsDictionary?: Array<{ Key: string; Value: string }>;
    [k: string]: unknown;
  };
}

export interface OrderCreate3ResponseRow {
  OrderNumber: string;
  OrderTag?: string;
  ErrorNumber: number;
  ErrorMessage?: string;
  [k: string]: unknown;
}

export type OrderCreate3Response = IressResponse<OrderCreate3ResponseRow>;

/* ─────────── Misc fees ─────────── */

export enum MiscFeeType {
  Unknown = 0,
  Regulatory = 1,
  GST = 2,
  LocalCommission = 3,
  ExchangeFees = 4,
  Stamp = 5,
  Levy = 6,
  Other = 7,
  Markup = 8,
  ConsumptionTax = 9,
  PerTransaction = 10,
  Conversion = 11,
  Agent = 12,
  TransferFee = 13,
  SecurityLending = 14,
  Research = 15,
}

export enum MiscFeeBasis {
  Absolute = 0,
  PerUnit = 1,
  Percentage = 2,
}

export enum MiscFeePercentageOf {
  Commission = 0,
  OrderValue = 1,
}

export interface MiscFee {
  Set: 0 | 1;
  FeeType: MiscFeeType;
  FeeBasis: MiscFeeBasis;
  Properties?: MiscFeePercentageOf;
  FeeAmount: number;
  Currency: string;
  Display: 0 | 1;
  SWIFTQualifier: string;
}

/* ─────────── Order state ─────────── */

export type OrderState =
  | 'PENDING'
  | 'WORKING'
  | 'PARTIAL'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED'
  | string; // confirm state strings with the WSDL
