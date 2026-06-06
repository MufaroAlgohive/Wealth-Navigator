# IOS+ External Algo Orders — Destinations

An **external algo order** is an order routed to a third-party execution algorithm (e.g. a broker VWAP, TWAP, POV, or custom algo). Like contingent orders, algos are a flavour of `OrderCreate3` / `OrderAmend2` / `OrderDelete` that targets an **algo destination**.

- **Service:** IOS+.
- **Header token:** `ServiceSessionKey`.
- **Methods used:** `OrderCreate3`, `OrderAmend2`, `OrderDelete`, `OrderPadGetBy*`, `OrderSearchGetBy*`.

## How to identify algo destinations

Algo destinations are visible in **IOS+ Administration** with:

- `Destination type = "EXTERNAL ALGO"`
- `Destination property Algo = enabled`

To discover them programmatically:

1. Call `DestinationGet(AccessMode = 0)` to list destinations the user can access.
2. Call `DestinationDetailGet(Destination = "<dest>")` for each.
3. Filter on:
   - `DestinationType = "EXTERNAL ALGO"`
   - `DestinationPropertiesMask` contains the `Algo` bit (value `256`).

> If the `DestinationDetailGet` method isn't entitled (requires "view destination" permission), maintain the list of algo destination codes in the calling app.

## Bitmask check

`DestinationPropertiesMask` is a bitmask. Bit `256` (2^8) indicates the `Algo` property is enabled.

```ts
function isAlgoDestination(mask: number): boolean {
  return (mask & 256) === 256;
}
```

## After identifying

Once you have the algo destination code and its supported properties (see [`02-attributes.md`](02-attributes.md)), you can place orders against it with `OrderCreate3` and the appropriate `ExecutionInstructions` set.

## See also

- [`02-attributes.md`](02-attributes.md) — order attributes (external algo properties).
- [`../contingent-orders/01-destinations-and-identification.md`](../contingent-orders/01-destinations-and-identification.md) — analogous CO flow.
- [`../01-order-create-amend-cancel.md`](../01-order-create-amend-cancel.md) — the underlying order methods.
