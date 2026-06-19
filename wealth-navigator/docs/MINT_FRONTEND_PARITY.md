# Mint Admin → Next.js — Frontend Parity Checklist

**Purpose:** single source of truth for merging the legacy Mint admin (19 static HTML pages) into the wealth-navigator Next.js app **with zero feature loss**. Tick items as ported. Source inventory derived from `MIGRATION [delete when done]/MyMintAdmin-main/public/*` on 2026-06-19.

**Decisions:** single Next.js app; legacy admin lives under route group `src/app/(admin)/admin/*`; data/Iress work deferred — **frontend first**. Legacy connects only to RETAIL/LIVE DB `mfxng` (browser anon + server service-role).

Status legend: ☐ not started · ◐ in progress · ☑ done & parity-verified.

---

## A. Foundation (build before pages)

> **Build state (2026-06-19):** foundation scaffolded & typechecks clean. Mint CRM mounted at `src/app/admin/*`; the old OEMS "admin persona" page moved to `/compliance` (top-bar + provenance refs updated).

- ☑ **Route group + shell** — `src/app/admin/layout.tsx` + `src/components/admin/admin-shell.tsx` (sidebar + header, WN tokens). Index `src/app/admin/page.tsx` redirects to first allowed page.
- ☑ **Sidebar nav** (exact legacy structure, role-filtered; `src/lib/admin/pages.ts`):
  - MAIN: Clients (`/admin/clients`), Client View Studio (`/admin/studio`)
  - INVESTMENTS: Dashboard (`/admin/dashboard`), Strategies (`/admin/strategies`), Factsheets (`/admin/factsheets`), Investors (`/admin/investors`), Order Book (`/admin/order-book`)
  - BANKING: EFT Payments (`/admin/eft`)
  - COMMUNICATIONS: Mint Mornings (`/admin/mint-mornings`), Emailers & Triggers (`/admin/emailers`)
  - SYSTEM: Settings (`/admin/settings`), App Settings (`/admin/app-settings`, admin-only), Team (`/admin/team`, admin-only), Cyber Compliance (`/admin/cyber-compliance`)
- ◐ **Auth → Supabase** — admin gate uses WN `@supabase/ssr` session (against `mfxng`). TODO: build `/signup` (invite), `/reset-password`, and `/login/forgot` parity (domain rule `@mymint.co.za`); add the post-login team-membership check.
- ☑ **RBAC context** — `src/lib/admin/rbac.ts` (`getAdminContext` reads `admin_team` via RETAIL service role) + client `src/lib/admin/context.tsx` (`useAdmin()`, `useCan()`); `dev` tier + `admin`/`superadmin` bypass; staff gated to `page_access`.
- ☑ **Route protection** — `src/app/admin/layout.tsx` resolves RBAC (no-session→login, not-member→login, unconfigured→dev-fallback banner). Global auth gate already in `src/middleware.ts`.
- ☑ **`/api/admin/me`** — `src/app/api/admin/me/route.ts` (ports `/api/team?action=me`).
- ☑ **Theme alignment** — reuses WN Tailwind tokens (purple `primary`) + shadcn/Radix. No Tailwind CDN.
- ◐ **Shared components** — using existing shadcn (button/card/table/dialog/badge/tabs/etc.) + `PortPlaceholder`. TODO bespoke: sortable/searchable data table, tristate permission control, KPI card, collapsible, `en-ZA`/ZAR formatters, realtime hook wrapper.
- ◐ **CC badge poller** — built into `admin-shell.tsx` (polls `/api/admin/cyber-compliance?action=badge-count` every 60s, silent until endpoint lands).

## B. Backend endpoints to port (Next route handlers under `/api/admin/*`) — frontend wiring now, full impl as each page lands

- ☐ `team` (me, list, invite, resend, update, update-permissions, update-email, remove, resolve-approval, audit-list, isSuperAdmin, complete-signup, forgot-password, impersonate, app-settings-get/save, submit-approval)
- ☐ `studio-config` · ☐ `investors/data` · ☐ `orderbook/*` (send-csv + actions, update-price, archive, archive-upsert) · ☐ `send-eft-email/*` + `eft/pending-transactions` · ☐ `mint-mornings` (status/preview/send/force/test) · ☐ `webhooks` (CRUD) + `email-logs` · ☐ `cyber-compliance/*` (list-*, incidents CRUD, check-migration, run-migration, check-policy-now, badge-count) · ☐ `studio` impersonate.
- Integrations to preserve: SumSub KYC (HMAC server-side), Resend (emails), Supabase webhooks, Vercel cron (orderbook 15:30/`0 16 * * *`, mint-mornings, health-check 15-min). Schedulers move off in-process `setInterval`.

