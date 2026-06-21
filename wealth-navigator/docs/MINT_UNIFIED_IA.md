# Mint — Unified platform IA (one bank, not two websites)

**Problem:** the OEMS trading desk (`/oems/*`) and the retail admin (`/admin/*`) were built as two shells joined by links. But they're **one dataset through two lenses** — they already share strategies, securities, prices, the client book, and governance. This is the merged information architecture.

## What drives what (data-flow / correlation map)
- **Market data → everything.** The Iress worker writes `securities_c` / `quote_snapshot_c` / `stock_intraday_c`. This single price source powers the desk (Securities, Equities, Curves, Cockpit ticker) **and** retail valuations (Investors' holdings, Factsheets, Order Book P&L, Cockpit AUM). One price, many views.
- **Strategies are the spine.** `strategies_c` is **designed/managed** by the desk + strategist (Mandates / Strategy Book), **invested in** by retail clients (Investors), **published** as Factsheets, and **rebalanced** (`rebalance_batch/event`) → which propagates to every client holding. One entity, four lenses.
- **The client book is the AUM.** `client_strategy_returns_c` aggregates into the Cockpit's "Platform AUM / Day P&L" (the desk overview literally reads the retail book), into per-investor detail, and into per-strategy AUM/investor counts. One book.
- **Retail demand → desk execution.** The retail **Order Book** (client buys) is what the desk **Blotter** executes (`oems_order_audit` / Iress IOS+); fills flow back to client holdings; cash settles via EFT/reconciliation.
- **Desk intelligence → client comms.** News/SENS + Macro + Research feed **Mint Mornings** (retail digest) and Emailers.
- **Governance spans all.** `admin_team` RBAC, cyber-compliance, audit, approvals, and Iress integration health govern the entire platform.

## Role model (personas → roles)
The existing persona store becomes the role lens that gates navigation. `admin` (Compliance) sees everything.
| Role (persona) | Primary focus |
|---|---|
| Trading Desk (`oems`) | Markets, Mandates, Blotter, Order Book, Integration |
| Strategist (`strategist`) | Strategies, Markets, Research |
| Wealth Manager (`wealth_manager`) | Clients, Investors, Strategies, Studio |
| Business (`business`) | Return Insights, Investors, Macro, Mint Mornings |
| Ops / Funeral (`funeral_cover`) | Order Book, EFT, Reconciliation, Clients |
| Compliance / Admin (`admin`) | **All** + Governance & Platform |

## Unified navigation (one sidebar, grouped by bank function, role-gated)
Shared entities appear **once**; the desk/retail split disappears into function.

1. **Overview** — role-aware landing (`PERSONA_HOME`): desk→Cockpit (`/oems`), WM→My Book (`/wm`), strategist→Strategist Desk (`/strategist`), business→House View (`/business`), funeral→Cover Overview (`/fc/overview`) *(all)*
2. **Markets** — Securities (`/oems/equities`) · Fixed Income · Money Market · Curves · Macro
3. **Orders & Cash** — Order Book (`/admin/order-book`) · Blotter (`/oems/blotter`) · EFT Payments (`/admin/eft`) · Reconciliation (`/fc/overview`)
4. **Strategies** — Strategies (`/strategies`, **Mandates | Builder** tabs; Builder = strategist/admin) · Factsheets (`/admin/factsheets`) · Return Insights (`/admin/dashboard`)
5. **Clients & Investors** — Clients (`/admin/clients`) · Investors (`/admin/investors`) · Client View Studio (`/admin/studio`)
6. **Intelligence & Comms** — News & SENS (`/oems/news`) · Research Lab (`/oems/research-lab`) · Mint Mornings (`/admin/mint-mornings`) · Emailers (`/admin/emailers`)
7. **Governance & Platform** — Approvals & Compliance (`/compliance`) · Cyber Compliance (`/admin/cyber-compliance`) · Integration (`/oems/integration`) · Team & Access (`/admin/team`) · App Settings (`/admin/app-settings`) · Settings (`/admin/settings`)

Drill-downs (e.g. `/oems/security`) are reached *from* their list, not the top nav.

## Implementation
- **One shell** `PlatformShell` (top bar + ticker + the unified `PlatformNav` + main) replaces both `OEMSShell` and `AdminShell`. Both `oems/layout` and `admin/layout` render it; each keeps only its extra providers (admin → `AdminProvider` RBAC; desk → command palette is in the shell).
- **One nav config** `src/lib/platform/nav.ts` (sections → items, each tagged with the roles that see it). Active state = longest-matching href so `/oems` ≠ `/oems/blotter`.
- **Nav visibility (stopgap, until RBAC):** `PlatformNav` shows the **full** nav to any real authenticated session (`useAuth().isAuthenticated`); the `usePersona()` gating only applies in the **no-session dev/design preview** so the persona switcher can still demo each role's surface. This was deliberate: real staff (e.g. a logged-in user) must not be hidden sections by the demo persona, which defaults to `oems`.
- **Done:** persona "home" pages folded into the sidebar via the role-aware Overview item (`PERSONA_HOME` / `overviewItem`); top-bar persona switcher now shares `PERSONA_HOME` (single source of truth — admin lands on `/oems` both places). Two strategy pages merged into one `/strategies` (`StrategiesMonitor` = Mandates, `StrategyBuilder` = Builder); old routes redirect in. Orphaned `side-nav.tsx` + `use-side-nav-badges.ts` deleted.
- **Next (auth/RBAC phase):** replace the `isAuthenticated`-shows-all stopgap with **per-user `page_access` gating** — resolve `getAdminContext()` (real `admin_team` role + `pageAccess`) app-wide and gate each nav item by its page-access key, so each signed-in user sees exactly their permitted surfaces. This is the proper end-state for visibility like Lonwabo's.
