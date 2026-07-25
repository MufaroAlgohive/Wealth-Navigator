# IRESS Integration & Scale-Safety — Engineering Reference

**Audience:** MINT / Wealth-Navigator devs. **Scope:** what IRESS V4 gives us, what the Railway worker actually uses, the OEMS order path, and — most importantly — the **RANDS vs ZAc (cents) scale-safety guarantees** that keep client valuations real. Produced 2026-07-25 from a full read-only scan of the worker + IRESS V4 docs. All claims cite `file:line`.

> **One-line takeaway:** Prices/values are only scale-safe today because of an **external Yahoo divergence guard**, *not* because the IRESS quote is self-describing. That guard has three holes. Close them (an immutable `scale_ref_cents` anchor) before the IRESS cutover, or a sub-R45 stock can be stored 100× inflated.

---

## 0. Current state (what's live *today*)

- **Yahoo is the live price writer**, via the MINT server (`MINT-DEVELOPMENT/server/index.cjs`): `refreshIntradayPrices()` every 2 min → `stock_intraday_c` for the ~246-name universe; `refreshHeldSecurities()` every 60 s → `stock_holdings_c.{market_value,unrealized_pnl}`.
- **IRESS retail ingest is OFF** (fail-closed: `IRESS_RETAIL_INGEST=1` + `RETAIL_SUPABASE_URL` + `IRESS_RETAIL_DRY_RUN=0` all required; worker resting posture is *mock mode, all writes off*).
- **`securities_c.last_price` is frozen since 2026-03-20** — an external feeder died and was never rebuilt in code; neither Yahoo cron writes it. Only `stock_intraday_c` is Yahoo-fresh today.
- **Canonical money unit = cents (ZAc)** in both DBs; UI divides by 100 for Rands.
- **IRESS order WRITE is blocked** (entitlement pending); order flow is exercised only on the CT/UAT seat (account `56378`).

---

## 1. What IRESS V4 offers (capability inventory)

Profile **DFM@Mint**. Prod `https://webservices.iress.co.za/v4`, CT/test `https://webservices-ct.iress.co.za/v4`. **Single CT license seat** (held by the Railway worker; error `25008` = seat not released). The master PDF lists ~31 methods but **the live WSDL is the source of truth** — save/diff it per environment.

### Mint's binding "definite" go-live set — 17 methods
| Service | Methods |
|---|---|
| Iress Pro (session ×4 + data) | `IRESSSessionStart/End`, `ServiceSessionStart/End`, `PricingQuoteGet(+Updates)`, `TimeSeriesGet2(+Updates)` |
| IOS+ (orders) | `OrderCreate3`, `OrderAmend2`, `OrderDelete`, `OrderPadGetByAccount(+Updates)`, `BookingGetByOrganisation2` |
| IPS (custody) | `IPSTransactionGetByAccount5` |
| FIX+ (venue status) | `TargetIDGet`, `TargetIDStatusGet` |

### DEFINITE / working today
`PricingQuoteGet` L1 JSE equity quotes (watchlist: NPN, PRX, FSR, SBK, AGL, MTN, SOL, SHP, CPI live; BHG returns a hollow row). `TimeSeriesGet2` equity daily/monthly history (`DataSource=zax, Exchange=jse` — confirmed by Andre 2026-07-09), ZAR govt bonds + GOVI curve (`YFX/YFXD`), ZAR real/ILB curve (yield-only). `SecuritySearchGet` bond reference terms (`SecurityType=401`). `OrderPadGetByAccount` read-only mirror (18 live orders on acct 56378).

### BLOCKED — entitlement flip pending (Charles / IRESS)
IOS+ order **WRITE** (`OrderCreate3/Amend2/Delete`) is blocked-vendor in prod. `BookingGetByOrganisation2`, `IPSTransactionGetByAccount5`, FIX+ `TargetIDGet/StatusGet` are mock-only pending the same entitlements.

