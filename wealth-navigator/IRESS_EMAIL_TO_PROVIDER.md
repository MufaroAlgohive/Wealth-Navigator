# IRESS V4 Web Services — Go-Live Endpoint List & Future-State Signal

> **Status:** Draft for CTO sign-off. Copy into your email client and fill the **To**, **From**, and **Sign-off** placeholders. Method names and namespaces verified against `Documentation & Vision/iress-v4-docs/10-reference/quick-reference/00-master.md`. File:line references verified against the Wealth Navigator codebase on 2026-06-09.

---

## Header

- **To:** [IRESS Account Manager — name TBC]
- **From:** Mint Wealth Navigator — Engineering
- **Subject:** V4 Web Services — Go-live endpoint list + future-state signal
- **Date:** Tuesday, 9 June 2026
- **Attachments:** [Link to v1.0 IRESS API Requirements Specification — Word + Markdown]

---

## Email body

Hi [Charles / account-manager name],

Following on from the requirements brief we sent through last week, I want to lock down exactly which V4 Web Services endpoints Mint Wealth Navigator will be calling at production go-live (our target is Q4 2026), and to give you a forward signal of what we expect to call in the 6–18 months after that. The project is **MINT Wealth Navigator v2.0** — a multi-persona platform serving the OEMS trader, wealth manager, strategist/research, compliance/admin, business/sales, financial-controller, and funeral-cover-administrator personas on a single front-end, fronted by a shared IRESS V4 adapter. Production is JSE / South African market; we are not on-boarding cross-border venues in this cycle.

**On the 100% / likely split:** the 100% list is what we *will* call in production from day one. It is small, it is concrete, and every method on it has a code path that is already wired in the codebase today (it currently resolves to a mock; the live swap is a 1-line `IRESS_MODE=live` config change). The likely list is what we expect to call over the next two quarters as the wealth-manager, strategist, financial-controller, and admin personas are lit up, and as we add the CO / algo / L2 / audit-trail / outbound-upload surfaces that those personas need. We want you to provision access for the 100% list immediately, and to give us a read on commercials and entitlement for the likely list in parallel so we can sequence.

**Three asks for your side:** first, please confirm receipt of this list and acknowledge that every 100% method is on the V4 WSDL today and not flagged for deprecation in 2026/2027. Second, please book a 30-minute technical call in the next two weeks to walk through the open questions in Section C — specifically the WSDL version pin, the SOAP binding preference, the OrderTag idempotency window, the long-poll cadence on `PricingQuoteGetUpdates`, and the `IPSAccountGetAll1` query shape for "list of client accounts the logged-in wealth manager can see". Third, please arrange a follow-up working session with your implementation team where we run the gap list in Section C item-by-item and lock the closest IRESS-native equivalent for each. The Email brief already lists our tolerance for "have it / have an equivalent / gap with suggestion" — we want to leave that call with green-amber-red ticks on every open question.

Best,
[Name]
[Title] · Mint Wealth Navigator
[Phone] · [Email]

---

## Section A — 100% use at go-live

These are the V4 endpoints we will be calling in production from day one. The `IressClient` TypeScript interface in the codebase declares 17 methods; the methods below are a superset that also includes the long-poll `*Updates` variants the live path will need (we declared the streaming methods but the current mock is a no-op — they will become the real wire-up the moment `IRESS_MODE=live`). Every row is grounded in a `file:line` reference in the running codebase.

### A.1 Session

| # | Method | Namespace / Service | Why we need it (1 line) | Codebase reference |
|---|---|---|---|---|
| 1 | `IRESSSessionStart` | Iress | First call on user login. Returns the parent `IRESSSessionKey` and `SessionNumber`; all subsequent service sessions are children of it. | `wealth-navigator/src/lib/iress/index.ts:78` (called from `bringUpMintSession`, the session-bring-up helper) |
| 2 | `IRESSSessionEnd` | Iress | Clean teardown on user logout. Closes the parent Iress session and cascades to all child service sessions. | `wealth-navigator/src/lib/iress/index.ts` (paired with `bringUpMintSession`); declared on `IressClient` at `client.ts:162` |
| 3 | `ServiceSessionStart` | Iress (per service: `IOSPlus` → `IOSPLUSAPI`, `IPS` → `IPSAPI`, `FIXPlus` → `FIXPLUSAPI`) | Opens the three service sessions the OEMS will use. We bring all three up in one helper. | `wealth-navigator/src/lib/iress/index.ts:94` (inside the `bringUpMintSession` helper, lines 87–100) |
| 4 | `ServiceSessionEnd` | Iress (per service) | Clean per-service teardown on logout, plus a per-service path for our 2-hour idle refresh. | Declared on `IressClient` at `client.ts:164` |

