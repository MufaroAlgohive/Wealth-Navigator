# IRESS V4 Endpoint Inventory & Future-Needs Analysis

> **Audience:** Product owner / architect. Read alongside `wealth-navigator/PLANNING.md` and `Documentation & Vision/Email`.
> **Scope:** What the Wealth Navigator codebase actually calls today, what IRESS V4 makes available, and what the Email business brief + multi-persona product vision implies we'll need next.
> **Date:** 2026-06-09 · IRESS V4 doc set v1.0 (`Documentation & Vision/iress-v4-docs/`) · Wealth Navigator rebuild v2.0.

---

## Executive summary

- The adapter (`wealth-navigator/src/lib/iress/`) declares **17 IRESS V4 methods** on the `IressClient` interface. The mock implements all 17. Two more (`bringUpMintSession` helper, `iressQueries` data bag) cover session bring-up and the seed-data shape that the UI consumes.
- The UI **actively calls 5 of those 17** methods through the React context (`useIress().client`) — the rest of the surface is declared and mocked but not yet wired into a page. The data side (`useIress().data`) is far more heavily used: **20 read-side query helpers** feed Cockpit, Strategies, Equities, Fixed Income, Money Market, Curves, Macro, News, Blotter, Security, and Settings.
- The IRESS V4 doc set explicitly enumerates **~30 distinct V4 method verbs** (15 in Iress Pro + market data, 18 in IOS+ orders, 5 in IPS, 2 in FIX+). Of those, the adapter currently covers roughly the **trading-and-data core**; several discoverability / entitlement / contingent-order / search / upload / legacy IPS methods are not yet on the interface.
- The most material gaps the Email brief and the product vision imply:
  1. **L2 depth** for the equities / security page (`PricingQuoteExGet` / WSDL depth method — listed in `01-requirements-traceability.md` but not on our interface).
  2. **Pre-trade / risk compliance** — the Email brief asks for it; the docs say it is **OEMS responsibility** (not a V4 method), but `DestinationGet` / `DestinationDetailGet` / `AttributeGetByUser` plus a wire-up of `OrderNoGetByOrderTag` is the right pattern.
  3. **SENS as a real feed** (not just hard-coded fixtures).
  4. **Order lifecycle on the user** (`OrderPadGetByUser` / `OrderPadGetByAccountGroup`) — only `OrderPadGetByAccount` is on the interface today.
  5. **Wider order search** (`OrderSearchGetByUser` / `OrderSearchGetByAccount`) — required for EOD reconciliation per the docs (`07-recovery/04`).
  6. **Account & position lists** (`IPSAccountGetAll1`, `IPSPositionGetAll1`) — explicitly out-of-scope for v2.0 but blocking the wealth-manager / strategy pages.
  7. **Outbound money movement / corporate actions** (`IPSUploadCreate1` etc.) — the Email brief mentions "wires / cash management"; the docs surface an open question about whether wires are inbound only.
  8. **Reconciliation / audit trail** (`AuditTrailGetByAccount` per `01-requirements-traceability.md`).
- No method we currently use is documented as deprecated in V4. `OrderCreate3` / `OrderAmend2` / `OrderDelete` are the current IOS+ verbs (the older `OrderCreate` / `OrderCreate2` are dropped from the WSDL — see `09-compatibility/01`).
- **No live IRESS connection is wired.** The mock is the source of truth; the `/api/ticks` route is a synthetic SSE stream unrelated to IRESS. The live swap is a 1-line `IRESS_MODE=live` config change plus a `live.ts` implementation of the interface that doesn't exist yet.

---

## Part A — Currently used endpoints

### A.1 `IressClient` interface (declared in `wealth-navigator/src/lib/iress/client.ts`)

| # | Method | Namespace | Returns | Mock implemented? | UI consumer |
|---|---|---|---|---|---|
| 1 | `iressSessionStart` | Iress | `IRESSSessionKey` + `SessionNumber` | ✅ | `lib/iress/index.ts:bringUpMintSession` (helper, not yet called from UI) |
| 2 | `iressSessionEnd` | Iress | `void` | ✅ (noop) | — |
| 3 | `serviceSessionStart` | Iress | `ServiceSessionKey` | ✅ | `lib/iress/index.ts:bringUpMintSession` (helper) |
| 4 | `serviceSessionEnd` | Iress | `void` | ✅ (noop) | — |
| 5 | `pricingQuoteGet` | Iress Pro | L1 `Quote` | ✅ (seed-mapped) | `mock.ts:quoteForSecurity` (used by `iressQueries.quote`); not called directly from any page |
| 6 | `pricingQuoteGetUpdates` | Iress Pro | update rows | ✅ (no-op) | — |
| 7 | `timeSeriesGet2` | Iress Pro | series of `{t, v}` | ✅ (mapped for NSS / ZARONIA / JIBAR / J203) | — (no UI call site; tick stream is SSE-mocked) |
| 8 | `timeSeriesGet2Updates` | Iress Pro | update rows | ✅ (no-op) | — |
| 9 | `orderCreate3` | IOS+ | `OrderNumber` + status | ✅ (idempotent on `OrderTag`) | `oems/blotter/new-order-dialog.tsx:95` |
| 10 | `orderAmend2` | IOS+ | `OrderNumber` | ✅ (state-checked) | — (declared; no page wires it) |
| 11 | `orderDelete` | IOS+ | `void` | ✅ (state-checked) | `oems/blotter/page.tsx:62` (cancel-all) |
| 12 | `orderPadGetByAccount` | IOS+ | rows of `Order` | ✅ (in-memory) | declared, not called from any page (UI uses `iressData.orders()`) |
| 13 | `orderPadGetByAccountUpdates` | IOS+ | update rows | ✅ (no-op) | — |
| 14 | `bookingGetByOrganisation2` | IOS+ | booking rows w/ MiscFees | ✅ | — (declared, not called) |
| 15 | `ipsTransactionGetByAccount5` | IPS | transaction rows | ✅ (in-memory) | — (declared, not called) |
| 16 | `targetIdGet` | FIX+ | `{TargetID}[]` | ✅ (fixture `MINT-DROPCOPY-01`) | — |
| 17 | `targetIdStatusGet` | FIX+ | status row | ✅ (always CONNECTED) | — |

### A.2 `iressQueries` data bag (`lib/iress/mock.ts` lines 276-301)

Exposed as `useIress().data` to the UI. The mock's read helpers — every page that consumes IRESS data goes through this bag, not through `client.*`.

| Helper | Returns | UI page(s) that consume it |
|---|---|---|
| `sectors()` | `SectorPerf[]` | `cockpit-client.tsx` (sector heatmap) |
| `indices()` | `IndexQuote[]` | `cockpit-client.tsx` |
| `fx()` | `fxQuotes` | (declared, not used) |
| `commodities()` | quote map | (declared, not used) |
| `jseEquities()` | `Instrument[]` | `cockpit-client.tsx` (movers), `equities/page.tsx`, `security/page.tsx`, `command-palette.tsx` |
| `bonds()` | `Bond[]` | `fixed-income/page.tsx` |
| `zarGoviCurve()` | Govi points | `cockpit-client.tsx`, `curves/page.tsx`, `fixed-income/page.tsx`, `money-market/page.tsx` |
| `zarSwapCurve()` | swap points | `curves/page.tsx` |
| `zarRealCurve()` | ILB points | `curves/page.tsx` |
| `zarBreakeven()` | breakeven points | `curves/page.tsx` |
| `jibarFixings()` | JIBAR history | `cockpit-client.tsx`, `money-market/page.tsx` |
| `zaronia()` | ZARONIA snapshot | (declared, not used) |
| `mmInstruments()` | money-market instruments | `money-market/page.tsx` |
| `macroCalendar()` | `MacroRelease[]` | (declared, not used) |
| `macroReleases()` | (alias) | (declared, not used) |
| `macroIndicators()` | `MacroIndicator[]` | `cockpit-client.tsx`, `macro/page.tsx` |
| `strategies()` | `Strategy[]` | `cockpit-client.tsx`, `equities/page.tsx`, `money-market/page.tsx`, `strategies/page.tsx`, `command-palette.tsx` |
| `strategyHoldings(id)` | `Holding[]` | `strategies/page.tsx:169` |
| `orders()` | `Order[]` | `cockpit-client.tsx`, `blotter/page.tsx`, `command-palette.tsx` |
| `news()` | `NewsItem[]` | `cockpit-client.tsx`, `news/page.tsx` |
| `sens()` | `SensItem[]` | `cockpit-client.tsx`, `news/page.tsx` |
| `endpointHealth()` | (declared) | — |
| `endpoints()` | (declared) | `integration/page.tsx`, `settings/page.tsx` |
| `quote(code, exchange)` | L1 quote | (internal helper) |

### A.3 What each OEMS page actually depends on

