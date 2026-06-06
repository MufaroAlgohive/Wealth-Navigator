# Iress Web Services V4 — Programmer's Guide (Modular)

> A modular, AI- and developer-friendly rendering of the *Iress Web Services V4 Programmer's Guide*, scoped to the **Mint OEMS (Order & Execution Management System)** build for the South African market.
>
> **Source:** `IressWebServicesV4-Programmers_Guide (1).pdf` (77 pages, IRESS).
> **Audience:** Mint engineering team, AI agents, and partner integrators.

---

## What this is

A complete, re-organised Markdown version of the Iress Web Services V4 Programmer's Guide, structured so that:

1. **AI agents** can ingest any one page (a single `.md` file) in isolation and reason about it.
2. **Developers** can jump straight to the topic they need (a method, an error code, a workflow).
3. **Mint OEMS** builders can trace every IRESS capability back to a specific V4 method and see how it maps to the South African trading workflow (JSE equities, ZAR money markets, SARB data, NSS fitted yield curves, SENS, FIX+ drop-copy, etc.).

Each file is self-contained: read it, you can implement against it.

---

## How to navigate

| If you want to… | Start here |
|---|---|
| Understand the platform at a high level | [`01-foundations/01-overview.md`](01-foundations/01-overview.md) |
| Wire up the first request from scratch | [`01-foundations/04-getting-started.md`](01-foundations/04-getting-started.md) |
| Learn the SOAP envelope shape | [`02-protocol/01-requests.md`](02-protocol/01-requests.md) and [`02-protocol/02-responses.md`](02-protocol/02-responses.md) |
| Manage sessions safely (login, expiry, recovery) | [`04-sessions/01-iress-sessions.md`](04-sessions/01-iress-sessions.md) → [`04-sessions/04-error-management-and-recovery.md`](04-sessions/04-error-management-and-recovery.md) |
| Page through large result sets | [`03-paging-and-updates/01-paging-overview.md`](03-paging-and-updates/01-paging-overview.md) |
| Subscribe to live updates (quotes, orders, executions) | [`03-paging-and-updates/03-updates.md`](03-paging-and-updates/03-updates.md) |
| Place / amend / cancel an order | [`05-services/iosplus/01-order-create-amend-cancel.md`](05-services/iosplus/01-order-create-amend-cancel.md) |
| Build a contingent (CO) or algo order | [`05-services/iosplus/contingent-orders/`](05-services/iosplus/contingent-orders/) or [`05-services/iosplus/algo-orders/`](05-services/iosplus/algo-orders/) |
| Pull a booking / fee breakdown | [`05-services/iosplus/bookings-and-fees/`](05-services/iosplus/bookings-and-fees/) |
| Read transactions out of IPS | [`05-services/ips/01-transactions.md`](05-services/ips/01-transactions.md) |
| Push an upload (e.g. trade files) into IPS | [`05-services/ips/uploads/`](05-services/ips/uploads/) |
| Consume FIX+ drop-copy / target status | [`05-services/fixplus/01-fixplus.md`](05-services/fixplus/01-fixplus.md) |
| Look up an error number | [`06-errors/01-session-error-codes.md`](06-errors/01-session-error-codes.md) |
| Plan recovery for a "Get" or "Set" method | [`07-recovery/01-application-recovery.md`](07-recovery/01-application-recovery.md) |
| Tune performance / respect server limits | [`08-performance/`](08-performance/) |
| See the complete method quick-reference | [`10-reference/quick-reference/`](10-reference/quick-reference/) |
| Map V4 capabilities to Mint OEMS requirements | [`11-mint-oems/01-requirements-traceability.md`](11-mint-oems/01-requirements-traceability.md) |
| Drop SOAP XML request/response samples into a client | [`13-soap-examples/`](13-soap-examples/) |
| Consume typed schemas / TS interfaces | [`12-schemas/`](12-schemas/) |

---

## Folder layout

