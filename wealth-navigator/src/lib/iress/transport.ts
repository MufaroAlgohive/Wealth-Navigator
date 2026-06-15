// Thin SOAP 1.1 transport for the IRESS V4 web services.
//
// This module deliberately avoids the heavy `soap` / `strong-soap` npm packages.
// The V4 WSDLs aren't available on disk — the typed `IressClient` interface in
// `client.ts` is the contract — and the envelope shape is small and stable:
// every method takes an `<Input><Header/><Parameters/></Input>` body and
// returns a `<MethodResponse><Output><Result><Header/><DataRows/></Result>/
// </Output></MethodResponse>` envelope. We construct and parse that over HTTPS
// with the platform `fetch` and a fast XML parser.
//
// All SOAP faults are translated into `IressError` with the V4 `ErrorNumber`
// (e.g. 25001 = invalid credentials, 25029 = order not found, 666 = system
// fault) so the rest of the app can match on a single error type.
//
// The transport is injectable — `createSoapTransport({ baseUrl, fetchImpl })`
// returns a small object with one method (`call`). Tests can pass a fake
// `fetchImpl` to assert envelope construction without hitting the network.

import { XMLParser } from "fast-xml-parser";

import { IressError } from "@/lib/iress/errors";

/** IRESS V4 SOAP namespaces. */
export const IRESS_NS = "http://webservices.iress.com.au/v4/";
export const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";

/** Per-method override of which XML element holds the success payload. */
export interface SoapCallSpec {
  /** SOAP method name, e.g. `IRESSSessionStart`. */
  method: string;
  /** Header object — flattened into `<Header>...</Header>`. */
  header: Record<string, string | number | boolean | undefined>;
  /** Parameters object — flattened into `<Parameters>...</Parameters>`. */
  parameters: Record<string, unknown>;
  /** Override the response element name (default = `${method}Response`). */
  responseElement?: string;
}

export interface SoapCallResult {
  /** Parsed result element (whatever the method returns inside `<Result>`). */
  result: Record<string, unknown>;
  /** Echo'd header values (`RequestID`, etc.). */
  header: Record<string, unknown>;
  /** All `DataRow` entries, in document order. */
  dataRows: Array<Record<string, unknown>>;
  /** Single-row convenience accessor (true for most V4 methods). */
  firstRow: Record<string, unknown> | undefined;
  /** Web-service time stamp string (when present). */
  webServiceTimeStamp?: string;
}

export interface SoapTransport {
  /** Send a SOAP call and return the typed result. Throws `IressError` on fault. */
  call(spec: SoapCallSpec): Promise<SoapCallResult>;
}

export interface CreateSoapTransportOptions {
  /** Base URL — no trailing slash, e.g. `https://webservices-ct.iress.co.za/v4`. */
  baseUrl: string;
  /** Injected fetch (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Extra SOAP headers (e.g. for auth / WS-Security). */
  extraHeaders?: Record<string, string>;
  /** Per-call request timeout in milliseconds. */
  timeoutMs?: number;
}

// ─── XML helpers ──────────────────────────────────────────────────────────

/** Compact, deterministic value → XML string. */
function xmlValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return escapeXml(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    // Array of primitives → space-separated inline (matches V4's typical
    // list-of-string encoding). Array of objects → caller should pre-stringify.
    return v.map((x) => (typeof x === "string" || typeof x === "number" ? String(x) : "")).join(" ");
  }
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `<${k}>${xmlValue(val)}</${k}>`)
      .join("");
  }
  return escapeXml(String(v));
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function tag(name: string, attrs: Record<string, string> = {}, body = ""): string {
  const a = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`)
    .join("");
  return body ? `<${name}${a}>${body}</${name}>` : `<${name}${a}/>`;
}

/** Build the request envelope XML for a single IRESS V4 method call. */
export function buildSoapEnvelope(spec: SoapCallSpec): string {
  const headerXml = Object.entries(spec.header)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `<${k}>${xmlValue(v)}</${k}>`)
    .join("");
  const paramsXml = xmlValue(spec.parameters);
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="${SOAP_NS}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">` +
    `<soap:Body>` +
    tag(
      spec.method,
      { xmlns: IRESS_NS },
      tag(
        "Input",
        {},
        `${tag("Header", {}, headerXml)}${tag("Parameters", {}, paramsXml)}`,
      ),
    ) +
    `</soap:Body>` +
    `</soap:Envelope>`
  );
}