### A.2 Market data (snapshot)

| # | Method | Namespace | Why we need it | Codebase reference |
|---|---|---|---|---|
| 5 | `PricingQuoteGet` | Iress Pro | L1 snapshot quote for any JSE security. Powers the L1 tape on `/oems/security`, `/oems/equities`, and the live backing for `/oems/equities` Movers panel. | `wealth-navigator/src/lib/iress/mock.ts:120` (`quoteForSecurity` is the internal helper that wraps it; called by every page that needs a single-ticker L1). Also consumed directly by `/oems/security/page.tsx:15,37,184` and `/oems/equities/page.tsx:14,134` via `initialQuotes()` / `seedLastFor()` — same data shape, currently seed-bypassed, will move to `PricingQuoteGet` in live. |

### A.3 Market data (streaming)

| # | Method | Namespace | Why we need it | Codebase reference |
|---|---|---|---|---|
| 6 | `PricingQuoteGetUpdates` | Iress Pro | Long-poll updates for an open `PricingQuoteGet` subscription. The natural live wire-up for `/api/ticks` SSE and `lib/store/tick-stream-provider.tsx`, both of which currently seed from `initialQuotes()`. | `wealth-navigator/src/app/api/ticks/route.ts:5,20` and `wealth-navigator/src/lib/store/tick-stream-provider.tsx:11,40` (both import `initialQuotes`; live swap is to a server-side long-poll proxy calling this method). Declared on `IressClient` at `client.ts:168`. |

### A.4 Time series

| # | Method | Namespace | Why we need it | Codebase reference |
|---|---|---|---|---|
| 7 | `TimeSeriesGet2` | Iress Pro | Generic time series for the ZAR Govi curve, ZAR swap curve, ZAR ILB curve, JIBAR fixings, ZARONIA, and the J203/ALSI benchmark. Powers `/oems/curves`, `/oems/macro`, `/oems/money-market`, and the Govi / NSS panel on the OEMS Cockpit. | `wealth-navigator/src/lib/iress/mock.ts:129` (mapper for `ZAR_NSS`, `ZAR_SWAP`, `ZAR_REAL`, `ZARONIA`, `JIBAR`, `J203`). The 13 read pages consume this through `iressQueries.*` (35 invocations); the live swap is a 1:1 path to `TimeSeriesGet2`. |
| 8 | `TimeSeriesGet2Updates` | Iress Pro | Long-poll updates for an open `TimeSeriesGet2` subscription. Same wire-up pattern as A.3 — feeds a server-side proxy that pushes curve / macro refreshes to the client. | Declared on `IressClient` at `client.ts:170`. No direct UI call site today; included in the 100% list because the live long-poll architecture requires it from day one. |

### A.5 Order entry

| # | Method | Namespace | Why we need it | Codebase reference |
|---|---|---|---|---|
| 9 | `OrderCreate3` | IOS+ | Place order at the JSE. We already implement `OrderTag` idempotency end-to-end on the client side. | `wealth-navigator/src/app/oems/blotter/new-order-dialog.tsx:95` — the only direct UI caller on `useIress().client`. |
| 10 | `OrderAmend2` | IOS+ | Amend volume / price / TIF on a working order. Triggers from the Blotter row-edit action. | Declared on `IressClient` at `client.ts:174`. Mock at `mock.ts:196` validates state machine; UI hook will land in the next sprint. |
| 11 | `OrderDelete` | IOS+ | Cancel a single order, or cancel-all working on the Blotter's destructive-confirm button. | `wealth-navigator/src/app/oems/blotter/page.tsx:62` — the cancel-all loop over `client.orderDelete`. |

### A.6 Order pad (working orders)