---

## C. Page parity — MAIN

### ☑ Clients — `/admin/clients` (legacy `index.html`, 10.9k) — **DONE 2026-06-19 (reads; KYC review deferred)**
Ported endpoint: `/api/admin/clients` (GET list + detail). Tables: `profiles`, `user_onboarding`, `required_actions`, `stock_holdings_c`, `securities_c`, `transactions`.
- ☑ Roster list (avatar initials, name, mint/email, KYC status badge, TEST tag) + search
- ☑ Detail header + tabs: Profile · KYC · Holdings · Activity
- ☑ Profile: contact/ID/currency/computershare/address/joined fields
- ☑ KYC: kyc_status, SumSub answer/status, bank, employment/income, agreement; Approve/Reject buttons
- ☑ Holdings: table (symbol, strategy, qty, value, P&L) w/ cost-basis (Expected_fill vs avg_fill) logic
- ☑ Activity: transaction list (credit/debit, status)
- DEFERRED (SumSub/storage bucket): KYC review accept/reject + certificate viewer + document operations → POST 501. Documents tab + signed-in-today/online presence + per-strategy collapsible holdings cards = refinement pass.

### ☑ Client View Studio — `/admin/studio` (legacy `studio.html`, 653) — **UI+READS DONE 2026-06-19; impersonation deferred**
Ported endpoint: `/api/admin/studio` (GET config/clients/portfolio). Admin-only.
- ☑ Env toggle Dev/Live (disabled if URL unconfigured; URLs from `MINT_APP_URL_DEV/LIVE`)
- ☑ Client list: tabs (Invested / All Users), search, client cards
- ☑ Portfolio inspector: value header, P&L/Return/Strategies metrics, top holdings (8), recent transactions (6)
- ☑ Cost-basis (Expected_fill vs avg_fill w/ 5× guard) + live-price (last_price→cost) + P&L math
- ☑ Launch card "Open as [Name]" + Exit preview
- DEFERRED: impersonation sign-in link (Supabase auth-admin generateLink) → POST 501; opens app if a link is returned. Phone-frame mockup simplified to a preview panel (visual pass later). Live-price uses last_price (rands) not intraday cents, to avoid scale bugs in the preview.

## D. Page parity — INVESTMENTS

### ☑ Dashboard — `/admin/dashboard` (legacy `dashboard.html`, 11.5k) — **DONE 2026-06-19 (Overview + Return Insights)**
Ported endpoint: `/api/admin/dashboard` (counts + featured + returns). **Consolidation:** the legacy Strategies/Factsheets *tabs* are now dedicated nav pages (`/admin/strategies`, `/admin/factsheets`), so the merged Dashboard is Overview + Return Insights only (no duplication).
- ☑ Overview KPIs (Total/Featured/Public strategies, Total Users, KYC Verified, Bank Linked)
- ☑ Top-strategies-by-YTD bar chart (**recharts**) + featured grid (links to `/admin/factsheets?id=`)
- ☑ Return Insights: Assets/Strategy mode toggle, period tabs (1D/5D/1M/6M/YTD/1Y/5Y/All), gainers/losers bar lists, ≤ -4% alert banner
- N/A here (moved): strategy create/edit form → `/admin/strategies`; factsheet render → `/admin/factsheets`. Realtime/intraday polling + per-strategy password gates deferred to a refinement pass.

