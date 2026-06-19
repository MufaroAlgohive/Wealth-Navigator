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

1. **Overview** — Cockpit (`/oems`) · house overview, role-tailored *(all)*
2. **Markets** — Securities (`/oems/equities`) · Fixed Income · Money Market · Curves · Macro
3. **Strategies** — Strategies (`/admin/strategies`, catalogue+builder) · Mandates (`/oems/strategies`, desk/rebalance) · Factsheets (`/admin/factsheets`) · Return Insights (`/admin/dashboard`)
4. **Clients & Investors** — Clients (`/admin/clients`) · Investors (`/admin/investors`) · Client View Studio (`/admin/studio`)
5. **Orders & Cash** — Order Book (`/admin/order-book`) · Blotter (`/oems/blotter`) · EFT Payments (`/admin/eft`) · Reconciliation (`/fc/overview`)
6. **Intelligence & Comms** — News & SENS (`/oems/news`) · Research Lab (`/oems/research-lab`) · Mint Mornings (`/admin/mint-mornings`) · Emailers (`/admin/emailers`)
7. **Governance & Platform** — Approvals & Compliance (`/compliance`) · Cyber Compliance (`/admin/cyber-compliance`) · Integration (`/oems/integration`) · Team & Access (`/admin/team`) · App Settings (`/admin/app-settings`) · Settings (`/admin/settings`)

Drill-downs (e.g. `/oems/security`) are reached *from* their list, not the top nav.

## Implementation
- **One shell** `PlatformShell` (top bar + ticker + the unified `PlatformNav` + main) replaces both `OEMSShell` and `AdminShell`. Both `oems/layout` and `admin/layout` render it; each keeps only its extra providers (admin → `AdminProvider` RBAC; desk → command palette is in the shell).
- **One nav config** `src/lib/platform/nav.ts` (sections → items, each tagged with the roles that see it). `PlatformNav` filters by `usePersona()`; `admin` sees all. Active state = longest-matching href so `/oems` ≠ `/oems/blotter`.
- Persona switcher (already in the top bar) is the role selector. Pages themselves are unchanged; only the chrome unifies.
- **Next:** fold the persona "home" pages (`/wm`, `/strategist`, `/business`) into role-tailored Cockpit variants; merge `/oems/strategies` (mandate) + `/admin/strategies` (builder) into one Strategies page with desk/retail tabs.
