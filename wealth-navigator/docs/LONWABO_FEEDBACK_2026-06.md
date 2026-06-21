# Lonwabo Damane — design feedback (call 2026-06-20)

Source: `Call with Lonwabo Damane.vtt`. Juan told Lonwabo the figures are placeholder/fake
("use fake data just so you can have the view"), so **every "fix the values" remark is backend
phase**, not design. Items below are the design/UX pass.

Legend: `[ ]` todo · `[~]` needs decision · `[D]` deferred (backend/data).

## A. Frontend changes — clear-cut (do these)

- [x] **Order Book — add `Strategy` column + `Date` column; default-sort by date.** ✓ 2026-06-20
- [x] **Order Book — Active vs Closed split; group by strategy with an expand/drill-down to the executed securities under each.** (Send buttons + CSV kept.) ✓ 2026-06-20
- [x] **Research Lab — sticky basket-weight summary bar.** ✓ 2026-06-20 (`BasketSummaryBar`; sticky forced via inline style — `glass-panel`'s position:relative was overriding the `sticky` utility)
- [x] **Research Lab — remove constituents one-by-one; live re-weight on add/remove; AND inline-edit an existing constituent's share count ("move this to 22 shares").** ✓ 2026-06-20 (`RemovableHoldingsTable` per-row remove + editable `ShareCell` → delta proposal → live recompute. Share-edit added in the sign-off audit — original extraction missed it.)
- [x] **Research Lab — Current vs Proposed side-by-side, real-time totals, charts under each.** ✓ 2026-06-20 (`BasketCompare` + delta strip)
- [x] **Research Lab — sector + weight pie charts; drop the duplicate block.** ✓ 2026-06-20 (`ResearchLabPies`; standalone "Sector exposure" block removed). DECIDED 2026-06-20: kept the 4 (sector + weight under each side) — it's the rebalance comparison view he asked for; the redundant standalone block is gone.
- [x] **Research Lab — separate "Fundamentals" tab, divided from current constituents.** ✓ 2026-06-20 (Composition | Fundamentals tabs; "Research candidates" divider)
- [x] **Research Lab — capitalise "MINT".** ✓ 2026-06-20 ("MINT Research Lab" badge)
- [x] **Research Lab — per-security research notes + buy/sell, wishlist, popup, tick.** ✓ 2026-06-20 (UI shell; `security_research` DB persistence is the data phase)
- [x] **Research Lab — committee approval queue ("Submit for approval"); nothing takes effect unsigned.** ✓ 2026-06-20 (UI shell into the existing committee queue; ties to `/compliance` in the data phase)
- [x] **Clients — "All clients ↔ Invested clients" toggle, default = Invested; reflect KYC-ready vs home users.** ✓ 2026-06-20 (Invested = KYC-verified proxy until a holdings flag exists)
- [x] **Client detail — rename "P&L" → "Total P&L"; show managing-parent relationship; holdings columns: instrument, MTM, purchase value, quantity, strategy name.** ✓ 2026-06-20 (Purchase Value now populated from the holdings cost basis — was a dead field the API never returned; fixed in the sign-off audit.)
- [x] **Strategies — detail panel sticky while the strategy list scrolls; click updates all tiles.** ✓ 2026-06-20 (master/detail card list + sticky detail panel; click-to-update preserved). DECIDED 2026-06-20: kept the sticky detail panel — meets his intent (selected detail stays visible while the list scrolls, click updates everything) and is cleaner than a literal sticky-header table.
- [x] **Sectors page — remove the duplicate sector heat map; surface Top Gainers / Top Movers instead.** ✓ 2026-06-20 (Equities page: duplicate heat map removed, Top Movers full-width)
- [x] **Securities page — rebuild as "universe of securities in our strategies" with daily / monthly / 6-month return columns + search.** ✓ 2026-06-20 (search + 1D/1M/6M columns; 1M/6M show "—" until worker writes period returns)
- [x] **Cockpit → Day P&L — aggregate across ALL strategies.** ✓ 2026-06-20 (sub-label "across all strategies"; sums strategy dayPnl / client-book aggregate)
- [x] **Cockpit → Portfolio Accounts — investor snippet (holdings + performance, default YTD horizon).** ✓ 2026-06-20 (`CockpitPortfolioAccounts`; 1D/MTD/YTD toggle). Real-data mode renders a genuine "All investors" aggregate row from the client book; mock rows tagged "STRATEGY" stand-ins with a note. Per-investor list (~3,000) + MTD = data phase.
- [x] **Cockpit → News flow — All/Alliance/SENS toggle; sources both; click-to-expand Dialog.** ✓ 2026-06-20 (`CockpitNewsFlow`)
- [x] **Nav — Order Book higher: "Orders & Cash" moved directly under "Markets" (above Strategies).** ✓ 2026-06-20
- [x] **Dashboard under Strategies — Strategy returns table (Day / Month / 6 Month / Basket value) on `/admin/dashboard` (Return Insights).** ✓ 2026-06-20 (period returns + basket_value show once the worker writes them)

## B. Decisions needed before building

- [x] **Sector heat map (resolved 2026-06-20).** Decision: Cockpit allocation → **treemap** (`SectorTreemap`, size=weight, colour=day move, both real + seed paths); Equities-page duplicate heat map removed → Top Movers full-width.
- [x] **Featured Strategies block.** Resolved: KEPT, driven by the `is_featured` flag (set in the admin edit-strategy modal); honest empty state otherwise.
- [x] **Research Lab "Add" semantics.** Resolved: Add → wizard adds to the **Proposed** basket (live recompute); names carry a research thesis/rating via the shortlist; nothing live until "Submit for approval".
- [x] **Research persistence + approval workflow.** UI shells built (research notes/rating + wishlist + tick; committee approval queue). DB persistence (`security_research`, approval storage) + `/compliance` wiring = data phase.
- [x] **Emailer / "the edge" — resolved 2026-06-20: rebuilt in-platform.** Marketing **Campaigns** module added to `/admin/emailers` (default tab, alongside the existing transactional Webhook Triggers + Send Logs): campaigns list (Draft/Scheduled/Sent), compose dialog (name/subject/audience segment/body/from/schedule), Audiences panel. Sends + persistence are deferred toasts/notes (Resend blast + campaign storage = data phase); no fabricated send/open stats. New component `src/components/admin/emailer-campaigns.tsx`.

## B2. Surfaced by the sign-off transcript re-scan — YOUR CALL

- [~] **AI research assistant embedded in the Research Lab.** Lonwabo floated it on the call ("I would like to include Claude on our research lab"); **you (Juan) pushed back** ("I would not like to include it on the research lab… not without gateways / if it's not set up correctly"). Treated as a deliberate exclusion — NOT built. Say the word if you want it (it needs an API gateway + guardrails first).

## C. Deferred — data / backend / accuracy (NOT this design pass)

- [D] Confirm R2035 / ZAR-curve values are real-time from IRESS SA (looked wrong; currently mock).
- [D] Yahoo → IRESS data switchover (math changes).
- [D] Define what "P&L sensitivity" chart measures; label it. (leave for FI hire)
- [D] Yield-curve fields: 10yr instrument, break-even, combined curve, spreads — confirm with IRESS then pull live.
- [D] Money-market / fixed-income instrument universe + 1d/5d returns — pending Charles/Andre data.
- [D] "Curve move" / "Kev move" Cockpit widgets — purpose unknown, ask Charles.
- [D] Portfolio Positions tile — no use case yet; aggregate-all-strategies? (clarify later)
- [D] Client holdings values/ratios/purchase values/"transaction fee 99"/MTM — wire with real data.
- [D] Per-client fee splitting (transaction vs custody) — "new tables have that".
- [D] Investor/client counts + amounts (≈3000 investors; ≈7,200 figure).
- [D] Order-book live wiring to the OEMS.
- [D] Cache-busting / build versioning so users get the latest deploy without a manual hard-refresh.

## Approved as-is (no change)
Cockpit overall, ZARONIA chart, AUM tile, Factsheets (radial presentation + live toggle),
Return Insights (separate tab), Macro, EFT/Reconciliation, Approvals & Compliance, Team & Access
(RBAC), Integration, Sidebar, Edit-strategy modal (featured toggle / risk rating / description / save).
