# IOS+ Order Attributes (Iress Strategy Properties — IS013–IS041)

Single-page reference for the **`ISxxx`** order attributes used by contingent orders. (External algo attributes use their own vendor-defined codes — see [`../algo-orders/02-attributes.md`](../algo-orders/02-attributes.md).)

The full set is method-/destination-specific. The table below is the subset the source PDF enumerates; the live IOS+ admin may have more.

| Code | Name | Type | Values | Used by |
|---|---|---|---|---|
| `IS013` | Contingency security (exchange) | string | `Security.Exchange` | FIXED CO, TRAILING CO |
| `IS014` | Contingency base price (TRAILING) | string | `Last` | TRAILING CO |
| `IS016` | Contingent order status | string (STI) | `Active`, `Triggered`, `Deleted`, `Pre-Active` | all COs |
| `IS020` | Contingency base price (FIXED) | string | `Last`, `Bid`, `Ask` | FIXED CO |
| `IS021` | Condition | string | `Greater`, `Less`, `Equal`, `Greater or Equal`, `Less or Equal` | FIXED CO |
| `IS022` | Price | float | trigger price | FIXED CO |
| `IS025` | Trailing type | string | `Price`, `Percentage` | TRAILING CO |
| `IS026` | Trailing direction | string | `Above the base price`, `Below the base price` | TRAILING CO |
| `IS027` | Trailing offset | float | | TRAILING CO |
| `IS028` | Email on trigger | bool | | FIXED CO, TRAILING CO |
| `IS029` | Email on partial trade | bool | | FIXED CO, TRAILING CO |
| `IS030` | Email on full trade | bool | | FIXED CO, TRAILING CO |
| `IS031` | Emailed on failed | bool | | FIXED CO, TRAILING CO |
| `IS032` | Email on expiry | bool | | FIXED CO, TRAILING CO |
| `IS034` | Email on untraded order | bool | | FIXED CO, TRAILING CO |
| `IS035` | Audit trail trigger event | bool | | FIXED CO, TRAILING CO |
| `IS036` | Audit trail partial trade | bool | | FIXED CO, TRAILING CO |
| `IS037` | Audit trail full trade | bool | | FIXED CO, TRAILING CO |
| `IS038` | Audit trail failed | bool | | FIXED CO, TRAILING CO |
| `IS039` | Audit trail expiry | bool | | FIXED CO, TRAILING CO |
| `IS040` | Audit trail untraded order | bool | | FIXED CO, TRAILING CO |
| `IS041` | Email address | string | | FIXED CO, TRAILING CO |

## Setting attributes on order entry

Pass them via `ExecutionInstructions` or `ExecutionInstructionsDictionary` on `OrderCreate3` / `OrderAmend2`. The exact format depends on the parameter type:

- `ExecutionInstructions` (string array): each element is a `Key(Value)` string, e.g. `"IS022(250.00)"`.
- `ExecutionInstructionsDictionary` (key/value structure): use the structured form.

The example from the source PDF:

```csharp
_OrderCreate3Input.Parameters.ExecutionInstructionsArray = new string[] {
    "7000(MyStrategy)",        // external algo — not an IS code
    "9006(7:30:00 AM)"
};
```

## Discovery

See [`02-attribute-get-by-user.md`](02-attribute-get-by-user.md) for `AttributeGetByUser` (use `AttributeCategoryNumber = 8` for the IS set).

## See also

- [`../contingent-orders/02-attributes.md`](../contingent-orders/02-attributes.md) — narrative for CO attributes.
- [`../algo-orders/02-attributes.md`](../algo-orders/02-attributes.md) — external algo attribute counterpart.
