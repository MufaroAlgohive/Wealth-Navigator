# MINT OEMS — IRESS status (2026-06-15, after re-reading the V4 docs + a clean redeploy)

Account `DFM@MINT`, company `Mint`, endpoint `https://webservices-ct.iress.co.za/v4`.
Scope: **IRIS (market data) + IOS+**.

## What we did on our side first (so we're not asking IRESS to debug our code)
- Re-read the V4 docs and **removed our request-shape guesses**: TimeSeriesGet2 now sends the
  documented `<Code>/<Exchange>/<DateFrom>/<DateTo>/<Interval>` shape; IOS+ `Server` now uses the
  documented `IOSPLUSAPI` (was `mint_ct`).
- Redeployed to CT and captured the live faults below. **Both blockers persist with sharper,
  doc-referenced evidence — they are IRESS-side, not request typos.**

## 1. TimeSeriesGet2 — the CT build diverges from the published doc; need the working request
The published sample (`05-services/market-data/02-time-series-get-2.md`, lines 49-55) uses
`<Interval>Daily</Interval>` + `<Code>`. On the live CT build:
- Sending the documented `<Interval>Daily</Interval>` → `soap:Receiver — Invalid Parameter Value:
  <empty> as Frequency`. The build **ignores `<Interval>` and reads a `<Frequency>` field.**
- Sending `<Frequency>Daily</Frequency>` (the V4 *string* enum) advances past that, then the build
  rejects `<Code>` until we send `<SecurityCode>` (every other method's convention).
- With `<Frequency>` + `<SecurityCode>` correct, it then rejects **`<DateFrom>`** with
  `{"title":"Invalid DateFrom","detail":"Bad request syntax or unsupported method","status":400}`
  for every value/format/alias/omission we've tried (`2025-01-01`, ISO+Z, epoch ms/s, `dd-Mon-yyyy`,
  `DateFrom/FromDate/StartDate/From`, and omitting the range with `NumberOfPoints`).

**Ask:** one working `TimeSeriesGet2` request + response for a **JSE equity daily series** on CT —
specifically the exact `<DateFrom>`/`<DateTo>` form, and confirmation of the period field name
(`<Frequency>` vs `<Interval>`) + security field (`<SecurityCode>` vs `<Code>`). That single example
unblocks price history, yield curves, ALSI/indices and macro. (Our worker has default-off env hatches
`IRESS_TS_PERIOD_FIELD` / `IRESS_TS_SECID_FIELD` so we can match whatever you confirm without a redeploy.)

## 2. IOS+ session — "could not locate the session key" for our IDS, with the documented server name
`ServiceSessionStart(Service=IOSPlus, Server=IOSPLUSAPI)` (the documented Phoenix name) returns
**HTTP 500 — "Could not locate the session key for this request."** — the *same* fault we got with
`mint_ct`. A wrong server name would be `25012`; getting the identical "locate" fault for both means
it fails **before** server-name validation. Per `06-errors/01-session-error-codes.md` this is the
`666 "could not locate IDS … session key with …@IDSAxx but no such IDS"` case. Our IRESS session is
`…@IDSA01` and `PricingQuoteGet` works fine on it (IRIS needs no service session).

**Ask:** (a) is `DFM@MINT` provisioned/entitled for **IOS+ service sessions** on CT? and (b) how does
ServiceSessionStart reach the IOS+ IDS for a session pinned to `@IDSA01` — a specific host/endpoint, or
a routing step the WebServicesTester performs? Plus the working order-send SOAP example when ready.

## 3. Production endpoint + confirm CT data is real
CT is the documented dev/UAT endpoint and should carry SA data, but our live coverage check shows CT
`PricingQuoteGet` `LastPrice` doesn't match real JSE values, no constant scale (ratios ~0.28–3.29; e.g.
**Shoprite real ≈ R286.81, CT returns R127.42**).

**Ask:** (a) does `webservices-ct` carry **real** JSE prices or a test feed? and (b) confirm the
**production** endpoint + credentials (`https://webservices.iress.co.za/v4`).

## On us
- **Yahoo → IRESS price flip: BLOCKED until #3.** Shadow only (`IRESS_RETAIL_DRY_RUN=1`, 0 writes) — CT
  prices don't match reality, so flipping now would overwrite real client-facing prices.
- Orders + news unblock once #2 lands; price history / curves / macro once #1 lands.

Verifiable live: `GET /debug/iress-methods`, `POST /debug/timeseries-probe` on the worker.
