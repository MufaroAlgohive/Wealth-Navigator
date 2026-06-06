# IOS+ — OrderPadGetByAccount & Updates

`OrderPadGetByAccount` (and its sibling variants `OrderPadGetByUser`, `OrderPadGetByAccountGroup`, etc.) returns a snapshot of the order pad for the given account. The matching `OrderPadGetByAccountUpdates` long-polls updates for the same set of orders.

- **Service:** IOS+.
- **Header token:** `ServiceSessionKey`.
- **Updates support:** Yes — pair with `OrderPadGetByAccountUpdates`.
- **Paging:** No (the order pad is small for a single account).
- **Scope for Mint:** the OMS order-blotter, the working-orders list, the live order-state stream.

## Method index

| Method | Filter |
|---|---|
| `OrderPadGetByAccount` | Per account. |
| `OrderPadGetByAccountUpdates` | Per account. |
| `OrderPadGetByUser` | Per user (across all accounts the user can see). |
| `OrderPadGetByUserUpdates` | Per user. |
| `OrderPadGetByAccountGroup` | Per account group. |
| `OrderPadGetByAccountGroupUpdates` | Per account group. |
| `OrderSearchGetByUser` | Wider filter set, typically slower. |
| `OrderSearchGetByAccount` | Per account, wider filter set. |

The method used to **filter** the orders is independent of the method used to **watch** for updates. For account-level display, use `OrderPadGetByAccount` + `OrderPadGetByAccountUpdates` with the **same** `RequestID`.

## `OrderPadGetByAccount` — key parameters

| Name | Type | Description |
|---|---|---|
| `AccountCode` | string | The IPS account code. |
| `OrderFilter` | enum | One of: `5` = active orders, `6` = today + yesterday, `7` = today. The PDF is explicit: use `5` for the active-only snapshot and avoid overlap with the inactive search. |
| `IncludeInactive` | bool | If true, returns inactive orders too. |
| … | … | Other filters per the WSDL. |

## Updates pair

| Method | Pairs with |
|---|---|
| `OrderPadGetByAccount` | `OrderPadGetByAccountUpdates` |
| `OrderPadGetByUser` | `OrderPadGetByUserUpdates` |
| `OrderPadGetByAccountGroup` | `OrderPadGetByAccountGroupUpdates` |

**Same `RequestID` is required** across the data call and the updates call.

## Recovery pattern (recommended)

The source PDF is explicit about a two-step reconciliation at startup / recovery:

### Step 1 — retrieve active orders and start watching

```text
OrderPadGetByAccount(
  AccountCode = "...",
  OrderFilter = 5,             // active only
  Updates = true,
  RequestID = R1
)
```

Page through the snapshot (rarely needed) until `StatusCode = 3`. Then long-poll `OrderPadGetByAccountUpdates(RequestID=R1)`.

> Don't use `OrderFilter=6` (today + yesterday) or `7` (today) here — it produces a large overlap with the existing updates stream and slows down recovery.

### Step 2 — retrieve inactive orders since last known

```text
OrderSearchGetByUser(
  DateTimeFrom = <latest known record timestamp>,
  OrderState = 3                // inactive only
)
```

### Overlap handling

Orders can transition from `ACTIVE` to `INACTIVE` between step 1 and step 2. The client must:

- Process updates from step 1 first.
- For each row in step 2, check if it's already been seen via step 1's updates. If yes, drop.
- For each update from step 1, check if it's already in the step 2 result. If yes, drop.

The order of arrival is **non-deterministic** — handle duplicates symmetrically.

## Sample payload

Request:
```xml
<OrderPadGetByAccount xmlns="http://webservices.iress.com.au/v4/">
  <Input>
    <Header>
      <ServiceSessionKey>ef0123ab-...@WebServicesTestA.iress.com.au</ServiceSessionKey>
      <RequestID>R-orders-1</RequestID>
      <Updates>true</Updates>
      <Timeout>25</Timeout>
      <PageSize>0</PageSize>
      <WaitForResponse>true</WaitForResponse>
      <PagingBookmark/>
      <PagingDirection>0</PagingDirection>
    </Header>
    <Parameters>
      <AccountCode>MINT-LIVE-001</AccountCode>
      <OrderFilter>5</OrderFilter>
    </Parameters>
  </Input>
</OrderPadGetByAccount>
```

The first response carries the snapshot; subsequent responses with `StatusCode = 3` mean the updates stream is live. Switch to `OrderPadGetByAccountUpdates`.

## Mint OEMS — UI plumbing

```
   ┌────────────────────────────┐
   │   OrderPadGetByAccount     │   ← snapshot at startup / reconnect
   │   Updates=true, RID=R1     │
   └─────────────┬──────────────┘
                 ▼
   ┌────────────────────────────┐
   │   OrderPadGetByAccount-    │   ← long-poll
   │   Updates(RID=R1)          │
   └─────────────┬──────────────┘
                 ▼
            UI updates
                 ▼
   ┌────────────────────────────┐
   │   OrderSearchGetByUser     │   ← daily reconciliation
   │   DateTimeFrom=…           │      (separate process)
   │   OrderState=3             │
   └────────────────────────────┘
```

- The order blotter view subscribes to step 1 + the updates stream.
- The reconciliation job runs step 2 on a schedule and emits exceptions when it disagrees with the live state.

## See also

- [`01-order-create-amend-cancel.md`](01-order-create-amend-cancel.md) — to place / amend / cancel.
- [`../../07-recovery/04-iosplus-order-retrieval-recovery.md`](../../07-recovery/04-iosplus-order-retrieval-recovery.md) — full recovery flow.
- [`../../03-paging-and-updates/03-updates.md`](../../03-paging-and-updates/03-updates.md) — the long-polling pattern.