| Page | IRESS surface it consumes (mock today) | V4 method(s) it maps to in live |
|---|---|---|
| `/oems` Cockpit | `sectors, indices, zarGoviCurve, jibarFixings, macroIndicators, orders, jseEquities, news, sens` | `PricingQuoteGet` (L1) + `TimeSeriesGet2` (NSS, JIBAR, macro codes) + `OrderPadGetByAccount` + news / SENS feed |
| `/oems/blotter` | `orders` (read) + `client.orderCreate3` (new order) + `client.orderDelete` (cancel-all) | `OrderPadGetByAccount(Updates)` + `OrderCreate3` + `OrderAmend2` + `OrderDelete` |
| `/oems/strategies` | `strategies` + `strategyHoldings` (per-strategy holdings) | `IPSPositionGetByAccount5` (per strategy account) + `IPSTransactionGetByAccount5` (recent transactions) — neither on our interface yet |
| `/oems/equities` | `jseEquities` + `strategies` | `PricingQuoteGet` + `PricingQuoteExGet` (L2 / extended) |
| `/oems/fixed-income` | `bonds` + `zarGoviCurve` | `PricingQuoteGet` (bonds) + bond-reference methods + `TimeSeriesGet2` (NSS) |
| `/oems/money-market` | `strategies` + `mmInstruments` + `jibarFixings` + `zarGoviCurve` | `TimeSeriesGet2` (JIBAR code) + `TimeSeriesGet2` (NSS) + NCD pricing methods |
| `/oems/curves` | `zarGoviCurve` + `zarSwapCurve` + `zarRealCurve` + `zarBreakeven` | `TimeSeriesGet2` (curve codes) |
| `/oems/macro` | `macroIndicators` + `macroReleases` | `TimeSeriesGet2` (macro codes) + `TimeSeriesGet2` (calendar) |
| `/oems/news` | `news` + `sens` | Iress Pro news / SENS feed (WSDL methods) |
| `/oems/security` | `jseEquities` | `PricingQuoteGet` + `PricingQuoteExGet` + L2 + cashflows |
| `/oems/integration` | `endpoints` + `iressConfig` | n/a (ops surface) |
| `/oems/cockpit` | tick stream from `/api/ticks` (synthetic SSE, **not IRESS**) | live: `PricingQuoteGetUpdates` / `TimeSeriesGet2Updates` long-poll |

### A.4 Non-OEMS pages — IRESS dependency

- `wealth-navigator/src/app/wm/page.tsx` — imports `clientsByWealthManager` directly from `@/lib/iress/seed`, **bypassing the `iressData` bag**. This is the wealth-manager persona stub (`PLANNING.md` lists it as deferred for v2.0).
- `wealth-navigator/src/app/strategist/page.tsx` — imports `oemsStrategies, mandateTemplates` from `@/lib/iress/seed`. Same pattern.
- `wealth-navigator/src/app/admin/page.tsx` — imports `pendingApprovals, auditTrail` from `@/lib/iress/seed`. Same pattern.
- `wealth-navigator/src/app/business/page.tsx` — imports `oemsStrategies, deals` from `@/lib/iress/seed`. Same pattern.
- `wealth-navigator/src/app/fc/overview/page.tsx` — imports `reconLegs, cashPositions, reconExceptions` from `@/lib/iress/seed`. Same pattern.

All five personas **do not currently call the `IressClient` interface at all** — they read seed fixtures directly. They are stub pages per `PLANNING.md` §1.1, but the pattern matters: when they get lit up, they'll need new methods (see Part D).

### A.5 REST/SSE surfaces in `src/app/api/`

- `auth/login`, `auth/logout` — local mock; do not call IRESS.
- `health` — returns adapter mode + base URL + methods config.
- `ticks` — `wealth-navigator/src/app/api/ticks/route.ts` synthesises SSE ticks over the seed quotes. **Not IRESS.** The comment in the file is explicit: "In production this would proxy the IRESS edge WebSocket; in dev it just synthesises random walks."

### A.6 Env & config (`.env.example`)

`IRESS_IRESS_METHODS`, `IRESS_IOS_METHODS`, `IRESS_IPS_METHODS`, `IRESS_FIX_METHODS` declare the cut-down WSDL method lists we'd request when we do get creds. These are the **commented baseline** that `01-foundations/03-endpoints.md` recommends, minus a few:

- IRESS side is missing `IRESSSessionEnd` and `ServiceSessionEnd` (logical, since they're in the IOS cut).
- IOS side is missing `OrderPadGetByUser` / `…Updates`, `OrderPadGetByAccountGroup` / `…Updates`, `OrderSearchGetByUser`, `OrderNoGetByOrderTag`, `ETCGetByOrganisation`, `SessionRequestEnd`. The docs page `01-foundations/03-endpoints.md` lists all of these in the recommended WSDL cut; our `.env.example` only ships a subset.
- IPS side is missing the entire `IPSUpload*` family.
- FIX side includes only the two V4 methods; this matches the doc recommendation.

---

## Part B — IRESS V4 method universe (master catalogue)

Source: every `.md` file under `Documentation & Vision/iress-v4-docs/`. I have read all 60 doc pages in full. Methods are listed by namespace as the docs structure them.

### B.1 Iress Pro (market data, sessions, WebAdmin, news)

| # | Method | Business domain | Description |
|---|---|---|---|
| 1 | `IRESSSessionStart` | Auth | Open an Iress session. Returns `IRESSSessionKey`. Mandatory first call. |
| 2 | `IRESSSessionEnd` | Auth | End an Iress session (and all child service sessions). |
| 3 | `PricingQuoteGet` | Market data (L1) | Snapshot quote for a security on an exchange. Supports `Updates`. |
| 4 | `PricingQuoteGetUpdates` | Market data (L1) | Long-poll updates for a `PricingQuoteGet` subscription. |
| 5 | `PricingQuoteExGet` | Market data (L1/L2 ext) | Extended L1 / depth-of-book snapshot. PDF is light — WSDL is source of truth. |
| 6 | `PricingTradeHistoricalGet` | Market data (historical) | Historical trades (EOD / intraday prints). WSDL-dependent. |
| 7 | `TimeSeriesGet2` | Time series | Generic time series for securities, curves, macro codes. Supports `Updates`. |
| 8 | `TimeSeriesGet2Updates` | Time series | Long-poll updates. |
| 9 | `AuditTrailGetByAccount` | Audit / compliance | Per-account audit log. Paging with bookmarks. Documented in `01-requirements-traceability.md` & `02-paging-with-bookmarks.md`. |
| 10 | News / SENS / wire feed methods | News | The PDF does not enumerate; WSDL has them. Currently a gap. |
| 11 | Iress Pro security-lookup methods | Reference | Per `01-requirements-traceability.md`, used for security reference (JSE equities, Z instruments, NCDs, currency / exchange metadata). |
| 12 | `IressSessionEnd` (alias) | Auth | Same as `IRESSSessionEnd`; appears in the Iress Pro quick-ref table. |

### B.2 IOS+ (order & execution management)

| # | Method | Business domain | Description |
|---|---|---|---|
| 1 | `ServiceSessionStart` | Auth | Open an IOS+ service session. `Service = "IOSPlus"`, `Server = "IOSPLUSAPI"`. |
| 2 | `ServiceSessionEnd` | Auth | End the IOS+ service session. |
| 3 | `OrderCreate3` | Order entry | Place order. **Idempotency required via `OrderTag`.** |
| 4 | `OrderAmend2` | Order amend | Amend volume / price / stop / TIF / strategy attributes. |
| 5 | `OrderDelete` | Order cancel | Cancel an order. |
| 6 | `OrderPadGetByAccount` | Order retrieval | Per-account order pad. `OrderFilter` enum: `1=working`, `2=filled today`, `3=all`, `4=inactive`, `5=active`. `OrderFilter=5` is the recommended active-only snapshot. |
| 7 | `OrderPadGetByAccountUpdates` | Order retrieval | Long-poll updates. |
| 8 | `OrderPadGetByUser` | Order retrieval | Per-user pad (all accounts the user can see). |
| 9 | `OrderPadGetByUserUpdates` | Order retrieval | Long-poll updates. |
| 10 | `OrderPadGetByAccountGroup` | Order retrieval | Per account group. |
| 11 | `OrderPadGetByAccountGroupUpdates` | Order retrieval | Long-poll updates. |
| 12 | `OrderSearchGetByUser` | Order retrieval | Wider filter set, slower. Used in step-2 reconciliation with `OrderState=3` (inactive). |
| 13 | `OrderSearchGetByAccount` | Order retrieval | Per-account, wider filter set. |
| 14 | `OrderNoGetByOrderTag` | Order recovery | Lookup by tag. **Recommended for `OrderCreate3` recovery** when no response is received (`07-recovery/05`). |
| 15 | `BookingGetByOrganisation2` | Settlements / fees | Fetch bookings (TradeNumber, BookingNumber, MiscFees). |
| 16 | `ETCGetByOrganisation` | Pre-trade cost | Estimated Trade Cost snapshot. Pre-trade transparency. |
| 17 | `DestinationGet` | Discovery | List user-accessible destinations (regular, CO, algo). `AccessMode=0` returns accessible. |
| 18 | `DestinationDetailGet` | Discovery | Inspect a destination. `DestinationSubTypeNumber` distinguishes CO (30-49) from algo (Algo bit in `DestinationPropertiesMask`). |
| 19 | `AttributeGetByUser` | Discovery | Order-entry attribute catalog. `AttributeCategoryNumber=5` for algo properties, `=8` for Iress Strategy Properties (IS013-IS041). |
| 20 | `SessionRequestEnd` | Session mgmt | End a specific `RequestID`'s subscription. |

### B.2.1 IOS+ Contingent Orders (placed via `OrderCreate3` with CO destination + `ExecutionInstructions`)

| CO type | `DestinationSubTypeNumber` | Key attributes |
|---|---|---|
| **FIXED CO** | 30-39 | `IS013`, `IS016`, `IS020` (base: `Last`/`Bid`/`Ask`), `IS021` (cond.), `IS022` (price), `IS028`–`IS041` (notify / audit) |
| **TRAILING CO** | 30-39 | `IS013`, `IS014`, `IS016`, `IS025` (`Price`/`Percentage`), `IS026` (`Above`/`Below`), `IS027` (offset), `IS028`–`IS041` |
| **OCO** | 30-39 | `IS016` only (read-only flag). Pair linkage via destination. |
| **IFDONE** | 30-39 | `IS016` only (read-only flag). Parent-child via destination + parent order reference. |
| **Take-profit (canonical)** | AUTODESK + IFDONE + FIXED CO | Composite pattern (`contingent-orders/07-take-profit.md`) |

### B.2.2 IOS+ Algo Orders (placed via `OrderCreate3` against an algo destination)

- **Discovery**: `DestinationGet` → `DestinationDetailGet` with `DestinationPropertiesMask & 256` for the Algo bit.
- **Attributes**: `7000(strategy)`, `9006(start time)`, … (per algo vendor; discover with `AttributeGetByUser(AttributeCategoryNumber=5)`).

### B.3 IPS (portfolio system)

| # | Method | Business domain | Description |
|---|---|---|---|
| 1 | `ServiceSessionStart` | Auth | `Service = "IPS"`, `Server = "IPSAPI"`. |
| 2 | `IPSTransactionGetByAccount5` | Transactions | Per-account transaction history. **Modern**, header-level paging. |
| 3 | `IPSAccountGetAll1` | Account list | **Legacy** cursor paging (param-level `PreviousAccountCode`). For full account reconciliation. |
| 4 | `IPSPositionGetAll1` | Positions | **Legacy** cursor paging. For full position reconciliation. |
| 5 | `IPSUploadCreate1` | Uploads (write) | Create an upload job; returns `UploadNumber`. |
| 6 | `IPSUploadDataSet1` | Uploads (write) | Push data rows. |
| 7 | `IPSUploadRun1` | Uploads (write) | Execute the upload. |
| 8 | `IPSUploadSummaryGet2` | Uploads (read) | Summary: rowsProcessed, rowsSucceeded, rowsFailed. |
| 9 | `IPSUploadErrorGet1` | Uploads (read) | Per-row error list (paged). |

**Upload types** (illustrative — WSDL is source of truth): `SECURITY_LIST`, `HOLDINGS`, `PRICES`. These are the IRESS-side write paths for client-built reference data and positions; the V4 surface does not include a generic "wire / cash movement" outbound.

### B.4 FIX+

| # | Method | Business domain | Description |
|---|---|---|---|
| 1 | `ServiceSessionStart` | Auth | `Service = "FIXPlus"`, `Server = "FIXPLUSAPI"`. |
| 2 | `TargetIDGet` | FIX+ status | List FIX+ targets the user can see. |
| 3 | `TargetIDStatusGet` | FIX+ status | Check whether a target is logged in / connected. |

**Important:** the actual FIX message stream (drop-copy bytes) comes over a **separate TCP FIX connection**, not via V4. V4 FIX+ is **control/status only**. This is the single biggest "you don't get it from V4" gap (`11-mint-oems/01-requirements-traceability.md` "What you don't get from V4").

### B.5 Total method count (named in the doc set)

| Namespace | Distinct method verbs called out in the docs |
|---|---|
| Iress Pro / market data | ~9 (incl. `IRESSSessionStart/End`, `PricingQuote*`, `TimeSeriesGet2*`, `PricingTradeHistoricalGet`, `AuditTrailGetByAccount`, news/SENS) |
| IOS+ | 20 (incl. `ServiceSession*`, `OrderCreate3`, `OrderAmend2`, `OrderDelete`, `OrderPadGet*` × 3, `OrderPadGet*Updates` × 3, `OrderSearchGet*` × 2, `OrderNoGetByOrderTag`, `BookingGetByOrganisation2`, `ETCGetByOrganisation`, `DestinationGet`, `DestinationDetailGet`, `AttributeGetByUser`, `SessionRequestEnd`) |
| IPS | 9 (`ServiceSessionStart` shared, `IPSTransactionGetByAccount5`, `IPSAccountGetAll1`, `IPSPositionGetAll1`, `IPSUploadCreate1`, `IPSUploadDataSet1`, `IPSUploadRun1`, `IPSUploadSummaryGet2`, `IPSUploadErrorGet1`) |
| FIX+ | 3 (`ServiceSessionStart` shared, `TargetIDGet`, `TargetIDStatusGet`) |
| **Total** | **~41 verbs** (some shared like `ServiceSessionStart` are counted once) |

> Caveat: the PDF "is not exhaustive"; the live WSDL exposes more. The doc set's explicit list of named verbs is the source for this catalogue.

### B.6 Cross-cutting protocol / recovery surface (not endpoint-specific but "available")

| Surface | Doc | Description |
|---|---|---|
| Session model | `04-sessions/*` | Two-layer: `IRESSSessionKey` + `ServiceSessionKey` per service. 2h idle / 24h max / 01:00 SAST group expiry. |
| Header | `02-protocol/01-requests` | `RequestID` (GUID), `Updates`, `Timeout` (25s default, 55s for `IRESSSessionStart`), `PageSize` (1000), `PagingBookmark`, `PagingDirection` (forward only). |
| Sync vs async | `02-protocol/03` | `WaitForResponse` flag. |
| Paging | `03-paging-and-updates/01,02,03,04` | StatusCode 1/2/3. Modern = header bookmark. Legacy IPS = param-level cursor. |
| Updates (long-poll) | `03-paging-and-updates/03` | `Updates=true` + matching `*Updates` method with same `RequestID`. 10 000-row queue limit. 30-min request expiry. 1000s `NoUpdateBlockTime`. |
| Error model | `06-errors/01,02,03,04` | Match on `ErrorNumber`, not on description string. Session codes 25001–25035 + 666. |
| Recovery patterns | `07-recovery/01-05` | Get → retry with new RID. Set with idempotency key (e.g. `OrderTag`) → safe. Set without → state-check first. |
| Server-side limits | `08-performance/02` | 50 reqs/session, 20 000 sessions/server, 10 000-row update queue, 2h session idle, 24h max. |
| Client optimisations | `08-performance/01` | Largest `PageSize`; bulking; gzip; cut-down WSDL; HTTP keep-alive; in-process cache. |
| WSDL compatibility | `09-compatibility/01` | Method names can change between WSDL versions; `OrderCreate` → `OrderCreate2` → `OrderCreate3`. Save the WSDL per env/date. |
| MINT addenda | `11-mint-oems/*` | SA env strategy, end-to-end JSE order call graph, requirements traceability, low-hanging-fruit checklist. |

---

## Part C — Gaps (V4 available, not yet wired)

### C.1 Adapter surface (declared on `IressClient`)

All V4 methods on the interface are implemented in the mock. So the "gap" inside the adapter is **zero on the surface IressClient exposes today**. The gap is in Part C.2 (methods we'd add next).

### C.2 Methods on the V4 list that are NOT on the adapter

These are the verb names that the docs call out, that we have no TypeScript signature for, and that the Email brief or product vision likely implies:

| Method | Namespace | Business reason we'd add it | Email / brief / planning tie-in |
|---|---|---|---|
| `IRESSSessionEnd` | Iress | Session teardown on logout. | `lib/iress/index.ts:bringUpMintSession` builds the session but no caller ends it. Hygiene. |
| `OrderPadGetByUser` / `…Updates` | IOS+ | Per-user blotter across multiple accounts. | `11-mint-oems/03-call-graph-jse-order.md` step 5 lists `OrderPadGetByUser(Updates=true)` as an alternative. |
| `OrderPadGetByAccountGroup` / `…Updates` | IOS+ | WM sees many clients; account-group pagination is the right granularity. | Wealth-manager persona (`/wm`) and `OrderPad*` docs. |
| `OrderSearchGetByUser` | IOS+ | EOD reconciliation step 2 (`07-recovery/04`). | Required for `OrderPadGetBy*` recovery algorithm. |
| `OrderSearchGetByAccount` | IOS+ | Account-scoped wider filter for recon. | Same. |
| `OrderNoGetByOrderTag` | IOS+ | Recovery for `OrderCreate3` when no response is received. | `07-recovery/05`. **P0** — we already implement idempotency; we don't currently handle the "I never got a response" case. |
| `SessionRequestEnd` | IOS+ | Cleanly end a long-poll subscription. | `03-paging-and-updates/03-updates.md` "explicitly call `SessionRequestEnd(RequestID=…)` to end". |
| `DestinationGet` | IOS+ | Discover CO / algo destinations per user. | Pre-requisite for contingent & algo orders. |
| `DestinationDetailGet` | IOS+ | Inspect a destination's `DestinationSubTypeNumber` / Algo bit. | Same. |
| `AttributeGetByUser` | IOS+ | Per-user attribute catalog for CO/algo order entry. | Same. |
| `ETCGetByOrganisation` | IOS+ | Pre-trade cost snapshot. | "pre-trade compliance" — Email brief. |
| `PricingQuoteExGet` | Iress Pro | Extended L1 / depth-of-book. | Equities + Security pages (`/oems/equities`, `/oems/security`) — Email brief explicitly lists "Equities (L1/L2)". |
| `PricingTradeHistoricalGet` | Iress Pro | Historical trades (time-and-sales backfill). | `/oems/security` time-and-sales widget. |
| `IPSAccountGetAll1` | IPS | List all accounts the user can see. | Reconciliation + account picker. |
| `IPSPositionGetAll1` | IPS | List all positions. | Recon + wealth-manager view. |
| `IPSUploadCreate1` … `IPSUploadErrorGet1` | IPS | Outbound data writes (security lists, holdings, prices). | Email brief mentions "reconciliation" and "wires"; the docs are explicit that wires are inbound-only via `IPSTransactionGetByAccount5`. The upload methods are the write path for *our* reference / position data into IPS. |
| `AuditTrailGetByAccount` | Iress | Per-account audit trail. | Compliance / admin surfaces. |
| News / SENS / wires V4 methods | Iress | WSDL exposes them. The Email brief names SENS and wires explicitly. | Confirmed gap per `11-mint-oems/01-requirements-traceability.md` "SENS" question. |

**Count of methods on the V4 list that we don't have:** ~18.

### C.3 Methods on the V4 list that we *do* have but don't call

| Method | Currently | Use case the Email brief / planning implies |
|---|---|---|
| `pricingQuoteGet` | declared, used only via `iressQueries.quote` (un-used in pages) | Will become the live L1 feed behind `/api/ticks` SSE, replacing the synthetic walker. |
| `pricingQuoteGetUpdates` | declared, no-op | Live long-poll for the L1 tape. |
| `timeSeriesGet2` | declared, mocked for NSS/ZARONIA/JIBAR/J203, **no UI call site** | All "curve" / "fixings" / "macro" surfaces are currently served from `iressQueries.*` seed arrays. The live path is `TimeSeriesGet2` + `TimeSeriesGet2Updates`. |
| `timeSeriesGet2Updates` | declared, no-op | Live curve / macro update stream. |
| `orderPadGetByAccount` | declared, not called from any page (UI uses `iressQueries.orders()`) | The live equivalent of the blotter feed. **P0** for go-live. |
| `orderPadGetByAccountUpdates` | declared, no-op | Live order-state updates. |
| `bookingGetByOrganisation2` | declared, not called | Fee-level detail. `/oems/blotter` should open a side-panel per fill showing MiscFees (regulatory / GST / stamp / levy / brokerage). |
| `ipsTransactionGetByAccount5` | declared, not called | EOD transaction reconciliation. The recovery overlay in `03-call-graph-jse-order.md` step 7 is exactly this. |
| `targetIdGet` / `targetIdStatusGet` | declared, not called from a page (data only) | `/oems/integration` should show real FIX+ target status from IRESS, not seed. |

### C.4 HTTP-side gaps

- **No SOAP client** (`lib/iress/live.ts` does not exist). The mock is the only adapter.
- **No WSDL downloaded or versioned.** `.env.example` declares the cut-down method lists but the WSDL files are not on disk.
- **`/api/ticks` is synthetic**, not a proxy of any IRESS method. When we go live, this needs to be either a WebSocket to a `strong-soap` long-poll client, or replaced entirely with `EventSource` over an internal proxy that calls `PricingQuoteGetUpdates`.
- **No `AmendIfExists` patterns** for Iress WebAdmin / IOS+ Admin (the docs call these out in `07-recovery/02` / `03`). We don't currently call any WebAdmin methods, so this is latent.
- **No `OrderNoGetByOrderTag`** in the recovery chain (see C.2 — would be P0 for production).

---

## Part D — Future needs by business surface

The Email brief is short — 23 lines — but the product surface is broad. The brief names 10 functional areas: reference data, equities L1/L2, fixed income (clean/dirty/Greeks), money market (JIBAR/ZARONIA/NCDs), fitted yield curves (NSS), macro (SARB/StatsSA/G10), SENS and wires, auth, streaming, SLA, reconciliation. The PLANNING doc and existing persona pages go further with **OEMS trader**, **wealth manager**, **strategist**, **admin**, **business**, **funeral cover**, and **financial controller** surfaces. Below I map each surface to the V4 methods that would unlock it.

### D.1 TRADING (OEMS) — `OEMS persona / /oems/*`

**What's already there:** Trading path is the deepest currently wired. `OrderCreate3`, `OrderDelete`, pre-trade checks (`strategy.ts:preTradeCheck`), idempotency via `OrderTag`, and the `OrderNoGetByOrderTag` recovery pattern are all in place or trivially addable.

**What's missing and what V4 unlocks it:**

- **Real L2 depth on `/oems/security` and `/oems/equities`.** Email brief: *"Equities (L1/L2)"*. The only V4 method the doc names for L2 is `PricingQuoteExGet` (extended L1 / depth-of-book per `01-requirements-traceability.md`); `02-paging-and-updates/03` and `05-services/market-data/03` both note that for true L2 the WSDL has a depth method. Methods: `PricingQuoteExGet`, possibly a depth-specific method surfaced in the WSDL. Streamed via `PricingQuoteExGetUpdates`.
- **Pre-trade Estimated Trade Cost (ETC) before send.** Email brief: "pre-trade compliance" + the doc-flagged "low-hanging fruit" item in `01-requirements-traceability.md` ("Pre-trade compliance hooks — V4 doesn't have a 'pre-flight check' method"). V4 method: `ETCGetByOrganisation(Organisation, Account, Date)`. Display the expected cost on the new-order dialog and block the send if the user hasn't acknowledged the cost over a threshold.
- **Algo + CO orders for the trading desk.** The current new-order dialog has no CO/algo picker. V4 method: `DestinationGet` + `DestinationDetailGet` (to enumerate CO destinations with `DestinationSubTypeNumber` 30-39, algo destinations with `DestinationPropertiesMask & 256`); `AttributeGetByUser(AttributeCategoryNumber=8)` to fetch the IS set; `AttributeGetByUser(AttributeCategoryNumber=5)` for algo. Then `OrderCreate3` with `ExecutionInstructions` carrying the attributes. The composite take-profit pattern (`AUTODESK + IFDONE + FIXED CO`) is documented end-to-end in `contingent-orders/07-take-profit.md`.
- **Per-user / per-account-group order pad.** Currently the blotter is account-scoped via `iressData.orders()`. When we go live, the V4 path is `OrderPadGetByUser(Updates=true)` for a trader's whole book, and `OrderPadGetByAccountGroup` for the desk. Methods: `OrderPadGetByUser` + `…Updates`, `OrderPadGetByAccountGroup` + `…Updates`. This is the realistic shape for a multi-strategy desk.
- **Order search / wider filter for EOD reconciliation.** `07-recovery/04-iosplus-order-retrieval-recovery.md` is explicit: step 2 is `OrderSearchGetByUser(DateTimeFrom=…, OrderState=3)`. Add `OrderSearchGetByUser` / `OrderSearchGetByAccount` on the interface, run it nightly, and surface exceptions in a `/oems/integration/reconciliation` panel.
- **Order recovery when `OrderCreate3` returns no response.** `OrderNoGetByOrderTag(OrderTag=…)` per `07-recovery/05`. This is a one-day add and closes the single biggest recovery hole.
- **`SessionRequestEnd`** on unmount so a trader's page navigation doesn't burn one of the 50 active-request slots.
- **The "real" tick stream.** `pricingQuoteGetUpdates` + a server-side proxy that translates the V4 long-poll into a WebSocket or SSE for the client. The current `/api/ticks` route is fully synthetic. The "where this lives in your stack" diagram in `01-foundations/01-overview.md` puts the OEMS Web/OMS on top, talking HTTPS/SOAP/gzip to IRESS; the SSE/WS proxy is a Mint responsibility.

**V4 methods / verbs referenced:** `PricingQuoteExGet`, `PricingQuoteExGetUpdates`, `ETCGetByOrganisation`, `DestinationGet`, `DestinationDetailGet`, `AttributeGetByUser`, `OrderPadGetByUser` + `Updates`, `OrderPadGetByAccountGroup` + `Updates`, `OrderSearchGetByUser`, `OrderSearchGetByAccount`, `OrderNoGetByOrderTag`, `SessionRequestEnd`, `PricingQuoteGetUpdates`, `OrderPadGetByAccountUpdates`.

### D.2 WEALTH MANAGEMENT (WM) — `wealth_manager persona / /wm`

**What the persona needs (per PLANNING §1.1; the page is currently a stub):** A view of a wealth manager's book of clients, the model portfolios they've been assigned, the per-client holdings, the per-client P&L, the suitability assessment, the annual review date, the advisor hierarchy, the house-view overrides.

**V4 methods that unlock it:**

- **List of all clients & accounts the WM can see.** `IPSAccountGetAll1` (legacy cursor-paging) is the only V4 method the doc names for this. We'll wrap it in a modern `pagedFetch(IPSAccountGetAll1, …)` helper that handles the non-standard cursor (`PreviousAccountCode`) — see `03-paging-and-updates/04-paging-in-ips.md`.
- **Per-account positions.** `IPSPositionGetAll1` (legacy). Same cursor handling.
- **Per-account transactions.** `IPSTransactionGetByAccount5` is already on our interface. Add the call site: a per-client "Activity" panel.
- **Per-account holdings snapshot for a chosen model portfolio.** `IPSTransactionGetByAccount5` gives the activity; for the **holdings** snapshot we'd need to derive it from transactions (because V4 doesn't have a "give me the current position" method — positions are derived from the transaction history). The Email brief names "wires / cash movements"; V4 covers these as inbound transactions only (`01-requirements-traceability.md` "wires" entry).
- **Suitability / mandate / model portfolio assignment.** V4 has no surface for this. Likely an internal Mint data store, or — if we have to source it from IRESS — `IPSUploadCreate1` etc. to write the model-portfolio assignment into IPS. (WSDL-dependent; `uploads/01` says upload type strings are server-side config.)
- **Client reporting / statements.** Per-account transactions + positions + a PDF/HTML renderer; V4 is the data source, the document is generated by Mint.

**Email brief tie-in:** No direct sentence — but the brief's "wires / cash management" and the existing `clientsByWealthManager` seed fixture (`seed.ts`) imply this surface.

**V4 methods referenced:** `IPSAccountGetAll1`, `IPSPositionGetAll1`, `IPSTransactionGetByAccount5` (already on interface), `IPSUploadCreate1` + family (if we want to push model assignments into IPS).

### D.3 STRATEGY / RESEARCH — `strategist persona / /strategist`

**What the persona needs:** Model portfolios (mandates), drift vs target, performance attribution, benchmark time series, rebalance controls. Existing `oemsStrategies` seed already mocks this for the OEMS; the dedicated `/strategist` page is a stub.

**V4 methods that unlock it:**

- **Model portfolio universe.** A model portfolio is a `Strategy` in our type model; the V4 source is the IPS transactions for each "strategy account". `IPSTransactionGetByAccount5` is the read path.
- **Benchmark time series.** `TimeSeriesGet2(Code = "J203" / "ALSI" / "SWIX" / "FINI" / "RESI" …)`. Already on the interface; the live path is straightforward.
- **Performance attribution.** NSS curve decomposition (the ZAR Govi curve, the swap curve, the ILB curve) is what drives PCA. `TimeSeriesGet2` for each curve code, then a Mint-side PCA calculation. The "Curve Move · PCA" panel in `cockpit-client.tsx` already shows this with a hand-built decomposition.
- **Sector heatmap.** `TimeSeriesGet2` per JSE sector, normalised. Or — more likely — a single snapshot method (WSDL) for sector performance. The PDF doesn't enumerate a sector-snapshot method explicitly; `iressQueries.sectors()` is currently a seed.
- **Rebalance controls.** The `preTradeCheck` and `canRebalance` gates in `strategy.ts` are Mint-side. V4 doesn't have a "rebalance a strategy" verb; rebalancing is just a coordinated set of `OrderCreate3` calls per holding. (And: per the `strategy.ts:canRebalance` comment, the **server-side** pre-trade mandate check is also what IOS+ enforces — we mirror it client-side.)

**Email brief tie-in:** *"fixed income (clean/dirty pricing, Greeks), money market (JIBAR/ZARONIA/NCDs), fitted yield curves (NSS)"* — all of these feed the strategist's view.

**V4 methods referenced:** `TimeSeriesGet2` (per curve code, per benchmark, per sector — already on interface), `IPSTransactionGetByAccount5` (per strategy account), `OrderCreate3` (per rebalance leg). Plus the contingent/algo methods from D.1 if the strategist wants a "buy the curve" algo.

### D.4 COMPLIANCE / ADMIN — `admin persona / /admin`

**What the persona needs:** Audit trail, entitlement management, supervisory overrides, user & group administration, kill-switch. Existing `pendingApprovals` / `auditTrail` seed in `seed.ts` and the page stub. The `BLOTTER` page in OEMS has a "Cancel working" destructive confirm; admin is the natural home for a force-cancel-all-orders UI.

**V4 methods that unlock it:**

- **Per-account audit trail.** `AuditTrailGetByAccount(AccountCode, DateFrom, DateTo)`. The doc calls it out in `01-requirements-traceability.md` "Audit trail reconciliation". Not on our interface; WSDL is the source of truth. Method supports bookmark paging.
- **Entitlement inspection.** The doc is light, but every method's "view destination" / "view-destination" permission gates the discovery methods (`DestinationDetailGet`). The "What you don't get from V4" section in `01-requirements-traceability.md` says there's no programmatic entitlement-introspection method; admin is forced to mirror the user-roles model from IRESS admin into the Mint data model. Open question — see Part F.
- **User / group administration.** The doc references `AdminUserCreate2`, `UserCreate`, `AccountCreate` (in Iress WebAdmin and IOS+ Admin — `07-recovery/02`, `03`). These are the Iress WebAdmin / IOS+ Admin method families. Not on our interface. We don't have a real user / group / role model yet; the `auditTrail` seed and the mock `/api/auth/login` are placeholders. When we wire a real IdP (Clerk or Auth0 per PLANNING §8) we'll also need to mirror roles in IRESS, and `AdminUserCreate2` / `AccountCreate` (with `AmendIfExists=true`) become part of the onboarding flow.
- **Force-close.** `IRESSSessionStart(SessionNumberToKick=-1)` per `04-sessions/03-user-scenarios.md` is the documented "kick every other session for this user" recovery. Useful for "lock out a departing trader immediately".
- **SOD, supervisory review, kill-switch.** None of these are V4 methods. They're Mint features; the V4 underpinning is the audit trail + force-close.

**Email brief tie-in:** No direct mention. The PLANNING doc lists the admin persona as deferred for v2.0 (`PLANNING §1.1`).

**V4 methods referenced:** `AuditTrailGetByAccount`, `AdminUserCreate2`, `UserCreate`, `AccountCreate`, `IRESSSessionStart(SessionNumberToKick=-1)`, plus the entitlement-gated discovery methods from D.1.

### D.5 BUSINESS / SALES — `business persona / /business`

**What the persona needs:** KYC / FICA onboarding, prospect-to-client pipeline, CRM-style account opening, deal capture, fees & commercials tracking. The page is a stub; `oemsStrategies` and `deals` are seeded. The Email brief doesn't mention this surface — it's a product-vision call.

**V4 methods that unlock it:**

- **Account creation.** `AccountCreate` (IOS+ Admin), `AdminUserCreate2` (Iress WebAdmin). Both support `AmendIfExists=true` per `07-recovery/02` and `03` for idempotent onboarding.
- **Mandate / model portfolio assignment.** `IPSUploadCreate1` … `IPSUploadRun1` (type "MODEL_PORTFOLIO_ASSIGNMENT" or similar — WSDL-dependent) if we want IPS as the system of record; otherwise an internal Mint table.
- **KYC / FICA documents.** No V4 surface. External system (XDS, Compliant, etc.) or Mint's own document store.
- **CRM / deal pipeline.** No V4 surface. External CRM (Salesforce, HubSpot) or Mint's own.

**Email brief tie-in:** None. **Open question for Part F** — is the business/sales surface in scope for IRESS at all, or do we treat it as a separate system?

**V4 methods referenced:** `AccountCreate`, `AdminUserCreate2`, `IPSUploadCreate1` family.

### D.6 FINANCIAL CONTROL — out-of-scope in `PLANNING §1.1` but mentioned in the Email brief

**What the persona needs:** Reconciliation of trades, positions, cash, fees, corporate actions, settlements, custodian feeds.

**V4 methods that unlock it:**

- **Daily trade reconciliation.** `IPSTransactionGetByAccount5(AccountCode, DateFrom, DateTo)`. Already on the interface.
- **Booking / fee reconciliation.** `BookingGetByOrganisation2(From, To, AccountCode?)`. Already on the interface.
- **Holdings reconciliation.** `IPSPositionGetAll1` (legacy paging — `pagedFetch` wrapper). Not on the interface.
- **Account-list reconciliation.** `IPSAccountGetAll1` (legacy paging). Not on the interface.
- **FIX+ drop-copy status.** `TargetIDGet` + `TargetIDStatusGet`. Already on the interface. **But** the actual FIX bytes are over a separate TCP connection — see the doc note.
- **Audit trail reconciliation.** `AuditTrailGetByAccount`. Not on the interface.
- **Settlement / clearing (STRATE).** V4 does **not** have a settlement method. `01-requirements-traceability.md` "What you don't get from V4" is explicit. STRATE settlement is downstream of IRESS; we'd build or buy a separate bridge.
- **Corporate actions.** Surface as transactions in `IPSTransactionGetByAccount5` (the docs note this explicitly in `05-services/ips/01-transactions.md` — "Corporate actions: dividend / distribution / capital events are surfaced as transactions; make sure the OEMS can categorise them"). So no new V4 method; categorisation is on us.
- **Custodian feeds.** Out of scope for V4 (custodian-specific protocols).

**Email brief tie-in:** Direct — *"Wires (cash movements) … reconciliation"*. Plus the trace matrix in `11-mint-oems/01-requirements-traceability.md` "Reconciliation" section enumerates exactly these methods.

**V4 methods referenced:** `IPSTransactionGetByAccount5` (have), `BookingGetByOrganisation2` (have), `IPSPositionGetAll1` (gap), `IPSAccountGetAll1` (gap), `AuditTrailGetByAccount` (gap), `TargetIDGet` / `TargetIDStatusGet` (have).

### D.7 FUNERAL COVER — `funeral_cover persona / /fc`

**What the persona needs:** Member administration, premium collection, claims, beneficiary management. The page is a stub; `reconLegs`, `cashPositions`, `reconExceptions` are seeded. The Email brief doesn't mention funeral cover — it's a product-vision call.

**V4 analysis:** IRESS is a market-data + order + portfolio system. **None** of the V4 surface maps to:
- member onboarding (no name/address/ID number surface)
- premium collection / debit orders (no payment-rail surface)
- claims (no claims surface)
- beneficiaries (no relationship surface)
- underwriting (no risk-scoring surface)

What we *could* use IRESS for, if the funeral-cover fund is also a "client" of an IRESS account:
- **Invest the fund's float.** The funeral cover premium float is a money-market / bond portfolio; we'd want `TimeSeriesGet2` for the ZAR NSS curve, `PricingQuoteGet` for the bonds / NCDs, and `OrderCreate3` for trading.
- **Reconcile the investment book against IPS.** `IPSTransactionGetByAccount5` etc. as per D.6.
- **Publish daily unit prices / NAV.** If the policy is unit-linked, we publish a unit price; IRESS is the source of the underlying portfolio valuation.

**Open question for Part F:** Is IRESS the system of record for the funeral-cover product, or is it only the investment-side system? My read of the seed (`reconLegs`, `cashPositions`, `reconExceptions`) is that the funeral-cover team reconciles **their** book against **the IRESS** book — i.e. IRESS is the investment system, the funeral-cover policy admin is a separate system.

**V4 methods referenced:** same as D.6 (financial control), if the funeral-cover fund's investments are in IRESS. Otherwise, none.

### D.8 REAL-TIME / INFRASTRUCTURE

Cross-cutting concerns that span every persona. The IRESS docs have a lot to say about each.

- **Streaming pattern.** The doc's recommended pattern (`03-paging-and-updates/03`) is: snapshot via the data method, page to `StatusCode=3`, then long-poll the `*Updates` method with the same `RequestID`. 10 000-row queue limit. 30-min request expiry. 1000s `NoUpdateBlockTime`. We currently don't implement any of this — the synthetic `/api/ticks` is a 700ms interval random walk, and the OEMS UI subscribes via `useTick` (Zustand). To go live, the right shape is: a server-side proxy that runs the long-poll loop and exposes a WebSocket or SSE to the client.
- **SSE vs WebSocket.** Both are viable (`PLANNING §5.3` flags the choice). SSE is one-way, simpler; WebSocket is two-way, supports commands (cancel subscription, narrow filter). For ticks, SSE is fine; for orders (where the client may want to narrow the filter mid-flight) WebSocket is better. The doc doesn't dictate; it's an Mint choice.
- **FIX drop-copy.** Per `01-foundations/01-overview.md` and the FIX+ docs, the FIX bytes come over a **separate TCP FIX connection**. Mint's `lib/iress/fix-plus.ts` (planned per `PLANNING §3.1`) is the V4 status surface; a separate `lib/fix/dropcopy.ts` is the FIX bytes surface. They are independent. **No V4 method carries the FIX bytes themselves.**
- **Market data entitlement enforcement.** The V4 PDF doesn't enumerate an entitlement-introspection method. Per `04-low-hanging-fruit.md` "Method entitlements": *"Different users may be entitled to different methods (e.g. a junior trader can't place algo orders). The 'view destination' permission gates `DestinationDetailGet`. Confirm what the user-roles model looks like in IRESS and how it maps to the OEMS role model."* Open question for Part F.
- **Rate limiting.** V4 has no published per-second limit; the only cap is the 50-active-requests-per-session and the 20 000-active-sessions-per-server (`02-sa-endpoints-and-envs.md`). Mint-side rate limiting would be a polite guard, not a hard requirement.
- **Idempotency keys.** The doc is explicit: `OrderTag` on every `OrderCreate3`. We already do this. We don't yet have the recovery half (`OrderNoGetByOrderTag`) — see D.1.
- **Session recovery.** The doc is exhaustive. We currently have the helper `bringUpMintSession` in `lib/iress/index.ts:76` but no caller; nothing builds / tears down sessions today. To go live, we need:
  1. A session supervisor that builds the Iress + 3 service sessions on user login.
  2. Heartbeat / idle handling (refresh before 2h).
  3. A 01:00 SAST strategy (`SessionTimeout` override).
  4. Recovery on 25006/25009/25014/25019/25022/25033.
  5. `SessionRequestEnd` on page unmount for long-polling subscriptions.

