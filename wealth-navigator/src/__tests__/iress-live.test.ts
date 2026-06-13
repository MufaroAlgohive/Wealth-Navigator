import { afterEach, describe, expect, it, vi } from "vitest";

import type { IressClient } from "@/lib/iress/client";
import { IressError } from "@/lib/iress/errors";
import { createLiveIressClient, liveIressClient, describeQuoteRowKeys, describeQuoteRowNumericFields, iressQuotePriceScale, quoteRawRowHasPriceData, quoteRawRowLast, resolveQuoteLast } from "@/lib/iress/live";
import { IRESS_NS, type SoapTransport, buildSoapEnvelope } from "@/lib/iress/transport";

// ─── 1. Env-var detection in `index.ts` ─────────────────────────────────

const METHOD_NAMES: Array<keyof IressClient> = [
  "iressSessionStart",
  "iressSessionEnd",
  "serviceSessionStart",
  "serviceSessionEnd",
  "pricingQuoteGet",
  "pricingQuoteGetUpdates",
  "timeSeriesGet2",
  "timeSeriesGet2Updates",
  "orderCreate3",
  "orderAmend2",
  "orderDelete",
  "orderNoGetByOrderTag",
  "orderPadGetByAccount",
  "orderPadGetByAccountUpdates",
  "bookingGetByOrganisation2",
  "ipsTransactionGetByAccount5",
  "ipsAccountGetAll1",
  "ipsPositionGetAll1",
  "targetIdGet",
  "targetIdStatusGet",
];

describe("index.ts env-var detection", () => {
  const ORIGINAL_ENV = process.env.IRESS_MODE;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      process.env.IRESS_MODE = undefined;
    } else {
      process.env.IRESS_MODE = ORIGINAL_ENV;
    }
    vi.resetModules();
  });

  it("returns the mock client when IRESS_MODE is unset", async () => {
    process.env.IRESS_MODE = undefined;
    vi.resetModules();
    const [mod, { mockIressClient: mock }] = await Promise.all([
      import("@/lib/iress/index"),
      import("@/lib/iress/mock"),
    ]);
    expect(mod.iress).toBe(mock);
  });

  it("returns the mock client when IRESS_MODE=mock", async () => {
    process.env.IRESS_MODE = "mock";
    vi.resetModules();
    const [mod, { mockIressClient: mock }] = await Promise.all([
      import("@/lib/iress/index"),
      import("@/lib/iress/mock"),
    ]);
    expect(mod.iress).toBe(mock);
  });

  it("returns the live client when IRESS_MODE=live", async () => {
    process.env.IRESS_MODE = "live";
    vi.resetModules();
    const [mod, { liveIressClient: live }, { mockIressClient: mock }] = await Promise.all([
      import("@/lib/iress/index"),
      import("@/lib/iress/live"),
      import("@/lib/iress/mock"),
    ]);
    expect(mod.iress).toBe(live);
    expect(mod.iress).not.toBe(mock);
  });

  it("returns the live client when IRESS_MODE=wsdl-stub (same SOAP transport)", async () => {
    process.env.IRESS_MODE = "wsdl-stub";
    vi.resetModules();
    const [mod, { liveIressClient: live }] = await Promise.all([
      import("@/lib/iress/index"),
      import("@/lib/iress/live"),
    ]);
    expect(mod.iress).toBe(live);
  });

  it("getIressClient() returns the right adapter for an explicit mode", async () => {
    vi.resetModules();
    const [mod, { mockIressClient: mock }, { liveIressClient: live }] = await Promise.all([
      import("@/lib/iress/index"),
      import("@/lib/iress/mock"),
      import("@/lib/iress/live"),
    ]);
    expect(mod.getIressClient("mock")).toBe(mock);
    expect(mod.getIressClient("live")).toBe(live);
    expect(mod.getIressClient("wsdl-stub")).toBe(live);
  });
});

// ─── 2. liveIressClient is a valid IressClient (object shape) ───────────