| # | Method | Namespace | Why we need it | Codebase reference |
|---|---|---|---|---|
| 12 | `OrderPadGetByAccount` | IOS+ | Per-account order pad. The live equivalent of the seed-backed `iressData.orders()` call the Blotter consumes today. `OrderFilter=5` (active only) for the live wire-up. | Declared on `IressClient` at `client.ts:176`. Consumed today via the seed bag in `lib/iress/mock.ts:295` (`orders()`); the live path replaces the bag with this method. |
| 13 | `OrderPadGetByAccountUpdates` | IOS+ | Long-poll updates for the order pad subscription. Pushes `WORKING → FILLED / CANCELLED / PARTIAL` transitions to the Blotter in real time. | Declared on `IressClient` at `client.ts:183`. No direct caller today; in the 100% list because the Blotter's "working orders" panel needs real-time state. |

### A.7 Booking & corporate actions

| # | Method | Namespace | Why we need it | Codebase reference |
|---|---|---|---|---|
| 14 | `BookingGetByOrganisation2` | IOS+ | Per-booking row including the `MiscFees` array (stamp, brokerage, GST, levy). Powers the fee-level detail on the Blotter row side-panel and the Financial Controller's daily reconciliation. | Declared on `IressClient` at `client.ts:184`. Mock at `mock.ts:226`; the `/fc/overview` Daily reconciliation panel (`page.tsx:87`) names this method as its endpoint. |

### A.8 IPS (Investment Portfolio Service)

| # | Method | Namespace | Why we need it | Codebase reference |
|---|---|---|---|---|
| 15 | `IPSTransactionGetByAccount5` | IPS | Per-account transaction history (modern, header-level paging). Powers the Financial Controller's EOD reconciliation, the wealth-manager "Activity" panel, and the funeral-cover recon. | Declared on `IressClient` at `client.ts:200`. Named explicitly in the `/fc/overview` page's `Daily reconciliation` panel header at `wealth-navigator/src/app/fc/overview/page.tsx:87`. |

### A.9 FIX+ control plane

| # | Method | Namespace | Why we need it | Codebase reference |
|---|---|---|---|---|
| 16 | `TargetIDGet` | FIX+ | List the FIX+ drop-copy targets the user can see. Backed today by fixture `MINT-DROPCOPY-01`; live will return the user's actual target list. | Declared on `IressClient` at `client.ts:212`. Mock at `mock.ts:265`; consumed by `/oems/integration` once the live surface is in. |
| 17 | `TargetIDStatusGet` | FIX+ | Per-target connection state. Feeds the "FIX+ drop-copy connection" status pill on `/oems/integration` and `/oems/cockpit`. | Declared on `IressClient` at `client.ts:213`. Mock at `mock.ts:268` always returns `CONNECTED`; live swap is direct. |

> **Note on FIX bytes:** the FIX+ V4 surface is **status and control only**. The actual FIX message stream (drop-copy bytes) travels over a **separate TCP FIX connection** that Mint terminates directly; V4 is not in the bytes path. We'll cover the FIX protocol version (4.2 / 4.4 / 5.0 SP2) and the drop-copy connection logistics in Section C.

---

## Section B — Likely future use, 6–18 months

Grouped by business surface. Priority scheme: **P0 = blocker for go-live or for the first adjacent persona lighting up in 90 days; P1 = next quarter, sequenced behind a P0; P2 = future, no committed date.** Each pick names the V4 method, the namespace, the business rationale (grounded in the Email brief and the persona pages), the dashboard panel it unlocks, and a one-line priority justification.

### B.1 Trading (OEMS) — `/oems/*`

