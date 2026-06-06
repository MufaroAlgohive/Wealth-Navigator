# Quick Reference — IOS+

| Method | Updates | Notes |
|---|---|---|
| `ServiceSessionStart` | – | Service = `"IOSPlus"`, Server = e.g. `"IOSPLUSAPI"`. |
| `OrderCreate3` | – | Place order. |
| `OrderAmend2` | – | Amend order. |
| `OrderDelete` | – | Cancel order. |
| `OrderPadGetByAccount` / `…Updates` | yes | Per account. |
| `OrderPadGetByUser` / `…Updates` | yes | Per user. |
| `OrderPadGetByAccountGroup` / `…Updates` | yes | Per account group. |
| `OrderSearchGetByUser` | – | Wider filter. |
| `OrderSearchGetByAccount` | – | Per account, wider filter. |
| `OrderNoGetByOrderTag` | – | Lookup by tag (recovery). |
| `BookingGetByOrganisation2` | – | Bookings (fees). |
| `ETCGetByOrganisation` | – | Pre-trade cost. |
| `DestinationGet` | – | List destinations. |
| `DestinationDetailGet` | – | Inspect a destination. |
| `AttributeGetByUser` | – | Order-entry attributes. |
| `SessionRequestEnd` | – | End a specific request. |

See [`../../05-services/iosplus/`](../../05-services/iosplus/).