### UNCONFIRMED (open asks to IRESS/Andre)
JSE index levels (J203/J200/sector — codes resolve, 0 rows; Exchange/DataSource unknown), USD/ZAR + FX spot (no code found → ECB/Frankfurter fallback), JIBAR/ZARONIA/Prime/Repo (0 rows or placeholder `1` → SARB API), equity fundamentals verb (→ Yahoo fallback), **L2 depth / time-and-sales** (`PricingQuoteExGet` / `PricingTradeHistoricalGet` — method+entitlement unconfirmed, synthetic today), SENS news body entitlement.

### Key protocol facts
- Two-layer sessions: parent `IRESSSessionKey` → child `ServiceSessionKey` per service. `ApplicationID` unique per login (`Mint-OEMS-<env>-<node>-<guid>`).
- Streaming = long-poll: base method with `Updates=true` → page to `StatusCode=3` → repeat `<Method>Updates` with same `RequestID`. Caps: **50 in-flight requests/session**, 10k-row queue, 30-min expiry.
- **`DataSource` is exchange-specific** (JSE→JSED, YFX→YFXD, equity history→zax). Wrong DataSource → error 5 "Invalid access" (previously misread as an entitlement wall).
- Order idempotency: `OrderCreate3.OrderTag` (UUID) mandatory, ~5-min dedupe; recover via `OrderNoGetByOrderTag`. `OrderAmend2` has **no** SOAP idempotency (needs local pre-check).
- **No corporate-actions method** in V4 — dividends/splits arrive as `IPSTransactionGetByAccount5` rows.
- **No IRESS-provided price-scale/tick-size field** exists — scale must be *inferred*, never read (this is the root of the scale-safety problem, §4).

---

## 2. What the worker uses vs the gaps to close

### Used (17 methods) — `workers/iress-ingest/src/`
Sessions (`market-data.ts:140`, `session.ts:385`), `PricingQuoteGet` (`quotes.ts:62`), `TimeSeriesGet2` (`timeseries.ts:302`, `bonds.ts:94`), `SecuritySearchGet` (`bonds.ts:64`), `NewsHeadlineGet`/`NewsVendorGet` (`news-ingest.ts`), `OrderPadGetByAccount` (`orders.ts:258`, `order-poller.ts:127`), `OrderCreate3` (`http-api.ts:3787`), `OrderAmend2` (`:1167`), `OrderDelete` (`:905`), `OrderNoGetByOrderTag` (`:3863`), IPS trio (`ips.ts` — **parked**, `IRESS_ENABLE_IPS` off).

### Gaps — IRESS capabilities we do NOT use yet
| Capability | Why it matters | Effort |
|---|---|---|
| **L2 market depth** (`PricingQuoteExGet`-class) | Desk trades blind on a single bid/ask; no slippage/impact/limit-placement signal. **Biggest execution-quality gap.** | High (no binding, needs entitlement) |
| **Streaming `*Updates`** (Quote/TimeSeries/OrderPad) | Declared on the client, never called. Would cut tick latency to sub-second, fewer SOAP round-trips on the single seat, real-time fills. | Medium |
| **`BookingGetByOrganisation2`** (fees) | Carries `MiscFees` (brokerage/STT/VAT/settlement). Today P&L is **gross** — omits transaction costs; no contract notes, no true cost basis. | Low–Med |
| **FIX+ `TargetIDGet/StatusGet`** | Venue CONNECTED/DISCONNECTED health — desk-critical to know a route is down. | Low |
| **Intraday time-series** (1m/5m/1h) | `syncTimeSeries` only requests `Daily`; charts are EOD-only. | Medium (entitlement) |
| **Corporate actions** | No dividends/splits → price-return only, false gaps around splits, wrong cost basis. | High |
| **Sector indices** | `IRESS_TIMESERIES_SECTOR_CODES` empty by default — plumbing exists, just unconfigured. | Trivial (config) |
| **Broader order types/TIF** | `send-to-market` maps only MKT + DAY; no stop/GTC/IOC/FOK. | Medium |
| **IPS custody feed** | Fully coded, parked — authoritative positions/cash/NAV independent of fill-derivation. | Low to unpark (entitlement) |
| **News breadth + bodies** | ~20 vendors entitled, only SENS/SENSD consumed; no full HTML story bodies. | Low |

