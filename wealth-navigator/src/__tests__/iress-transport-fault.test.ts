import { describe, expect, it } from "vitest";

import { IressError } from "@/lib/iress/errors";
import { createSoapTransport, type SoapCallSpec } from "@/lib/iress/transport";

/** Minimal fake `fetch` returning a fixed status + body. */
function fakeFetch(status: number, body: string): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  })) as unknown as typeof fetch;
}

const SVC_SPEC: SoapCallSpec = {
  method: "ServiceSessionStart",
  header: {},
  parameters: { Service: "IOSPlus", Server: "MINT_CT" },
};

async function callAndCatch(t: ReturnType<typeof createSoapTransport>): Promise<unknown> {
  return t.call(SVC_SPEC).then(
    () => null,
    (e) => e,
  );
}

describe("SOAP transport — fault body capture", () => {
  it("surfaces the raw server body when a 500 has no faultstring/detail", async () => {
    // Exactly the shape that previously collapsed to just "soap:Receiver — HTTP 500".
    const body = "<html><body>Server Error: user not entitled for service IOSPlus</body></html>";
    const t = createSoapTransport({ baseUrl: "https://x/v4", fetchImpl: fakeFetch(500, body) });

    const err = await callAndCatch(t);
    expect(err).toBeInstanceOf(IressError);
    expect((err as Error).message).toContain("[body:");
    expect((err as Error).message).toContain("not entitled");
    expect((err as { soapFault?: { rawBody?: string } }).soapFault?.rawBody).toContain("not entitled");
  });

  it("does NOT append the raw body when a structured IRESSFaultDetail is present", async () => {
    const body =
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
      `<soap:Fault><faultcode>soap:Receiver</faultcode><faultstring>err</faultstring>` +
      `<detail><IRESSFaultDetail><Number>25034</Number><Message>Entitlement check failed</Message></IRESSFaultDetail></detail>` +
      `</soap:Fault></soap:Body></soap:Envelope>`;
    const t = createSoapTransport({ baseUrl: "https://x/v4", fetchImpl: fakeFetch(200, body) });

    const err = await callAndCatch(t);
    expect(err).toBeInstanceOf(IressError);
    expect((err as Error).message).toContain("Entitlement check failed");
    expect((err as Error).message).not.toContain("[body:");
  });
});
