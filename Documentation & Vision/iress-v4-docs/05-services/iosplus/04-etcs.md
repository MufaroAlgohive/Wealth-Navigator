# IOS+ — ETCs (ETCGetByOrganisation)

`ETCGetByOrganisation` returns the **Estimated Trade Cost** snapshot for an organisation — pre-trade cost estimates, used by traders to gauge all-in cost before placing an order.

- **Service:** IOS+.
- **Header token:** `ServiceSessionKey`.
- **Updates support:** No (snapshot).
- **Paging:** Yes.

> The PDF mentions this method as part of the IOS+ surface but does not detail parameters. Confirm with the WSDL. The standard shape is: organisation code, optional account filter, optional date range.

## Mint OEMS — usage notes

- Useful for **pre-trade cost transparency** — show the user the expected fees/commissions before they commit.
- Pair with `OrderPadGetByAccountUpdates` to track the actual booking after fill, and reconcile expected vs actual.
- ETCs are typically recomputed intra-day as the market data and fee schedule update.

## See also

- [`03-bookings.md`](03-bookings.md) — the post-fill view.
- [`05-misc-fees-reference.md`](05-misc-fees-reference.md) — the fee model.