**V4 methods referenced (cross-cutting):** `IRESSSessionStart` (with `ApplicationID`, `SessionNumberToKick`, `KickLikeSessions`, `Locale`, `SessionTimeout`), `IRESSSessionEnd`, `ServiceSessionStart/End`, all `*Updates` methods, `SessionRequestEnd`, `OrderNoGetByOrderTag`, `TargetIDStatusGet`.

---

## Part E — Recommended rollout priorities

Ranked by **(i) business value to the SA OEMS build + multi-persona vision** and **(ii) implementation cost** (P0 = table-stakes for go-live, P1 = next 90 days, P2 = future). Each pick names the V4 methods to add to the adapter.

| # | Priority | Theme | What | V4 method(s) | Business value | Cost | Rationale |
|---|---|---|---|---|---|---|---|
| 1 | **P0** | Recovery | `OrderNoGetByOrderTag` + recovery flow | `OrderNoGetByOrderTag` | **High** — closes the "I sent an order and never got a response" hole that the doc repeatedly flags as the highest-stakes case. | **Low** — one method, one recovery helper in `lib/iress/recovery.ts`. | `07-recovery/05-iosplus-order-creation-recovery.md` is explicit: this is the only safe retry pattern. Without it, a network drop during a sell order is an unknown state. |
| 2 | **P0** | Recovery | Two-step recon at startup | `OrderSearchGetByUser(OrderState=3)` + reuse existing `OrderPadGetByAccount` | High | Medium — the algorithm is documented (`07-recovery/04`); we need the search method. | Same algorithm for startup and for reconnect. Necessary for the blotter to be correct after a process restart. |
| 3 | **P0** | Live data | Long-poll streaming pattern (server proxy) | `PricingQuoteGetUpdates`, `TimeSeriesGet2Updates`, `OrderPadGetByAccountUpdates` | High | Medium-High — the wire-up is well-documented, but it's a new server component (the long-poll → SSE/WS proxy). | Synthetic ticks are fine for a demo; they're a non-starter for production. |
| 4 | **P0** | Live | Real WSDL + cut-down generator + SOAP client | All | High | High — `lib/iress/live.ts`, WSDL files in VCS, env-driven method filters. | The whole `IRESS_MODE=live` switch is meaningless without this. |
| 5 | **P0** | Live | Session supervisor | `IRESSSessionStart`, `IRESSSessionEnd`, `ServiceSessionStart`, `ServiceSessionEnd` | High | Medium — bring-up is half-done; the missing half is the supervisor loop with idle/01:00 SAST/recovery. | Without this, a 2-hour idle is a 25014. Without `ApplicationID` discipline, orphan sessions accumulate. |
| 6 | **P1** | Compliance | Pre-trade Estimated Trade Cost (ETC) on the new-order dialog | `ETCGetByOrganisation` | High | Low — one method, one panel on the existing dialog. | Differentiator vs the brokers' UIs; lets the trader see all-in cost before commit. The `preTradeCheck` helper in `strategy.ts` is the right hook. |
| 7 | **P1** | Equities | L2 depth on `/oems/security` + `/ooms/equities` | `PricingQuoteExGet` (and WSDL-surfaced depth method) | High | Medium — depends on what the WSDL actually exposes. The PLANNING doc lists "depth-ladder" as the security page's marquee widget. | Email brief: "Equities (L1/L2)". |
| 8 | **P1** | Wealth / Strategy | Per-account transactions + positions, account list | `IPSTransactionGetByAccount5` (call site), `IPSPositionGetAll1` (new), `IPSAccountGetAll1` (new) + `pagedFetch` legacy-cursor helper | High | Medium — three methods, one paging wrapper, lots of UI work on `/wm` + `/strategist`. | Wealth-manager and strategist personas are deferred for v2.0; this is the data layer they need. |
| 9 | **P1** | Reconciliation | Audit trail per account | `AuditTrailGetByAccount` | Medium-High | Low-Medium — one method, one panel. | The trace matrix in `11-mint-oems/01-requirements-traceability.md` "Reconciliation" calls it out. |
| 10 | **P1** | Contingent / Algo | CO + algo order entry in the blotter | `DestinationGet`, `DestinationDetailGet`, `AttributeGetByUser` × 2, then `OrderCreate3` with `ExecutionInstructions` | High | High — destination discovery, attribute catalog, UI for CO/algo order entry, take-profit composite pattern. | Differentiator; the trading desk's voice will be "I want to do OCO brackets and take-profits". |
| 11 | **P1** | Infra | `SessionRequestEnd` discipline + per-`RequestID` clean-up | `SessionRequestEnd` | Medium | Low — one helper, calls on unmount. | Avoids burning the 50 active-request slots per session. |
| 12 | **P2** | Compliance | Audit trail UI for the admin persona | `AuditTrailGetByAccount` (UI on top of #9) | Medium | Medium — separate from the data layer; admin persona work. | |
| 13 | **P2** | Compliance | WebAdmin user/role provisioning | `AdminUserCreate2`, `UserCreate`, `AccountCreate` | Medium | High — when a real IdP is wired, this is the second half of the auth story. | |
| 14 | **P2** | Reconciliation | Outbound data into IPS (security lists, holdings, prices) | `IPSUploadCreate1`, `IPSUploadDataSet1`, `IPSUploadRun1`, `IPSUploadSummaryGet2`, `IPSUploadErrorGet1` | Medium | High — full upload workflow, error handling, per-row error surfacing. | For when Mint becomes the system of record for some reference data and pushes it into IPS. |
| 15 | **P2** | Historical | Time-and-sales backfill | `PricingTradeHistoricalGet` | Medium | Low — one method, one panel. | |
| 16 | **P2** | News | Real SENS / news feed | (WSDL-surfaced news / SENS / wire methods) | Medium | High — depends on the WSDL; may be a separate feed (per the doc's "ask Charles" list). | |
| 17 | **P2** | Order retrieval | Per-user / per-account-group order pad | `OrderPadGetByUser` + `…Updates`, `OrderPadGetByAccountGroup` + `…Updates` | Medium | Medium — three new methods, alternative blotter view. | |
| 18 | **P2** | Business / Funeral | Confirm whether IRESS is in scope | (none new) | Depends on Part F answers. | | |

**P0 count:** 5 picks (all about making the live path actually work).
**P1 count:** 6 picks (post-launch differentiation, financial-control depth, CO/algo, infra hygiene).
**P2 count:** 7 picks (admin persona, WebAdmin provisioning, news, historical prints, per-user blotters, and the business/funeral cover scope question).

---

## Part F — Open questions for IRESS / business

The IRESS V4 doc set is comprehensive on the *API* and light on the *product decisions*. The Email brief is comprehensive on the *requirements* and silent on the *organisation*. The following questions are the ones the docs explicitly flag as "ask Charles" (the IRESS account exec) or that the product brief does not resolve.

1. **L2 depth — true book or extended L1?** `01-requirements-traceability.md` Gaps #1: *"confirm whether IRESS exposes a true L2 depth method or only an extended L1 (book snapshot) via `PricingQuoteExGet`. If only L1, consider whether a third-party feed (e.g. JSE direct) is needed for the OEMS."* **Impact:** the entire `/oems/security` page depth-ladder widget. **Action:** get the WSDL; check the `PricingQuoteExGet` method's column set; budget for a JSE direct feed if true L2 is not exposed.
2. **SENS delivery — V4 method, separate feed, or per-security?** `01-requirements-traceability.md` Gaps #3 + `04-low-hanging-fruit.md` "Things to ask Charles" #2. **Impact:** the `/oems/news` page; whether the SENS stream is real-time or delayed. **Action:** ask Charles; consider a SENS subscription from a third-party vendor if V4 doesn't carry it.
3. **NSS curve code and shape.** The trace matrix is explicit: *"Confirm the NSS curve code with the IRESS Vol-2 reference data — the OEMS should treat the curve as a typed time series and dispatch on tenor."* And `04-low-hanging-fruit.md` "Things to ask Charles" #3. **Impact:** `/oems/curves`. **Action:** ask Charles for: (a) the Iress code for the ZAR NSS curve, (b) whether it's delivered as points (e.g. 1Y, 2Y, 5Y, 10Y, 20Y, 30Y) or as the NSS parameters (β0..β3, τ1, τ2), (c) whether `TimeSeriesGet2Updates` is supported.
4. **Macro data — what is delivered, what is interpolated.** `04-low-hanging-fruit.md` #4. **Impact:** `/oems/macro`. **Action:** ask Charles for the macro series list, frequency, and lag for SARB / StatsSA / G10.
5. **Pre-trade compliance hooks.** `04-low-hanging-fruit.md` #5 + the doc note: *"Not in the spec, but critical for an OEMS. Ask if IRESS has any pre-trade compliance methods (e.g. a 'validate order' method that returns pre-trade warnings), or whether compliance is purely the OEMS's responsibility."* **Action:** answer is almost certainly the latter (per `01-requirements-traceability.md` "Pre-trade compliance … is OEMS responsibility"). Document the position.
6. **Wires — inbound only, or also outbound?** `04-low-hanging-fruit.md` #6. **Impact:** the Email brief's "wires / cash management" line. **Action:** ask Charles whether the V4 has an outbound wire / payment-initiation method, or whether wires are read-only via `IPSTransactionGetByAccount5`. (Reading the docs, the answer appears to be read-only with the IPS transactions; the upload methods are for *our* reference / position data, not for payments.)
7. **FIX+ — drop-copy or execution?** `04-low-hanging-fruit.md` #7. **Action:** confirm. Reading the docs and the existing code, we model drop-copy (`MINT-DROPCOPY-01` is the only target in the mock). Confirm.
8. **SLA — what's the published SLA?** `04-low-hanging-fruit.md` #8. **Action:** ask Charles for uptime, latency, support response, and the penalty / credit framework. Commercials but technically important.
9. **Method entitlements / role model.** `04-low-hanging-fruit.md` #9. **Impact:** Mint's user / role model needs to mirror IRESS's, including the "view destination" permission that gates `DestinationDetailGet`. **Action:** ask Charles for the IRESS user-roles catalogue. Decide how to mirror it in Mint's data model.
10. **Locale / dates / holidays.** `04-low-hanging-fruit.md` #10. **Action:** confirm: dates ISO-8601, timezone SAST, public holidays server-side (JSE 2026 calendar already in `lib/sa-holidays.ts` — confirm we don't need to also send settlement-date hints).
11. **Funeral cover — system of record?** D.7. **Action:** business decision. Is the funeral-cover product a separate admin system with IRESS used only for the investment float? Or is it unit-linked and tracked in IPS? This is the biggest open scope question.
12. **Business / Sales — in scope?** D.5. **Action:** business decision. Does the multi-persona vision include KYC / FICA / CRM in Mint, or are those separate products? If they're separate, we don't need the WebAdmin / IOS+ Admin "create" methods in v3.x.
13. **Settlement / clearing (STRATE).** D.6. **Action:** business decision. The V4 surface doesn't cover settlement. We can either build or buy a STRATE bridge, or accept that downstream settlement is out of scope for Mint and lives in the custodian / back-office system.
14. **Authentication & IdP.** PLANNING §8 plans for Clerk / Auth0. **Action:** confirm the IdP choice and that the Mint "user" maps 1:1 to an IRESS Iress session. The doc implies one Iress session per OEMS node / per user login (`04-sessions/01-iress-sessions.md`); the `ApplicationID` becomes the linking key.
15. **The `wsdl-stub` mode.** `lib/iress/index.ts:9` defines `IressMode = "mock" | "live" | "wsdl-stub"` but only "mock" is implemented. The doc on `01-foundations/04-getting-started.md` describes the WSDL generation step. **Action:** decide if/when we build the `wsdl-stub` mode (CI type-checking against a saved WSDL is the obvious use case — `09-compatibility/01-wsdl-compatibility.md` makes the case).

---

## Appendix — every IRESS V4 doc file I read

| Doc file | One-line summary |
|---|---|
| `README.md` | Modular re-organisation of the V4 Programmer's Guide; navigation + scope. |
| `INDEX.md` | Master table of contents for the modular set. |
| `01-foundations/01-overview.md` | SOAP 1.1 / Document/Literal; service model (Iress, IOS+, IPS, FIX+); permission gate; two-layer session. |
| `01-foundations/02-architecture.md` | Web-server / Phoenix IDS architecture; long-polling update loop; stateless horizontal scale; gzip. |
| `01-foundations/03-endpoints.md` | Region matrix; SA production + CT test endpoints; WSDL method filter; recommended Mint WSDL cuts. |
| `01-foundations/04-getting-started.md` | End-to-end first-call recipe; permission pre-flight; sample SOAP request/response; smoke test checklist. |
| `02-protocol/01-requests.md` | Request envelope shape; Iress vs Service request distinction; header fields. |
| `02-protocol/02-responses.md` | Response envelope; StatusCode 1/2/3; per-row errors; SOAP fault shape; `IRESSFaultDetail`. |
| `02-protocol/03-sync-vs-async.md` | `WaitForResponse`; when to use sync vs async; anti-patterns. |
| `03-paging-and-updates/01-paging-overview.md` | Server-side paging; pseudo-code loop; guidance per use case. |
| `03-paging-and-updates/02-paging-with-bookmarks.md` | `PagingBookmark`; resume pattern; durability considerations. |
| `03-paging-and-updates/03-updates.md` | Long-polling pattern; `*Updates` method naming; queue limit; watch-then-snapshot pattern. |
| `03-paging-and-updates/04-paging-in-ips.md` | Legacy IPS methods (`IPSAccountGetAll1`, `IPSPositionGetAll1`); parameter-level cursor; the `PageCursor` interface. |
| `04-sessions/01-iress-sessions.md` | `IRESSSessionStart` / `IRESSSessionEnd`; license accounting; 50 active requests / session; 20 000 sessions server-wide; `ApplicationID` discipline. |
| `04-sessions/02-service-sessions.md` | `ServiceSessionStart` / `ServiceSessionEnd`; lifetime tied to parent; server-side die cases; multi-service pattern. |
| `04-sessions/03-user-scenarios.md` | License exhaustion 25008; `<CurrentSessions>` list; `SessionNumberToKick`; force-close `-1`; recommended behaviour. |
| `04-sessions/04-error-management-and-recovery.md` | Error code → action map; 5 recovery recipes; don't-reuse-keys rule; recommended state machine. |
| `04-sessions/05-session-expiration.md` | 2h idle / 24h max / 01:00 group expiry; `SessionTimeout` override; can't extend; the 01:00 SAST gotcha. |
| `05-services/market-data/01-iress-session-start.md` | Detailed `IRESSSessionStart`; parameters; license-exhaustion fault; wrapper sketch. |
| `05-services/market-data/02-time-series-get-2.md` | `TimeSeriesGet2`; common call patterns (EOD, ZARONIA, JIBAR, NSS, SARB, StatsSA, G10). |
| `05-services/market-data/03-pricing-quote-get.md` | `PricingQuoteGet`; L1 snapshot; updates pattern; market-state handling. |
| `05-services/iosplus/01-order-create-amend-cancel.md` | `OrderCreate3` / `OrderAmend2` / `OrderDelete`; order states; bulk calls; `OrderTag` idempotency. |
| `05-services/iosplus/02-order-pad.md` | `OrderPadGetByAccount` + Updates; `OrderFilter` enum; two-step recovery. |
| `05-services/iosplus/03-bookings.md` | `BookingGetByOrganisation2`; `<MiscFees>`; fee formulas; SWIFT qualifiers; `FeeType` enum. |
| `05-services/iosplus/04-etcs.md` | `ETCGetByOrganisation`; pre-trade cost. |
| `05-services/iosplus/05-misc-fees-reference.md` | Single-page `FeeType` / `FeeBasis` / `Properties` / `SWIFT` quick reference. |
| `05-services/iosplus/contingent-orders/01-destinations-and-identification.md` | CO destinations; `DestinationGet` + `DestinationDetailGet`; `DestinationSubTypeNumber` 30-49. |
| `05-services/iosplus/contingent-orders/02-attributes.md` | IS013-IS041 attribute catalogue; per-CO attribute sets. |
| `05-services/iosplus/contingent-orders/03-fixed-co.md` | FIXED CO semantics; `IS020`/`IS021`/`IS022`; example. |
| `05-services/iosplus/contingent-orders/04-trailing-co.md` | TRAILING CO semantics; `IS025`/`IS026`/`IS027`; example. |
| `05-services/iosplus/contingent-orders/05-oco.md` | OCO; pair linkage; light on details. |
| `05-services/iosplus/contingent-orders/06-ifdone.md` | IFDONE; parent-child; example. |
| `05-services/iosplus/contingent-orders/07-take-profit.md` | Composite pattern: AUTODESK + IFDONE + FIXED CO. |
| `05-services/iosplus/algo-orders/01-destinations.md` | Algo destinations; `DestinationPropertiesMask & 256`; discovery. |
| `05-services/iosplus/algo-orders/02-attributes.md` | External algo properties; `7000`/`9006`; per-vendor discoverability. |
| `05-services/iosplus/order-attributes/01-is-attributes.md` | Single-page IS013-IS041 reference. |
| `05-services/iosplus/order-attributes/02-attribute-get-by-user.md` | `AttributeGetByUser`; category numbers (5 algo, 8 IS). |
| `05-services/fixplus/01-fixplus.md` | `TargetIDGet` / `TargetIDStatusGet`; control/status only; FIX bytes over separate TCP. |
| `05-services/ips/01-transactions.md` | `IPSTransactionGetByAccount5`; EOD recon; corporate actions. |
| `05-services/ips/uploads/01-uploads-overview.md` | Five-step workflow: Create → DataSet → Run → Summary → Error. |
| `05-services/ips/uploads/02-ips-upload-create-1.md` | `IPSUploadCreate1`; `UploadType` strings. |
| `05-services/ips/uploads/03-ips-upload-data-set-1.md` | `IPSUploadDataSet1`; row shapes. |
| `05-services/ips/uploads/04-ips-upload-run-1.md` | `IPSUploadRun1`; longer timeout. |
| `05-services/ips/uploads/05-ips-upload-summary-get-2.md` | `IPSUploadSummaryGet2`; counts. |
| `05-services/ips/uploads/06-ips-upload-error-get-1.md` | `IPSUploadErrorGet1`; per-row errors; paged. |
| `06-errors/01-session-error-codes.md` | 25001-25035 + 666; per-code meaning + action. |
| `06-errors/02-application-error-management.md` | System / data / client-side errors; match on number not string. |
| `06-errors/03-faq.md` | 10 000 queue limit; 50 active requests; gzip. |
| `06-errors/04-support-queries.md` | What to send IRESS in a ticket; sanitise before sending. |
| `07-recovery/01-application-recovery.md` | Get / Set recovery styles; per-category guidance; decision flowchart. |
| `07-recovery/02-iress-webadmin-recovery.md` | `AmendIfExists=true` for WebAdmin "set" methods. |
| `07-recovery/03-iosplus-admin-recovery.md` | Same pattern for IOS+ Admin. |
| `07-recovery/04-iosplus-order-retrieval-recovery.md` | Two-step recon: `OrderPadGet*` (active) + `OrderSearchGetByUser` (inactive). |
| `07-recovery/05-iosplus-order-creation-recovery.md` | `OrderNoGetByOrderTag` for `OrderCreate3` recovery; the sequence diagram. |
| `08-performance/01-client-side-optimisations.md` | `PageSize`, bulking, gzip, network, cut-down WSDL, HTTP keep-alive, in-process cache. |
| `08-performance/02-server-side-limits.md` | Defaults + per-limit behaviour. |
| `09-compatibility/01-wsdl-compatibility.md` | WSDL versioning; method-list changes; `OrderCreate` → `OrderCreate2` → `OrderCreate3` lineage. |
| `10-reference/quick-reference/00-master.md` | Master one-page method index per service. |
| `10-reference/quick-reference/01-iress-pro.md` | Iress Pro quick ref. |
| `10-reference/quick-reference/02-iosplus.md` | IOS+ quick ref. |
| `10-reference/quick-reference/03-contingent-orders.md` | CO quick ref: discovery + per-CO attribute sets. |
| `10-reference/quick-reference/04-fixplus.md` | FIX+ quick ref. |
| `10-reference/quick-reference/05-ips.md` | IPS quick ref. |
| `11-mint-oems/01-requirements-traceability.md` | **Per-Email-brief-requirement trace to V4 methods.** The "What you don't get from V4" + "Gaps to flag" sections are the doc's most actionable content. |
| `11-mint-oems/02-sa-endpoints-and-envs.md` | SA endpoint / environment strategy; `ApplicationID` per env; WSDL versioning. |
| `11-mint-oems/03-call-graph-jse-order.md` | End-to-end JSE order call graph with recovery overlay. The single best doc to use as a runbook. |
| `11-mint-oems/04-low-hanging-fruit.md` | "Things easy to add" + "Things to ask Charles" — directly addresses the Email's last paragraph. |
| `12-schemas/01-common-header.md` | XSD sketch of the common `RequestHeader`. |
| `12-schemas/02-service-headers.md` | Per-service header token matrix. |
| `12-schemas/03-error-schema.md` | SOAP fault shape + `IRESSFaultDetail` field table + per-row data error. |
| `12-schemas/04-misc-fees-enum.md` | TypeScript `MiscFeeType` / `MiscFeeBasis` / `MiscFeePercentageOf` enums + SWIFT default map. |

---

*This document is a read-only research deliverable. No code was changed. The IRESS V4 doc set, the Email brief, and the Wealth Navigator codebase were the only inputs. Counts: 41 V4 method verbs catalogued · 17 on the adapter surface · 18 gap methods on the V4 list · 18 recommendations (5 P0 / 6 P1 / 7 P2) · 15 open questions. Surprises: the doc-confirmed `OrderCreate3` is current, no deprecation in our current surface; the FIX+ surface is **status only**, not the FIX bytes themselves; the "what you don't get from V4" list (settlement, pre-trade compliance, true L2) is explicit and matches the product brief's open questions.*