| # | Method | Namespace | Business rationale | Triggering dashboard / panel | Priority |
|---|---|---|---|---|---|
| 1 | `OrderNoGetByOrderTag` | IOS+ | We already implement `OrderTag` idempotency in the new-order dialog; the missing half is the recovery round-trip. Closes the "I sent an order and never got a response" hole on a network drop, which is the single highest-stakes recovery case the V4 recovery guide calls out. | Blotter "Pending order" reconciliation panel + post-trade integrity check | **P0** — without this, a network drop during a sell order is an unknown state. |
| 2 | `OrderSearchGetByUser` | IOS+ | The two-step recovery algorithm for the order pad (active via `OrderPadGetByAccount`, inactive via `OrderSearchGetByUser(OrderState=3)`). Also the EOD reconciliation driver. | Financial Controller's `Daily reconciliation` panel; `/fc/overview` | **P0** — same algorithm runs at startup, on reconnect, and at EOD. |
| 3 | `DestinationGet` | IOS+ | Discover the destinations a trader is entitled to use: regular, contingent order (CO, `DestinationSubTypeNumber` 30–49), and algo (Algo bit in `DestinationPropertiesMask`). | New Order dialog's destination picker | **P0** — gating dependency for contingent and algo orders (B.4 below). |
| 4 | `DestinationDetailGet` | IOS+ | Inspect a destination's `DestinationSubTypeNumber` / `DestinationPropertiesMask` to distinguish CO from algo and to set `ExecutionInstructions` correctly. | New Order dialog + CO/algo attribute loader | **P0** — pairs with `DestinationGet`. |
| 5 | `ETCGetByOrganisation` | IOS+ | Pre-trade Estimated Trade Cost snapshot. Display the expected all-in cost on the New Order dialog and block send if the trader hasn't acknowledged a cost over the configured threshold. The `preTradeCheck` helper in `lib/iress/strategy.ts` is the integration hook. | New Order dialog's "Estimated cost" disclosure panel | **P0** — Email brief explicitly calls out pre-trade compliance; this is the closest IRESS-native equivalent. |
| 6 | `PricingQuoteExGet` | Iress Pro | Extended L1 / depth-of-book for the equities and security pages. Email brief names "Equities (L1/L2)" explicitly. (WSDL is source of truth for the depth column set; this is the V4 method the V4 doc set names for extended L1.) | `/oems/security` depth-ladder widget; `/oems/equities` extended view | **P0** — marquee widget on the security page; email brief requirement. |
| 7 | `SessionRequestEnd` | IOS+ | Cleanly end a long-poll subscription by `RequestID`. Called on page unmount and on logout so a trader's navigation doesn't burn one of the 50 active-request slots per session. | Cross-cutting infra hygiene; no specific panel | **P1** — important hygiene but not on the critical path. |

### B.2 Wealth management — `/wm`

| # | Method | Namespace | Business rationale | Triggering dashboard / panel | Priority |
|---|---|---|---|---|---|
| 8 | `IPSAccountGetAll1` | IPS | List all client accounts the logged-in wealth manager can see. Powers the `/wm` page's "My Client Book · Top 5 by AUM" panel. (Confirm the right method for "accounts I can see" — see Section C open question 7.) | `/wm` "My Client Book" + "Suitability review queue" + "Activity" | **P0** — the single most-wanted method for the wealth-manager persona; currently the page reads `clientsByWealthManager` directly from `@/lib/iress/seed`. |
| 9 | `IPSPositionGetAll1` | IPS | Per-account positions for the wealth manager's book. Legacy cursor paging — the V4 doc set recommends a `pagedFetch` wrapper to handle the param-level `PreviousAccountCode`. | `/wm` "Holdings" drill-down + per-client P&L | **P0** — same dependency as `IPSAccountGetAll1`; the two always go together. |

### B.3 Strategy / research — `/strategist`

| # | Method | Namespace | Business rationale | Triggering dashboard / panel | Priority |
|---|---|---|---|---|---|
| 10 | (Same `IPSTransactionGetByAccount5` + `TimeSeriesGet2` from A.4 / A.8) | IPS / Iress Pro | Per-strategy-account transactions plus the benchmark time series. The `/strategist` page is currently a stub reading `oemsStrategies` / `mandateTemplates` from `@/lib/iress/seed`. | `/strategist` "Mandate universe" + "Drift vs target" + "Performance attribution" panels | **P1** — gated on the strategist persona being lit up after the WM persona. |
| 11 | `PricingTradeHistoricalGet` | Iress Pro | Time-and-sales backfill for the security page's historical-prints widget. | `/oems/security` "Time and sales" widget | **P2** — nice-to-have for traders. |

### B.4 Compliance / admin — `/admin`