// ─── Parser ───────────────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: false,
  parseAttributeValue: true,
  parseTagValue: true,
  trimValues: true,
  // Don't coerce text "0" / "false" into numbers/booleans blindly — V4 uses
  // string "true"/"false" for booleans and we want to keep numeric strings
  // numeric only when the type was numeric in the XSD.
  numberParseOptions: { hex: false, leadingZeros: false },
});

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

function readNumber(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function readString(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** Read a possibly-array element from a parsed-XML object (single child). */
function first(v: unknown): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return asRecord(v[0]);
  return asRecord(v);
}

/** Extract a list of records from `<X><Row>...</Row><Row>...</Row></X>`. */
function rows(v: unknown): Array<Record<string, unknown>> {
  if (v === undefined || v === null) return [];
  const rec = asRecord(v);
  const raw = rec["Row"] ?? rec["DataRow"];
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map((r) => asRecord(r));
  return [asRecord(raw)];
}

// ─── Fault translation ────────────────────────────────────────────────────

function readFault(detailNode: Record<string, unknown>): { number: number; message: string } {
  // IRESSFaultDetail (V4 namespaced) or a generic detail
  const detail = asRecord(detailNode);
  const iressDetail = first(detail["IRESSFaultDetail"]) ?? detail;
  const number = readNumber(iressDetail["Number"], 666);
  const message = readString(iressDetail["Message"]) || "IRESS SOAP fault";
  return { number, message };
}

/** Collapse a (possibly HTML/XML) error body to a single, bounded log line. */
function summariseRawBody(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const flat = raw.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > 600 ? `${flat.slice(0, 600)}…` : flat;
}

function throwFault(
  method: string,
  fault: { faultcode?: string; faultstring?: string; detail?: Record<string, unknown> } | undefined,
  status: number,
  rawBody?: string,
): never {
  const code = fault?.faultcode ? readString(fault.faultcode) : "soap:Receiver";
  const fallback = fault?.faultstring ? readString(fault.faultstring) : `HTTP ${status}`;
  const { number, message } = fault?.detail
    ? readFault(fault.detail)
    : { number: 666, message: fallback };
  // The V4 error table covers 25001-25035 + 666; anything else is a system fault.
  // When the server returns a contentless 500 (no faultstring/detail), the raw
  // response body is the only place the real reason lives (e.g. "not entitled"
  // / "unknown server") — surface it so callers can log it verbatim.
  const rawSummary = summariseRawBody(rawBody);
  const detailSuffix = !fault?.detail && rawSummary && rawSummary !== fallback ? ` [body: ${rawSummary}]` : "";
  const e = new IressError(number, method, `${code} — ${message}${detailSuffix}`);
  // Tag extra context for loggers without losing the typed shape.
  (e as Error & { soapFault?: unknown }).soapFault = { code, fallback, status, rawBody: rawSummary };
  throw e;
}

// ─── Transport factory ────────────────────────────────────────────────────

/**
 * Create a SOAP 1.1 transport. The transport is stateful only in the
 * sense that it remembers the base URL and headers — there is no per-call
 * connection state to manage, so this is safe to share across requests.
 */
export function createSoapTransport(opts: CreateSoapTransportOptions): SoapTransport {
  const { baseUrl, fetchImpl = globalThis.fetch.bind(globalThis), extraHeaders = {}, timeoutMs = 30_000 } = opts;
  if (!baseUrl) {
    throw new IressError(25018, "CreateSoapTransport", "IRESS_BASE_URL is not set");
  }
  const endpoint = baseUrl.replace(/\/+$/, "") + "/SOAP.aspx";

  async function call(spec: SoapCallSpec): Promise<SoapCallResult> {
    const envelope = buildSoapEnvelope(spec);
    const headers: Record<string, string> = {
      "Content-Type": 'text/xml; charset="utf-8"',
      SOAPAction: `"${IRESS_NS}${spec.method}"`,
      Accept: "text/xml",
      ...extraHeaders,
    };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: envelope,
        signal: ctl.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new IressError(666, spec.method, `SOAP transport failure: ${message}`);
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) {
      // Try to extract an IRESSFaultDetail from the body anyway.
      const text = await res.text().catch(() => "");
      let fault: { faultcode?: string; faultstring?: string; detail?: Record<string, unknown> } | undefined;
      try {
        const parsed = xmlParser.parse(text);
        const env = asRecord(asRecord(parsed["soap:Envelope"])["soap:Body"]);
        fault = asRecord(env["soap:Fault"]);
      } catch {
        // ignore — we'll throw a generic fault
      }
      throwFault(spec.method, fault, res.status, text);
    }
    const text = await res.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = xmlParser.parse(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new IressError(666, spec.method, `SOAP response parse failure: ${message}`);
    }
    const env = asRecord(asRecord(parsed["soap:Envelope"])["soap:Body"]);
    const faultNode = first(env["soap:Fault"]);
    if (faultNode) {
      const fault = asRecord(faultNode);
      const detail = first(fault["detail"]);
      throwFault(spec.method, { ...fault, detail }, 500, text);
    }
    const responseName = spec.responseElement ?? `${spec.method}Response`;
    const responseNode = asRecord(env[responseName] ?? env[`${IRESS_NS}${responseName}`] ?? {});
    const output = first(responseNode["Output"]) ?? responseNode;
    const result = first(output["Result"]) ?? output;
    const headerNode = first(result["Header"]) ?? {};
    const dataRowsNode = first(result["DataRows"]) ?? result["DataRows"] ?? {};
    const dataRows = rows(dataRowsNode);
    return {
      result: asRecord(result),
      header: asRecord(headerNode),
      dataRows,
      firstRow: dataRows[0],
      webServiceTimeStamp: readString(headerNode["WebServiceTimeStamp"]) || undefined,
    };
  }

  return { call };
}