describe("liveIressClient shape", () => {
  it("exports an object", () => {
    expect(liveIressClient).toBeDefined();
    expect(typeof liveIressClient).toBe("object");
  });

  it("has every one of the 18 IressClient methods", () => {
    for (const name of METHOD_NAMES) {
      expect(liveIressClient, `missing method ${name}`).toHaveProperty(name);
      expect(typeof (liveIressClient as unknown as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("createLiveIressClient() returns a fresh object with the same 18 methods", () => {
    const fresh = createLiveIressClient();
    for (const name of METHOD_NAMES) {
      expect(fresh).toHaveProperty(name);
      expect(typeof (fresh as unknown as Record<string, unknown>)[name]).toBe("function");
    }
  });
});

// ─── 3. Each of the 17 methods throws IressError when validation fails ──
//
// We call every method with a deliberately-bad payload and expect an
// `IressError` rejection. No network is touched — validation runs before
// the first `await`.

describe("validation — every method throws IressError on bad input", () => {
  // We inject a transport that would explode if called — proving that the
  // error comes from validation, not from the SOAP stack.
  const SENTINEL = new Error("transport should not be reached for bad input");
  const fakeClient = createLiveIressClient({
    transport: { call: () => Promise.reject(SENTINEL) },
  });

  it("iressSessionStart — missing UserName", async () => {
    await expect(
      fakeClient.iressSessionStart({
        UserName: "",
        CompanyName: "MINT",
        Password: "x",
        ApplicationID: "Mint-OEMS-Dev-web-1-abc",
      }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("iressSessionStart — missing Password", async () => {
    await expect(
      fakeClient.iressSessionStart({
        UserName: "akhumalo",
        CompanyName: "MINT",
        Password: "",
        ApplicationID: "Mint-OEMS-Dev-web-1-abc",
      }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("iressSessionEnd — missing IRESSSessionKey", async () => {
    await expect(fakeClient.iressSessionEnd({ IRESSSessionKey: "" })).rejects.toBeInstanceOf(IressError);
  });

  it("serviceSessionStart — missing IRESSSessionKey", async () => {
    await expect(
      fakeClient.serviceSessionStart({ IRESSSessionKey: "", Service: "IOSPlus", Server: "IOSPLUSAPI" }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("serviceSessionStart — missing Service", async () => {
    await expect(
      fakeClient.serviceSessionStart({ IRESSSessionKey: "k", Service: "" as never, Server: "IOSPLUSAPI" }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("serviceSessionEnd — missing ServiceSessionKey", async () => {
    await expect(fakeClient.serviceSessionEnd({ ServiceSessionKey: "" })).rejects.toBeInstanceOf(IressError);
  });

  it("pricingQuoteGet — missing Header.SessionKey", async () => {
    await expect(
      fakeClient.pricingQuoteGet({
        Header: { SessionKey: "", RequestID: "r1" },
        SecurityCode: "NPN",
        Exchange: "JSE",
      }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("pricingQuoteGet — missing SecurityCode", async () => {
    await expect(
      fakeClient.pricingQuoteGet({
        Header: { SessionKey: "k", RequestID: "r1" },
        SecurityCode: "",
        Exchange: "JSE",
      }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("pricingQuoteGetUpdates — missing RequestID", async () => {
    await expect(fakeClient.pricingQuoteGetUpdates({ RequestID: "" })).rejects.toBeInstanceOf(IressError);
  });

  it("timeSeriesGet2 — missing Header.SessionKey", async () => {
    await expect(
      fakeClient.timeSeriesGet2({
        Header: { SessionKey: "", RequestID: "r1" },
        Code: "ZAR_NSS",
        Interval: "Daily",
      }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("timeSeriesGet2 — missing Code", async () => {
    await expect(
      fakeClient.timeSeriesGet2({
        Header: { SessionKey: "k", RequestID: "r1" },
        Code: "",
        Interval: "Daily",
      }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("timeSeriesGet2 — missing Interval throws IressError 25018", async () => {
    // Regression test for the V4 "Invalid Parameter Value: as Frequency" fault.
    // The required `Interval` STRING field must be present in the request
    // before we ever hit the wire; callers that omit it should see a clear
    // local error. The earlier shape used `Frequency: 8` (Long), but the
    // V4 WSDL sample payload uses the `<Interval>Daily</Interval>` string
    // and the live CT server rejects the Long form.
    await expect(
      fakeClient.timeSeriesGet2({
        Header: { SessionKey: "k", RequestID: "r1" },
        Code: "SOL",
        Interval: "",
      }),
    ).rejects.toMatchObject({
      code: 25018,
      method: "TimeSeriesGet2",
    });
  });

  it("timeSeriesGet2 — passes Interval through to the SOAP body", async () => {
    // Verifies that the required `Interval` parameter actually lands in
    // the outgoing XML envelope (not just in the TypeScript types). Uses
    // the V4 `"Daily"` string — the value the worker actually sends for
    // the 7-day rolling J203 / R2030 / R2035 / R2040 series. Earlier
    // versions sent `Frequency: 8` (Long), which the live CT server
    // rejects with `Invalid Parameter Value: 8 as Frequency`.
    const call = vi.fn().mockResolvedValueOnce({
      result: {},
      header: { ErrorNumber: 0 },
      dataRows: [],
    });
    const transport: SoapTransport = { call } as unknown as SoapTransport;
    const client = createLiveIressClient({ transport });
    await client.timeSeriesGet2({
      Header: { SessionKey: "k", RequestID: "r1" },
      Code: "SOL",
      Interval: "Daily",
    });
    const params = (call.mock.calls[0]![0] as { parameters: Record<string, unknown> })
      .parameters;
    expect(params["Interval"]).toBe("Daily");
    expect(params["Code"]).toBe("SOL");
    // The old `Frequency` Long must not appear on the wire any more —
    // the live CT server rejects it.
    expect(params["Frequency"]).toBeUndefined();
  });

  it("timeSeriesGet2Updates — missing RequestID", async () => {
    await expect(fakeClient.timeSeriesGet2Updates({ RequestID: "" })).rejects.toBeInstanceOf(IressError);
  });

  it("orderCreate3 — missing ServiceSessionKey", async () => {
    await expect(
      fakeClient.orderCreate3({
        ServiceSessionKey: "",
        OrderTag: "t-1",
        Order: {
          AccountCode: "MINT-LIVE-001",
          SecurityCode: "NPN",
          Exchange: "JSE",
          BuySell: 1,
          OrderType: "LMT",
          Volume: 100,
          Price: 100,
          Destination: "JSE",
          TimeInForce: "DAY",
        },
      }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("orderCreate3 — missing OrderTag", async () => {
    await expect(
      fakeClient.orderCreate3({
        ServiceSessionKey: "ssk",
        OrderTag: "",
        Order: {
          AccountCode: "MINT-LIVE-001",
          SecurityCode: "NPN",
          Exchange: "JSE",
          BuySell: 1,
          OrderType: "LMT",
          Volume: 100,
          Price: 100,
          Destination: "JSE",
          TimeInForce: "DAY",
        },
      }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("orderAmend2 — missing ServiceSessionKey", async () => {
    await expect(
      fakeClient.orderAmend2({ ServiceSessionKey: "", OrderNumber: "ORD-1" }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("orderAmend2 — missing OrderNumber", async () => {
    await expect(
      fakeClient.orderAmend2({ ServiceSessionKey: "ssk", OrderNumber: "" }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("orderDelete — missing ServiceSessionKey", async () => {
    await expect(
      fakeClient.orderDelete({ ServiceSessionKey: "", OrderNumber: "ORD-1" }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("orderNoGetByOrderTag — missing ServiceSessionKey", async () => {
    await expect(
      fakeClient.orderNoGetByOrderTag({ ServiceSessionKey: "", OrderTag: "ord-1" }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("orderNoGetByOrderTag — missing OrderTag", async () => {
    await expect(
      fakeClient.orderNoGetByOrderTag({ ServiceSessionKey: "ssk", OrderTag: "" }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("orderPadGetByAccount — missing ServiceSessionKey", async () => {
    await expect(
      fakeClient.orderPadGetByAccount({
        ServiceSessionKey: "",
        AccountCode: "MINT-LIVE-001",
        OrderFilter: 1,
        RequestID: "r1",
      }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("orderPadGetByAccount — missing AccountCode", async () => {
    await expect(
      fakeClient.orderPadGetByAccount({
        ServiceSessionKey: "ssk",
        AccountCode: "",
        OrderFilter: 1,
        RequestID: "r1",
      }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("orderPadGetByAccountUpdates — missing RequestID", async () => {
    await expect(fakeClient.orderPadGetByAccountUpdates({ RequestID: "" })).rejects.toBeInstanceOf(
      IressError,
    );
  });

  it("bookingGetByOrganisation2 — missing ServiceSessionKey", async () => {
    await expect(
      fakeClient.bookingGetByOrganisation2({ ServiceSessionKey: "", From: "2024-01-01", To: "2024-12-31" }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("bookingGetByOrganisation2 — missing From", async () => {
    await expect(
      fakeClient.bookingGetByOrganisation2({ ServiceSessionKey: "ssk", From: "", To: "2024-12-31" }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("ipsTransactionGetByAccount5 — missing AccountCode", async () => {
    await expect(
      fakeClient.ipsTransactionGetByAccount5({
        ServiceSessionKey: "ssk",
        AccountCode: "",
        DateFrom: "2024-01-01",
        DateTo: "2024-12-31",
      }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("ipsTransactionGetByAccount5 — missing DateFrom", async () => {
    await expect(
      fakeClient.ipsTransactionGetByAccount5({
        ServiceSessionKey: "ssk",
        AccountCode: "MINT-LIVE-001",
        DateFrom: "",
        DateTo: "2024-12-31",
      }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("targetIdGet — missing ServiceSessionKey", async () => {
    await expect(fakeClient.targetIdGet({ ServiceSessionKey: "" })).rejects.toBeInstanceOf(IressError);
  });

  it("targetIdStatusGet — missing TargetID", async () => {
    await expect(
      fakeClient.targetIdStatusGet({ ServiceSessionKey: "ssk", TargetID: "" }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("IressError carries code 25018 (invalid input) and the calling method name", async () => {
    try {
      await fakeClient.pricingQuoteGet({
        Header: { SessionKey: "", RequestID: "r1" },
        SecurityCode: "NPN",
        Exchange: "JSE",
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(IressError);
      const e = err as IressError;
      expect(e.code).toBe(25018);
      expect(e.method).toBe("PricingQuoteGet");
      expect(e.message).toMatch(/SessionKey/);
    }
  });
});

// ─── 4. XML envelope helper round-trips a known request ─────────────────

describe("buildSoapEnvelope", () => {
  it("produces a SOAP 1.1 envelope with the right namespace + method tag", () => {
    const xml = buildSoapEnvelope({
      method: "PricingQuoteGet",
      header: { SessionKey: "ABCD@WebServicesCT", RequestID: "r-1", Updates: false, Timeout: 25 },
      parameters: { SecurityCode: "NPN", Exchange: "JSE" },
    });
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="utf-8"\?>/);
    expect(xml).toContain('xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"');
    expect(xml).toContain(`xmlns="${IRESS_NS}"`);
    expect(xml).toContain("<PricingQuoteGet");
    expect(xml).toContain("<Input>");
    expect(xml).toContain("<Header>");
    expect(xml).toContain("<SessionKey>ABCD@WebServicesCT</SessionKey>");
    expect(xml).toContain("<RequestID>r-1</RequestID>");
    expect(xml).toContain("<Updates>false</Updates>");
    expect(xml).toContain("<Timeout>25</Timeout>");
    expect(xml).toContain("</Header>");
    expect(xml).toContain("<Parameters>");
    expect(xml).toContain("<SecurityCode>NPN</SecurityCode>");
    expect(xml).toContain("<Exchange>JSE</Exchange>");
    expect(xml).toContain("</Parameters>");
    expect(xml).toContain("</Input>");
    expect(xml).toContain("</PricingQuoteGet>");
    expect(xml).toContain("</soap:Body>");
    expect(xml).toContain("</soap:Envelope>");
  });

  it("escapes XML special characters in values", () => {
    const xml = buildSoapEnvelope({
      method: "IRESSSessionStart",
      header: { RequestID: "r-x" },
      parameters: { ApplicationLabel: "Mint & Co <dev>" },
    });
    expect(xml).toContain("Mint &amp; Co &lt;dev&gt;");
    expect(xml).not.toContain("Mint & Co <dev>");
  });

  it("skips empty / undefined header fields", () => {
    const xml = buildSoapEnvelope({
      method: "IRESSSessionStart",
      header: { RequestID: "r-1", SessionKey: "", ServiceSessionKey: undefined },
      parameters: {},
    });
    expect(xml).toContain("<RequestID>r-1</RequestID>");
    expect(xml).not.toContain("<SessionKey>");
    expect(xml).not.toContain("<ServiceSessionKey>");
  });

  it("uses ServiceSessionKey for service methods (IOS+/IPS/FIX+)", () => {
    const xml = buildSoapEnvelope({
      method: "OrderCreate3",
      header: { ServiceSessionKey: "ssk-1", RequestID: "r-1" },
      parameters: { Order: { AccountCode: "MINT-LIVE-001", SecurityCode: "NPN", Exchange: "JSE" } },
    });
    expect(xml).toContain("<ServiceSessionKey>ssk-1</ServiceSessionKey>");
    expect(xml).toContain("<AccountCode>MINT-LIVE-001</AccountCode>");
  });
});

// ─── 5. Transport translation: SOAP fault → IressError ──────────────────

describe("createSoapTransport — fault translation", () => {
  it("throws IressError 25001 (invalid credentials) on a fault with that Number", async () => {
    const transport = await import("@/lib/iress/transport");
    const t = transport.createSoapTransport({
      baseUrl: "https://example.test/v4",
      fetchImpl: (async () =>
        new Response(
          `<?xml version="1.0"?>
          <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
            <soap:Body>
              <soap:Fault>
                <faultcode>soap:Client</faultcode>
                <faultstring>Bad credentials</faultstring>
                <detail>
                  <IRESSFaultDetail xmlns="${IRESS_NS}">
                    <Message>Invalid login</Message>
                    <Number>25001</Number>
                    <Service>IRESS</Service>
                    <UserName>DFM@Mint</UserName>
                  </IRESSFaultDetail>
                </detail>
              </soap:Fault>
            </soap:Body>
          </soap:Envelope>`,
          { status: 500, headers: { "Content-Type": "text/xml" } },
        )) as unknown as typeof fetch,
    });
    await expect(
      t.call({ method: "IRESSSessionStart", header: { RequestID: "r-1" }, parameters: {} }),
    ).rejects.toMatchObject({ code: 25001, method: "IRESSSessionStart" });
  });

  it("falls back to code 666 (system fault) when the body has no Number", async () => {
    const transport = await import("@/lib/iress/transport");
    const t = transport.createSoapTransport({
      baseUrl: "https://example.test/v4",
      fetchImpl: (async () =>
        new Response(
          `<?xml version="1.0"?>
          <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
            <soap:Body>
              <soap:Fault>
                <faultcode>soap:Server</faultcode>
                <faultstring>IDS unavailable</faultstring>
              </soap:Fault>
            </soap:Body>
          </soap:Envelope>`,
          { status: 500, headers: { "Content-Type": "text/xml" } },
        )) as unknown as typeof fetch,
    });
    await expect(
      t.call({ method: "IRESSSessionStart", header: { RequestID: "r-1" }, parameters: {} }),
    ).rejects.toMatchObject({ code: 666 });
  });

  it("parses a happy-path response and returns dataRows", async () => {
    const transport = await import("@/lib/iress/transport");
    const t = transport.createSoapTransport({
      baseUrl: "https://example.test/v4",
      fetchImpl: (async () =>
        new Response(
          `<?xml version="1.0"?>
          <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
            <soap:Body>
              <IRESSSessionStartResponse xmlns="${IRESS_NS}">
                <Output>
                  <Result>
                    <Header>
                      <RequestID>r-1</RequestID>
                      <StatusCode>2</StatusCode>
                      <ErrorNumber>0</ErrorNumber>
                    </Header>
                    <DataRows>
                      <DataRow>
                        <IRESSSessionKey>KEY-1@WebServicesCT</IRESSSessionKey>
                        <SessionNumber>3</SessionNumber>
                        <SessionTimeout>120</SessionTimeout>
                        <ApplicationID>Mint-OEMS-Dev-web-1-abc</ApplicationID>
                      </DataRow>
                    </DataRows>
                  </Result>
                </Output>
              </IRESSSessionStartResponse>
            </soap:Body>
          </soap:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } },
        )) as unknown as typeof fetch,
    });
    const res = await t.call({
      method: "IRESSSessionStart",
      header: { RequestID: "r-1" },
      parameters: {},
    });
    expect(res.firstRow?.IRESSSessionKey).toBe("KEY-1@WebServicesCT");
    expect(res.dataRows).toHaveLength(1);
    expect(res.header.StatusCode).toBe(2);
  });

  it("rejects with code 666 when the network call throws", async () => {
    const transport = await import("@/lib/iress/transport");
    const t = transport.createSoapTransport({
      baseUrl: "https://example.test/v4",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await expect(
      t.call({ method: "IRESSSessionStart", header: { RequestID: "r-1" }, parameters: {} }),
    ).rejects.toMatchObject({ code: 666, method: "IRESSSessionStart" });
  });
});

// ─── 6. End-to-end: live client calls reach the transport and map correctly

describe("live client end-to-end with a fake transport", () => {
  function makeQuoteResponseXml(securityCode: string, exchange: string) {
    return `<?xml version="1.0"?>
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <PricingQuoteGetResponse xmlns="${IRESS_NS}">
            <Output>
              <Result>
                <Header>
                  <RequestID>q-1</RequestID>
                  <StatusCode>2</StatusCode>
                  <ErrorNumber>0</ErrorNumber>
                </Header>
                <DataRows>
                  <DataRow>
                    <SecurityCode>${securityCode}</SecurityCode>
                    <Exchange>${exchange}</Exchange>
                    <LastTrade>4180.5</LastTrade>
                    <Bid>4179.0</Bid>
                    <Ask>4182.0</Ask>
                    <BidSize>100</BidSize>
                    <AskSize>200</AskSize>
                    <Volume>12345</Volume>
                    <Currency>ZAR</Currency>
                    <MarketState>OPEN</MarketState>
                  </DataRow>
                </DataRows>
              </Result>
            </Output>
          </PricingQuoteGetResponse>
        </soap:Body>
      </soap:Envelope>`;
  }

  function makeSessionStartResponseXml() {
    return `<?xml version="1.0"?>
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <IRESSSessionStartResponse xmlns="${IRESS_NS}">
            <Output>
              <Result>
                <Header>
                  <RequestID>init-1</RequestID>
                  <StatusCode>2</StatusCode>
                  <ErrorNumber>0</ErrorNumber>
                </Header>
                <DataRows>
                  <DataRow>
                    <IRESSSessionKey>REAL-KEY@WebServicesCT</IRESSSessionKey>
                    <SessionNumber>7</SessionNumber>
                    <SessionTimeout>120</SessionTimeout>
                    <ApplicationID>Mint-OEMS-Dev-web-1-abc</ApplicationID>
                  </DataRow>
                </DataRows>
              </Result>
            </Output>
          </IRESSSessionStartResponse>
        </soap:Body>
      </soap:Envelope>`;
  }

  it("iressSessionStart maps a real-shaped response into IressSessionStartResponse", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(makeSessionStartResponseXml(), { status: 200, headers: { "Content-Type": "text/xml" } }),
    );
    const transport = await createTransportWithFetch(fetchImpl);
    const client = createLiveIressClient({ transport });
    const res = await client.iressSessionStart({
      UserName: "DFM@Mint",
      CompanyName: "MINT",
      Password: "123",
      ApplicationID: "Mint-OEMS-Dev-web-1-abc",
      SessionTimeout: 120,
    });
    expect(res.IRESSSessionKey).toBe("REAL-KEY@WebServicesCT");
    expect(res.SessionNumber).toBe(7);
    expect(res.SessionTimeout).toBe(120);
    expect(res.ApplicationID).toBe("Mint-OEMS-Dev-web-1-abc");
    // And the request envelope is the SOAP 1.1 shape we expect.
    expect(fetchImpl.mock.calls).toHaveLength(1);
    const [urlArg, initArg] = fetchImpl.mock.calls[0] as [RequestInfo, RequestInit];
    const url = String(urlArg);
    const init = initArg;
    expect(url).toContain("/SOAP.aspx");
    expect((init.headers as Record<string, string>)["Content-Type"]).toContain("text/xml");
    expect((init.headers as Record<string, string>).SOAPAction).toContain("IRESSSessionStart");
    expect(String(init.body)).toContain("<IRESSSessionStart");
    expect(String(init.body)).toContain("<UserName>DFM@Mint</UserName>");
    expect(String(init.body)).toContain("<Password>123</Password>");
  });

  it("pricingQuoteGet maps IRESS L1 fields into a Quote", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(makeQuoteResponseXml("NPN", "JSE"), {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        }),
    );
    const transport = await createTransportWithFetch(fetchImpl);
    const client = createLiveIressClient({ transport });
    const res = await client.pricingQuoteGet({
      Header: { SessionKey: "k", RequestID: "q-1" },
      SecurityCode: "NPN",
      Exchange: "JSE",
    });
    expect(res.Header.ErrorNumber).toBe(0);
    expect(res.Header.StatusCode).toBe(2);
    expect(res.DataRows).toHaveLength(1);
    expect(res.DataRows[0]?.symbol).toBe("NPN");
    expect(res.DataRows[0]?.last).toBe(4180.5);
    expect(res.DataRows[0]?.bid).toBe(4179);
    expect(res.DataRows[0]?.ask).toBe(4182);
    expect(res.DataRows[0]?.currency).toBe("ZAR");
    expect(res.DataRows[0]?.marketState).toBe("OPEN");
  });

  it("orderNoGetByOrderTag returns the broker OrderNumber when the tag resolves", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `<?xml version="1.0"?>
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <OrderNoGetByOrderTagResponse xmlns="${IRESS_NS}">
            <Output>
              <Result>
                <Header>
                  <RequestID>ord-tag-1</RequestID>
                  <StatusCode>2</StatusCode>
                  <ErrorNumber>0</ErrorNumber>
                </Header>
                <DataRows>
                  <DataRow>
                    <OrderNumber>ORD-44322</OrderNumber>
                    <OrderTag>mint-ord-9f8e7d6c-b5a4-4916</OrderTag>
                  </DataRow>
                </DataRows>
              </Result>
            </Output>
          </OrderNoGetByOrderTagResponse>
        </soap:Body>
      </soap:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } },
        ),
    );
    const transport = await createTransportWithFetch(fetchImpl);
    const client = createLiveIressClient({ transport });
    const res = await client.orderNoGetByOrderTag({
      ServiceSessionKey: "ssk",
      OrderTag: "mint-ord-9f8e7d6c-b5a4-4916",
    });
    expect(res.OrderNumber).toBe("ORD-44322");
    expect(res.OrderTag).toBe("mint-ord-9f8e7d6c-b5a4-4916");
    // Envelope shape — the request XML must carry the tag in the body and
    // the service session key in the header.
    const [urlArg, initArg] = fetchImpl.mock.calls[0] as [RequestInfo, RequestInit];
    const url = String(urlArg);
    const init = initArg;
    expect(url).toContain("/SOAP.aspx");
    expect((init.headers as Record<string, string>).SOAPAction).toContain("OrderNoGetByOrderTag");
    expect(String(init.body)).toContain("<OrderNoGetByOrderTag");
    expect(String(init.body)).toContain("<ServiceSessionKey>ssk</ServiceSessionKey>");
    expect(String(init.body)).toContain("<OrderTag>mint-ord-9f8e7d6c-b5a4-4916</OrderTag>");
  });

  it("orderNoGetByOrderTag returns OrderNumber='' when the tag is unknown (200 OK + empty DataRow)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `<?xml version="1.0"?>
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <OrderNoGetByOrderTagResponse xmlns="${IRESS_NS}">
            <Output>
              <Result>
                <Header>
                  <RequestID>ord-tag-1</RequestID>
                  <StatusCode>2</StatusCode>
                  <ErrorNumber>0</ErrorNumber>
                </Header>
                <DataRows></DataRows>
              </Result>
            </Output>
          </OrderNoGetByOrderTagResponse>
        </soap:Body>
      </soap:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } },
        ),
    );
    const transport = await createTransportWithFetch(fetchImpl);
    const client = createLiveIressClient({ transport });
    const res = await client.orderNoGetByOrderTag({
      ServiceSessionKey: "ssk",
      OrderTag: "unknown-tag",
    });
    expect(res.OrderNumber).toBe("");
    expect(res.OrderTag).toBe("unknown-tag");
  });

  it("orderNoGetByOrderTag throws IressError when response header ErrorNumber is non-zero", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `<?xml version="1.0"?>
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <OrderNoGetByOrderTagResponse xmlns="${IRESS_NS}">
            <Output>
              <Result>
                <Header>
                  <RequestID>ord-tag-1</RequestID>
                  <StatusCode>2</StatusCode>
                  <ErrorNumber>25010</ErrorNumber>
                  <ErrorDescription>Method not entitled</ErrorDescription>
                </Header>
                <DataRows></DataRows>
              </Result>
            </Output>
          </OrderNoGetByOrderTagResponse>
        </soap:Body>
      </soap:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } },
        ),
    );
    const transport = await createTransportWithFetch(fetchImpl);
    const client = createLiveIressClient({ transport });
    const err = await client
      .orderNoGetByOrderTag({ ServiceSessionKey: "ssk", OrderTag: "ord-1" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(IressError);
    expect((err as IressError).code).toBe(25010);
    expect((err as IressError).method).toBe("OrderNoGetByOrderTag");
  });
});

// Helper: import the createSoapTransport factory and bind a custom fetch.
// We do this dynamically so the test file doesn't need to know the import
// path.
async function createTransportWithFetch(fetchImpl: typeof fetch) {
  const transport = await import("@/lib/iress/transport");
  return transport.createSoapTransport({ baseUrl: "https://example.test/v4", fetchImpl });
}

// ─── 7. Live client does not call the transport for invalid input ────────

describe("validation runs before any transport call", () => {
  it("never reaches the SOAP layer for a missing SessionKey", async () => {
    const callSpy = vi.fn();
    const fakeTransport: SoapTransport = { call: callSpy as unknown as SoapTransport["call"] };
    const client = createLiveIressClient({ transport: fakeTransport });
    await expect(
      client.pricingQuoteGet({
        Header: { SessionKey: "", RequestID: "r" },
        SecurityCode: "NPN",
        Exchange: "JSE",
      }),
    ).rejects.toBeInstanceOf(IressError);
    expect(callSpy).not.toHaveBeenCalled();
  });
});

// ─── 8. pricingQuoteGet surfaces non-zero ErrorNumber from the response ──
//
// V4 returns 200 OK with empty DataRows + ErrorNumber!=0 in the response
// header when the request is refused at the application layer (e.g. 25034
// entitlement check failed). Without an explicit check, the worker silently
// drops the symbol and "quote sync complete" never logs.

describe("pricingQuoteGet response ErrorNumber handling", () => {
  function makeErrorResponseXml(errorNumber: number, description: string) {
    return `<?xml version="1.0"?>
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <PricingQuoteGetResponse xmlns="${IRESS_NS}">
            <Output>
              <Result>
                <Header>
                  <RequestID>q-1</RequestID>
                  <StatusCode>2</StatusCode>
                  <ErrorNumber>${errorNumber}</ErrorNumber>
                  <ErrorDescription>${description}</ErrorDescription>
                </Header>
                <DataRows></DataRows>
              </Result>
            </Output>
          </PricingQuoteGetResponse>
        </soap:Body>
      </soap:Envelope>`;
  }

  it("throws IressError(25034, ...) when response header ErrorNumber is non-zero", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(makeErrorResponseXml(25034, "Entitlement check failed for NPN"), {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        }),
    );
    const transport = await createTransportWithFetch(fetchImpl);
    const client = createLiveIressClient({ transport });
    const err = await client
      .pricingQuoteGet({
        Header: { SessionKey: "k", RequestID: "q-1" },
        SecurityCode: "NPN",
        Exchange: "JSE",
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(IressError);
    expect((err as IressError).code).toBe(25034);
    expect((err as IressError).method).toBe("PricingQuoteGet");
    expect((err as Error).message).toContain("Entitlement check failed for NPN");
  });

  it("falls through to the typed Quote mapping when ErrorNumber is 0", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `<?xml version="1.0"?>
            <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
              <soap:Body>
                <PricingQuoteGetResponse xmlns="${IRESS_NS}">
                  <Output>
                    <Result>
                      <Header>
                        <RequestID>q-1</RequestID>
                        <StatusCode>2</StatusCode>
                        <ErrorNumber>0</ErrorNumber>
                      </Header>
                      <DataRows>
                        <DataRow>
                          <SecurityCode>NPN</SecurityCode>
                          <Exchange>JSE</Exchange>
                          <LastTrade>4180.5</LastTrade>
                          <Currency>ZAR</Currency>
                          <MarketState>OPEN</MarketState>
                        </DataRow>
                      </DataRows>
                    </Result>
                  </Output>
                </PricingQuoteGetResponse>
              </soap:Body>
            </soap:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } },
        ),
    );
    const transport = await createTransportWithFetch(fetchImpl);
    const client = createLiveIressClient({ transport });
    const res = await client.pricingQuoteGet({
      Header: { SessionKey: "k", RequestID: "q-1" },
      SecurityCode: "NPN",
      Exchange: "JSE",
    });
    expect(res.Header.ErrorNumber).toBe(0);
    expect(res.DataRows).toHaveLength(1);
    expect(res.DataRows[0]?.last).toBe(4180.5);
  });
});

// ─── 8. Real IRESS V4 server uses bare element names (<Last>, <QuoteState>)
//   instead of the longer camelCase ones our mock + WSDL samples use. The
//   mapper must fall back to the real-server names or every watchlist
//   symbol comes back as `last=0`. These tests pin that behaviour. ─────────

describe("mapQuote field-name fallback for real IRESS V4 responses", () => {
  // Same helper as the end-to-end suite, but with the field names that the
  // production IRESS CT server actually returns.
  function makeRealIressQuoteXml(securityCode: string, exchange: string) {
    return `<?xml version="1.0"?>
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <PricingQuoteGetResponse xmlns="${IRESS_NS}">
            <Output>
              <Result>
                <Header>
                  <RequestID>q-1</RequestID>
                  <StatusCode>2</StatusCode>
                  <ErrorNumber>0</ErrorNumber>
                </Header>
                <DataRows>
                  <DataRow>
                    <SecurityCode>${securityCode}</SecurityCode>
                    <Exchange>${exchange}</Exchange>
                    <Last>4180.5</Last>
                    <Bid>4179.0</Bid>
                    <Ask>4182.0</Ask>
                    <BidSize>100</BidSize>
                    <AskSize>200</AskSize>
                    <Volume>12345</Volume>
                    <Currency>ZAR</Currency>
                    <QuoteState>OPEN</QuoteState>
                    <LastTradeTime>2026-06-12T07:35:12</LastTradeTime>
                  </DataRow>
                </DataRows>
              </Result>
            </Output>
          </PricingQuoteGetResponse>
        </soap:Body>
      </soap:Envelope>`;
  }

  it("uses <Close> when CLOSED and <Last> is absent but <LastTrade> is stale", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `<?xml version="1.0"?>
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <PricingQuoteGetResponse xmlns="${IRESS_NS}">
            <Output>
              <Result>
                <Header>
                  <RequestID>q-1</RequestID>
                  <StatusCode>2</StatusCode>
                  <ErrorNumber>0</ErrorNumber>
                </Header>
                <DataRows>
                  <DataRow>
                    <SecurityCode>AGL</SecurityCode>
                    <Exchange>JSE</Exchange>
                    <LastTrade>120003</LastTrade>
                    <Close>552.1</Close>
                    <Bid>551.5</Bid>
                    <Ask>552.5</Ask>
                    <QuoteState>CLOSED</QuoteState>
                  </DataRow>
                </DataRows>
              </Result>
            </Output>
          </PricingQuoteGetResponse>
        </soap:Body>
      </soap:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } },
        ),
    );
    const transport = await createTransportWithFetch(fetchImpl);
    const client = createLiveIressClient({ transport });
    const res = await client.pricingQuoteGet({
      Header: { SessionKey: "k", RequestID: "q-1" },
      SecurityCode: "AGL",
      Exchange: "JSE",
    });
    expect(res.DataRows[0]?.last).toBe(552.1);
    expect(res.DataRows[0]?.marketState).toBe("CLOSED");
  });

  it("rejects bogus <Last> and uses <Close> when Last deviates >3x from Close", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `<?xml version="1.0"?>
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <PricingQuoteGetResponse xmlns="${IRESS_NS}">
            <Output>
              <Result>
                <Header>
                  <RequestID>q-1</RequestID>
                  <StatusCode>2</StatusCode>
                  <ErrorNumber>0</ErrorNumber>
                </Header>
                <DataRows>
                  <DataRow>
                    <SecurityCode>AGL</SecurityCode>
                    <Exchange>JSE</Exchange>
                    <Last>120003</Last>
                    <Close>552</Close>
                    <Bid>551.5</Bid>
                    <Ask>552.5</Ask>
                    <QuoteState>CLOSED</QuoteState>
                  </DataRow>
                </DataRows>
              </Result>
            </Output>
          </PricingQuoteGetResponse>
        </soap:Body>
      </soap:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } },
        ),
    );
    const transport = await createTransportWithFetch(fetchImpl);
    const client = createLiveIressClient({ transport });
    const res = await client.pricingQuoteGet({
      Header: { SessionKey: "k", RequestID: "q-1" },
      SecurityCode: "AGL",
      Exchange: "JSE",
    });
    expect(res.DataRows[0]?.last).toBe(552);
  });

  it("prefers <Last> over a stale <LastTrade> when both are present", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `<?xml version="1.0"?>
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <PricingQuoteGetResponse xmlns="${IRESS_NS}">
            <Output>
              <Result>
                <Header>
                  <RequestID>q-1</RequestID>
                  <StatusCode>2</StatusCode>
                  <ErrorNumber>0</ErrorNumber>
                </Header>
                <DataRows>
                  <DataRow>
                    <SecurityCode>AGL</SecurityCode>
                    <Exchange>JSE</Exchange>
                    <LastTrade>120001</LastTrade>
                    <Last>552.1</Last>
                    <Bid>551.5</Bid>
                    <Ask>552.5</Ask>
                    <QuoteState>OPEN</QuoteState>
                  </DataRow>
                </DataRows>
              </Result>
            </Output>
          </PricingQuoteGetResponse>
        </soap:Body>
      </soap:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } },
        ),
    );
    const transport = await createTransportWithFetch(fetchImpl);
    const client = createLiveIressClient({ transport });
    const res = await client.pricingQuoteGet({
      Header: { SessionKey: "k", RequestID: "q-1" },
      SecurityCode: "AGL",
      Exchange: "JSE",
    });
    expect(res.DataRows[0]?.last).toBe(552.1);
  });

  it("maps <Last>+<QuoteState> (real IRESS shape) to last=4180.5 marketState=OPEN", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(makeRealIressQuoteXml("NPN", "JSE"), {
          status: 200,
          headers: { "Content-Type": "text/xml" },
        }),
    );
    const transport = await createTransportWithFetch(fetchImpl);
    const client = createLiveIressClient({ transport });
    const res = await client.pricingQuoteGet({
      Header: { SessionKey: "k", RequestID: "q-1" },
      SecurityCode: "NPN",
      Exchange: "JSE",
    });
    expect(res.DataRows).toHaveLength(1);
    const row = res.DataRows[0];
    expect(row?.symbol).toBe("NPN");
    expect(row?.last).toBe(4180.5);
    expect(row?.bid).toBe(4179);
    expect(row?.ask).toBe(4182);
    expect(row?.marketState).toBe("OPEN");
    expect(row?.currency).toBe("ZAR");
    expect(typeof row?.ts).toBe("number");
    expect(row?.ts).toBeGreaterThan(0);
  });

  it("scales CT LastPrice integer cents to ZAR when <Last> is absent (AGL shape)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `<?xml version="1.0"?>
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <PricingQuoteGetResponse xmlns="${IRESS_NS}">
            <Output>
              <Result>
                <Header>
                  <RequestID>q-1</RequestID>
                  <StatusCode>2</StatusCode>
                  <ErrorNumber>0</ErrorNumber>
                </Header>
                <DataRows>
                  <DataRow>
                    <SecurityCode>AGL</SecurityCode>
                    <Exchange>JSE</Exchange>
                    <LastPrice>55210</LastPrice>
                    <PreviousClosePrice>55180</PreviousClosePrice>
                    <OpenPrice>55100</OpenPrice>
                    <HighPrice>55300</HighPrice>
                    <LowPrice>55050</LowPrice>
                    <BidPrice>55190</BidPrice>
                    <AskPrice>55220</AskPrice>
                    <TradingStatus>CLOSED</TradingStatus>
                  </DataRow>
                </DataRows>
              </Result>
            </Output>
          </PricingQuoteGetResponse>
        </soap:Body>
      </soap:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } },
        ),
    );
    const transport = await createTransportWithFetch(fetchImpl);
    const client = createLiveIressClient({ transport });
    const res = await client.pricingQuoteGet({
      Header: { SessionKey: "k", RequestID: "q-1" },
      SecurityCode: "AGL",
      Exchange: "JSE",
    });
    const row = res.DataRows[0];
    expect(row?.last).toBeCloseTo(552.1, 2);
    expect(row?.prevClose).toBeCloseTo(551.8, 2);
    expect(row?.bid).toBeCloseTo(551.9, 2);
    expect(row?.marketState).toBe("CLOSED");
  });

  it("scales BHG when LastPrice below threshold but OHLC cluster is cents", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `<?xml version="1.0"?>
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <PricingQuoteGetResponse xmlns="${IRESS_NS}">
            <Output>
              <Result>
                <Header>
                  <RequestID>q-bhg</RequestID>
                  <StatusCode>2</StatusCode>
                  <ErrorNumber>0</ErrorNumber>
                </Header>
                <DataRows>
                  <DataRow>
                    <SecurityCode>BHG</SecurityCode>
                    <Exchange>JSE</Exchange>
                    <LastPrice>2445</LastPrice>
                    <PreviousClosePrice>52850</PreviousClosePrice>
                    <OpenPrice>52800</OpenPrice>
                    <HighPrice>52900</HighPrice>
                    <LowPrice>52700</LowPrice>
                    <BidPrice>52820</BidPrice>
                    <AskPrice>52860</AskPrice>
                    <TotalValue>99792000</TotalValue>
                    <TotalVolume>189000</TotalVolume>
                    <TradingStatus>CLOSED</TradingStatus>
                  </DataRow>
                </DataRows>
              </Result>
            </Output>
          </PricingQuoteGetResponse>
        </soap:Body>
      </soap:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } },
        ),
    );
    const transport = await createTransportWithFetch(fetchImpl);
    const client = createLiveIressClient({ transport });
    const res = await client.pricingQuoteGet({
      Header: { SessionKey: "k", RequestID: "q-bhg" },
      SecurityCode: "BHG",
      Exchange: "JSE",
    });
    const row = res.DataRows[0];
    expect(row?.last).toBeCloseTo(528.5, 0);
    expect(row?.prevClose).toBeCloseTo(528.5, 0);
    expect(row?.open).toBeCloseTo(528, 0);
  });
});

describe("iressQuotePriceScale", () => {
  it("returns 0.01 when LastPrice integer exceeds 4500 (cents) without Last", () => {
    expect(iressQuotePriceScale({ LastPrice: 55210 })).toBe(0.01);
    expect(iressQuotePriceScale({ LastPrice: 120001 })).toBe(0.01);
  });
  it("returns 1 when bare Last is present and OHLC is ZAR-scale", () => {
    expect(iressQuotePriceScale({ Last: 610 })).toBe(1);
    expect(iressQuotePriceScale({ Last: 610, Open: 608, Close: 607 })).toBe(1);
  });
  it("returns 1 when LastPrice is already ZAR-scale (NPN ~610)", () => {
    expect(iressQuotePriceScale({ LastPrice: 610 })).toBe(1);
  });
  it("returns 0.01 when LastPrice below threshold but OHLC cluster is cents (BHG shape)", () => {
    expect(
      iressQuotePriceScale({
        LastPrice: 2445,
        OpenPrice: 52800,
        PreviousClosePrice: 52850,
        HighPrice: 52900,
        LowPrice: 52700,
      }),
    ).toBe(0.01);
  });
  it("returns 0.01 when bare Last is bogus vs OHLC cents cluster (BHG Last=2445)", () => {
    expect(
      iressQuotePriceScale({
        Last: 2445,
        OpenPrice: 52800,
        PreviousClosePrice: 52850,
      }),
    ).toBe(0.01);
  });
});

describe("resolveQuoteLast", () => {
  function rowNums(row: Record<string, string | number>) {
    const num = (...keys: string[]) => {
      for (const k of keys) {
        const v = row[k];
        if (v !== undefined && v !== null && v !== "") {
          const n = Number(v);
          if (Number.isFinite(n)) return n;
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
    return resolveQuoteLast(num, str);
  }

  it("AGL: rejects bogus Last=120003, prefers Close=552", () => {
    expect(
      rowNums({ Last: 120003, Close: 552, QuoteState: "CLOSED" }),
    ).toBe(552);
  });

  it("FSR: rejects bogus Last=4983, prefers Close=78", () => {
    expect(
      rowNums({ Last: 4983, Close: 78, QuoteState: "CLOSED" }),
    ).toBe(78);
  });

  it("NPN: keeps valid Last=610 when Close=608", () => {
    expect(
      rowNums({ Last: 610, Close: 608, QuoteState: "CLOSED" }),
    ).toBe(610);
  });

  it("AGL: rejects bogus Last using High/Low mid when Close is absent", () => {
    expect(
      rowNums({ Last: 120003, High: 560, Low: 544, QuoteState: "CLOSED" }),
    ).toBe(552);
  });

  it("AGL: write-through when bogus Last=120003 and no OHLC anchor (market closed)", () => {
    // Pre-June-2026 this returned 0 because `noAnchorSuspicious` rejected
    // anything > 4500 with no anchor. The fix relaxes that guard for
    // `marketState=CLOSED` rows so the weekend / holiday UI surfaces the
    // raw value the IRESS V4 server returned rather than going blank.
    // The worker is the right place to apply any scale-validity check.
    expect(
      rowNums({ Last: 120003, QuoteState: "CLOSED" }),
    ).toBe(120003);
  });

  it("FSR: write-through when bogus Last=4986 and no anchor (market closed)", () => {
    expect(
      rowNums({ Last: 4986, QuoteState: "CLOSED" }),
    ).toBe(4986);
  });

  it("BHG: prefers Open anchor when Last=2445 is bogus vs Open=528", () => {
    expect(
      rowNums({ Last: 2445, Open: 528, QuoteState: "CLOSED" }),
    ).toBe(528);
  });

  it("BHG: scales OHLC cents cluster when LastPrice=2445 below threshold", () => {
    const scale = iressQuotePriceScale({
      LastPrice: 2445,
      OpenPrice: 52800,
      PreviousClosePrice: 52850,
      HighPrice: 52900,
      LowPrice: 52700,
      TotalValue: 99792000,
      TotalVolume: 189000,
    });
    expect(scale).toBe(0.01);
    const num = (...keys: string[]) => {
      for (const k of keys) {
        const priceMap: Record<string, number> = {
          LastPrice: 2445,
          OpenPrice: 52800,
          PreviousClosePrice: 52850,
          HighPrice: 52900,
          LowPrice: 52700,
          TotalValue: 99792000,
          TotalVolume: 189000,
        };
        const v = priceMap[k];
        if (v !== undefined) {
          const n = Number(v);
          if (Number.isFinite(n)) return n * scale;
        }
      }
      return 0;
    };
    const str = (...keys: string[]) => {
      for (const k of keys) {
        const v = { TradingStatus: "CLOSED" }[k as keyof { TradingStatus: string }];
        if (v) return String(v);
      }
      return "";
    };
    expect(resolveQuoteLast(num, str)).toBeCloseTo(528.5, 0);
  });

  it("BHG CT stale row: returns the raw price when PreviousClosePrice is present (write-through)", async () => {
    // Real BHG CT pattern: the row carries a previous-close anchor (e.g.
    // 2445 ZAR) alongside a bogus LastPrice. After the June 2026 fix the
    // mapper no longer treats a "PreviousClosePrice + LastPrice only" row
    // as stale-by-default — the worker is responsible for the
    // write/no-write decision and may still skip when the value is
    // obviously out-of-scale, but the mapper returns the raw value so the
    // worker has something to log.
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `<?xml version="1.0"?>
      <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
        <soap:Body>
          <PricingQuoteGetResponse xmlns="${IRESS_NS}">
            <Output>
              <Result>
                <Header>
                  <RequestID>q-bhg-stale</RequestID>
                  <StatusCode>2</StatusCode>
                  <ErrorNumber>0</ErrorNumber>
                </Header>
                <DataRows>
                  <DataRow>
                    <SecurityCode>BHG</SecurityCode>
                    <Exchange>JSE</Exchange>
                    <LastPrice>2445</LastPrice>
                    <PreviousClosePrice>2445</PreviousClosePrice>
                    <OpenPrice>0</OpenPrice>
                    <HighPrice>0</HighPrice>
                    <LowPrice>0</LowPrice>
                    <TotalVolume>0</TotalVolume>
                    <TotalValue>0</TotalValue>
                    <TradingStatus>CLOSED</TradingStatus>
                  </DataRow>
                </DataRows>
              </Result>
            </Output>
          </PricingQuoteGetResponse>
        </soap:Body>
      </soap:Envelope>`,
          { status: 200, headers: { "Content-Type": "text/xml" } },
        ),
    );
    const transport = await createTransportWithFetch(fetchImpl);
    const client = createLiveIressClient({ transport });
    const res = await client.pricingQuoteGet({
      Header: { SessionKey: "k", RequestID: "q-bhg-stale" },
      SecurityCode: "BHG",
      Exchange: "JSE",
    });
    // PreviousClosePrice is the canonical closed-market anchor and the
    // mapper now returns it as `last` so the worker has a non-zero value
    // to write through (the worker's own scale-validity check decides
    // whether to drop the row).
    expect(res.DataRows[0]?.last).toBe(2445);
    expect(res.DataRows[0]?.prevClose).toBe(2445);
    expect(res.DataRows[0]?.marketState).toBe("CLOSED");
  });

  it("uses SettlementPrice when Close is absent", () => {
    expect(
      rowNums({ Last: 120003, SettlementPrice: 552, QuoteState: "CLOSED" }),
    ).toBe(552);
  });
});

describe("describeQuoteRowNumericFields diagnostic helper", () => {
  it("returns all numeric fields from a raw row", () => {
    const row = { SecurityCode: "AGL", Last: 120003, Close: 552, QuoteState: "CLOSED" };
    expect(describeQuoteRowNumericFields(row)).toEqual({
      Last: 120003,
      Close: 552,
    });
  });
});

describe("describeQuoteRowKeys diagnostic helper", () => {
  it("returns a sorted, comma-joined key list for a populated row", () => {
    const row = { SecurityCode: "NPN", Last: 1, QuoteState: "OPEN", Bid: 2 };
    expect(describeQuoteRowKeys(row)).toBe("Bid,Last,QuoteState,SecurityCode");
  });
  it("returns <empty row> when the row has no keys", () => {
    expect(describeQuoteRowKeys({})).toBe("<empty row>");
  });
  it("returns <missing row> when the row is undefined", () => {
    expect(describeQuoteRowKeys(undefined)).toBe("<missing row>");
  });
});

/**
 * The legacy IPS methods (`IPSAccountGetAll1`, `IPSPositionGetAll1`) expose
 * their cursor inside the `<Parameters>` block instead of the V4 header.
 * The live client transparently loops the cursor across pages and returns
 * a single flat response. These tests pin the contract:
 *
 *   1. validation runs before any transport call (rejects empty key)
 *   2. the response is the concatenated DataRows from every page
 *   3. the cursor advances via `PreviousAccountCode` / `PreviousSecurityCode`
 *   4. entitlement 25014 surfaces as a single response with the
 *      "entitlement not enabled" header
 *   5. StatusCode 2 does NOT stop paging (it's the V4 "still rows left"
 *      signal, not the legacy cursor's stop condition)
 */
describe("ipsAccountGetAll1 (live, legacy paging)", () => {
  it("rejects an empty ServiceSessionKey before any transport call", async () => {
    const transport: SoapTransport = { call: vi.fn() } as unknown as SoapTransport;
    const client = createLiveIressClient({ transport });
    await expect(
      client.ipsAccountGetAll1({ ServiceSessionKey: "" }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("concatenates rows across multiple pages using PreviousAccountCode as the cursor", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        result: {},
        header: { ErrorNumber: 0 },
        dataRows: [
          { AccountCode: "A", AccountName: "Account A" },
          { AccountCode: "B", AccountName: "Account B" },
        ],
      })
      .mockResolvedValueOnce({
        result: {},
        header: { ErrorNumber: 0 },
        dataRows: [
          { AccountCode: "Z1A", AccountName: "Account Z1A" },
          { AccountCode: "Z1B", AccountName: "Account Z1B" },
        ],
      })
      .mockResolvedValueOnce({ result: {}, header: { ErrorNumber: 0 }, dataRows: [] });
    const transport: SoapTransport = { call } as unknown as SoapTransport;
    const client = createLiveIressClient({ transport });
    const res = await client.ipsAccountGetAll1({ ServiceSessionKey: "ssk", PageSize: 2 });
    expect(res.Header?.ErrorNumber).toBe(0);
    // Page 1: 2 rows; Page 2: 2 rows; Page 3: empty
    expect(res.DataRows.length).toBe(4);
    expect(res.DataRows.map((r) => r.AccountCode)).toEqual(["A", "B", "Z1A", "Z1B"]);
    // The first call must have used the empty cursor; the second call
    // must have used `B` (the last row's AccountCode) as the cursor.
    const params1 = (call.mock.calls[0]![0] as { parameters: Record<string, unknown> }).parameters;
    const params2 = (call.mock.calls[1]![0] as { parameters: Record<string, unknown> }).parameters;
    expect(params1["PreviousAccountCode"]).toBe("");
    expect(params2["PreviousAccountCode"]).toBe("B");
  });
});

describe("ipsPositionGetAll1 (live, legacy paging)", () => {
  it("rejects an empty ServiceSessionKey before any transport call", async () => {
    const transport: SoapTransport = { call: vi.fn() } as unknown as SoapTransport;
    const client = createLiveIressClient({ transport });
    await expect(
      client.ipsPositionGetAll1({ ServiceSessionKey: "" }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("returns a 25014 entitlement-required envelope when the live call is unauthorized", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        result: {},
        header: { ErrorNumber: 25014, ErrorDescription: "Not entitled" },
        dataRows: [],
      });
    const transport: SoapTransport = { call } as unknown as SoapTransport;
    const client = createLiveIressClient({ transport });
    const res = await client.ipsPositionGetAll1({ ServiceSessionKey: "ssk" });
    expect(res.Header?.ErrorNumber).toBe(25014);
    expect(res.DataRows).toEqual([]);
  });

  it("honors the AccountCode filter and uses PreviousSecurityCode as the cursor", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        result: {},
        header: { ErrorNumber: 0 },
        dataRows: [
          { SecurityCode: "NPN", AccountCode: "Z12345", Quantity: 100 },
          { SecurityCode: "PRX", AccountCode: "Z12345", Quantity: 200 },
        ],
      })
      .mockResolvedValueOnce({ result: {}, header: { ErrorNumber: 0 }, dataRows: [] });
    const transport: SoapTransport = { call } as unknown as SoapTransport;
    const client = createLiveIressClient({ transport });
    const res = await client.ipsPositionGetAll1({
      ServiceSessionKey: "ssk",
      AccountCode: "Z12345",
      PageSize: 2,
    });
    expect(res.DataRows.length).toBe(2);
    // The first call must have used the empty cursor; the second call
    // must have used `PRX` (the last row's SecurityCode) as the
    // PreviousSecurityCode cursor.
    const params1 = (call.mock.calls[0]![0] as { parameters: Record<string, unknown> }).parameters;
    const params2 = (call.mock.calls[1]![0] as { parameters: Record<string, unknown> }).parameters;
    expect(params1["PreviousSecurityCode"]).toBe("");
    expect(params1["AccountCode"]).toBe("Z12345");
    expect(params2["PreviousSecurityCode"]).toBe("PRX");
  });
});

// ─── 9. Raw-row price-data helpers (closed-market write-through) ───────

describe("pricingQuoteGet surfaces RawDataRows for the worker write-through path", () => {
  it("populates RawDataRows with the original unmapped row even when the mapped Quote collapses to last=0", async () => {
    // Verifies the contract the worker depends on: a closed-market row whose
    // mapped `last` is 0 still carries the original LastPrice / PreviousClose
    // fields in RawDataRows so the worker can decide to write through.
    const call = vi.fn().mockResolvedValueOnce({
      result: {},
      header: { ErrorNumber: 0 },
      dataRows: [
        {
          SecurityCode: "SOL",
          Exchange: "JSE",
          MarketState: "C",
          Last: 0,
          LastPrice: 1_582_300, // cents
          PreviousClosePrice: 1_580_000,
        },
      ],
    });
    const transport: SoapTransport = { call } as unknown as SoapTransport;
    const client = createLiveIressClient({ transport });
    const res = await client.pricingQuoteGet({
      Header: { SessionKey: "k", RequestID: "r1" },
      SecurityCode: "SOL",
      Exchange: "JSE",
    });
    expect(res.DataRows).toHaveLength(1);
    expect(res.RawDataRows).toBeDefined();
    expect(res.RawDataRows?.[0]?.["LastPrice"]).toBe(1_582_300);
    expect(res.RawDataRows?.[0]?.["PreviousClosePrice"]).toBe(1_580_000);
    expect(res.RawDataRows?.[0]?.["MarketState"]).toBe("C");
  });
});

describe("quoteRawRowHasPriceData", () => {
  it("returns false for null / non-object rows", () => {
    expect(quoteRawRowHasPriceData(null)).toBe(false);
    expect(quoteRawRowHasPriceData(undefined)).toBe(false);
    expect(quoteRawRowHasPriceData("SOL")).toBe(false);
    expect(quoteRawRowHasPriceData(42)).toBe(false);
  });

  it("returns false for an empty row", () => {
    expect(quoteRawRowHasPriceData({})).toBe(false);
  });

  it("returns false when every known price field is zero", () => {
    // Mirrors the BHG-style empty payload that previously caused the worker
    // to log "no trade" on a market-closed row.
    expect(
      quoteRawRowHasPriceData({
        SecurityCode: "BHG",
        MarketState: "C",
        Last: 0,
        LastPrice: 0,
        PreviousClosePrice: 0,
        BidPrice: 0,
        AskPrice: 0,
      }),
    ).toBe(false);
  });

  it("returns true when LastPrice is non-zero (closed market, cents)", () => {
    expect(
      quoteRawRowHasPriceData({
        SecurityCode: "SOL",
        MarketState: "C",
        LastPrice: 1_582_300, // R15,823.00 in cents
        PreviousClosePrice: 1_580_000,
      }),
    ).toBe(true);
  });

  it("returns true when PreviousClosePrice is non-zero (LastPrice=0, Last>0)", () => {
    // NPN-style row where IRESS ships the raw `Last` (ZAR) but the close is
    // the only canonical anchor on a closed day.
    expect(
      quoteRawRowHasPriceData({
        SecurityCode: "NPN",
        MarketState: "C",
        Last: 285_000.5,
        LastPrice: 0,
        PreviousClosePrice: 284_500,
      }),
    ).toBe(true);
  });
});

describe("quoteRawRowLast", () => {
  it("returns 0 for null / non-object rows", () => {
    expect(quoteRawRowLast(null)).toBe(0);
    expect(quoteRawRowLast(undefined)).toBe(0);
    expect(quoteRawRowLast("SOL")).toBe(0);
  });

  it("returns 0 when no price fields are populated", () => {
    expect(quoteRawRowLast({ SecurityCode: "BHG", MarketState: "C" })).toBe(0);
  });

  it("prefers `Last` when populated (NPN-style row)", () => {
    expect(
      quoteRawRowLast({
        SecurityCode: "NPN",
        MarketState: "C",
        Last: 285_000.5,
        LastPrice: 1_582_300,
        PreviousClosePrice: 284_500,
      }),
    ).toBe(285_000.5);
  });

  it("falls back to LastPrice when Last=0 (AGL/FSR/SOL style closed row)", () => {
    // Worker must produce a non-zero last so the row can be written to Supabase.
    expect(
      quoteRawRowLast({
        SecurityCode: "SOL",
        MarketState: "C",
        Last: 0,
        LastPrice: 1_582_300,
        PreviousClosePrice: 1_580_000,
      }),
    ).toBe(1_582_300);
  });

  it("falls back to LastTrade when both Last and LastPrice are zero", () => {
    expect(
      quoteRawRowLast({
        SecurityCode: "MTN",
        MarketState: "C",
        Last: 0,
        LastPrice: 0,
        LastTrade: 9_550,
        PreviousClosePrice: 9_500,
      }),
    ).toBe(9_550);
  });

  it("falls back to PreviousClose when every other price field is zero", () => {
    expect(
      quoteRawRowLast({
        SecurityCode: "SBK",
        MarketState: "C",
        Last: 0,
        LastPrice: 0,
        LastTrade: 0,
        PreviousClosePrice: 19_200,
      }),
    ).toBe(19_200);
  });
});
