# AttributeGetByUser

Returns the list of order-entry attributes a user is entitled to. The `AttributeCategoryNumber` filter narrows to a specific attribute set.

- **Service:** IOS+.
- **Header token:** `ServiceSessionKey`.
- **Updates support:** No.
- **Paging:** Confirm with the WSDL.

## Parameters

| Name | Type | Description |
|---|---|---|
| `AttributeCategoryNumber` | int | See categories below. |
| (other filters) | various | Per the WSDL. |

## Attribute categories

| `AttributeCategoryNumber` | Category | Used for |
|---|---|---|
| `5` | External Algo Properties | [`../algo-orders/02-attributes.md`](../algo-orders/02-attributes.md) |
| `8` | Iress Strategy Properties | [`../contingent-orders/02-attributes.md`](../contingent-orders/02-attributes.md) (IS013–IS041) |
| (others) | Per the WSDL | |

## Return value

A list of attribute definitions — typically:

- `AttributeCode` (the `ISxxx` or `7xxx` code)
- `AttributeName` (display name)
- `AttributeType` (string, int, bool, float, enum)
- `ListValues` (for enums)
- `Description`

Use the list to build the UI for order entry, and to validate the `ExecutionInstructions` you set on `OrderCreate3`.

## See also

- [`01-is-attributes.md`](01-is-attributes.md) — the IS set.
- [`../algo-orders/02-attributes.md`](../algo-orders/02-attributes.md) — algo attributes.