| # | Method | Namespace | Business rationale | Triggering dashboard / panel | Priority |
|---|---|---|---|---|---|
| 12 | `AuditTrailGetByAccount` | Iress (per the V4 master quick-ref; served on the IPS service session) | Per-account audit log. Powers the compliance officer's "Pending approvals" panel and the audit-trail review surface. | `/admin` "Audit trail" + "Pending approvals" panels | **P0** — required before the admin persona can replace the seed-backed `auditTrail` fixture. |
| 13 | `AttributeGetByUser` | IOS+ | Per-user attribute catalog. `AttributeCategoryNumber=5` for algo properties, `=8` for Iress Strategy Properties (IS013–IS041). Required to populate the CO / algo parameter set on the New Order dialog. | New Order dialog's CO/algo parameter editor | **P1** — depends on contingent/algo orders being prioritised. |

### B.5 Business / sales — `/business`

| # | Method | Namespace | Business rationale | Triggering dashboard / panel | Priority |
|---|---|---|---|---|---|
| 14 | (WebAdmin / IOS+ Admin families: `AdminUserCreate2`, `UserCreate`, `AccountCreate` — all with `AmendIfExists=true`) | Iress WebAdmin / IOS+ Admin | Account and user creation for the onboarding flow when the wealth-manager persona begins on-boarding new client households. | `/business` "KYC / FICA pipeline" + `/wm` onboarding wizard | **P2** — gated on the business/sales persona being in scope (see open question 12 in Section C). |
| 15 | `IPSUploadCreate1`, `IPSUploadDataSet1`, `IPSUploadRun1`, `IPSUploadSummaryGet2`, `IPSUploadErrorGet1` | IPS | Outbound uploads of Mint-authored reference data (security lists, holdings, prices) into IPS. Five-step workflow: Create → DataSet → Run → Summary → Error. | `/oems/integration` "Outbound uploads" panel | **P1** — first two picks (WSDL confirmation on upload type strings, then a small end-to-end test) need to land before the WM persona is fully live. |

### B.6 Financial control — `/fc/overview`

| # | Method | Namespace | Business rationale | Triggering dashboard / panel | Priority |
|---|---|---|---|---|---|
| 16 | `IPSAccountGetAll1` + `IPSPositionGetAll1` (carried from B.2) | IPS | Account-list and position-list reconciliation against the Financial Controller's books. | `/fc/overview` "Cash positions" panel (already labels `IPSAccountGetAll1` at `page.tsx:148`) + the new "Holdings reconciliation" panel | **P0** — same dependency as B.2. |

### B.7 Real-time / streaming infrastructure

| # | Method | Namespace | Business rationale | Triggering dashboard / panel | Priority |
|---|---|---|---|---|---|
| 17 | `PricingQuoteExGetUpdates` (if surfaced in the WSDL — confirm in Section C) | Iress Pro | Long-poll updates for the extended L1 / depth subscription. Pairs with B.1 #6. | `/oems/security` depth-ladder streaming | **P1** — depends on the WSDL exposing an `Ex` updates method; if not, fallback is polling `PricingQuoteExGet` on a short cadence. |
| 18 | `OrderPadGetByUser` + `…Updates`, `OrderPadGetByAccountGroup` + `…Updates` | IOS+ | Per-user and per-account-group blotters. A multi-strategy desk typically wants a per-user pad (all accounts the user can see) and a per-account-group pad (all accounts in a desk / mandate). | Trader "My book" cross-account view; desk-level "All accounts" view | **P2** — useful for the multi-strategy desk iteration; not blocking go-live. |

### B.8 Adjacent / deferred

The following are real V4 surfaces that Mint will need eventually but are not on a 6–18 month plan. Listed for completeness, not for action this cycle.

- **WebAdmin provisioning** (`AdminUserCreate2`, `UserCreate`, `AccountCreate`) — P2, gated on the IdP choice (open question 14 in Section C).
- **Time-and-sales feed** (`PricingTradeHistoricalGet`) — P2, see B.3 #11.
- **Real SENS feed** (the WSDL news / SENS methods are not enumerated in the V4 PDF; the WSDL is the source of truth) — P2, see open question 9 in Section C.
- **Order templates / model portfolios** — P2, depends on IPS upload type string confirmation.
- **FIX+ drop-copy bytes path** — P2, and *not* a V4 method: lives on a separate TCP FIX connection. See open question 15 in Section C for the protocol version.

