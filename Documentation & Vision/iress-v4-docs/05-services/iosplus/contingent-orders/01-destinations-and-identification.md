# IOS+ Contingent Orders — Destinations & Identification

A **Contingent Order (CO)** is an order that becomes active based on the state of another order. The four CO destination types are: **FIXED CO**, **TRAILING CO**, **OCO**, **IFDONE**.

Contingent orders are **not** separate methods — they're a flavour of `OrderCreate3` / `OrderAmend2` / `OrderDelete` that targets a **CO destination** (and sets the appropriate `ExecutionInstructions`).

- **Service:** IOS+.
- **Header token:** `ServiceSessionKey`.
- **Methods used:** `OrderCreate3`, `OrderAmend2`, `OrderDelete`, `OrderPadGetBy*`, `OrderSearchGetBy*`.

## How to identify CO destinations

### 1. Call `DestinationGet`

```
DestinationGet(AccessMode = 0)
  → list of destinations the user has access to
```

`AccessMode = 0` returns destinations the user can access.

### 2. Call `DestinationDetailGet` for each

```
DestinationDetailGet(Destination = "<dest>")
  → details including DestinationSubTypeNumber
```

### 3. Filter on `DestinationSubTypeNumber`

| Range | Type |
|---|---|
| `30` – `49` | **Contingent order** destinations. |
| (other) | Non-CO (regular, algo, etc.). |

> If the `DestinationDetailGet` method is not entitled (requires "view destination" permission), maintain the list of CO destination codes in the calling application and skip the discovery step.

## When to use the discovery flow

| Scenario | Approach |
|---|---|
| First-time setup, environment changed, or destination list unknown | Run `DestinationGet` + `DestinationDetailGet`, cache the result. |
| Production, stable env, known destination codes | Hardcode the list; refresh weekly. |
| Multi-tenant with different destination entitlements per user | Always discover per-user; cache with the user id as key. |

## The four CO destinations

| Destination | Trigger | Common use |
|---|---|---|
| **FIXED CO** | Trigger when a contingency security's price reaches a fixed level relative to a base. | "If SHP > R 250, buy 1 000 SHP at R 251." |
| **TRAILING CO** | Trigger when a contingency security's price moves a fixed amount / percentage off a base. | "If SHP moves up R 5 from its base, sell 1 000 SHP." |
| **OCO** | One-Cancels-Other: one of two orders fills → cancel the other. | "Buy limit at R 250, OR sell stop at R 240 — whichever hits first cancels the other." |
| **IFDONE** | If-Done: child order activates only when parent fully or partially fills. | Parent BUY → child SELL (bracket / take-profit). |

Each destination accepts a different set of order attributes (`IS013`–`IS041`). See [`02-attributes.md`](02-attributes.md) and the per-destination pages.

## Execution instructions

The CO attributes are passed via `ExecutionInstructions` (or the dictionary form) on the `OrderCreate3` call:

```ts
_OrderCreate3Input.Parameters.ExecutionInstructionsArray = new string[] {
  "IS013(Security.Exchange)",        // Contingency security's exchange
  "IS020(Last)",                     // Base price type
  "IS021(Greater or Equal)",         // Condition
  "IS022(250.00)",                   // Trigger price
  "IS041(trader@mint.co.za)"         // Notification email
};
```

> The exact format (single string, array of `Key(Value)` strings, or dictionary) is method-specific. See [`../order-attributes/01-is-attributes.md`](../order-attributes/01-is-attributes.md).

## See also

- [`02-attributes.md`](02-attributes.md) — the full IS013–IS041 attribute set.
- [`03-fixed-co.md`](03-fixed-co.md) — FIXED CO.
- [`04-trailing-co.md`](04-trailing-co.md) — TRAILING CO.
- [`05-oco.md`](05-oco.md) — OCO.
- [`06-ifdone.md`](06-ifdone.md) — IFDONE.
- [`07-take-profit.md`](07-take-profit.md) — practical take-profit pattern (IFDONE + AUTODESK + FIXED CO).