### ☑ Strategies — `/admin/strategies` (legacy `strategies.html`, 1176) — **UI+READS DONE 2026-06-19; create deferred**
Ported endpoint: `/api/admin/strategies` (GET list + securities map; GET search-securities). Tables: `strategies_c`, `securities_c`.
- ☑ Create form: name, short_name, description, risk_level, sector, base_currency, is_public, is_featured + holdings
- ☑ Securities search (debounced) + add/remove holdings + editable shares + auto weight/market-value/min-investment calc
- ☑ Browse list: search + risk/visibility filters + sort (newest/name/most-holdings); cards (badges, holdings count, min)
- ☑ Strategy detail modal (holdings table w/ shares/mv/weight/daily-change)
- DEFERRED: create/edit (write to live `strategies_c`) → POST 501 + notice; submit wired + toasts notice. (Modal "View Factsheet" → `/admin/factsheets?id=` once that page lands.)

### ☑ Factsheets — `/admin/factsheets` (legacy gallery 1424 + detail 1356) — **DONE 2026-06-19 (read-only)**
Ported endpoint: `/api/admin/factsheets` (GET list + detail). Tables: `strategies_c`, `strategies_returns_c`, `securities_c`, `client_strategy_returns_c`.
- ☑ Gallery: overview band (Strategies Live, Total Investors, Avg YTD, Top Performer), spotlight card w/ sparkline + CTA, filter tabs (All/Live/Staged/Draft), search, sort, card grid w/ sparklines + deterministic icon colors
- ☑ Detail: header (badges/tags), KPIs (Holdings, Min Investment, All-time Return), performance summary (Best/Worst/Avg Day, YTD — derived from basket_value series), holdings table (+CASH 8% row), calendar returns grid (year selector, monthly from basket_value), fees & disclaimers
- ☑ Detail reachable via `?id=` (Strategies modal links here) and via card click; Back returns to gallery
- NOTE: daily-change carousel folded into the holdings table; investor counts capped at 5000 rows.

### ☑ Investors — `/admin/investors` (legacy `investors.html`, 1381) — **DONE 2026-06-19 (read-only)**
Ported endpoint: `/api/admin/investors/data` (read aggregation; test accounts excluded). Maths done client-side.
- ☑ KPI bar (Total AUM, Invested, P&L, Avg Return, Best/Worst Performer)
- ☑ Investor list: search, mini cards (value + return%); detail header w/ value + holdings/cash breakout
- ☑ Detail KPIs (Invested, P&L, YTD, Inception)
- ☑ Performance: since-inception NAV line chart (**recharts**), monthly calendar (year selector), top holdings
- ☑ Risk: Sharpe/Sortino/Vol/MaxDD/Ann.Return (derived from NAV daily returns)
- ☑ Allocations: holdings table + sector donut (recharts) + legend
- ☑ Transactions: fee summary (broker/ISIN/txn/buffer) + classified ledger
- ☑ Cost-basis (Expected_fill vs avg_fill, cents) + realized-P&L folding (closed positions) + residual cash
- SIMPLIFIED/NOTED: family-member holdings folded into the parent account (no separate Minor rows yet); Strategies/Single-Securities split, drawdown chart, rebalance-fee reconstruction, realtime + `?embed=1` deferred to a refinement pass.

## D2. Page parity — INVESTMENTS (Order Book)

### ☑ Order Book — `/admin/order-book` (legacy `orderbook.html`, 8.4k) — **UI+READS+CSV DONE 2026-06-19; settlement writes deferred**
Ported endpoint: `/api/admin/orderbook` (GET ledger). Tables: `stock_holdings_c`+`profiles`+`securities_c`.
- ☑ Tabs: Active Orderbook · Closed Books; Live/UAT toggle (`profiles.is_test`); search; shown Client/MINT P&L totals
- ☑ Holdings ledger (Client, Instrument, Ticker, Side, Qty, Avg Fill, Expected Fill, Live Price, Strategy, Client P&L, MINT P&L)
- ☑ Export CSV client-side (quote-escaped); cost-basis (Expected_fill vs avg_fill) + Client P&L (live−expected)×qty + MINT P&L (expected−avg)×qty
- DEFERRED (data/settlement phase, POST 501): price-update + fill/settle, reverse investor, 15:30 snapshot capture, Strate BIR (H1/B1/B2/B3/T1) export, pins/cleanup, approval sign-off. Pending-Rebalances tab + investor detail panel = refinement pass.

## E. Page parity — BANKING

