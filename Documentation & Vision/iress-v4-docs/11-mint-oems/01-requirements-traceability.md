# Mint OEMS — Requirements Traceability

The Mint team sent Charles a tick-box manifest (see the email in the repo root) covering the SA market. This page traces each tick-box to the **V4 method(s)** that fulfill it, and links to the relevant doc.

> The exact code strings (security codes, curve codes, macro codes, destination names) are **IRESS reference-data values** that must be confirmed with the IRESS Vol-2 reference-data feed. The methods themselves are stable; the codes aren't.

## Traceability matrix

### Reference data

| Requirement | V4 method(s) | Doc |
|---|---|---|
| Security reference (JSE equities, Z instruments, NCDs, etc.) | `TimeSeriesGet2` (for codes & metadata), Iress Pro security-lookup methods (per WSDL) | [`../05-services/market-data/02-time-series-get-2.md`](../05-services/market-data/02-time-series-get-2.md) |
| Currency / exchange metadata | Iress Pro reference methods | [`../05-services/market-data/`](../05-services/market-data/) |
| Fee schedule / destination metadata | `DestinationGet`, `DestinationDetailGet`, `AttributeGetByUser` | [`../05-services/iosplus/contingent-orders/01-destinations-and-identification.md`](../05-services/iosplus/contingent-orders/01-destinations-and-identification.md) |

### Equities (L1 / L2)

| Requirement | V4 method(s) | Doc |
|---|---|---|
| **L1** — best bid/offer, last trade, volume | `PricingQuoteGet` (+ `PricingQuoteExGet` for extended) | [`../05-services/market-data/03-pricing-quote-get.md`](../05-services/market-data/03-pricing-quote-get.md) |
| **L2** — order book depth | Iress Pro depth methods (per WSDL) — likely `PricingQuoteExGet` or a depth-specific method | (WSDL-dependent) |
| Streaming L1 / L2 | `PricingQuoteGet` + `PricingQuoteGetUpdates` | [`../03-paging-and-updates/03-updates.md`](../03-paging-and-updates/03-updates.md) |
| Historical EOD | `TimeSeriesGet2` | [`../05-services/market-data/02-time-series-get-2.md`](../05-services/market-data/02-time-series-get-2.md) |

### Fixed income (clean / dirty pricing, Greeks)

| Requirement | V4 method(s) | Doc |
|---|---|---|
| Clean / dirty price | Iress Pro pricing methods (per WSDL — `PricingQuoteGet` for the snapshot; `PricingQuoteExGet` for the extended fields) | [`../05-services/market-data/03-pricing-quote-get.md`](../05-services/market-data/03-pricing-quote-get.md) |
| Greeks | Extended pricing methods (per WSDL) | (WSDL-dependent) |
| Bond reference (coupon, maturity, issuer) | Iress Pro reference methods + `TimeSeriesGet2` for the price series | [`../05-services/market-data/`](../05-services/market-data/) |

> The PDF doesn't enumerate every bond-pricing method. Confirm the full set with the Vol-2 reference docs.

### Money market — JIBAR / ZARONIA / NCDs

| Requirement | V4 method(s) | Doc |
|---|---|---|
| JIBAR fixings (historic) | `TimeSeriesGet2` with the JIBAR code | [`../05-services/market-data/02-time-series-get-2.md`](../05-services/market-data/02-time-series-get-2.md) |
| ZARONIA fixings (historic) | `TimeSeriesGet2` with the ZARONIA code | same |
| ZARONIA streaming (live) | `TimeSeriesGet2` + `TimeSeriesGet2Updates` (if supported) | [`../03-paging-and-updates/03-updates.md`](../03-paging-and-updates/03-updates.md) |
| NCD pricing | `PricingQuoteGet` (or extended) for the NCD's Iress code; `TimeSeriesGet2` for the series | [`../05-services/market-data/`](../05-services/market-data/) |

### Fitted yield curves — NSS

| Requirement | V4 method(s) | Doc |
|---|---|---|
| NSS-fitted ZAR yield curve points | `TimeSeriesGet2` with the curve code (per-tenor points) | [`../05-services/market-data/02-time-series-get-2.md`](../05-services/market-data/02-time-series-get-2.md) |
| Curve updates (live) | `TimeSeriesGet2` + `TimeSeriesGet2Updates` (if supported) | [`../03-paging-and-updates/03-updates.md`](../03-paging-and-updates/03-updates.md) |

> Confirm the NSS curve code with the IRESS Vol-2 reference data — the OEMS should treat the curve as a typed time series and dispatch on tenor.

### Macro — SARB, StatsSA, G10

| Requirement | V4 method(s) | Doc |
|---|---|---|
| SARB repo rate, ZARONIA, JIBAR history | `TimeSeriesGet2` | [`../05-services/market-data/02-time-series-get-2.md`](../05-services/market-data/02-time-series-get-2.md) |
| StatsSA CPI / unemployment / GDP | `TimeSeriesGet2` | same |
| G10 rates / FX | `TimeSeriesGet2` (FX and rates as separate series) | same |

### SENS announcements & wires

| Requirement | V4 method(s) | Doc |
|---|---|---|
| SENS (JSE Stock Exchange News Service) announcements | Iress Pro news/announcement methods (per WSDL) — likely a time-series or news-feed method | (WSDL-dependent — confirm with IRESS) |
| Wires (cash movements) | IPS transactions (`IPSTransactionGetByAccount5`) | [`../05-services/ips/01-transactions.md`](../05-services/ips/01-transactions.md) |

