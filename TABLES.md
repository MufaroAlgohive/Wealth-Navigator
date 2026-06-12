# Mint App — Database Table Documentation

A reference for every Supabase table and storage bucket used in the Mint platform.

---

## 👤 User & Identity

### `profiles`
Core user identity record, created when a user signs up via Supabase Auth.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Matches the Supabase Auth `user.id` |
| `first_name` | text | First name |
| `last_name` | text | Last name |
| `email` | text | Auth email address |
| `phone` | text | Phone number |
| `id_number` | text | SA ID number (populated during onboarding) |
| `mint_number` | text | Unique internal Mint account number |
| `created_at` | timestamptz | Account creation timestamp |

**Used by:** login, profile page, gift sending, banking initiation, onboarding, ID validation.

---

### `user_onboarding`
Tracks each user's progress through the multi-step KYC and account setup flow.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `user_id` | UUID | FK → Supabase Auth user |
| `kyc_status` | text | `verified`, `pending`, `failed`, `resubmit` |
| `sumsub_raw` | JSONB | Raw Sumsub applicant data (includes `address_saved` flag) |
| `onboarding_step` | int | Last completed step number (1–6) |
| `bank_name` | text | Bank name captured during onboarding |
| `bank_account_number` | text | Bank account number |
| `employment_status` | text | Employment classification |
| `employment_data` | JSONB | Full employment details from Step 1 |
| `mandate_signed_at` | timestamptz | Timestamp of discretionary mandate signature |
| `risk_disclosure_signed_at` | timestamptz | Timestamp of risk disclosure acceptance |
| `source_of_funds` | text | Declared source of funds |
| `updated_at` | timestamptz | Last update timestamp |

**Used by:** onboarding flow (all steps), Sumsub webhook, banking capture, gift claim verification.

---

### `user_onboarding_pack_details`
Stores verified KYC artefacts and compliance documents for a user.

| Column | Type | Description |
|---|---|---|
| `user_id` | UUID | FK → Supabase Auth user |
| `applicant_id` | text | Sumsub applicant ID |
| `id_verified` | boolean | Sumsub ID check passed |
| `agreements` | JSONB | Array of signed agreement records |
| `employment_data` | JSONB | Employment details |
| `bank_letter_url` | text | URL to uploaded bank confirmation letter |
| `created_at` | timestamptz | Row creation timestamp |

**Gates:** Step 1 (KYC) of onboarding. Must exist for a user to progress past identity verification.

---

### `required_actions`
A per-user checklist that drives the "Actions Needed" banner in the app.

| Column | Type | Description |
|---|---|---|
| `user_id` | UUID | FK → Supabase Auth user |
| `kyc_verified` | boolean | KYC passed |
| `kyc_pending` | boolean | Sumsub review in progress |
| `kyc_needs_resubmission` | boolean | User must re-upload documents |
| `bank_linked` | boolean | TruID bank link complete |
| `bank_in_review` | boolean | Bank link submitted, not yet confirmed |
| `bank_linked_at` | timestamptz | Timestamp of successful bank link |

**Updated by:** Sumsub webhook, TruID bank capture endpoint, onboarding completion.

---

## 💰 Financials

### `wallets`
Each user's internal cash balance (their "Mint Wallet").

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `user_id` | UUID | FK → Supabase Auth user (unique) |
| `balance` | numeric | Available balance in **Rands** (e.g. `1500.00`) |
| `pending_balance` | numeric | Funds in transit / not yet settled |
| `updated_at` | timestamptz | Last update timestamp |

> ⚠️ `balance` is stored in **Rands**, not cents. Contrast with `stock_holdings_c` prices which are in cents.

---

### `transactions`
The central financial ledger. Every money movement creates a row here.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `user_id` | UUID | FK → owner of the transaction |
| `name` | text | Human-readable label (e.g. "Investment Gift — Satrix S&P 500") |
| `description` | text | Optional detail |
| `amount` | numeric | Amount in **cents** |
| `direction` | text | `credit` or `debit` |
| `status` | text | `pending` or `posted` |
| `store_reference` | text | Reference code (e.g. `GIFT-{id}`, `EFT-{id}`) |
| `transaction_date` | date | Date of transaction |
| `settlement_status` | text | Settlement state |

**Used by:** deposits, EFT confirms, investments, gift sends/cancels/refunds, subscription billing, child wallet top-ups.

---

## 📈 Investments

### `securities_c`
Master catalogue of all tradeable assets (stocks, ETFs).

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `symbol` | text | Ticker symbol (e.g. `STX500`) |
| `name` | text | Full asset name |
| `last_price` | numeric | End-of-day price in **cents** |
| `sector` | text | Asset sector |
| `asset_type` | text | `stock`, `etf`, etc. |
| `ytd_start_price` | numeric | Price at start of current year in cents — for YTD return calc |

