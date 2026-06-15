# MINT OEMS — IRESS status & the 2 things left (2026-06-15)

After the Andre call + a day of live debugging. Account `DFM@MINT`, company `Mint`,
endpoint `https://webservices-ct.iress.co.za/v4`. Scope: **IRIS (market data) + IOS+**.

## Resolved (no longer blockers)
- **No entitlement limits.** Andre confirmed every 500 is request-shape, not permissions.
- **Service model:** IRIS = all market data (quotes, time-series, **news**), no server name.
  IOSPlus = orders/accounts, `Server=mint_ct`. IPS / FIX+ are never called.
- **`mint_ct` casing / company `Mint`** — confirmed irrelevant / correct.
- **TimeSeriesGet2 wire shape — SOLVED by us.** The live CT build wants the period in a
  `<Frequency>` field carrying the V4 **string** enum (`Daily`), with `<DateFrom>`/`<DateTo>`,
  on the base IRIS session. Proven empirically: the fault advanced
  `5 as Frequency` → `<empty> as Frequency` → past all params to **`Invalid SecId`**.

## The 2 things still needed from IRESS (Andre)

### 1. TimeSeriesGet2 — the exact DateFrom form (we solved everything up to it)
We've worked the request shape out by trial against the live CT server and got past two layers:
- Period selector: `<Frequency>` carrying the **string** enum `Daily` (not a Long, not `<Interval>`).
- Security: `<SecurityCode>` (like every other method) — **not** `<Code>`. This resolved the
  earlier `Invalid SecId`.

It now fails only on the date, with `{"title":"Invalid DateFrom","detail":"Bad request syntax or
unsupported method","status":400}`. We've exhaustively tried, all rejected identically:
- **Value formats:** `2026-06-01`, `2026-06-01T00:00:00`, `…Z`, `…000Z`, epoch-ms, epoch-s,
  `2026/06/01`, `06/01/2026`, `01-Jun-2026`, space-separated.
- **Years:** 2024, 2025 (your doc's example range) and 2026.
- **Field-name aliases:** `DateFrom`, `FromDate`, `StartDate`, `From`.
- **Omitting the range** (with `NumberOfPoints`) — still `Invalid DateFrom`.

Since a recognised field rejects every value, alias **and** omission — and the detail is the
TimeSeries REST layer's generic HTTP 400 — this looks like a SOAP→REST bridge detail on the build.

**Ask:** one working TimeSeriesGet2 request/response for a JSE equity daily series (and ideally one
index/curve). Seeing the exact `<DateFrom>`/`<DateTo>` form (and confirming `<SecurityCode>` +
`<Frequency>Daily`) closes this out — it unblocks JSE price history, yield curves, ALSI/indices and
macro (our Yahoo replacement).

### 2. IOS+ orders — the session + a working order SOAP
`ServiceSessionStart(Service=IOSPlus, Server=mint_ct)` returns
**"Could not locate the session key for this request."** even though the same `IRESSSessionKey`
works for `PricingQuoteGet`. We confirmed IRESS issues **no affinity cookie**, so it's not
client-side stickiness. Our session lands on node `…@IDSA01`.

**Ask:** (a) how does the session reach the `mint_ct` node for service-session creation — a
specific endpoint/host, or a routing step the WebServicesTester does? and (b) the working
order-send SOAP example you offered (request + response).

## On us (no IRESS dependency)
- **Yahoo → IRESS price flip:** ready; flip `IRESS_RETAIL_DRY_RUN=0` in Monday market hours
  after a coverage/scaling check (IRESS currently prices ~132–149 / 246 names; the rest stay on
  Yahoo, never blanked).
- **News via IRIS:** can be wired from the worker once the above two are in (news is an IRIS feed).

Everything is verifiable live: `GET /debug/iress-methods` and
`POST /debug/timeseries-probe {code,exchange,interval}` on the worker.
