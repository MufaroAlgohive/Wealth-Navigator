# Ozone Top-Up Wallet Integration

> **Phase C6** of the Mint OEM Finalisation Plan (`docs/MINT_FINALISATION_PLAN.md`).
> Status: **MOCK ONLY** — real Ozone API integration is blocked on Tsie
> confirming the vendor contract.

## Overview

Ozone is the upstream rail for instant client wallet top-ups. The
banking surface (`/oems/banking/wallet-topup`) drives the
`OzoneProvider` to generate a checkout redirect; the ozone-callback
webhook flips the matching `wallet_transactions` row from `pending`
to `completed`/`failed`; the existing EFT approval surface picks it up
in the same flow as a manual reference.

```
┌──────────────────┐ initiate (POST)  ┌──────────────────────────┐
│ Banking · Wallet │ ───────────────► │ /api/admin/eft/ozone-topup │
│ Top-ups page    │ ◄─ redirect_url ─└────────┬─────────────────┘
└──────────────────┘                         │ provider.initiateTopup()
                                              ▼
                                       ┌──────────────────┐
                                       │ OzoneProvider    │
                                       │ (mock or live)   │
                                       └────────┬─────────┘
                                                │ (live: redirect)
                                                ▼
                                       ┌──────────────────┐
                                       │ Ozone checkout   │
                                       │   webview / 3DS  │
                                       └────────┬─────────┘
                                                │ webhook (HMAC)
                                                ▼
┌──────────────────┐ update status     ┌──────────────────────────┐
│ wallet_transactions │ ◄─────────────│ /api/admin/eft/ozone-callback │
│   topup_method='ozone' │            └──────────────────────────┘
│   status='completed' │
└──────────────────┘
             │
             ▼ (Normal EFT approval path)
┌──────────────────┐
│ EFT approvals    │
└──────────────────┘
```

## Setup (when the real API is available)

1. Tsie / vendor provides the URL + API key for the production
   environment (Ozone's API contract documents the request shape; the
   inline type stubs in `src/lib/payments/ozone.ts` mirror what the
   BFF expects).
2. Set on Vercel:
   ```
   OZONE_MODE=live
   OZONE_API_URL=https://api.ozone.example/v1
   OZONE_API_KEY=<server-side secret>
   OZONE_WEBHOOK_SECRET=<shared secret>
   OZONE_REDIRECT_BASE_URL=https://wealth-navigator-one.vercel.app
   ```
3. Point Ozone's webhook URL at
   `https://wealth-navigator-one.vercel.app/api/admin/eft/ozone-callback`
4. The `LiveOzoneProvider.health()` will then return
   `{ status: 'ok', mode: 'live' }` and the `/api/admin/eft/ozone-health`
   BFF will surface `mode: "live"`. The Banking page swaps its
   `data-source` badge from `MOCK` to `SUPABASE`.

## Mock mode (development + verification)

`OZONE_MODE=mock` (or unset) wires `MockOzoneProvider`:

- `initiateTopup` returns `{ redirect_url, transaction_id }` where the
  redirect points at `/oems/banking/wallet-topup?...&tx=<oz-mock-...>`.
- A `setTimeout` 5 000 ms later flips the in-memory transaction to
  `completed`.
- The UI's "Initiate top-up" button opens the redirect in a new tab; the
  callback runs the moment the user re-visits the page (the mock wiring
  skips the actual HTTP webhook round-trip and writes directly via the
  same code path the production callback would take).

### Manual fill injection

You can also seed a callback manually via curl:

```bash
curl -X POST http://localhost:3000/api/admin/eft/ozone-callback \
  -H "Content-Type: application/json" \
  -d '{
    "transaction_id": "oz-mock-abc123…",
    "status": "completed",
    "reference": "OZ-001"
  }'
```

In live mode the header `X-Ozone-Signature: sha256=<hmac>` is required.

## Callback flow

The webhook route (`/api/admin/eft/ozone-callback`):

1. Validates the JSON envelope (returns 400 on shape mismatch).
2. Verifies `X-Ozone-Signature` against `OZONE_WEBHOOK_SECRET` when set
   (uses `crypto.timingSafeEqual`).
3. Looks up the matching `wallet_transactions` row by
   `metadata->ozone_transaction_id`.
4. Flips `status` to `completed` / `failed` / `pending` (whatever the
   provider sent).
5. Idempotency: a repeat `completed` webhook returns
   `{ idempotent: true }` without re-writing.
6. On `completed`, writes an `email_logs` row (audit only — the actual
   Resend dispatch is wired in a follow-up phase).

### Status mapping

| Body `status` | Action |
|---|---|
| `completed` | Flips row to `completed`, stamps `processed_at`, logs an email audit row. |
| `failed` | Flips row to `failed`, stamps `processed_at`. No email log. |
| `pending` | Stores the provider's reference + received_at but leaves `processed_at` null. |

## Related files

- `wealth-navigator/src/lib/payments/ozone.ts` — provider abstraction
- `wealth-navigator/src/app/api/admin/eft/ozone-topup/route.ts` — POST initiate
- `wealth-navigator/src/app/api/admin/eft/ozone-callback/route.ts` — POST webhook
- `wealth-navigator/src/app/api/admin/eft/ozone-health/route.ts` — GET provider status (used by the page)
- `wealth-navigator/src/app/oems/(banking)/wallet-topup/page.tsx` — UI driver
- `wealth-navigator/src/app/api/admin/eft/route.ts` — `topup-ozone` legacy action (Phase B4 manual reference)