---

### `strategies_c`
Defines the pre-built investment portfolios ("Strategies") available on the platform.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `name` | text | Strategy display name |
| `description` | text | Marketing copy |
| `holdings` | JSONB | List of constituent securities and their weights |
| `risk_level` | text | `low`, `medium`, `high` |
| `min_investment` | numeric | Minimum buy-in in Rands |

---

### `user_strategies`
Links a user to the strategies they have invested in.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `user_id` | UUID | FK → Supabase Auth user |
| `strategy_id` | UUID | FK → `strategies_c` |
| `invested_amount` | numeric | Total cost basis in Rands |
| `status` | text | `active` or `closed` |
| `created_at` | timestamptz | First investment date |

---

### `stock_holdings_c`
Granular per-user inventory of individual stock positions.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `user_id` | UUID | FK → Supabase Auth user |
| `family_member_id` | UUID | FK → `family_members` (for child holdings; null for parent) |
| `security_id` | UUID | FK → `securities_c` |
| `strategy_id` | UUID | FK → `strategies_c` (null for direct holdings) |
| `quantity` | numeric | Number of shares held |
| `avg_fill` | numeric | Average purchase price in **cents** |
| `Expected_fill` | numeric | Anticipated fill price in cents |
| `market_value` | numeric | Current market value in cents |
| `Status` | text | `active` or `exited` |
| `is_active` | boolean | Active position flag |
| `exit_price` | numeric | Price at exit in cents (if sold) |
| `as_of_date` | date | Valuation date |

---

### `stock_returns_c`
Historical end-of-day performance data per security.

| Column | Type | Description |
|---|---|---|
| `security_id` | UUID | FK → `securities_c` |
| `as_of_date` | date | Date of snapshot |
| `current_price` | numeric | EOD price in cents |
| `1d_pnl` | numeric | 1-day P&L |
| `1m_pnl` | numeric | 1-month P&L |
| `ytd_pnl` | numeric | Year-to-date P&L |

---

### `stock_intraday_c`
Real-time intraday price snapshots, refreshed every ~15 seconds during market hours.

| Column | Type | Description |
|---|---|---|
| `security_id` | UUID | FK → `securities_c` |
| `current_price` | numeric | Live price in **cents** |
| `timestamp` | timestamptz | Time of snapshot |

**Used by:** live portfolio valuation, holdings page, balance card.

---

### `strategies_returns_c`
Historical return series for each strategy — powers the performance charts.

| Column | Type | Description |
|---|---|---|
| `strategy_id` | UUID | FK → `strategies_c` |
| `as_of_date` | date | Date |
| `basket_value` | numeric | Strategy basket value (used for equity curve chart) |
| `1d_pnl` | numeric | 1-day return |
| `1m_pnl` | numeric | 1-month return |
| `ytd_pnl` | numeric | Year-to-date return |

---

### `client_strategy_returns_c`
Per-user, per-strategy P&L snapshots. Drives the **home page balance card** and equity curve charts.

| Column | Type | Description |
|---|---|---|
| `user_id` | UUID | FK → Supabase Auth user |
| `family_member_id` | UUID | FK → `family_members` (null for parent accounts) |
| `strategy_id` | UUID | FK → `strategies_c` |
| `as_of_date` | date | Date of snapshot |
| `basket_value` | numeric | User's portion of basket value in Rands |
| `1d_pnl` | numeric | Pre-computed 1-day P&L |
| `5d_pnl` | numeric | Pre-computed 5-day P&L |
| `1m_pnl` | numeric | Pre-computed 1-month P&L |
| `ytd_pnl` | numeric | Pre-computed YTD P&L |
| `inception_pnl` | numeric | Total P&L since first investment |

> ⚠️ Written by an external P&L computation job. Do **not** use `inception_pnl` directly for chart/badge values — compute from `basket_value` deltas instead to ensure chart and badge stay in sync.

---