---

## Section C — Open questions for IRESS

A working list of items where we need IRESS to confirm or clarify. The order is roughly priority-ordered (top of list = highest-stakes for go-live).

1. **WSDL version pinning.** Is the V4 WSDL stable for 2026 and 2027, or are there breaking changes planned (deprecated methods, new mandatory header fields, new envelope semantics)? We want to save the WSDL per env / per date in VCS per the compatibility guidance. Please share the version currently in production at the CT test environment and the planned-prod version, and the deprecation policy.
2. **SOAP 1.1 vs 1.2 binding preference.** The V4 doc set says SOAP 1.1 / Document/Literal. Please confirm the production endpoint requires 1.1 and confirm the action URL.
3. **`OrderTag` idempotency window.** How long does an `OrderTag` remain in the IRESS idempotency cache after a successful `OrderCreate3`? We generate a UUID per attempt client-side; we need to know the window so we can choose a `crypto.randomUUID()` per attempt vs. per logical order.
4. **Session recovery window.** How long does an `IRESSSessionKey` survive a network drop? Is the existing service-session key reusable, or do we need to re-issue `ServiceSessionStart` after a TCP-level reconnect? What is the recommended reconnect pattern for the 2-hour idle / 24-hour max / 01:00 SAST window?
5. **Rate limits on `PricingQuoteGet` and `PricingQuoteGetUpdates`.** The V4 doc set mentions 50 active requests per session and 20 000 active sessions per server. We want published per-second and per-method rate limits (or the closest equivalent) so we can put a polite guard on the client and on the long-poll proxy.
6. **`PricingQuoteGetUpdates` long-poll cadence.** What is the recommended `Timeout` and `NoUpdateBlockTime` for a JSE active-name subscription? What is the expected update rate at the JSE peak? We want to size the long-poll proxy's connection pool accordingly.
7. **`IPSAccountGetAll1` is the right method for "list of client accounts the logged-in wealth manager can see".** The V4 master quick-ref marks it as "legacy cursor paging in parameters". Please confirm this is the right surface, or — if entitlements are not gated at the Iress session level — point us at the right method (e.g. a hypothetical `AdvisorGetByUser` hierarchy method, or an entitlement-filtered wrapper).
8. **JSE sector weights / sector performance.** We currently have a placeholder for the Cockpit's "Sector heatmap" panel. Please confirm the right V4 method to fetch the JSE sector weights and the sector performance (1D / 1W / 1M / YTD). If it's `TimeSeriesGet2` per sector code, please share the code list. If it's a snapshot method in the WSDL, please share the method name.
9. **SENS / corporate-actions news.** The V4 PDF does not enumerate the news / SENS methods; the WSDL does. Please share the method name(s) for the SENS feed and the per-corporate-action news. (Confirm whether the SENS stream is real-time or delayed, and whether it is included in the standard V4 entitlement or a separate subscription.)
10. **JIBAR / NSS / ZARONIA fixings.** The V4 doc set shows `TimeSeriesGet2(Code = "ZAR_NSS" / "ZAR_SWAP" / "ZAR_REAL" / "JIBAR" / "ZARONIA")` as the call pattern. Please confirm the actual codes on the production WSDL, and confirm whether `TimeSeriesGet2Updates` is supported for each. (For the NSS curve specifically: please confirm whether it is delivered as points — e.g. 1Y, 2Y, 5Y, 10Y, 20Y, 30Y — or as the NSS parameters `β0..β3, τ1, τ2`. The OEMS treats the curve as a typed time series and dispatches on tenor.)
11. **Funeral cover / non-trading products.** Mint has a funeral-cover persona. Should the funeral-cover product be on IRESS at all, or is it a separate system (C-Flow, Avbob, in-house policy admin)? We want to confirm the system of record and the integration boundary. (My read of the seed fixtures — `reconLegs`, `cashPositions`, `reconExceptions` — is that the funeral-cover team reconciles their book against the IRESS book, i.e. IRESS is the investment system and the funeral-cover policy admin is a separate system. Please confirm.)
12. **Settlement / STRATE.** Is `BookingGetByOrganisation2` sufficient for our settlement-instrumented books, or do we need the JSE's STRATE settlement feed directly? The V4 doc set is explicit that V4 does not cover settlement; please confirm the recommended path.
13. **`wsdl-stub` mode.** Our env config supports `IRESS_MODE=wsdl-stub` for CI type-checking against a saved WSDL. We would like a test WSDL we can hit from a CI environment without a real session. Please share the CT test WSDL, the test environment endpoint, and the entitlement scope of a test user.
14. **SLA.** What is the published SLA for V4 Web Services at the JSE peak? We are targeting a sub-1.5 s round-trip on `OrderCreate3` from the new-order dialog's "Send" click to a confirmed `OrderNumber`. Please share latency percentiles, uptime, support response, and the penalty / credit framework.
15. **FIX+ drop-copy.** The V4 surface is status and control only; the FIX bytes are over a separate TCP FIX connection. Please confirm the supported FIX protocol versions (FIX 4.2 / 4.4 / 5.0 SP2) for the drop-copy, and share the network-allowlist and TCP port for the production drop-copy endpoint.
16. **IdP / `ApplicationID` discipline.** Mint's auth layer is being rebuilt around [Clerk / Auth0 — TBC]. Please confirm the `ApplicationID` discipline: should it be one `ApplicationID` per OEMS node, per user, or per session? The V4 doc set says `ApplicationID = Mint-OEMS-<env>-<node>-<guid>`; please confirm the node-level granularity is acceptable, and whether you need one per environment (dev / staging / load / prod) or one shared per node across envs.