### ☑ EFT Payments — `/admin/eft` (legacy `eft.html`, 1299) — **UI+READS DONE 2026-06-19; writes deferred**
Ported endpoint: `/api/admin/eft?action=…`. Tables: `wallets`+`profiles`, `wallet_transactions`, `family_members` (RETAIL/LIVE).
- ☑ Stats: Client Wallets count, Total Wallet Amount (ZAR)
- ☑ Add-to-wallet card: client autocomplete (debounced, ≤8), child-account selector (available_balance/100), wallet type (Active/Test), amount, submit
- ☑ Client table (Date, User, Amount, Reference, Send Notice) + expandable child rows
- ☑ Filter tabs: Active / Test / Pending Approvals
- ☑ Pending approvals: Approve/Reject (reason) buttons
- ☑ READ endpoints: list-wallets, pending-transactions, search-clients, member-children
- DEFERRED (data/backend phase — these mutate **live client balances** + send email): `add-wallet`, `approve-deposit`, `reject-deposit`, `send-notice`. The POST handler returns 501 + notice; the UI wires them and toasts the notice. Also: approver-email gating (Lonwabo/Mufaro) + the "Funds Allocated" email re-applied when writes land.

## F. Page parity — COMMUNICATIONS

### ☑ Mint Mornings — `/admin/mint-mornings` (legacy `mint-mornings.html`, 426) — **UI+STATUS DONE 2026-06-19; send deferred**
Ported endpoint: `/api/admin/mint-mornings` (GET status). Tables: `mint_mornings_log`.
- ☑ Schedule banner (07:00 SAST); status card (sent today?) + Refresh
- ☑ Stats: last send date, articles sent, users reached, sent at (created_at)
- ☑ Manual send + Re-send(force) + Test send controls (wired; toast the deferred notice)
- ☑ Send history table (mint_mornings_log, last 30)
- DEFERRED (email bucket): `preview` (digest HTML render) + send/force/test (Resend dispatch) → POST returns 501 + notice.

### ☑ Emailers & Triggers — `/admin/emailers` (legacy `emailers.html`, 545) — **DONE 2026-06-19**
Ported endpoints: `/api/admin/webhooks` (CRUD), `/api/admin/email-logs`. Tables: `email_webhook_triggers`, `email_logs`.
- ☑ Webhook URL card + Copy
- ☑ Triggers table (Name+meta, Table, Event badge, Email Type, Enabled Switch, Edit/Delete)
- ☑ Trigger modal (name, table, event, email_type, user_id_field, condition_field/value, description, enabled)
- ☑ Send Logs tab (Time, Type, Recipient, Subject, Source, Status + expandable error) + type filter + refresh
- ☑ Receiver `/api/webhooks/supabase` now wired (Welcome/Wallet-Funded/Trade-Confirmation) — see backend bucket.

## G. Page parity — SYSTEM

### ☑ Settings — `/admin/settings` (legacy `settings.html`, 361) — **DONE 2026-06-19 (first real page)**
- ☑ Account (email, role, approver tier), Appearance (theme/EN-ZA placeholders), admin-only links (Studio, App Settings, Team), sign-out note
- ☑ Role-gated rows via `useAdmin()` RBAC context

### ☑ App Settings — `/admin/app-settings` (legacy `app-settings.html`, 266) — admin-only — **DONE 2026-06-19**
Ported endpoint: `GET/POST /api/admin/app-settings` (was `/api/team?action=app-settings-get/save&key=fees`). Table: `app_settings` (RETAIL). GET = any member; POST = admin only + whitelist/coerce 7 keys + upsert on_conflict=key + best-effort `admin_team_audit` write.
- ☑ 7 fee fields (ISIN custody, broker rate %, execution reserve %, transaction fee %, monthly strategy fee, rebalance brokerage %, rebalance custody) w/ R/% affixes, grouped (Purchase/Cash/Strategy/Rebalance)
- ☑ percent ×100 display conversion; all-or-nothing dirty-check; Save (disabled until valid+changed)
- ☑ "Last updated [date] · [email]" metadata (`en-ZA`); missing-table warning banner; toast (sonner); admins-only gate
- NOTE: per-page access is client gate + API-enforced (GET member / POST admin). Server-side per-page gating across all admin routes is a foundation TODO (Section A).

