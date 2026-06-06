# Quick Reference — Contingent Orders

Contingent orders are placed with the same `OrderCreate3` method, just against a **CO destination** with the right `ExecutionInstructions`.

| CO Type | Destination sub-type | Key attributes (IS codes) |
|---|---|---|
| **FIXED CO** | `DestinationSubTypeNumber` 30–39 | `IS013`, `IS016`, `IS020`, `IS021`, `IS022`, `IS028`–`IS041` |
| **TRAILING CO** | `DestinationSubTypeNumber` 30–39 | `IS013`, `IS014`, `IS016`, `IS025`, `IS026`, `IS027`, `IS028`–`IS041` |
| **OCO** | `DestinationSubTypeNumber` 30–39 | `IS016` (read-only) |
| **IFDONE** | `DestinationSubTypeNumber` 30–39 | `IS016` (read-only); plus a parent-order reference |

| Discovery | Method | Notes |
|---|---|---|
| List destinations | `DestinationGet(AccessMode=0)` | User-accessible. |
| Inspect a destination | `DestinationDetailGet(Destination=…)` | Check `DestinationSubTypeNumber`. |
| Find CO destinations | Filter `DestinationSubTypeNumber` between `30` and `49`. | |
| List attributes | `AttributeGetByUser(AttributeCategoryNumber=8)` | Returns the IS-code set. |

See [`../../05-services/iosplus/contingent-orders/`](../../05-services/iosplus/contingent-orders/).