### Auth

| Requirement | V4 method(s) | Doc |
|---|---|---|
| User login | `IRESSSessionStart` | [`../04-sessions/01-iress-sessions.md`](../04-sessions/01-iress-sessions.md) |
| Logout | `IRESSSessionEnd` (and `ServiceSessionEnd` first) | same |
| Session recovery (license exhaustion) | `IRESSSessionStart(SessionNumberToKick=…)` | [`../04-sessions/03-user-scenarios.md`](../04-sessions/03-user-scenarios.md) |
| Force-close all | `IRESSSessionStart(SessionNumberToKick=-1)` | same |

### Streaming

| Requirement | V4 method(s) | Doc |
|---|---|---|
| Live L1 quotes | `PricingQuoteGet` + `PricingQuoteGetUpdates` | [`../03-paging-and-updates/03-updates.md`](../03-paging-and-updates/03-updates.md) |
| Live order pad | `OrderPadGetBy*` + `OrderPadGetBy*Updates` | [`../05-services/iosplus/02-order-pad.md`](../05-services/iosplus/02-order-pad.md) |
| Live curve / macro | `TimeSeriesGet2` + `TimeSeriesGet2Updates` (per method support) | [`../03-paging-and-updates/03-updates.md`](../03-paging-and-updates/03-updates.md) |

### SLA (system / performance)

| Requirement | V4 concept | Doc |
|---|---|---|
| Compression (gzip) | `Accept-Encoding: gzip` HTTP header | [`../08-performance/01-client-side-optimisations.md`](../08-performance/01-client-side-optimisations.md) |
| 50 active requests per session | server-side cap | [`../08-performance/02-server-side-limits.md`](../08-performance/02-server-side-limits.md) |
| 2-hour idle session expiry | server-side cap | [`../04-sessions/05-session-expiration.md`](../04-sessions/05-session-expiration.md) |
| 30-minute request expiry | server-side cap | [`../08-performance/02-server-side-limits.md`](../08-performance/02-server-side-limits.md) |
| 10 000-row update queue | server-side cap | [`../06-errors/03-faq.md`](../06-errors/03-faq.md) |

### Reconciliation

| Requirement | V4 method(s) | Doc |
|---|---|---|
| Daily trade reconciliation | `IPSTransactionGetByAccount5` | [`../05-services/ips/01-transactions.md`](../05-services/ips/01-transactions.md) |
| Booking / fee reconciliation | `BookingGetByOrganisation2` | [`../05-services/iosplus/03-bookings.md`](../05-services/iosplus/03-bookings.md) |
| Holdings reconciliation | `IPSPositionGetAll1` (legacy paging) | [`../05-services/ips/`](../05-services/ips/) + [`../03-paging-and-updates/04-paging-in-ips.md`](../03-paging-and-updates/04-paging-in-ips.md) |
| Account list reconciliation | `IPSAccountGetAll1` (legacy paging) | same |
| FIX+ drop-copy status | `TargetIDGet` + `TargetIDStatusGet` | [`../05-services/fixplus/01-fixplus.md`](../05-services/fixplus/01-fixplus.md) |

## What you don't get from V4

- **Real-time FIX message stream** for the drop-copy itself. V4 FIX+ is for control/status; the actual FIX bytes come over a **separate TCP FIX connection**. Confirm with IRESS.
- **Hosted OMS UI**. V4 is the API; the OEMS UI is what you build.
- **Pre-trade compliance** (e.g. fat-finger, regulatory checks). Those are OEMS responsibilities; you can use V4 data to implement them but the rules engine is your code.
- **Settlement / clearing** (e.g. STRATE). Use the IPS transactions + bookings for downstream reconciliation, but settlement itself isn't a V4 method.

## Gaps to flag at the session with Charles

The email said: *"Where a specific endpoint, field, or behaviour is not a direct match to what you have, please propose the closest alternative."* A few to surface:

1. **L2 depth** — confirm whether IRESS exposes a true L2 depth method or only an extended L1 (book snapshot) via `PricingQuoteExGet`. If only L1, consider whether a third-party feed (e.g. JSE direct) is needed for the OEMS.
2. **NSS curve delivery** — confirm the code and the per-tenor shape. The OEMS may need to render the curve as `(tenor, yield)` pairs.
3. **SENS** — confirm whether V4 exposes SENS as a news/announcement feed or as a per-security time series. If neither, consider a SENS subscription from a different vendor.
4. **ZARONIA / JIBAR streaming** — confirm whether updates are supported on the relevant `TimeSeriesGet2` instance; if not, poll on a schedule.
5. **Pre-trade compliance hooks** — V4 doesn't have a "pre-flight check" method. The OEMS must implement its own (and use `OrderPadGet*` and `PricingQuoteGet` for context).

## See also

- [`02-sa-endpoints-and-envs.md`](02-sa-endpoints-and-envs.md) — the SA endpoint / environment strategy.
- [`03-call-graph-jse-order.md`](03-call-graph-jse-order.md) — full call graph for a JSE order.
- [`04-low-hanging-fruit.md`](04-low-hanging-fruit.md) — the "low-hanging fruit" call-out the email asked for.