### `strategy_rebalance_residuals`
Cash left over from strategy rebalancing events (fractional amounts that couldn't be deployed).

| Column | Type | Description |
|---|---|---|
| `user_id` | UUID | FK → Supabase Auth user |
| `strategy_id` | UUID | FK → `strategies_c` |
| `residual_amount` | numeric | Rands of undeployed cash from rebalance |
| `as_of_date` | date | Date of rebalance |

---

### `subscriptions`
Manages recurring fee-based services (e.g. management fees, Mint Mornings premium).

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `user_id` | UUID | FK → Supabase Auth user |
| `plan_id` | text | Subscription plan identifier |
| `status` | text | `active`, `cancelled`, `past_due` |
| `current_period_end` | date | Next billing date |
| `updated_at` | timestamptz | Last update |

---

## 👨‍👩‍👧 Family & Goals

### `family_members`
Linked accounts — primarily child accounts managed by a guardian parent.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `user_id` | UUID | FK → guardian (parent) Supabase Auth user |
| `first_name` | text | Child's first name |
| `last_name` | text | Child's last name |
| `relationship` | text | `child`, `spouse`, etc. |
| `available_balance` | numeric | Child's wallet balance in **cents** |
| `status` | text | `active`, `pending`, etc. |
| `pairing_code` | text | Code used to link accounts |
| `birth_certificate_url` | text | Uploaded birth certificate storage URL |

---

### `investment_goals`
User-defined savings targets, optionally linked to a strategy or child account.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `user_id` | UUID | FK → Supabase Auth user |
| `family_member_id` | UUID | FK → `family_members` (null for personal goals) |
| `name` | text | Goal label (e.g. "University Fund") |
| `target_amount` | numeric | Goal amount in Rands |
| `invested_amount` | numeric | Amount invested so far |
| `progress_percent` | numeric | Computed progress toward target |
| `target_date` | date | Target completion date |
| `linked_strategy_id` | text | FK → `strategies_c` (optional) |
| `linked_security_id` | text | FK → `securities_c` (optional) |
| `linked_asset_name` | text | Display name of linked asset |

---

## 🎁 Gifting

### `gift_claims`
Tracks every investment gift from creation through to claim or expiry.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `sender_user_id` | UUID | FK → gifting user |
| `recipient_identifier` | text | Email or SA ID entered by sender |
| `recipient_user_id` | UUID | FK → recipient Supabase user (null if not yet registered) |
| `amount` | numeric | Gift value in **cents** |
| `asset_type` | text | `strategy` or `security` |
| `strategy_id` | UUID | FK → `strategies_c` (if strategy gift) |
| `security_id` | UUID | FK → `securities_c` (if stock gift) |
| `security_symbol` | text | Ticker of gifted stock |
| `asset_name` | text | Display name of gifted asset |
| `token` | text | 6-digit claim code |
| `status` | text | `pending_claim`, `pending_registration`, `claimed`, `cancelled`, `expired` |
| `message` | text | Optional personal note from sender |
| `expires_at` | timestamptz | Expiry timestamp (4 hours from creation) |
| `extension_fees` | integer | Extra fees charged for extending the gift window |
| `cancelled_at` | timestamptz | Timestamp of cancellation |

**Email flow:** On insert, two emails fire via Resend — one to the sender confirming the gift was sent, one to the recipient with the claim code and instructions tailored to their registration status.

---

## 📧 Communications

### `order_emails`
Logs every investment confirmation or fill email sent via Resend, preventing duplicate sends.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `user_id` | UUID | FK → Supabase Auth user |
| `email` | text | Recipient email address |
| `confirmation_status` | text | `sent`, `failed`, `skipped` |
| `fill_status` | text | Status of the fill notification email |
| `resend_id` | text | Resend API message ID |
| `transaction_id` | UUID | Reference to the triggering transaction |
| `holding_id` | UUID | Reference to the triggering holding |

---

### `notifications`
In-app push notifications shown in the notification centre, grouped by date.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `user_id` | UUID | FK → recipient user |
| `title` | text | Notification heading |
| `body` | text | Notification body text |
| `type` | text | `investment`, `gift`, `system`, etc. |
| `read` | boolean | Whether the user has read it |
| `payload` | JSONB | Action metadata (e.g. `{ action: "gift_received", gift_id: "..." }`) |
| `created_at` | timestamptz | Timestamp |

---

### `News_articles`
Market news and editorial content shown in the app's news feed.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `title` | text | Article headline |
| `content` | text | Full article body |
| `author` | text | Author name |
| `published_at` | timestamptz | Publication timestamp |
| `category` | text | Topic tag (e.g. `markets`, `economy`) |
| `image_url` | text | Cover image URL |

---

### `mint_mornings_log`
Prevents the daily "Mint Mornings" newsletter from being sent more than once per day.

| Column | Type | Description |
|---|---|---|
| `sent_date` | date | Date the newsletter was sent |
| `sent_at` | timestamptz | Exact send timestamp |
| `recipient_count` | integer | Number of emails dispatched |

---

## 🏦 Banking & Credit

### `truid_bank_snapshots`
Stores raw bank data retrieved via the TruID bank-linking integration.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `user_id` | UUID | FK → Supabase Auth user |
| `snapshot_data` | JSONB | Full TruID account and transaction payload |
| `captured_at` | timestamptz | Timestamp of capture |
| `bank_name` | text | Identified bank |
| `account_number` | text | Verified account number |

**Used by:** bank link verification, credit scoring input.

---

### `loan_application`
Tracks each credit/liquidity application from submission through to approval or rejection.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `user_id` | UUID | FK → Supabase Auth user |
| `status` | text | `pending`, `approved`, `rejected`, `repaid` |
| `amount_requested` | numeric | Requested loan amount in Rands |
| `amount_approved` | numeric | Approved disbursement amount |
| `interest_rate` | numeric | Applied interest rate |
| `repayment_date` | date | Due date |
| `created_at` | timestamptz | Application timestamp |

---

### `loan_engine_score`
Stores the credit score and risk assessment computed by the Mint lending engine.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `user_id` | UUID | FK → Supabase Auth user |
| `loan_application_id` | UUID | FK → `loan_application` |
| `score` | numeric | Computed credit score |
| `risk_band` | text | `low`, `medium`, `high` |
| `score_components` | JSONB | Breakdown of individual scoring factors |
| `computed_at` | timestamptz | Timestamp of score calculation |

---

### `credit_transactions_history`
Ledger of repayment and disbursement events against a loan.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `loan_application_id` | UUID | FK → `loan_application` |
| `user_id` | UUID | FK → Supabase Auth user |
| `type` | text | `disbursement` or `repayment` |
| `amount` | numeric | Amount in Rands |
| `created_at` | timestamptz | Transaction timestamp |

---

### `credit_accounts`
Summary credit account state for a user.

| Column | Type | Description |
|---|---|---|
| `user_id` | UUID | FK → Supabase Auth user (unique) |
| `outstanding_balance` | numeric | Current outstanding amount owed |
| `credit_limit` | numeric | Approved credit limit |
| `status` | text | Account status |

---

### `insurance_policies`
Stores funeral cover policies issued through the Mint app.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `user_id` | UUID | FK → Supabase Auth user |
| `policy_number` | text | Unique policy reference |
| `plan_name` | text | Cover tier |
| `premium` | numeric | Monthly premium amount |
| `cover_amount` | numeric | Total cover value |
| `beneficiaries` | JSONB | List of named beneficiaries |
| `status` | text | `active`, `cancelled`, `lapsed` |
| `signed_agreement_url` | text | URL to the signed policy document |
| `created_at` | timestamptz | Policy inception date |

---

## 🔐 Security & System

### `user_sessions`
Tracks active login sessions for the "Manage Sessions" security feature.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `user_id` | UUID | FK → Supabase Auth user |
| `session_token` | text | Hashed session fingerprint |
| `user_agent` | text | Browser/device user-agent string |
| `browser` | text | Parsed browser name |
| `os` | text | Parsed operating system |
| `device_type` | text | Parsed device type |
| `ip_address` | text | Login IP address |
| `is_current` | boolean | Marks the active session |
| `created_at` | timestamptz | Login timestamp |
| `last_active_at` | timestamptz | Last activity timestamp |

---

### `it_incidents`
Internal log for tracking platform incidents and service disruptions.

| Column | Type | Description |
|---|---|---|
| `id` | UUID | Row UUID |
| `title` | text | Incident title |
| `affected_service` | text | Which service is impacted |
| `severity` | text | `low`, `medium`, `high`, `critical` |
| `status` | text | `open`, `investigating`, `resolved` |
| `start_time` | timestamptz | When the incident began |
| `description` | text | Detail notes |

---

## 🗄️ Storage Buckets (Supabase Storage)

| Bucket | Contents |
|---|---|
| `signed-agreements` | PDF copies of signed discretionary mandates, risk disclosures, and insurance policies |
| `sumsub-archive` | Raw Sumsub KYC applicant data archived for compliance |

---

## ⚠️ Key Data Conventions

| Convention | Detail |
|---|---|
| **Prices in cents** | `securities_c.last_price`, `stock_holdings_c.avg_fill`, `transactions.amount`, `gift_claims.amount`, `family_members.available_balance` are all in **cents** |
| **Wallet balance in Rands** | `wallets.balance` is stored in **Rands** (e.g. `1500.00`) — divide cents by 100 before writing |
| **`_c` suffix tables** | Market data tables (`securities_c`, `strategies_c`, `stock_holdings_c`, etc.) are populated/managed by external data pipelines, not directly by user actions |
| **`client_strategy_returns_c`** | Written by an external P&L job. Use `basket_value` deltas for chart/badge consistency — do not rely on pre-computed `inception_pnl` |
| **`required_actions`** | Single row per user; upserted by onboarding and KYC webhooks to drive the Actions Needed UI |