### Gating (resting default = mock, writes off)
Two seat-isolated entrypoints: `main.ts` (UAT/CT seat: quotes, orders, timeseries, bonds, alerts, retail, parked-IPS, optional news) and `main-prod.ts` (prod seat: news + health only). SOAP gated on `IRESS_MODE=live` (default `mock`). Prod market-data split on `IRESS_MARKET_DATA_PROD=1` (default off). Two write tiers: `IRESS_WORKER_DRY_RUN` (default **true**) + `SUPABASE_ALLOW_WRITES` (default **false**); retail has its own `IRESS_RETAIL_DRY_RUN` (writes only when `="0"`).

---

## 3. The OEMS order path

### End-to-end flow
Two entry doors converge on one audit row + one worker endpoint (`OrderCreate3`):
- **Door A — bulk book dispatch** (desk/UAT): UI → `api/admin/orderbook/send-to-market/route.ts` → resolves book from RETAIL `stock_holdings_c` by `strategy_name_snapshot` → `runLimitGuard()` pre-trade → writes `oems_order_audit` (INSTITUTIONAL, `status:"working"`) → fans out to worker `POST /uat/send-to-market`.
- **Door B — single client order**: `api/admin/orderbook/client-order/route.ts` (Bearer `MINT_CLIENT_ORDER_SECRET`) → **parks** the order (`status:"parked"`, zero IRESS) under the cosmetic `"CLIENT-BUY"` label → admin release re-runs preflight then fans out.
- **Worker** `uatSendToMarket()` (`http-api.ts:3649`) maps to IRESS `NewOrder` → `client.orderCreate3(...)` (`:3787`) on the IOS+ session → `stampAfterOrderCreate3()` overwrites `order_id` with the broker `OrderNumber`.
- **Poll → fills**: `order-poller.ts::pollUatForFills` (30 s, `OrderFilter:3`) matches broker rows back by `OrderNumber`, stamps `filled/avgPx/status/slippageBps`. Production `orders.ts::pollAccountsForOrders` delete-then-inserts to mirror the book and `derivePositions()` nets fills → `oems_position_c` (**not IPS**, long-only).

### Real vs UAT today
| Aspect | State |
|---|---|
| UAT account | `56378` (`env.ts:256`) |
| `env.uatMode` | default **false**; gates the only `OrderCreate3` path |
| Order type | **MKT-forced**, `Price` omitted (`http-api.ts:3720`); TIF hard **DAY** |
| Per-client guard | **Dormant** — `resolveHolderKind` defaults everything to `"desk"` (`pretrade-guard.ts:462`); real guards behind `IRESS_PER_CLIENT_GUARD` |
| Attribution | Broker sees only the **omnibus** AccountCode; no per-client identity reaches IRESS. Client orders grouped under `"CLIENT-BUY"`. |

### Gaps to a real production order path
1. **IRESS write entitlement** (blocked-vendor; only IRESS can flip it).
2. **No prod create route** — the sole `OrderCreate3` caller is `uatSendToMarket`, hard-gated to `env.uatMode` + UAT account/destination.
3. **MKT/DAY only** — no LMT/stop/GTC/IOC/FOK on create.
4. **Per-client pre-trade guards dormant** — guard runs against the omnibus account.
5. **No fills → `stock_holdings_c` bridge** — confirmation only stamps `Fill_date`; broker fill price/qty never corrects the client's held quantity or cost basis. **Biggest functional gap for a retail OEMS.**
6. **`avgPx` unit ambiguity** — the UAT poller stores `avgPx` in **Rands** (`order-poller.ts:281`) but `derivePositions` treats it as **cents** and ÷100 (`orders.ts:225`). If a Rands value reaches `derivePositions`, `open_average_price` is ~100× off. **Pin the SOAP unit of `Order.avgPx` before trusting positions.**

