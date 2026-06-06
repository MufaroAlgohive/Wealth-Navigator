# 01 — Overview

## What is Iress Web Services V4?

Iress Web Services V4 is IRESS's **SOAP API** for accessing market data, trading, and portfolio functionality without installing the Iress front-end. It is a platform-agnostic, scalable, and redundant server-based solution.

| Attribute | Value |
|---|---|
| API style | SOAP 1.1, **Document/Literal** |
| Transport | HTTP / HTTPS |
| Compression | gzip (`Accept-Encoding: gzip`) supported |
| Designed for | .NET, Java 6, and modern SOAP toolkits |
| Sample repo | <https://github.com/iress/webservices-v4-docs> |

## What products does it expose?

| Service | Description | Session type |
|---|---|---|
| **Iress** | Iress Pro market data (Level 1 / Level 2 / time series / pricing) | Iress session only |
| **IOS+** | Order & execution management (orders, bookings, contingent, algo, ETCs) | Iress + IOS+ service session |
| **IPS** | Portfolio System (accounts, positions, transactions, uploads) | Iress + IPS service session |
| **FIX+** | FIX+ targets and session status | Iress + FIX+ service session |

## What capabilities does V4 give you?

1. **Watch for updates** via a long-polling mechanism (`Updates=True` in the input header, then poll the matching `*Updates` method).
2. **Page through large result sets** using `PageSize` and `PagingBookmark` — status code `1` means "more pages".
3. **Execute asynchronously** by setting `WaitForResponse=False`; poll the same `RequestID` to retrieve data when ready.

## Permission gate

Users must hold the **"Web Services"** permission at the **group level** in Iress Web Administration. Without it, the WSDL generation step will reject the credentials.

## Two-layer session model

```
┌────────────────────┐
│   Iress session    │  ← user authenticates once via IRESSSessionStart
│   (IRESSSessionKey)│
└─────────┬──────────┘
          │
          ├─► Market data (Iress service)        — uses IRESSSessionKey
          │
          ├─► IOS+ service session               — uses ServiceSessionKey
          ├─► IPS service session                — uses ServiceSessionKey
          └─► FIX+ service session               — uses ServiceSessionKey
```

- A service session **cannot exist** without a parent Iress session.
- The parent Iress session **expires after 2 hours of inactivity**; **max 24h** total lifetime.
- Ending the Iress session **ends every** child service session.

## Where it lives in your stack (Mint OEMS view)

```
                    ┌────────────────────────┐
                    │  Mint OEMS Web / OMS   │
                    │  (React / Node / .NET) │
                    └──────────┬─────────────┘
                               │ HTTPS / SOAP / gzip
                               ▼
        ┌──────────────────────────────────────────┐
        │   IRESS Web Services V4                  │
        │   webservices.iress.co.za/v4             │
        │   (PHX master + SOAP.aspx ASMX)          │
        └──┬─────────────┬─────────────┬───────────┘
           │             │             │
           ▼             ▼             ▼
        Iress Pro    IOS+ servers   IPS servers   FIX+ targets
        (Phoenix)   (Phoenix)     (Phoenix)     (Phoenix)
```

## Why this matters for Mint

For the South African OEMS build, V4 is the **single integration point** for:

- JSE L1/L2 market data (Iress Pro methods — `PricingQuoteGet`, `TimeSeriesGet2`)
- ZAR fixed-income clean/dirty pricing and Greeks (Iress Pro + IPS enrichment)
- JIBAR / ZARONIA / NCD money-market pricing
- NSS-fitted yield curves (typically delivered as `TimeSeriesGet2` with a specific curve code)
- SARB, StatsSA, G10 macro time series
- SENS announcements (Iress Pro; potentially delivered as a security-level news feed)
- Order placement, amendment, cancellation, booking, allocation (IOS+)
- Portfolio holdings, transactions, uploads (IPS)
- FIX+ drop-copy / target status for downstream reconciliation

> See [`11-mint-oems/01-requirements-traceability.md`](../11-mint-oems/01-requirements-traceability.md) for the per-requirement trace.

## What this guide is — and isn't

**Is:**
- A faithful modular transcription of the 77-page PDF Programmer's Guide, with cross-links, examples, and Mint-OEMS-specific addenda.

**Isn't:**
- A replacement for the live WSDL. **The WSDL is the source of truth** — re-generate it (see [Getting Started](04-getting-started.md)) and diff it against your last saved copy.