```
iress-v4-docs/
├── README.md                          ← you are here
├── 01-foundations/                    ← Overview, architecture, endpoints, getting started
├── 02-protocol/                       ← Request/response shapes, sync vs async
├── 03-paging-and-updates/             ← Pagination + long-polling updates
├── 04-sessions/                       ← Iress sessions, service sessions, errors, recovery
├── 05-services/                       ← Per-service method docs
│   ├── market-data/                   ← Iress Pro (PricingQuoteGet, TimeSeriesGet2, …)
│   ├── iosplus/                       ← Trading (orders, bookings, contingent, algo)
│   │   ├── contingent-orders/         ← FIXED CO, TRAILING CO, OCO, IFDONE, take profit
│   │   ├── algo-orders/               ← External algo properties
│   │   ├── bookings-and-fees/         ← MiscFees tags, SWIFT qualifiers
│   │   ├── etcs/                      ← ETCGetByOrganisation
│   │   ├── order-attributes/          ← Iress strategy property catalog (IS013-IS041)
│   │   └── examples/                  ← Worked SOAP request/response samples
│   ├── ips/                           ← Portfolio data
│   │   └── uploads/                   ← IPSUploadCreate1 → Run1 → ErrorGet1
│   └── fixplus/                       ← FIX+ target / status
├── 06-errors/                         ← Error code tables
├── 07-recovery/                       ← Application recovery patterns
├── 08-performance/                    ← Client optimisations + server limits
├── 09-compatibility/                  ← WSDL compatibility
├── 10-reference/
│   └── quick-reference/               ← One-page method index per service
├── 11-mint-oems/                      ← Mint OEMS–specific addenda (SA market)
├── 12-schemas/                        ← JSON / TypeScript / Zod type definitions
└── 13-soap-examples/                  ← Raw SOAP XML request + response payloads
```

---

## Conventions used in this doc set

- **Method names** are in `code` and match the SOAP verb exactly (e.g. `IRESSSessionStart`, `OrderCreate3`).
- **Endpoints** are listed per region. The South Africa endpoints (`webservices.iress.co.za/v4` and `webservices-ct.iress.co.za/v4`) are the **production-relevant** ones for Mint.
- **Service names** in `ServiceSessionStart`: `"IOSPlus"`, `"IPS"`, `"FIXPlus"`. The IRESS market-data service is accessed with just the Iress session key (no service session).
- **StatusCode values** in responses: `1` = more data, `2` = finished, `3` = watching for updates.
- **PageSize default**: 1000 (server may override per method).
- **RequestID** must be globally unique per active request (use a GUID).
- **gzip** compression is supported — set `Accept-Encoding: gzip`.

---

## IRESS public sample repo

All SOAP request/response examples in this guide mirror the samples IRESS publishes at:
`https://github.com/iress/webservices-v4-docs`.

If anything in the docs diverges from the live WSDL or that repo, the **live WSDL is the source of truth** — re-generate the cut-down WSDL (see [`01-foundations/04-getting-started.md`](01-foundations/04-getting-started.md)) to confirm.

---

## How this maps to the email (Mint OEMS session prep)

The email from the Mint team flagged a tick-box requirements spec covering:

- Reference data
- Equities (L1 / L2)
- Fixed income (clean / dirty pricing, Greeks)
- Money market (JIBAR / ZARONIA / NCDs)
- Fitted yield curves (Nelson-Siegel-Svensson)
- Macro (SARB, StatsSA, G10)
- SENS announcements & wires
- Auth, streaming, SLA, reconciliation

→ See [`11-mint-oems/01-requirements-traceability.md`](11-mint-oems/01-requirements-traceability.md) for the per-tick-box trace into the V4 methods described in this guide.

---

## Versioning & change log

- **v1.0** — Initial modular transcription from the V4 Programmer's Guide PDF, scoped to Mint OEMS build.
- The source PDF did not show a date on its cover; the embedded `Iress - Iress Web Services Release Notes Version V4` footer is the canonical version marker.
