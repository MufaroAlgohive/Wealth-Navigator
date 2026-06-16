# MINT OEMS — IRESS status (2026-06-16): market data SOLVED, 3 small items left

Account `DFM@MINT`, company `Mint`, endpoint `https://webservices-ct.iress.co.za/v4`.
Scope: **IRIS (market data) + IOS+**.

## SOLVED on our side — TimeSeriesGet2 now works (it was our calling shape, as Andre said)
Using Andre's working SOAP, the live CT shape is (the published WSDL sample is wrong here):
- `<SecurityCode>` (not `<Code>`), `<Exchange>`
- `<DataSource>JSED</DataSource>` — required (our account's feed)
- `<Frequency>Daily</Frequency>` — string enum (`Daily`/`Weekly`/`Monthly`), not `<Interval>`
- **`<TimeSeriesFromDate>` / `<TimeSeriesToDate>`** — the date fields. The old `<DateFrom>`
  was never read, which is why every value returned "Invalid DateFrom".

Confirmed live: NPN returns a full OHLCV bar (Open/High/Low/Close/Volume/TradeCount/VWAP).
Wired into the worker; equities work. **No IRESS action needed for equity time-series.**

## 3 small, precise items left

### 1. DataSource for indices / curves / macro (equities already work on `JSED`)
`JSED` is an **equities-only delayed** feed. `J203` is accepted as a code and the call succeeds,
but returns no rows on `JSED`; every other source we try for indices (`JSEI`, `INDEX`, `zax`, …)
returns `Invalid access` (code 5) for `DFM@MINT`. **Ask Andre:** which `<DataSource>` should we use
for (a) JSE indices (ALSI/J203), (b) the NSS/GOVI yield curve, (c) SARB/JIBAR macro — and is it
enabled for `DFM@MINT`? (`zax` is your admin source — `Invalid access` for us.)

### 2. IOS+ — `DFM@MINT` can't open a service session
`ServiceSessionStart(IOSPlus, …)` returns **`666 "Could not locate the session key for this request"`**
for *every* Service/Server value (including deliberately bogus ones) — so it fails at session-key
resolution, before server-name validation; not a request-shape issue. Your `OrderCreate3` example
shows IOS+ works on node `IDSA01` for an admin session, and our `IRESSSessionKey` (`…@IDSA01`) works
fine for market data. **Ask Andre:** please confirm `DFM@MINT` is permissioned to **open an IOS+
service session** (the user you mentioned setting up with Charles), and share a working
`ServiceSessionStart` for `DFM@MINT`. (We have your `OrderCreate3` array shape ready for once the
service session opens.)

### 3. Production endpoint + confirm CT is delayed/test
CT returns only today's bar and equity prices look delayed (e.g. NPN close R6.10). **Ask Andre:**
confirm `webservices-ct` is delayed/test, and provide the **production** endpoint + creds
(`https://webservices.iress.co.za/v4`) for go-live. (Retail prices stay on Yahoo until then —
shadow only, 0 writes.)

## Status by feature
- **Equities / quotes / time-series (OHLCV history):** ✅ working (JSED).
- **Indices / curves / macro history:** ⏳ needs the DataSource for those (#1).
- **Orders / blotter / positions:** ⏳ needs IOS+ access for DFM@MINT (#2).
- **Retail price cutover:** ⏳ needs prod endpoint + real data (#3).

Reproduce live: `POST /debug/soap-raw` (exact wire params), `POST /debug/timeseries-probe`.
