# MINT OEMS — IRESS status (2026-06-15, after live request-shape reverse-engineering)

Account `DFM@MINT`, company `Mint`, endpoint `https://webservices-ct.iress.co.za/v4`.
Scope: **IRIS (market data) + IOS+**.

We added a raw-SOAP prober to the worker (`POST /debug/soap-raw`) and drove the live CT
server directly. **We solved the request shapes ourselves; both remaining blockers are now
*proven* server-side (entitlement / provisioning), with controlled-experiment evidence.**

## 1. TimeSeriesGet2 — shape solved; blocked by a `DataSource` access entitlement
Reverse-engineered the CT build's actual wire shape (it diverges from the published WSDL sample):
- Period selector: **`<Frequency>`** carrying the V4 *string* enum (`Daily`) — NOT `<Interval>`
  (sending `<Interval>` → `Invalid Parameter Value: <empty> as Frequency`; sending a Long → `Invalid Parameter`).
- Security: **`<SecurityCode>`** — NOT `<Code>` (sending `<Code>` → `Invalid SecId`).
- Feed: **`<DataSource>`** — a recognised param that gates the request.

The wall: **with `<DataSource>` set to ANY value (`JSE`, `IRESS`, `ASX`, `EOD`, `1`, …) the server
returns `soap:Receiver — Invalid access` (code 5)**, checked *before* the date. With `<DataSource>`
omitted, the bridge can't resolve a feed and returns a misleading `Invalid DateFrom` (the same error
appears for every date format/alias/window AND when no date is sent at all — i.e. the date is never
the real problem). So the JSE time-series/EOD feed is **not entitled** for `DFM@MINT` on CT.

**Ask:** enable the **TimeSeriesGet2 historical/EOD data entitlement (the `DataSource`)** for
`DFM@MINT` (JSE EOD prices; ideally NSS/GOVI curve codes + SARB/JIBAR macro too). Then this works
with the shape above — no code change (the worker has env hatches `IRESS_TS_PERIOD_FIELD`/
`IRESS_TS_SECID_FIELD` to match whatever you confirm). One working request+response would also let
us pin the exact `<DataSource>` value.

## 2. IOS+ (all service sessions) — `ServiceSessionStart` can't resolve our session key
`ServiceSessionStart` returns **`code 666 — "Could not locate the session key for this request"`**
for **every** input we send — including a deliberately bogus `Service` ("NOPE"), bogus `Server`
("ZZZBOGUS"), and empty `Server`. A wrong server name would be `25012`; the identical 666 for all
inputs means it fails at the **first step — locating our `@IDSA01` IRESSSessionKey — before it
validates Service/Server.** The same `IRESSSessionKey` works fine for `PricingQuoteGet` (IRIS needs
no service session). Per `06-errors/01-session-error-codes.md`, 666 = "could not locate IDS … session
key with `…@IDSAxx` but no such IDS on the cluster — inform your IRESS account exec."

**Ask:** is `DFM@MINT` provisioned/entitled for **IOS+ (and IPS/FIX+) service sessions** on CT, and
can the `@IDSA01` IDS our session lands on actually create service sessions — or is there a routing
step (specific host/endpoint) the WebServicesTester does that the load-balanced `/v4` URL doesn't?

## 3. Production endpoint + confirm CT data is real
CT `PricingQuoteGet` prices don't match real JSE values, no constant scale (e.g. Shoprite real
≈ R286.81, CT returns R127.42) — looks like a test feed.
**Ask:** (a) does `webservices-ct` carry real prices or test data? (b) confirm the **production**
endpoint + creds (`https://webservices.iress.co.za/v4`).

## On us
- **Yahoo → IRESS price flip: BLOCKED until #3.** Shadow only (`IRESS_RETAIL_DRY_RUN=1`, 0 writes).
- Orders + news unblock on #2; price history / curves / macro on #1.

Reproduce live: `POST /debug/soap-raw` (exact wire params), `GET /debug/iress-methods`.