### ☑ Team — `/admin/team` (legacy `team.html`, 1346) — admin-only — **DONE 2026-06-19**
Ported endpoint family: `/api/admin/team?action=…` (GET list/audit-list/list-approvals; POST invite/resend/update-permissions/update-email/resolve-approval; PATCH update; DELETE remove). Tables: `admin_team`, `admin_team_audit`, `admin_approvals` (RETAIL). Admin-gated.
- ☑ Stats strip (Total / Dev / Master / Pending)
- ☑ Members tab: roster (Member, Tier badge, Role pill, Page Access chips, Status, Actions) + Invite modal (name, @mymint.co.za email, role, 8-page access grid)
- ☑ Actions: Role edit, **Permissions modal** (tier radio Staff/Master/Dev + accordion of toggle/tristate controls per section; Dev forces+disables to max — full `PERMISSION_MATRIX` ported), Update Email, Remove (self-remove hidden), Resend
- ☑ Approvals Inbox: status/type filters, cards w/ payload + notes, Approve/Reject (resolve-approval, gated to dev/master), pending count on tab
- ☑ Audit Log: relative-time + `describeAudit` text; limit 200
- ☑ Impersonation Log: admin/client/date filters; env badge; limit 200
- DEFERRED (backend bucket): invite/resend **email send + Supabase auth invite**, update-email **auth-account change** (DB row updates now; `authUpdated:false`), and resolve-approval **auto-execute** side-effects (send trade confirmation / commit fill price). Each returns an honest notice. `last_sign_in_at` (from auth.users) not yet joined into the roster.

### ☑ Cyber Compliance — `/admin/cyber-compliance` (legacy `cyber-compliance.html`, 1934) — **DONE 2026-06-19**
Ported endpoint: `/api/admin/cyber-compliance?action=…`. Tables: `cc_uptime_log`/`cc_api_health`/`cc_incidents`/`cc_policy_checks`/`cc_audit_log` + auth users (RETAIL).
- ☑ Migration banner (missing-table detect via `check-migration`)
- ☑ Health summary strip (Last Check / Uptime% / API Pass% / Policy Pass% via `health-summary`)
- ☑ Tabs: Status (service grid click-to-filter + uptime log) · API Health · Incidents · Audit Log · Policy Checks · User Activity
- ☑ Incidents: filters (status/priority/env) + search; table + Edit / Confirm-Resolve (pending) / Delete; create/edit modal
- ☑ Audit: operation + table filters; `Purge KYC logs`; old→new diff; changed_by name resolution
- ☑ Policy: env sub-tabs (CRM/Live/Dev), table, `Check Now`
- ☑ User Activity: presence counts + searchable user grid (service-role `admin.listUsers`)
- ☑ Sidebar 60s `badge-count` poll wired in `admin-shell`.
- DEFERRED (backend bucket): `run-policy-checks-live`, `run-health-check`, `run-migration`, and high/critical incident **alert email** — honest notices.

## H. Auth pages (map to WN auth) — **DONE 2026-06-19**
- ☑ Sign In — `/login` (existing WN page; admin-team gating enforced by the `(admin)` layout: not-member → `/login?reason=not-a-member`). Reason-banner display on `/login` = optional polish.
- ☑ Sign Up (invite) — `/signup` (invite session via `/auth/callback`, full name + password×2 ≥8, `POST /api/admin/complete-signup` activates `admin_team`, redirect to login). Public route.
- ☑ Forgot Password — `/login/forgot` (existing WN page; redirect now points at `/reset-password`).
- ☑ Reset Password — `/reset-password` (recovery session, password×2, `updateUser`, redirect). Public route.
- Note: `/signup` + `/reset-password` added to `src/middleware.ts` PUBLIC_PREFIXES; they show an "invalid/expired link" state when no session is present.

---

## I. Cross-cutting parity rules (apply to every page)
- Currency ZAR `en-ZA`; percent signed; dates `en-ZA`.
- Loading / empty / error / permission-denied states on every data view.
- Modals close on Esc + backdrop; toasts auto-dismiss.
- No FOUC: gate render until RBAC resolved.
- Cents-vs-rands unit detection where legacy stored mixed scales (holdings avg_fill, prices).
- Realtime where legacy used it (Dashboard, Investors, Order Book) via Supabase Realtime hooks.