---

## 4. Scale-safety (RANDS vs ZAc) — the core guarantee ⚠️

### The pipeline
- **HOP 1 — IRESS row** (`PricingQuoteGet`): mixed per-field — bare `<Last>` often **Rands** (NPN=610=R610), the `<LastPrice>`/OHLC cluster often integer **ZAc** (FSR/MTN/SBK). No field is self-labelled.
- **HOP 2 — `mapQuote`** (`src/lib/iress/live.ts:342`): normalises the **whole row to ONE scale** via `iressQuotePriceScale` (`:168`) — returns `1` (row is Rands) or `0.01` (row is cents). Rule: cents inferred only when the OHLC cluster **> 4500 (R45)** and there's no plausible bare `<Last>`. Emits every field in **Rands**.
- **HOP 3 — worker → cents**: `priceCents = round(lastRands*100)` → `stock_intraday_c.current_price` + `securities_c.last_price`. Retail path is guarded by `withinWriteGuard` (`retail-ingest.ts:211`); institutional watchlist path is **not**.
- **HOP 4 — UI → Rands**: `live-queries.ts:114` reads cents, applies `agreesWithYahoo`, `÷100`. MINT reads `securities_c.last_price` as cents, `÷100`.

### Verdict: **PARTIAL** ⚠️
`mapQuote` alone does **not** guarantee canonical cents. **Failure class:** a **sub-R45 stock delivered on the cents-schema** (LastPrice + whole OHLC cluster all integer ZAc, all < 4500) has *no internal signal*, so `iressQuotePriceScale` falls through to `scale=1` and treats R30 (3000 ZAc) as R3000 → `round(last*100)` persists **300000 cents → UI R3000, a 100× inflation.** This is exactly the 2026-06-13/14 incident (121/128 priced symbols 100× off, **all below R45**).

**The real safety net is the external Yahoo divergence guard** (`withinWriteGuard` on write, `agreesWithYahoo` on read) — *not* the OHLC anchor (the code comments overstate the anchor). And that guard has holes.

