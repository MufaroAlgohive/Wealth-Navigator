# MINT OEMS — IRESS status (2026-06-16): almost everything is a code fix on our side

Account `DFM@MINT`, company `Mint`, endpoint `https://webservices-ct.iress.co.za/v4`.
Scope: **IRIS (market data) + IOS+**.

> **Headline (Andre is right — it was our calling shape every time):** every blocker we
> hit turned out to be a wrong field name / wrong exchange / wrong DataSource on our side,
> NOT an entitlement wall. We've now self-fixed market data (equities + **fixed income**),
> orders, and positions. The only genuine gaps left are a handful of instruments that are
> **not in our security master at all** (FX spot, JSE equity index levels, SARB/ZARONIA
> rates) plus the production endpoint.

## How we found it (so you can reproduce)
We discovered `SecuritySearchGet` is callable on this build and used it to look up the real
codes/exchanges/feeds ourselves (the docs only said "security-lookup methods, per WSDL"):
- `SecuritySearchGet(SearchText="R2030")` → `R2030` on Exchange **`YFX`**, ISIN ZAG000106998.
- `SecuritySearchGet(SearchText="GOVI")` → `GOVI` "GOVI TOTAL RETURN INDEX" on **`YFX`**.

The key insight: **the DataSource is exchange-specific, not account-global.** JSE
equities/ETFs use `JSED`; YFX bonds/curve/indices use **`YFXD`**. Sending `JSED` for a YFX
instrument returns **`error 5 "Invalid access"`** — which we had wrongly read as a missing
entitlement. It was the wrong feed name for that exchange.

## SOLVED on our side (no IRESS action needed)

1. **Equities — quotes + EOD history.** `PricingQuoteGet` / `TimeSeriesGet2` with
   `Exchange=JSE`, `DataSource=JSED`. (NPN, SOL, etc. return full data.)
2. **TimeSeriesGet2 wire shape.** The live build reads `SecurityCode` + `DataSource` +
   `Frequency` (string `Daily`) + `TimeSeriesFromDate`/`TimeSeriesToDate` — not the WSDL
   sample's `<DateFrom>`/`<Interval>`.
3. **IOS+ orders + positions.** `ServiceSessionStart` with the `IRESSSessionKey` in
   `<Parameters>` + `Server=MINT_CT`. 18 live orders read on account 56378; positions
   derived from fills.
4. **Fixed income — bonds, GOVI index, the whole ZAR govt yield curve.** `TimeSeriesGet2`
   with `Exchange=YFX`, `DataSource=YFXD` returns the full daily history:
   - `R2030` → 7.92%, `R186` → 7.33%, `R2040` → 9.05%, `R2048` → 9.14% (a clean
     upward-sloping curve across the GOVI basket).
   - `GOVI` total-return index → ~1316 level series; `GOVISPOT` likewise.
   This is now wired into the worker (curve codes on YFX/YFXD). **No IRESS action needed.**

## Genuine gaps left (these really aren't in our reference data — please confirm/enable)

We proved these with `SecuritySearchGet` (returns **0 rows** = not in our master), so they
need provisioning, not a code change on our side:

1. **FX spot (USD/ZAR).** `SecuritySearchGet("USDZAR" / "USD" / "DOLLAR")` → nothing usable
   (only USD barrier-option exotics). `PricingQuoteGet(USDZAR, …)` returns a blank
   DataSource on every exchange we tried (REUTERS/BLOOMBERG/SARB/WMR/FOREX/CCY). **Ask:**
   what is the IRESS code + Exchange + DataSource for USD/ZAR spot on our account, or
   please enable the FX feed.
2. **JSE equity index levels (ALSI/Top 40 / J203).** The code resolves on `JSED` but
   returns no data (indices are calculated, not quoted), and `SecuritySearchGet` doesn't
   list them. **Ask:** the index feed's DataSource + codes for J203/J200 (and sector
   indices). *Workaround in place:* index-tracking ETFs (`STX40`, `ETFT40`) quote fine on
   `JSED`, so the dashboard can show those until the index feed is on.
3. **Rates: SARB repo, prime, ZARONIA, real JIBAR fixings.** `SecuritySearchGet` returns
   0 rows for ZARONIA/PRIME/REPO; a `JIBAR` code exists on YFX but its series is a
   placeholder (`1`). **Ask:** the codes/exchange/DataSource for the SARB/JIBAR/ZARONIA
   fixings (or confirm they're not on this account).
4. **Production endpoint.** CT looks delayed/test (NPN ~R6.08). **Ask:** confirm `webservices-ct`
   is delayed/test and provide the **production** endpoint + creds
   (`https://webservices.iress.co.za/v4`) for go-live.

## Status by feature
- **Equities / quotes / EOD history:** ✅ JSED.
- **Fixed income / bonds / GOVI index / ZAR yield curve:** ✅ YFX + YFXD (self-fixed).
- **Orders / blotter / positions:** ✅ IOS+ (self-fixed).
- **FX spot, JSE equity index levels, SARB/JIBAR/ZARONIA rates:** ⏳ not in our master (#1–3).
- **Retail price cutover:** ⏳ needs prod endpoint (#4).

Reproduce live: `POST /debug/soap-raw` (e.g. `{"method":"SecuritySearchGet","parameters":{"SearchText":"GOVI"}}`
or `{"method":"TimeSeriesGet2","parameters":{"SecurityCode":"R2030","Exchange":"YFX","DataSource":"YFXD","Frequency":"Daily","TimeSeriesFromDate":"2026-05-01","TimeSeriesToDate":"2026-06-16"}}`).
