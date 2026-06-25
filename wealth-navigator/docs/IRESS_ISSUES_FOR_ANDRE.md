# IRESS V4 — open integration items

**To:** Andre (IRESS)
**From:** MINT / Wealth Navigator integration
**Profile:** `DFM@Mint`  ·  **Endpoint:** `https://webservices-ct.iress.co.za/v4` (CT)
**Date:** 2026-06-22

Andre — thanks for the SOAP wire-shape confirmations on 15–16 June; they unblocked
the bond/curve feed. Below is a consolidated list of what's now working and the
items still open, each with the exact evidence from our side (error codes,
responses, the codes/exchanges we tried). Could you confirm or correct each, and
flag anything that needs Charles (entitlements/account) vs a code/feed answer?

---

## Working now (for context — no action needed)

| Feed | Method | Exchange / DataSource | Notes |
|---|---|---|---|
| JSE equity quotes (10-name watchlist) | `PricingQuoteGet` | `JSE` / `JSED` | NPN, PRX, FSR, SBK, AGL, MTN, SOL, SHP, CPI live (BHG is an issue — see #6) |
| ZAR govt bonds + GOVI yield curve | `TimeSeriesGet2` | **`YFX` / `YFXD`** | R186, R2030, R2032, R2035, R2037, R2040, R2044, R2048 return full history |
| ZAR real (ILB) curve | `TimeSeriesGet2` | `YFX` / `YFXD` | I2029, I2033, I2038, I2046, I2050 (yield-only) |
| Bond reference terms | `SecuritySearchGet` | — | `SecurityType=401`, coupon/maturity from `SecurityDescription` |
| Order mirror (read-only) | `OrderPadGetByAccount` | IOS+, `Server=MINT_CT` | 18 live orders on account 56378 |

The key learning from 16 June: **`DataSource` is exchange-specific, not
account-global** (JSE→`JSED`, YFX→`YFXD`), and the accepted `TimeSeriesGet2` wire
shape on this build is `<Frequency>Daily</Frequency>` (string) +
`<TimeSeriesFromDate>`/`<TimeSeriesToDate>` + a required `<DataSource>`. Sending
`JSED` for a YFX instrument returns `Invalid access` (error 5), which we had
misread as an entitlement wall. That's resolved.

---

## Open items

### 1. JSE index levels — J203 (ALSI), J200 (Top 40), sector indices

**Highest priority.** With the confirmed `Daily`/`DataSource` shape, bonds on
`YFX`/`YFXD` work — but the JSE index codes do not.

- `TimeSeriesGet2(J203, Exchange=JSE, DataSource=JSED, Frequency=Daily)` → the code
  **resolves but returns zero data rows**. No fault, just an empty series.
- `SecuritySearchGet("J203" / "ALSI" / "Top 40")` does **not** list the indices.
- Our read: JSE indices are *calculated*, not quoted, so they likely sit on a
  different exchange/feed (as the bonds did on YFX/YFXD).

**Ask:** what `Exchange` + `DataSource` (and exact codes) should we use for J203,
J200, and the JSE sector indices? Or is index history a different method on this
account? This blocks the ALSI intraday panel and the sector heatmap.

### 2. FX spot — USD/ZAR (and majors)

- `SecuritySearchGet("USDZAR" / "USD" / "DOLLAR")` → nothing usable (only USD
  barrier-option exotics).
- `PricingQuoteGet(USDZAR, …)` → blank `DataSource` on REUTERS / BLOOMBERG / SARB /
  WMR / FOREX / CCY.

**Ask:** the correct code + Exchange + DataSource for USD/ZAR spot, or confirm the
FX feed isn't on `DFM@Mint`. (We currently fall back to the ECB/Frankfurter API.)

### 3. Money-market & rates — JIBAR fixings, ZARONIA, Prime, Repo, SARB

- `SecuritySearchGet` returns **0 rows** for ZARONIA / PRIME / REPO.
- A `JIBAR` code exists on `YFX`, but its `TimeSeriesGet2` series is a
  **placeholder (single value `1`)**, not the real fixing.

**Ask:** the codes / Exchange / DataSource for the JIBAR fixings curve, ZARONIA,
Prime and Repo (or confirm these need a vendor/SARB feed instead). Blocks the
money-market page + the JIBAR/ZARONIA rate tiles.

### 4. Equity fundamentals — P/E, EPS, market cap, dividend, beta

- There is **no fundamentals method wired** on our side — `SecurityGet` isn't in
  our V4 client, and we don't know the entitlement status on `DFM@Mint`.
- These currently come from a Yahoo fallback, which we want to retire.

**Ask:** which V4 method returns issuer fundamentals (market cap, P/E, EPS,
dividend, beta) for JSE equities, and is it entitled on this profile? (This also
unblocks market-cap-weighted sector indices.)

### 5. Equity price history — 1M / 6M / YTD returns

- We have the working `TimeSeriesGet2` shape for `YFX`/`YFXD`. We need the
  equivalent confirmed for **JSE equities** (`Exchange=JSE`, `DataSource=JSED`,
  `Frequency=Daily`) — i.e. does `TimeSeriesGet2(NPN, JSE, JSED, Daily, <date
  range>)` return a price history series on this account?

**Ask:** confirm JSE equity daily history works with that shape (and any
entitlement needed). Blocks the 1M/6M return columns + YTD performance.

### 6. BHG (Bidcorp) — hollow JSE equity row

- `PricingQuoteGet(BHG, JSE)` returns a row whose only non-zero fields are
  `LastPrice` / `PreviousClosePrice`, and even those are stale (rejected by our
  last-price resolver). `marketState = OPEN` but there is **no live price data**.
- Every other watchlist name on the same board prices fine.

**Ask:** is BHG on the correct board/exchange for `DFM@Mint`? An `OPEN` market
state with no price data points to a listing/board mismatch for this one name.

### 7. `PreviousClosePrice` coverage (day-move)

We derive each security's day-move (`change_percent`) as
`(last − prevClose) / prevClose`. It works where the quote carries
`PreviousClosePrice` / `PreviousClose`, but some rows don't.

**Ask:** confirm `PricingQuoteGet` returns a usable previous-close across the full
JSE equity universe (not just the watchlist), so day-move is reliable when we
turn on the full-universe price feed.

### 8. L2 depth / time-&-sales

- We believe this is `PricingQuoteExGet`, but we haven't confirmed the method
  shape or whether it's entitled.

**Ask:** is order-book depth / time-&-sales available on `DFM@Mint`, and what's
the method + wire shape? (Lower priority.)

### 9. News / SENS

**Partial resolution 2026-06-25** — Charles Ntjana confirmed that IRESS Pro `NewsVendorGet` is the V4 verb for Market Data / News (vendor parameter, default `SENS`). Adapter + worker probe (`GET /debug/news-vendor-probe`) + BFF passthrough (`GET /api/iress/news`) wired; nothing persisted to Supabase yet (T5 vendor content — passthrough-only until vendor contract).

**Open sub-questions:**
- Does `DFM@Mint` carry the `NewsVendorGet` entitlement? (25010 / 25034 otherwise.)
- Do the rows include full story bodies or only headlines on this profile?
- `Vendor=SENS` vs `Vendor=IRESS` — which one populates against this account?

Verify after a worker redeploy with:
```bash
curl 'https://iress-worker-production.up.railway.app/debug/news-vendor-probe?vendor=SENS&pageSize=10&includeBody=1'
```
(Probe is rate-limited to 1 call per 10 s by default — env `NEWS_PROBE_MIN_GAP_MS`.)

### 10. CT vs production + license seat

- CT prices appear delayed / test (we see stale or closed-snapshot values rather than live marks).
- We hold a single CT license seat; we occasionally see
  `No more licenses available for this login` when a prior session hasn't
  released. We've added explicit `ServiceSessionEnd` → `IRESSSessionEnd` teardown.

**Ask:** (a) confirm CT is delayed/test and provide the production endpoint +
credentials for go-live; (b) confirm the seat count for `DFM@Mint` and the right
way to force-release a stale session.

---

## Answers we need (checklist)

1. ☐ J203 / J200 / sector index — Exchange + DataSource + codes (or method)
2. ☐ USD/ZAR spot — code + Exchange + DataSource (or "not on account")
3. ☐ JIBAR / ZARONIA / Prime / Repo — codes + Exchange + DataSource (or vendor)
4. ☐ Fundamentals — which method + entitlement on `DFM@Mint`
5. ☐ JSE equity daily history via `TimeSeriesGet2(NPN, JSE, JSED, Daily)` — works? entitled?
6. ☐ BHG — correct board/exchange
7. ☐ `PreviousClosePrice` — reliable across the full JSE universe?
8. ☐ L2 depth / time-&-sales — available? method?
9. ☐ News / SENS — IRESS path or vendor?
10. ☐ Production endpoint + creds; CT seat count / stale-session release

Happy to screen-share the live SOAP requests/responses for any of these.