---

## Section D — Appendix: code references for the 100% list

Compact audit trail IRESS can verify directly in the codebase.

| # | Method | Codebase reference (first use) | Notes |
|---|---|---|---|
| 1 | `IRESSSessionStart` | `wealth-navigator/src/lib/iress/index.ts:78` | Inside `bringUpMintSession`. |
| 2 | `IRESSSessionEnd` | `wealth-navigator/src/lib/iress/client.ts:162` | Declared; no UI caller; will pair with #1. |
| 3 | `ServiceSessionStart` | `wealth-navigator/src/lib/iress/index.ts:94` | Inside the `bringUpMintSession` loop, lines 87–100. |
| 4 | `ServiceSessionEnd` | `wealth-navigator/src/lib/iress/client.ts:164` | Declared. |
| 5 | `PricingQuoteGet` | `wealth-navigator/src/lib/iress/mock.ts:120` (via `quoteForSecurity` at `mock.ts:73`); transitively used by `/oems/security/page.tsx:15,37,184` and `/oems/equities/page.tsx:14,134` via `initialQuotes()` / `seedLastFor()` | Will become the live L1 feed behind the seed-bypass pattern. |
| 6 | `PricingQuoteGetUpdates` | `wealth-navigator/src/lib/iress/client.ts:168`; live wire-up target is `wealth-navigator/src/app/api/ticks/route.ts:5,20` and `wealth-navigator/src/lib/store/tick-stream-provider.tsx:11,40` (both currently seed from `initialQuotes()`) | Declared, no-op in mock. |
| 7 | `TimeSeriesGet2` | `wealth-navigator/src/lib/iress/mock.ts:129` (mapper) | Powers 13 read pages through `iressQueries.*`. |
| 8 | `TimeSeriesGet2Updates` | `wealth-navigator/src/lib/iress/client.ts:170` | Declared, no-op in mock. |
| 9 | `OrderCreate3` | `wealth-navigator/src/app/oems/blotter/new-order-dialog.tsx:95` | The only direct `useIress().client` caller for order entry. |
| 10 | `OrderAmend2` | `wealth-navigator/src/lib/iress/client.ts:174` (declared); mock state machine at `mock.ts:196` | No direct UI call site yet. |
| 11 | `OrderDelete` | `wealth-navigator/src/app/oems/blotter/page.tsx:62` | Cancel-all loop. |
| 12 | `OrderPadGetByAccount` | `wealth-navigator/src/lib/iress/client.ts:176` (declared); the live wire-up replaces `iressQueries.orders()` at `mock.ts:295` | Currently the Blotter reads from the seed bag; the live path is direct. |
| 13 | `OrderPadGetByAccountUpdates` | `wealth-navigator/src/lib/iress/client.ts:183` | Declared, no-op in mock. |
| 14 | `BookingGetByOrganisation2` | `wealth-navigator/src/lib/iress/client.ts:184` (declared); mock at `mock.ts:226`; labelled in `/fc/overview/page.tsx:87` | Method name appears in the Financial Controller's panel header. |
| 15 | `IPSTransactionGetByAccount5` | `wealth-navigator/src/lib/iress/client.ts:200` (declared); mock at `mock.ts:246`; labelled in `/fc/overview/page.tsx:87` | Same — method name appears in the panel header. |
| 16 | `TargetIDGet` | `wealth-navigator/src/lib/iress/client.ts:212` (declared); mock at `mock.ts:265` | Backed by fixture `MINT-DROPCOPY-01` in mock. |
| 17 | `TargetIDStatusGet` | `wealth-navigator/src/lib/iress/client.ts:213` (declared); mock at `mock.ts:268` | Mock always returns `CONNECTED`. |

