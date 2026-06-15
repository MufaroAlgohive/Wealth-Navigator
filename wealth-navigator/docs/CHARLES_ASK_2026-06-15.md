# MINT OEMS — IRESS status (2026-06-15, after re-reading the V4 docs)

Account `DFM@MINT`, company `Mint`, endpoint `https://webservices-ct.iress.co.za/v4`.
Scope: **IRIS (market data) + IOS+**.

## Correction: 2 of the 3 "blockers" were OUR divergence from the documented SOAP shapes — not IRESS limits

Re-reading the V4 docs showed the live requests had drifted off the documented shapes.
These are fixed on our side (code + one env var); no IRESS action needed unless the
documented shapes still fail after redeploy.

### A. IOS+ session — wrong `Server` value (fixed: env)
We were sending `ServiceSessionStart(Service=IOSPlus, Server=mint_ct)`. The docs are
unanimous that `Server` is the IRESS **Phoenix API server name = `IOSPLUSAPI`**, not the
company instance:
- `04-sessions/02-service-sessions.md` param table + worked example → `<Server>IOSPLUSAPI</Server>`
- `13-soap-examples/service-session-start.iosplus.request.xml` → `<Server>IOSPLUSAPI</Server>`
- `01-foundations/04-getting-started.md` pre-flight → "server name (e.g. `IOSPLUSAPI`)"
- `11-mint-oems/02-sa-endpoints-and-envs.md` → "`IOSPLUSAPI`, `IPSAPI`, `FIXPLUSAPI` … may differ, confirm with IRESS, make configurable"

`mint_ct` is **not** a valid server name; the `666 / "could not locate IDS … session key"`
fault (`06-errors/01-session-error-codes.md`, last row — "session key with `…@IDSAxx` but no
such IDS on the cluster") is consistent with the request never resolving to a real IOS+ server.
Our session key is `…@IDSA01`; market-data works because IRIS needs no service session.

**Fix (no code change — code already defaults to `IOSPLUSAPI`):** set Railway env
`IRESS_IOS_SERVER=IOSPLUSAPI` (currently `MINT_CT`) and restart the worker.

### B. TimeSeriesGet2 — request had drifted off the documented shape (fixed: code)
The V4 sample (`05-services/market-data/02-time-series-get-2.md`, lines 49-55) is:
```xml
<Parameters>
  <Code>SHP</Code>
  <Exchange>JSE</Exchange>
  <DateFrom>2025-01-01</DateFrom>
  <DateTo>2025-12-31</DateTo>
  <Interval>Daily</Interval>
</Parameters>
```
We had drifted to `SecurityCode`+`Code`, `<Frequency>` instead of `<Interval>`, and **four
date aliases each** (`DateFrom/FromDate/StartDate/From`, `DateTo/ToDate/EndDate/To`) — and were
stuck on `Invalid DateFrom`. We now send the documented shape verbatim and nothing else, with
two default-OFF env hatches (`IRESS_TS_PERIOD_FIELD`, `IRESS_TS_SECID_FIELD`) to A/B a suspected
CT-build quirk via `/debug/timeseries-probe` without a redeploy.

**Fix:** code realigned (`src/lib/iress/live.ts`); redeploy worker and re-check the J203 / R-code
polls. Only if the documented shape *still* returns `Invalid DateFrom` is this a genuine CT-build
question for IRESS — and then we'll have the exact request + fault to send.

## The 1 thing that genuinely needs IRESS

### C. Production endpoint + confirm CT data is real
`webservices-ct` is the **documented dev/UAT endpoint** (`11-mint-oems/02-sa-endpoints-and-envs.md`)
and is supposed to carry SA-market data. But our live coverage check (Mon 15 Jun, market hours)
shows CT `PricingQuoteGet` `LastPrice` doesn't match real JSE values, with no constant scale
(ratios ~0.28–3.29; e.g. **Shoprite real ≈ R286.81, CT returns R127.42**).

**Ask Andre:** (a) does `webservices-ct` carry **real** JSE prices or a scrambled/delayed test
feed? and (b) confirm the **production** endpoint + credentials (`https://webservices.iress.co.za/v4`).

## On us
- **Yahoo → IRESS price flip: BLOCKED until C.** Stays in shadow (`IRESS_RETAIL_DRY_RUN=1`, 0 writes).
  CT prices don't match reality, so flipping now would overwrite real client-facing prices. Once on
  the prod endpoint we re-run the coverage/scaling check; ratios ~1.0 ⇒ one-line env flip.
- **Orders + news** unblock once A (IOS+ `IOSPLUSAPI`) lands.

Verifiable live: `GET /debug/iress-methods`, `POST /debug/timeseries-probe` on the worker.
