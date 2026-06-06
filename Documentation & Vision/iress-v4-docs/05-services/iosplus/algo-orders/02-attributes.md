# IOS+ External Algo Orders — Attributes (External Algo Properties)

External algo attributes are a **subset of `ExecutionInstructions`** that configure the specific algorithm and its parameters. They are set via the `ExecutionInstructions` (or `ExecutionInstructionsDictionary`) parameter on `OrderCreate3` / `OrderAmend2`, and surfaced as an output column on `OrderPadGetBy*` / `OrderSearchGetBy*`.

- **Service:** IOS+.
- **Header token:** `ServiceSessionKey`.

## Discovery

### Option A — read what the front-end does

1. Create an algo order in Iress Pro against the algo destination.
2. Call `OrderPadGetByAccount` to retrieve it.
3. Observe the `ExecutionInstructions` values — these are the external algo attributes for that destination.

### Option B — call `AttributeGetByUser`

```
AttributeGetByUser(AttributeCategoryNumber = 5)
  → attributes in the External Algo Properties category
```

| Category number | Meaning |
|---|---|
| 5 | **External Algo Properties** |
| 8 | Iress Strategy Properties (contingent orders — see [`../contingent-orders/02-attributes.md`](../contingent-orders/02-attributes.md)) |
| (others) | Per the WSDL |

## Example (C# from source PDF)

```csharp
// External Algo Properties are a subset of ExecutionInstructions and are supported in this field.
_OrderCreate3Input.Parameters.ExecutionInstructionsArray = new string[] {
    "7000(MyStrategy)",
    "9006(7:30:00 AM)"
};
```

- `7000(...)` selects the **strategy** (e.g. `MyStrategy`).
- `9006(...)` selects the **start time** (e.g. `7:30:00 AM`).

> The exact set of attribute codes (7000, 9006, …) is destination-specific. The PDF uses 7000/9006 as illustrative; confirm with the WSDL and the algo vendor.

## Per-destination vs per-vendor

Each algo destination (one per algorithm / per broker config) may accept a different attribute set. **Always discover per destination** — the same `7000` may mean different things on different destinations.

## See also

- [`01-destinations.md`](01-destinations.md) — finding algo destinations.
- [`../contingent-orders/02-attributes.md`](../contingent-orders/02-attributes.md) — the CO attribute counterpart.
- [`../order-attributes/02-attribute-get-by-user.md`](../order-attributes/02-attribute-get-by-user.md) — `AttributeGetByUser` reference.
