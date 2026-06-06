# Suggested Call Graph for a JSE Order (Mint OEMS)

End-to-end flow for **placing one JSE equity order** through the Mint OEMS. Every step names the V4 method and points to the doc.

## 1. Session bring-up (per OEMS node / user login)

```
IRESSSessionStart(UserName, CompanyName, Password, ApplicationID, Locale="en-ZA", SessionTimeout=120)
  → IRESSSessionKey (K1)
ServiceSessionStart(IRESSSessionKey=K1, Service="IOSPlus", Server="IOSPLUSAPI")
  → ServiceSessionKey (S1)
ServiceSessionStart(IRESSSessionKey=K1, Service="IPS", Server="IPSAPI")
  → ServiceSessionKey (S2)
```

Docs:
- [`../04-sessions/01-iress-sessions.md`](../04-sessions/01-iress-sessions.md)
- [`../04-sessions/02-service-sessions.md`](../04-sessions/02-service-sessions.md)

## 2. Pre-trade pricing

```
PricingQuoteGet(SecurityCode="SHP", Exchange="JSE")
  → last, bid, ask, etc.
```

If the user has bound a streaming subscription, this is already up; if not, just snapshot.

Docs:
- [`../05-services/market-data/03-pricing-quote-get.md`](../05-services/market-data/03-pricing-quote-get.md)

## 3. Compliance / pre-flight

Out of V4 scope — Mint OEMS responsibility. Use the price + account config to enforce:
- Fat-finger checks.
- Buying-power / exposure checks.
- Restricted-list checks.
- Any client-specific rules.

## 4. Order placement

```
OrderCreate3(
  ServiceSessionKey=S1,
  Order={
    AccountCode="MINT-LIVE-001",
    SecurityCode="SHP", Exchange="JSE",
    BuySell=1, OrderType="LMT",
    Volume=1000, Price=250.50,
    Destination="JSE",
    TimeInForce="DAY",
    OrderTag="mint-ord-<uuid>"        // idempotency!
  }
)
  → OrderNumber=JSE-...
```

Docs:
- [`../05-services/iosplus/01-order-create-amend-cancel.md`](../05-services/iosplus/01-order-create-amend-cancel.md)
- [`../07-recovery/05-iosplus-order-creation-recovery.md`](../07-recovery/05-iosplus-order-creation-recovery.md)

## 5. Order watching (state updates)

```
OrderPadGetByAccount(
  ServiceSessionKey=S1,
  AccountCode="MINT-LIVE-001",
  OrderFilter=5,                       // active only
  Updates=true,
  RequestID=R1
)
-- Page until StatusCode=3, then:
OrderPadGetByAccountUpdates(RequestID=R1)  -- long-poll loop
```

Or, per-user:
```
OrderPadGetByUser(Updates=true, RequestID=R2) → ...
OrderPadGetByUserUpdates(RequestID=R2)
```

Docs:
- [`../05-services/iosplus/02-order-pad.md`](../05-services/iosplus/02-order-pad.md)
- [`../03-paging-and-updates/03-updates.md`](../03-paging-and-updates/03-updates.md)

## 6. Amend / cancel

```
OrderAmend2(ServiceSessionKey=S1, OrderNumber=JSE-..., Volume=1500)  // bump qty
OrderDelete(ServiceSessionKey=S1, OrderNumber=JSE-...)                // cancel
```

Docs:
- [`../05-services/iosplus/01-order-create-amend-cancel.md`](../05-services/iosplus/01-order-create-amend-cancel.md)

## 7. Fill → Booking → Reconciliation

When the order pad shows `FILLED`:

```
BookingGetByOrganisation2(ServiceSessionKey=S1, …)
  → DataRow with BookingNumber, TradeNumber, MiscFees[], …
```

For EOD reconciliation:

```
IPSTransactionGetByAccount5(
  ServiceSessionKey=S2,
  AccountCode="MINT-LIVE-001",
  DateFrom=…, DateTo=…
)  → transaction history; reconcile with the OEMS book
```

Docs:
- [`../05-services/iosplus/03-bookings.md`](../05-services/iosplus/03-bookings.md)
- [`../05-services/ips/01-transactions.md`](../05-services/ips/01-transactions.md)

## 8. Session tear-down (on shutdown / user logout)

```
ServiceSessionEnd(ServiceSessionKey=S1)
ServiceSessionEnd(ServiceSessionKey=S2)
IRESSSessionEnd(IRESSSessionKey=K1)
```

Docs:
- [`../04-sessions/01-iress-sessions.md`](../04-sessions/01-iress-sessions.md)
- [`../04-sessions/02-service-sessions.md`](../04-sessions/02-service-sessions.md)

## Full call graph (compact)

```
[startup]
  IRESSSessionStart ──────────────────► K1
    ├─► ServiceSessionStart("IOSPlus") ─► S1 ──► OrderCreate3 ──► OrderNumber
    │                                          └─► OrderAmend2
    │                                          └─► OrderDelete
    │                                          └─► OrderPadGetByAccount(Updates=true) ─┐
    │                                          └─► OrderPadGetByAccountUpdates ◄──────┘
    │                                          └─► BookingGetByOrganisation2
    │                                          └─► DestinationGet / DestinationDetailGet
    │                                          └─► AttributeGetByUser
    │
    └─► ServiceSessionStart("IPS")    ─► S2 ──► IPSTransactionGetByAccount5
                                               └─► IPSAccountGetAll1 (legacy paging)
                                               └─► IPSPositionGetAll1 (legacy paging)
                                               └─► IPSUploadCreate1 → DataSet1 → Run1 → SummaryGet2 / ErrorGet1
[shutdown]
  ServiceSessionEnd(S1), ServiceSessionEnd(S2), IRESSSessionEnd(K1)
```

## Recovery overlay (drawn on top of the call graph)

```
any call ──(25006/25009/25019/25033)──► ServiceSessionStart (rebuild S1 or S2)
                                        └─► continue with new key

any call ──(25014/25019/25022)────────► IRESSSessionStart (rebuild K1)
                                        └─► ServiceSessionStart (rebuild all children)
                                        └─► continue with new keys
```

See [`../07-recovery/`](../07-recovery/) for the full pattern catalogue.
