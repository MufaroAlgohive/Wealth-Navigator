# South Africa Endpoints & Environment Strategy

## Endpoints

| Env | URL | Use |
|---|---|---|
| **Production** | `https://webservices.iress.co.za/v4` | Live JSE / ZAR / SARB. |
| **Production test** | `https://webservices-ct.iress.co.za/v4` | Cape Town test. Pre-prod / staging / load-test. |

> Don't use the Australian test endpoints (`webservicestesta/b/c.iress.com.au`) for SA-market work — the data is for ASX, the fees, holidays, and settlement are all AU.

## Environment strategy

| Stage | Endpoint | Purpose | Credentials |
|---|---|---|---|
| **Dev** | SA prod-test (`webservices-ct`) | Day-to-day dev. Use a non-prod user/login. | IRESS dev creds. |
| **CI / automated tests** | SA prod-test | Headless runs. Provision a service account. | IRESS CI creds. |
| **Staging / pre-prod** | SA prod-test | Final integration, performance, UAT. | IRESS staging creds. |
| **Load test** | SA prod-test | At-scale, soak tests. Coordinate with IRESS for capacity windows. | IRESS load creds. |
| **Production** | SA prod (`webservices`) | Live trading. | IRESS prod creds. |

## Capacity & rate limits

V4 is not published with explicit per-second or per-minute rate limits; limits are enforced via the **active requests per session** cap (50) and the **active sessions** cap (20 000 server-wide). For load testing:

- Coordinate with IRESS to provision a dedicated server / capacity.
- Plan for ~50 concurrent in-flight requests per Iress session as the hard ceiling.
- If you need more, open more Iress sessions (one per "worker").

## Application IDs

Use **distinct, traceable `ApplicationID`s** per environment:

| Env | Pattern |
|---|---|
| Dev | `Mint-OEMS-Dev-<node>-<guid>` |
| Staging | `Mint-OEMS-Staging-<node>-<guid>` |
| Load test | `Mint-OEMS-LoadTest-<node>-<guid>` |
| Production | `Mint-OEMS-Prod-<node>-<guid>` |

This makes orphan-session cleanup trivial in IRESS admin.

## WSDL version strategy

> See [`../09-compatibility/01-wsdl-compatibility.md`](../09-compatibility/01-wsdl-compatibility.md).

- Save the WSDL **per environment, per date**. `wsdl/iress-prod-2025-01-15.wsdl`, etc.
- Diff on every WSDL refresh.
- Test in dev/staging first, then promote.

## Service name conventions

- The `Server` parameter for `ServiceSessionStart` is **environment-specific**. Confirm with your IRESS contact — common values include `IOSPLUSAPI`, `IPSAPI`, `FIXPLUSAPI`, but may differ.
- Make this configurable, not hardcoded.

## See also

- [`../01-foundations/03-endpoints.md`](../01-foundations/03-endpoints.md) — full endpoint list.
- [`../09-compatibility/01-wsdl-compatibility.md`](../09-compatibility/01-wsdl-compatibility.md) — WSDL handling.
