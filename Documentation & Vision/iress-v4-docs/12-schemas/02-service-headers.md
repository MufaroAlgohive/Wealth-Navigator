# Service-Specific Headers

## Iress Pro / Web Admin methods

Uses `SessionKey` (the Iress session token) in the header. No service session required.

| Methods | Service session? |
|---|---|
| `IRESSSessionStart` / `IRESSSessionEnd` | None — this is where you get the `SessionKey`. |
| `TimeSeriesGet2`, `PricingQuoteGet`, `PricingQuoteExGet`, `PricingTradeHistoricalGet`, etc. | None. |
| `DestinationGet`, `DestinationDetailGet`, `AttributeGetByUser` (these are technically IOS+ but called out in market-data context in the source PDF) | Service session required (IOS+). |

## IOS+

Service session required. `ServiceSessionStart(Service="IOSPlus", Server="<server>")` returns the `ServiceSessionKey`.

Header uses `ServiceSessionKey`.

## IPS

Service session required. `ServiceSessionStart(Service="IPS", Server="<server>")`.

Header uses `ServiceSessionKey`.

## FIX+

Service session required. `ServiceSessionStart(Service="FIXPlus", Server="<server>")`.

Header uses `ServiceSessionKey`.

## Header / token matrix

| Call | Header token |
|---|---|
| Iress Pro / Web Admin (no service) | `SessionKey` |
| IOS+ methods | `ServiceSessionKey` (from `ServiceSessionStart("IOSPlus", …)`) |
| IPS methods | `ServiceSessionKey` (from `ServiceSessionStart("IPS", …)`) |
| FIX+ methods | `ServiceSessionKey` (from `ServiceSessionStart("FIXPlus", …)`) |
| `IRESSSessionStart` itself | None (empty `SessionKey`) |
| `IRESSSessionEnd` | `SessionKey` (the one being ended) |
| `ServiceSessionStart` | `SessionKey` (the Iress parent) |
| `ServiceSessionEnd` | `ServiceSessionKey` (the one being ended) |

## See also

- [`01-common-header.md`](01-common-header.md)
- [`../02-protocol/01-requests.md`](../02-protocol/01-requests.md)
- [`../04-sessions/`](../04-sessions/)
