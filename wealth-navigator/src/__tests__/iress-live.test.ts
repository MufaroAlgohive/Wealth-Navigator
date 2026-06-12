import { afterEach, describe, expect, it, vi } from "vitest";

import type { IressClient } from "@/lib/iress/client";
import { IressError } from "@/lib/iress/errors";
import { createLiveIressClient, liveIressClient } from "@/lib/iress/live";
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
  "orderPadGetByAccount",
  "orderPadGetByAccountUpdates",
  "bookingGetByOrganisation2",
  "ipsTransactionGetByAccount5",
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

  it("has every one of the 17 IressClient methods", () => {
    for (const name of METHOD_NAMES) {
      expect(liveIressClient, `missing method ${name}`).toHaveProperty(name);
      expect(typeof (liveIressClient as unknown as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("createLiveIressClient() returns a fresh object with the same 17 methods", () => {
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
      fakeClient.timeSeriesGet2({ Header: { SessionKey: "", RequestID: "r1" }, Code: "ZAR_NSS" }),
    ).rejects.toBeInstanceOf(IressError);
  });

  it("timeSeriesGet2 — missing Code", async () => {
    await expect(
      fakeClient.timeSeriesGet2({ Header: { SessionKey: "k", RequestID: "r1" }, Code: "" }),
    ).rejects.toBeInstanceOf(IressError);
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
