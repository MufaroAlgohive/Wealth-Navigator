# MINT OEMS — IRESS status (2026-06-16): market data SOLVED, 3 small items left

Account `DFM@MINT`, company `Mint`, endpoint `https://webservices-ct.iress.co.za/v4`.
Scope: **IRIS (market data) + IOS+**.

> **Framing (Andre is right — nothing is "blocked"):** the two remaining items are NOT
> entitlement walls. They're missing **information** only IRESS has: (1) the exact reference-data
> **codes/exchanges/DataSource** for non-equity instruments — we proved equities work but our
> guesses for FX/index/curve/bonds don't resolve (empty `DataSource`); and (2) the working
> **`ServiceSessionStart` SOAP** for IOS+ — Andre's example showed `OrderCreate3` (which already
> had a `ServiceSessionKey`) but never the call that *creates* it, which is exactly where we fail.
> Both are quick answers, like the `TimeSeriesFromDate` field that unblocked time-series.

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

### 1. Enable the non-equity DataSources for `DFM@MINT` (CT account currently has ONLY JSE equities)
Confirmed empirically: on CT, `DFM@MINT` only has the **`JSED`** (JSE equities, delayed) feed.
Everything else is a recognised code but returns **no data** (empty `<DataSource>`, `ErrorNumber` 1/5):
- Indices (`J203`/ALSI) — `ErrorNumber 1`, no data on `JSED`; other index sources → `Invalid access` (code 5).
- Bonds / NSS-GOVI curve (`R186`, `R2030`, …) — empty `DataSource`, "Invalid code/exchange" on time-series.
- FX (`USDZAR`) — `ErrorNumber 5`, empty `DataSource`.
- Rates / macro (`JIBAR3M`, `ZARONIA`, `SARBREPO`) — `ErrorNumber 1`, empty `DataSource`.
Equities (`NPN` etc.) return full data under `JSED`. TimeSeriesGet2 + quotes both work — it's purely
that the other feeds aren't entitled.

**Ask Andre:** enable the DataSources for `DFM@MINT` on CT (or give production) for: **FX (USD/ZAR),
JSE indices (ALSI/J203 + sector J2xx), the NSS/GOVI yield curve, and SARB/JIBAR/ZARONIA rates+macro**
— and confirm the exact `<DataSource>` value + code for each. (`zax` is your admin source — `Invalid
access` for us; ours is `JSED` and it's equities-only.)

### 2. IOS+ — SOLVED on our side (it was our calling shape, like time-series)
`ServiceSessionStart` now succeeds and returns a `ServiceSessionKey`. The `666 "Could not locate the
session key"` was because we sent the `IRESSSessionKey` only in the header — **the CT build reads it
from `<Parameters>`** (the doc lists it as a parameter). Also confirmed: **`Server=MINT_CT`** is correct
(`IOSPLUSAPI` → `25012 Invalid server name` for this account). No IRESS action needed to open the
session. Orders/positions now just need the worker to run with `IRESS_IOS_SERVER=MINT_CT` and the
`OrderCreate3` array shape Andre already gave us.

### 3. Production endpoint + confirm CT is delayed/test
CT returns only today's bar and equity prices look delayed (e.g. NPN close R6.10). **Ask Andre:**
confirm `webservices-ct` is delayed/test, and provide the **production** endpoint + creds
(`https://webservices.iress.co.za/v4`) for go-live. (Retail prices stay on Yahoo until then —
shadow only, 0 writes.)

## Status by feature
- **Equities / quotes / time-series (OHLCV history):** ✅ working (JSED).
- **Indices / curves / macro history:** ⏳ needs the DataSource for those (#1).
- **Orders / blotter / positions:** ✅ IOS+ session opens (key-in-Parameters + `Server=MINT_CT`); flows once the worker runs with `IRESS_IOS_SERVER=MINT_CT`.
- **Retail price cutover:** ⏳ needs prod endpoint + real data (#3).

Reproduce live: `POST /debug/soap-raw` (exact wire params), `POST /debug/timeseries-probe`.