// ─── Helpers for callers ─────────────────────────────────────────────────

/** Build a V4 `<Header>` object, including the standard paged/watch fields. */
export function makeHeader(input: {
  sessionKey?: string;
  serviceSessionKey?: string;
  requestID: string;
  updates?: boolean;
  timeout?: number;
  pageSize?: number;
  pagingBookmark?: string;
  pagingDirection?: 0 | 1 | 2;
  waitForResponse?: boolean;
}): Record<string, string | number | boolean | undefined> {
  const out: Record<string, string | number | boolean | undefined> = {};
  // The Iress session uses `SessionKey`; IOS+/IPS/FIX+ use `ServiceSessionKey`.
  if (input.sessionKey !== undefined) out.SessionKey = input.sessionKey;
  if (input.serviceSessionKey !== undefined) out.ServiceSessionKey = input.serviceSessionKey;
  out.RequestID = input.requestID;
  if (input.updates !== undefined) out.Updates = input.updates;
  if (input.timeout !== undefined) out.Timeout = input.timeout;
  if (input.pageSize !== undefined) out.PageSize = input.pageSize;
  if (input.pagingBookmark !== undefined) out.PagingBookmark = input.pagingBookmark;
  if (input.pagingDirection !== undefined) out.PagingDirection = input.pagingDirection;
  if (input.waitForResponse !== undefined) out.WaitForResponse = input.waitForResponse;
  return out;
}

/** Read an integer scalar from a result header (e.g. ErrorNumber). */
export function readResultHeaderNumber(row: Record<string, unknown>, key: string): number {
  return readNumber(row[key], 0);
}

/** Read a string scalar from a result row, defaulting to empty string. */
export function readResultRowString(row: Record<string, unknown>, key: string): string {
  return readString(row[key]);
}