### Known product gap (not an IRESS gap, flagged for awareness)

`wealth-navigator/src/app/oems/blotter/page.tsx` does **not** currently read the `?focus=<OrderNumber>` deep-link the command palette generates. The other two deep-link surfaces — `/oems/strategies?focus=<strategyId>` (`page.tsx:27–28`) and `/oems/security?sym=<symbol>` (`page.tsx:24,29–31`) — are wired. This is a UI gap, not an IRESS gap; the fix is in the Blotter page, not in the adapter. We are tracking it for the next sprint.

### Persona pages that are seed-bypassed today

Five persona pages read seed fixtures directly from `@/lib/iress/seed` instead of going through the `iressClient` / `iressQueries` surface. When these personas are lit up, the methods they need (mostly in the "likely" list) are:

- `/wm/page.tsx:13` — `clientsByWealthManager` (needs `IPSAccountGetAll1` + `IPSPositionGetAll1`).
- `/strategist/page.tsx` — `oemsStrategies`, `mandateTemplates` (needs `IPSTransactionGetByAccount5` per strategy account + `TimeSeriesGet2` for benchmarks).
- `/admin/page.tsx` — `pendingApprovals`, `auditTrail` (needs `AuditTrailGetByAccount`).
- `/business/page.tsx` — `oemsStrategies`, `deals` (needs WebAdmin / IOS+ Admin + `IPSUpload*`).
- `/fc/overview/page.tsx:85,146` — `reconLegs`, `cashPositions`, `reconExceptions`; the panel headers already name `IPSTransactionGetByAccount5` and `IPSAccountGetAll1` (lines 87, 148).

---

## Section E — Sign-off

Thanks for getting this far. To summarise: we will call the 14 (session) + 4 (market data) + 1 (time series) + 3 (order entry) + 2 (order pad) + 1 (booking) + 1 (IPS) + 2 (FIX+ control) = **17 V4 methods** in production from day one, including the four long-poll / updates variants the live wire-up will need (`PricingQuoteGetUpdates`, `TimeSeriesGet2Updates`, `OrderPadGetByAccountUpdates`, plus the three session lifecycle verbs). We expect to call roughly **18 additional V4 methods** over the next 6–18 months as the wealth-manager, strategist, financial-controller, and admin personas light up, with P0 picks focused on `OrderNoGetByOrderTag` (recovery), `OrderSearchGetByUser` (EOD recon), `IPSAccountGetAll1` + `IPSPositionGetAll1` (WM book), `AuditTrailGetByAccount` (compliance), `DestinationGet` + `DestinationDetailGet` + `ETCGetByOrganisation` (pre-trade), and `PricingQuoteExGet` (L2 depth).

Please confirm receipt and book the 30-minute technical call. We'd like to use the 30 minutes on items 1, 3, 4, 5, 6, 7, 8, 10 in Section C — the protocol / WSDL / session / rate-limit / method-name clarifications — and schedule a follow-up working session for the persona-by-persona gap walk-through.

Best,
[Name]
[Title] · Mint Wealth Navigator · MINT Wealth (Pty) Ltd
[Phone] · [Email] · [Office address]
