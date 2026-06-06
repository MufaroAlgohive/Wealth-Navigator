# IOS+ Contingent Orders — Attributes (Iress Strategy Properties)

The order attributes used for contingent orders are exposed as **`ISxxx`** codes in the Iress Strategy Properties block (visible in IOS+ Order Entry). They are set via the `ExecutionInstructions` (or `ExecutionInstructionsDictionary`) parameter on `OrderCreate3` / `OrderAmend2`.

The exact set supported by each CO destination varies. The source PDF provides the table below (subset of the full attribute catalogue); the live IOS+ admin may have more.

| Attribute | Description | Type | List values |
|---|---|---|---|
| `IS013` | Contingency security (exchange) | string | e.g. `Security.Exchange` |
| `IS014` | Contingency base price (TRAILING CO) | string | `Last` |
| `IS016` | Contingent order status | string (set by STI) | `Active`, `Triggered`, `Deleted`, `Pre-Active` |
| `IS020` | Contingency base price (FIXED CO) | string | `Last`, `Bid`, `Ask` |
| `IS021` | Condition | string | `Greater`, `Less`, `Equal`, `Greater or Equal`, `Less or Equal` |
| `IS022` | Price | float | trigger price |
| `IS025` | Trailing type (TRAILING CO) | string | `Price`, `Percentage` |
| `IS026` | Trailing direction (TRAILING CO) | string | `Above the base price`, `Below the base price` |
| `IS027` | Trailing offset (TRAILING CO) | float | |
| `IS028` | Email on trigger | bool | |
| `IS029` | Email on partial trade | bool | |
| `IS030` | Email on full trade | bool | |
| `IS031` | Emailed on failed | bool | |
| `IS032` | Email on expiry | bool | |
| `IS034` | Email on untraded order | bool | |
| `IS035` | Audit trail trigger event | bool | |
| `IS036` | Audit trail partial trade | bool | |
| `IS037` | Audit trail full trade | bool | |
| `IS038` | Audit trail failed | bool | |
| `IS039` | Audit trail expiry | bool | |
| `IS040` | Audit trail untraded order | bool | |
| `IS041` | Email address | string | |

## Discovering attributes per destination

Two options:

### Option A — read what the front-end does

1. Create an order in Iress Pro or ViewPoint against the CO destination.
2. Call `OrderPadGetByAccount` to retrieve it.
3. Observe the `ExecutionInstructions` values — these are the CO attributes for that destination.

### Option B — call `AttributeGetByUser`

```
AttributeGetByUser(AttributeCategoryNumber = 8)
  → attributes in the Iress Strategy Properties category
```

| Category number | Meaning |
|---|---|
| 5 | External Algo Properties (see [`../algo-orders/02-attributes.md`](../algo-orders/02-attributes.md)) |
| 8 | Iress Strategy Properties (contingent order attributes) |
| (others) | Per the WSDL |

## Per-destination attribute sets

- [FIXED CO](03-fixed-co.md) — IS013, IS016, IS020–IS022, IS028–IS041.
- [TRAILING CO](04-trailing-co.md) — IS013, IS014, IS016, IS025–IS027, IS028–IS041.
- [OCO](05-oco.md) — IS016 only (read-only status flag).
- [IFDONE](06-ifdone.md) — IS016 only (read-only status flag).

## See also

- [`01-destinations-and-identification.md`](01-destinations-and-identification.md) — how to find CO destinations.
- [`../order-attributes/01-is-attributes.md`](../order-attributes/01-is-attributes.md) — full attribute catalog.
- [`../order-attributes/02-attribute-get-by-user.md`](../order-attributes/02-attribute-get-by-user.md) — `AttributeGetByUser` reference.
