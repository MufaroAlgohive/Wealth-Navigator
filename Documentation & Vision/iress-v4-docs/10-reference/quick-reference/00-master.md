# API Method Quick Reference

The complete set of V4 methods called out in the source PDF, by service.

## Iress Pro — Market Data & Web Admin

| Method | Service | Updates | Notes |
|---|---|---|---|
| `IRESSSessionStart` | Iress | – | Returns `IRESSSessionKey`. |
| `IRESSSessionEnd` | Iress | – | Ends the Iress session and all child service sessions. |
| `TimeSeriesGet2` | Iress | yes | Historical time series. |
| `PricingQuoteGet` | Iress | yes | Snapshot quote. |
| `PricingQuoteExGet` | Iress | (per WSDL) | Extended pricing. |
| `PricingTradeHistoricalGet` | Iress | (per WSDL) | Historical trades. |
| `AuditTrailGetByAccount` | Iress (via IPS service session) | – | Paging with bookmarks. |

## IOS+

| Method | Updates | Notes |
|---|---|---|
| `ServiceSessionStart` | – | Service = `"IOSPlus"`, Server = e.g. `"IOSPLUSAPI"`. |
| `OrderCreate3` | – | Place order. Use `OrderTag` for idempotency. |
| `OrderAmend2` | – | Amend. |
| `OrderDelete` | – | Cancel. |
| `OrderPadGetByAccount` (+ Updates) | yes | Per account. |
| `OrderPadGetByUser` (+ Updates) | yes | Per user. |
| `OrderPadGetByAccountGroup` (+ Updates) | yes | Per account group. |
| `OrderSearchGetByUser` | – | Wider filter. |
| `OrderSearchGetByAccount` | – | Per account, wider filter. |
| `OrderNoGetByOrderTag` | – | Recovery lookup. |
| `BookingGetByOrganisation2` | – | Fetch bookings (fees, settlement). |
| `ETCGetByOrganisation` | – | Pre-trade cost estimates. |
| `DestinationGet` | – | List destinations. |
| `DestinationDetailGet` | – | Inspect destination (incl. `DestinationSubTypeNumber` for COs). |
| `AttributeGetByUser` | – | List order-entry attributes. `AttributeCategoryNumber` = `5` (algo) or `8` (IS/CO). |
| `SessionRequestEnd` | – | End a specific request. |

## FIX+

| Method | Updates | Notes |
|---|---|---|
| `ServiceSessionStart` | – | Service = `"FIXPlus"`. |
| `TargetIDGet` | – | List FIX+ targets. |
| `TargetIDStatusGet` | – | Check if a target is logged in. |

## IPS

| Method | Updates | Notes |
|---|---|---|
| `ServiceSessionStart` | – | Service = `"IPS"`. |
| `IPSAccountGetAll1` | – | **Legacy** paging in parameters. |
| `IPSPositionGetAll1` | – | **Legacy** paging in parameters. |
| `IPSTransactionGetByAccount5` | – | **Modern** header-level paging. |
| `IPSUploadCreate1` | – | Create upload. |
| `IPSUploadDataSet1` | – | Push data rows. |
| `IPSUploadRun1` | – | Run upload. |
| `IPSUploadSummaryGet2` | – | Get summary. |
| `IPSUploadErrorGet1` | – | Get per-row errors. |

> The methods above are the ones called out in the source PDF. The live WSDL will expose many more. Re-generate your WSDL to see the full list — see [`../../01-foundations/03-endpoints.md`](../../01-foundations/03-endpoints.md).

## Per-service detail

- [`01-iress-pro.md`](01-iress-pro.md)
- [`02-iosplus.md`](02-iosplus.md)
- [`03-contingent-orders.md`](03-contingent-orders.md)
- [`04-fixplus.md`](04-fixplus.md)
- [`05-ips.md`](05-ips.md)
