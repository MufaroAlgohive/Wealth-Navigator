# Env migration — original Mint (Vercel) → merged app (Vercel) + Iress worker (Railway)

Source: the original Mint dashboard's Vercel env (`mint.env`). Values are stored locally in the gitignored `wealth-navigator/.env.local` — **this doc has names only, no secrets.**

## 1. Renames (old Mint name → merged-app name)
| Old (mint.env) | New (merged app) | Why |
|---|---|---|
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | `RETAIL_SUPABASE_URL` / `RETAIL_SUPABASE_SERVICE_ROLE_KEY` | mfxng is the **RETAIL/LIVE** DB in the 3-DB topology |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Next.js public-env convention |
| `SUMSUB_SECRET_KEY` | `SUMSUB_APP_SECRET` | code (`_sumsub.js` / `lib/admin/sumsub.ts`) reads `SUMSUB_APP_SECRET` |

> ⚠ **Auth target:** the merged app's browser auth (`NEXT_PUBLIC_SUPABASE_*`) must point at **mfxng** (RETAIL) — that's where `profiles` + `admin_team` live, so admins can log in to `/admin/*`. (The local `.env.local` is currently pointed at the nnwz test project for OEMS-desk dev; flip it to mfxng for admin/CRM testing.)

## 2. Vercel — merged app (`wealth-navigator`)
Set these in the Vercel project env (server vars encrypted):

**Supabase (3-DB split):**
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` → **mfxng** (retail/auth)
- `RETAIL_SUPABASE_URL`, `RETAIL_SUPABASE_SERVICE_ROLE_KEY` → **mfxng** (from mint.env `SUPABASE_*`)
- `INSTITUTIONAL_SUPABASE_URL`, `INSTITUTIONAL_SUPABASE_SERVICE_ROLE_KEY` → **nnwz** (OEMS; *not in mint.env* — from supabase_creds)

**Email / KYC / app:**
- `RESEND_API_KEY`, `ORDERBOOK_EMAIL_FROM` (+ `ORDERBOOK_EMAIL_TO` — *gap*)
- `SUPABASE_WEBHOOK_SECRET` (*gap* — set strong value; must match the header in Supabase → Database → Webhooks)
- `CRON_SECRET` (*gap* — protects Vercel cron routes)
- `SUMSUB_BASE_URL`, `SUMSUB_APP_TOKEN`, `SUMSUB_APP_SECRET`, `SUMSUB_LEVEL_NAME`
- `MINT_APP_URL_DEV`, `MINT_APP_URL_LIVE`

**Loan/credit engine (only when those features are ported; powers Cyber-Compliance policy checks):**
- `PAYSTACK_SECRET_KEY`, `VITE_PAYSTACK_PUBLIC_KEY`
- `STITCH_CLIENT_ID`, `STITCH_CLIENT_SECRET`
- `EXPERIAN_USERNAME`, `EXPERIAN_PASSWORD`, `EXPERIAN_ORIGIN`
- `TRUID_API_BASE`, `TRUID_DOMAIN`, `TRUID_SCHEME`, `TRUID_API_KEY`, `BRAND_ID`, `COMPANY_ID`, `REDIRECT_URL`, `WEBHOOK_URL`

**Do NOT set on Vercel:** `GITHUB_PAT` (git credential, not an app var).

## 3. Railway — Iress worker (`workers/iress-ingest`)
The worker writes prices to RETAIL and analytics to INSTITUTIONAL; it does **not** need email/KYC/loan keys.
- `RETAIL_SUPABASE_URL`, `RETAIL_SUPABASE_SERVICE_ROLE_KEY` → **mfxng** (from mint.env `SUPABASE_*`) ← the one thing this file actually contributes to Railway
- `INSTITUTIONAL_SUPABASE_URL`, `INSTITUTIONAL_SUPABASE_SERVICE_ROLE_KEY` → **nnwz** (*not in mint.env*)
- `IRESS_MODE=live`, `IRESS_USERNAME`, `IRESS_PASSWORD`, `IRESS_COMPANY_NAME`, `IRESS_ACCOUNT_CODE` (*not in mint.env* — IRESS SOAP creds)
- Worker gates (per `workers/iress-ingest/.env.example` + `docs/PHASE1_IRESS_RETAIL_CUTOVER.md`): `IRESS_WORKER_DRY_RUN`, `SUPABASE_ALLOW_WRITES`, and for the Yahoo cutover `IRESS_RETAIL_INGEST`, `IRESS_RETAIL_DRY_RUN`, `RETAIL_PRICE_SOURCE_COL`.

## 4. Gaps — NOT in mint.env, must be sourced/created
- `INSTITUTIONAL_SUPABASE_*` (nnwz) — from `supabase_creds` (already in local `.env.local`).
- `IRESS_USERNAME` / `IRESS_PASSWORD` — IRESS SOAP creds (Railway only).
- `ORDERBOOK_EMAIL_TO`, `SUPABASE_WEBHOOK_SECRET`, `CRON_SECRET`, `SESSION_SECRET` — generate.

## 5. Rotation (recommended)
`mint.env` itself is annotated "rotate", and these were shared in plaintext (Downloads + this session). After migrating, rotate: **Supabase service-role key**, **Resend**, **SumSub** (token+secret), **Paystack** (both), **Experian**, **TruID**, and the **GitHub PAT**. Then delete `~/Downloads/mint.env`.
