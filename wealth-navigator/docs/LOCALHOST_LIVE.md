# Running Live IRESS on Localhost

Connect Mint Wealth Navigator to the IRESS CT sandbox while keeping mock mode available for offline dev.

## Prerequisites

- Bun ≥ 1.1 or Node ≥ 20
- Network access to `https://webservices-ct.iress.co.za/v4`
- IRESS CT credentials (server-side only — **not** app login)

## Environment

Copy `.env.example` → `.env.local` and set:

```env
IRESS_MODE=live
IRESS_USERNAME=DFM@Mint
IRESS_PASSWORD=123
IRESS_COMPANY_NAME=Mint
IRESS_BASE_URL=https://webservices-ct.iress.co.za/v4

# Optional — for live blotter orders
# IRESS_ACCOUNT_CODE=YOUR_ACCOUNT
```

> **Never** use `NEXT_PUBLIC_*` for IRESS credentials. They must stay server-side.

App login remains separate: `admin` / `admin` at `/login`.

## Start

```bash
cd wealth-navigator
bun install
bun run dev
```

Open http://localhost:3000/login → sign in → `/oems`.

## What to look for

### DataSource badges

Panels show a small pill in the header:

| Badge | Meaning |
|-------|---------|
| **LIVE** (green) | Data from IRESS SOAP |
| **HYBRID** (blue) | Live quotes + seed/sim fallback |
| **SEED** (amber) | Static seed data |
| **MOCK** (muted) | In-process mock |

Key panels with live wiring:

- **Cockpit → Top Movers** — HYBRID when session up
- **Security → quote header** — HYBRID via `/api/iress/quotes`
- **Integration → endpoint health** — HYBRID in live mode

### Dev provenance strip

In development, the top bar shows:

`IRESS_MODE=live | Session: ok/fail | Live: N | Seed: M | Mock: K`

### API endpoints (require `mint-auth` cookie)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/iress/health` | Session health |
| `GET /api/iress/session` | Session status (no secrets) |
| `GET /api/iress/quotes?symbols=NPN,PRX` | Batch live quotes |
| `GET /api/iress/provenance` | Surface counts |

## Verify script

```powershell
.\scripts\verify-live-e2e.ps1
# or with custom base URL:
.\scripts\verify-live-e2e.ps1 -BaseUrl http://localhost:3000
```

## Mock mode (offline)

```env
IRESS_MODE=mock
```

All 129+ unit tests pass without network. The UI uses seed data and local tick simulation.

## Full inventory

See [DATA_PROVENANCE.md](./DATA_PROVENANCE.md) for every surface and its status.