### Fragile spots (fix before the IRESS cutover)
| # | Location | Risk | Fix |
|---|---|---|---|
| S1 | `live.ts:179-190` (the 4500/R45 threshold) | Sub-R45 cents-schema row → treated as Rands → 100× inflation. Magnitude can't self-disambiguate the dominant JSE price band. | Anchor to an **immutable external reference** (`chooseDisplayCents(last, refCents, trustedRefCents)`); for money-track writers **refuse to persist when `scaleVerified===false`** — treat "no anchor" as *skip*, not as Rands. |
| S2 | `quotes.ts:596-621` (institutional watchlist money-track write) | Writes `stock_intraday_c` + `securities_c.last_price` with **no divergence/scale guard** — only `isUatEnv()`. At full-prod cutover, no backstop. | Mirror the retail guard: gate on `withinWriteGuard(priceCents, refCents)` before the write. |
| S3 | `cutover.ts:41` (`withinWriteGuard` pass-through) | Returns *allow* when `refCents<=0`. A symbol with `last_price` 0/null (new, or never priced by the frozen feeder) gets an **unguarded** 100× write, which then corrupts `securities_c` and the UI self-anchor propagates it. | When `refCents<=0`, require verified scale (`scaleVerified===true` / a `trustedRefCents`) else **fail-closed**. |
| S4 | Divergence reference = `securities_c.last_price` (frozen; becomes IRESS's own output post-cutover) | A real >25% move since the freeze **falsely rejects** a correct IRESS price; post-cutover the guard degrades to a self-anchor that can't catch a consistent embedded mis-scale. | Add an **immutable, human-verified `securities_c.scale_ref_cents`** used *only* for scale disambiguation, decoupled from the mutable `last_price`. (`price-scale.ts` already threads `trustedRefCents`.) |
| S5 | `change_price` contract: writer `retail-ingest.ts:244` (cents) vs reader `index.cjs:6243` (asserts Rands, ×100) | After cutover the displayed **day-change** is 100× inflated (doesn't corrupt holdings valuation, but the shown change). | Pick one contract; align both sides; add a shared unit constant so the two repos can't drift. |
| S6 | `index.cjs` reads `last_price` 3 ways: keep-cents (6240), ÷100 (6459), ×100 (6546) | The ×100 at 6546 is currently dead (only logo/name read from that map) but is a live foot-gun — any future read of that map is 10,000× off. | Route every `securities_c.last_price` read through one `centsToRands()`; delete the dead ×100. |

### Yahoo fallback scale: **PASS**
Yahoo lands the **same canonical cents** — `regularMarketPrice` for JSE is already ZAc (`index.cjs:11672`), inserted verbatim into `stock_intraday_c.current_price`; identical column/unit to the IRESS path's `round(Rands*100)`. Switching feeds does **not** shift the price scale. Two caveats: Yahoo doesn't write `securities_c.last_price` (frozen), and the `change_price` contract differs (S5).

---

## 5. IRESS-primary / Yahoo-fallback architecture + cutover

### Intended model
IRESS is **primary** for everything it's entitled to (quotes/OHLC/change%, SENS, IOS+ orders, and — once entitled — timeseries/fundamentals). Yahoo is **fallback-only** in two senses: (1) **coverage** — any symbol IRESS can't price is skipped and left for Yahoo; (2) **gap-fields** — `market_cap/pe_ratio/dividends/ytd_performance` stay on the thin `/api/cron/yahoo-fundamentals` bridge (`YAHOO_FUNDAMENTALS_WRITE=1`), which **never** writes `last_price/change_percent`.

### Single-writer rule (critical)
Exactly one of `{ MINT_PRICE_WRITER_DISABLED=1 = Yahoo OFF }` **XOR** `{ IRESS_RETAIL_DRY_RUN=0 = IRESS ON }` at all times. **Sequence the flip so there's a brief no-writer gap, never an overlap.** A gap only makes prices briefly stale; an overlap interleaves two sources into `stock_intraday_c` (and "newest tick wins" readers flip-flop between IRESS-live and Yahoo-15min values).

> ⚠️ **The PHASE1 doc has the wrong order** — it enables IRESS *before* disconnecting Yahoo, creating a double-write window. Use the order below (Yahoo off first).

> ⚠️ **Per-symbol coexistence (`iress_price_validation_c`) only works against the WN Yahoo cron — NOT the MINT server**, which is all-or-nothing via the kill-switch. So while the MINT server is the Yahoo feed, cutover **must be all-or-nothing**: only flip the kill-switch once IRESS coverage is ~100% of the traded universe, or accept that uncovered symbols freeze.

### Cutover runbook
0. **Baseline (read-only):** confirm Yahoo (MINT server) is the live `stock_intraday_c` writer; `securities_c.last_price` still frozen.
1. **[Retail DB]** apply additive `price_source` migration (nullable, idempotent).
2. **[Worker]** turn on the PROD market-data seat: `IRESS_MODE=live`, `IRESS_MARKET_DATA_PROD=1`, `IRESS_MARKETDATA_BASE_URL=…/v4`, creds set. Verify `/debug/market-data` prod session up **and** UAT orders still up (distinct `ApplicationID` = no seat kick).
3. **[Worker] SHADOW** (writes nothing): `IRESS_RETAIL_INGEST=1`, `RETAIL_SUPABASE_URL`, service-role key, `IRESS_RETAIL_DRY_RUN=1`. Inspect `retail_ingest_complete`: coverage ratio + `iressCents` vs `yahooCents` magnitude match. **Yahoo stays primary through this step.**
4. **Decision:** confirm write-authority model (full-prod endpoint = all symbols write, divergence-guarded; the per-symbol allowlist applies only on the CT endpoint).
5. **[MINT server] STOP YAHOO FIRST:** `MINT_PRICE_WRITER_DISABLED=1`, restart. Confirm `[intraday-refresh]`/`[held-refresh]` logs stop. (Brief no-writer gap is intended and safe.)
6. **[Worker] ENABLE IRESS:** `IRESS_RETAIL_DRY_RUN=0`, redeploy. IRESS is now the single writer.
7. **[MINT/CRM]** disconnect the daily Yahoo securities-master job for `last_price/change_percent`; keep only the gap-field bridge.
8. **Verify** `price_source='iress'`, fresh `last_price`+`change_percent`, live ticks, UI moves. **Re-home `stock_holdings_c.{market_value,unrealized_pnl}`** (see gap below).
- **Rollback (reverse order):** worker `IRESS_RETAIL_DRY_RUN=1` → confirm → MINT `MINT_PRICE_WRITER_DISABLED=0` + restart. No DDL to revert.

### Failure handling — read-side auto, write-side MANUAL
Implemented & automatic: prod-session outage → `fetchLiveQuote` returns no-row, symbols skipped, values left in place; per-tick `withinWriteGuard` circuit-breaker (≥25% divergence reject); read-side staleness drop (`iressQuoteMaxAgeMs` 48h) + `IRESS_PRICE_OVERLAY=0` master kill.
**The gap:** nothing consumes the `degraded` heartbeat to re-enable Yahoo. Once `MINT_PRICE_WRITER_DISABLED=1`, an IRESS outage **freezes prices** (skipped symbols keep their last IRESS value; read-side falls back to a now-stale `securities_c` that Yahoo no longer refreshes). Recovery = **manual** rollback. Consider an external watchdog that clears the kill-switch on `integration_worker_health='degraded'`.

### `stock_holdings_c` refresh gap ⚠️
`refreshHeldSecurities` (Yahoo) also writes `stock_holdings_c.{market_value,unrealized_pnl}` every 60 s, but the **IRESS worker writes only `securities_c` + `stock_intraday_c`**. After `MINT_PRICE_WRITER_DISABLED=1`, **nothing recomputes holding market values** — assign an owner (a MINT read-path recompute, or a worker loop) before cutover.

---

## 6. Prioritised actions

**P0 — before any IRESS cutover (client-fund safety):**
1. Add immutable `securities_c.scale_ref_cents`; make money-track writers `fail-closed` when scale unverified (fixes S1, S3, S4).
2. Add the divergence guard to the institutional watchlist write (S2).
3. Fix the `change_price` unit contract (S5) and delete the dead ×100 in `index.cjs` (S6).
4. Assign an owner for `stock_holdings_c` valuation refresh post-cutover.
5. Pin the `Order.avgPx` SOAP unit; fix the poller/`derivePositions` mismatch (§3.6).

**P1 — un-freeze prices (do this regardless of cutover):** re-enable a `securities_c.last_price` writer (WN `yahoo-fundamentals` cron `YAHOO_FUNDAMENTALS_WRITE=1`, or the IRESS cutover).

**P2 — order path to production:** IRESS write entitlement (external) → prod create route → LMT/TIF breadth → per-client guards → fills→`stock_holdings_c` reconciliation bridge.

**P3 — use more of IRESS:** streaming `*Updates`, `BookingGetByOrganisation2` fees→net P&L, FIX+ venue status, sector index codes (config-only), L2 depth (entitlement), corporate actions.

---

*Sources: read-only scan of `workers/iress-ingest/src/**`, `src/lib/iress/**`, `src/app/api/admin/orderbook/**`, `src/lib/orders/**`, `MINT-DEVELOPMENT/server/index.cjs`, and `Documentation & Vision/iress-v4-docs/**` + the IRESS Web Services V4 Programmer's Guide. Companion docs: `PHASE1_IRESS_RETAIL_CUTOVER.md`, `IRESS_PRICE_SCALE_INCIDENT_HANDOFF.md`, `IRESS_V4_METHOD_INVENTORY.md`.*
