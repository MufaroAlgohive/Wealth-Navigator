# IOS+ — Order Create / Amend / Cancel

Three methods that form the heart of the trading surface: place a new order, modify an existing order, and cancel an order. All are "set" methods, all return per-row error info on bulk calls.

- **Service:** IOS+ (service session required).
- **Header token:** `ServiceSessionKey`.

## Method index

| Method | What it does | Updates? |
|---|---|---|
| `OrderCreate3` | Place a new order (equity, derivative, contingent, algo, FIX, etc.). Supports bulk. | No |
| `OrderAmend2` | Amend an existing order. The source PDF only explicitly describes a simple volume amend; in practice the method supports a wide range of attribute changes. Supports bulk. | No |
| `OrderDelete` | Cancel an order. Supports bulk. | No |

> After placing / amending / cancelling, subscribe to `OrderPadGetByAccountUpdates` (or per-user variant) to track state changes. The order management methods themselves are not subscription endpoints.

## `OrderCreate3`

### Parameters (key fields)

| Name | Type | Required | Description |
|---|---|---|---|
| `AccountCode` | string | yes | The IPS account the order is for. |
| `SecurityCode` | string | yes | Iress security code. |
| `Exchange` | string | yes | e.g. `JSE`. |
| `BuySell` | enum | yes | `1` = Buy, `2` = Sell. (Confirm enum values with the WSDL.) |
| `OrderType` | enum | yes | `MKT` (market), `LMT` (limit), `STP` (stop), `STP_LMT` (stop-limit), etc. Confirm values with the WSDL. |
| `Volume` | long | yes | Quantity in security's unit. |
| `Price` | double | no | Limit price (for `LMT`, `STP_LMT`). |
| `StopPrice` | double | no | Stop trigger price (for `STP`, `STP_LMT`). |
| `Destination` | string | yes | The trading destination / venue code (e.g. `JSE`, `A2X`, `BSE_JSE`). |
| `TimeInForce` | enum | no | `DAY`, `GTC`, `IOC`, `FOK`, `GTD`. |
| `ExpiryDate` | date | no | Required for `GTD`. |
| `OrderTag` | string | recommended | A **unique** tag (e.g. the OEMS order id). Prevents double-sends. See [recovery notes](../../../07-recovery/05-iosplus-order-creation-recovery.md). |
| `ExecutionInstructions` | string array | no | Per the strategy / algo / CO / take-profit you want. See [order-attributes](order-attributes/01-is-attributes.md) and the [contingent-orders](contingent-orders/) and [algo-orders](algo-orders/) docs. |
| `ExecutionInstructionsDictionary` | string array | no | Alternate / structured form of `ExecutionInstructions`. Confirm with WSDL. |
| … | … | no | Many more per the WSDL. Confirm against the live WSDL. |

### Return value

Per `DataRow`:
- `OrderNumber` — the IOS+ order number.
- `OrderTag` — echoed back.
- `ErrorNumber`, `ErrorMessage` — non-zero / non-empty indicates failure.

On bulk calls, partial success is possible. Inspect every `DataRow`.

## `OrderAmend2`

### Parameters (key fields)

| Name | Type | Required | Description |
|---|---|---|---|
| `OrderNumber` | string | yes | The IOS+ order number to amend. |
| `Volume` | long | no | New total volume. |
| `Price` | double | no | New price. |
| `StopPrice` | double | no | New stop. |
| `TimeInForce` | enum | no | |
| `ExpiryDate` | date | no | |
| `ExecutionInstructions` | string array | no | Replace / modify strategy properties. |
| `OrderTag` | string | no | Replace the tag (use carefully — the uniqueness guard may flag). |
| … | … | no | Other fields per the WSDL. |

> The source PDF gives a "simple volume amend" example. The same method can amend more fields; check the WSDL for the full parameter list.

## `OrderDelete`

### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `OrderNumber` | string | yes | The IOS+ order number to cancel. |
| `AccountCode` | string | depends | Sometimes required. Confirm with WSDL. |

## Order states

The exact state machine is method-specific; the source PDF doesn't enumerate the full set, but the states surfaced in the order pad are typically:

| State | Meaning |
|---|---|
| `PENDING` | Submitted but not yet acknowledged by the destination. |
| `WORKING` | Live on the exchange. |
| `PARTIAL` | Partially filled. |
| `FILLED` | Fully filled. |
| `CANCELLED` | Cancelled (full or partial residual). |
| `REJECTED` | Rejected by destination. |
| `EXPIRED` | Time-in-force expired. |

> Confirm the exact state strings with the WSDL — they may be numeric codes (e.g. `OrderState = 3` for inactive) or text codes depending on the method.

## Sample payload — `OrderCreate3`

Request:
```xml
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <OrderCreate3 xmlns="http://webservices.iress.com.au/v4/">
      <Input>
        <Header>
          <ServiceSessionKey>ef0123ab-...@WebServicesTestA.iress.com.au</ServiceSessionKey>
          <RequestID>ord-1</RequestID>
          <Updates>false</Updates>
          <Timeout>25</Timeout>
          <PageSize>0</PageSize>
          <WaitForResponse>true</WaitForResponse>
          <PagingBookmark></PagingBookmark>
          <PagingDirection>0</PagingDirection>
        </Header>
        <Parameters>
          <Order>
            <AccountCode>MINT-LIVE-001</AccountCode>
            <SecurityCode>SHP</SecurityCode>
            <Exchange>JSE</Exchange>
            <BuySell>1</BuySell>
            <OrderType>LMT</OrderType>
            <Volume>1000</Volume>
            <Price>250.50</Price>
            <Destination>JSE</Destination>
            <TimeInForce>DAY</TimeInForce>
            <OrderTag>mint-ord-9f8e7d6c-...</OrderTag>
          </Order>
        </Parameters>
      </Input>
    </OrderCreate3>
  </soap:Body>
</soap:Envelope>
```

Response (excerpt — success):
```xml
<OrderCreate3Response xmlns="http://webservices.iress.com.au/v4/">
  <Output>
    <Result>
      <Header>
        <RequestID>ord-1</RequestID>
        <StatusCode>2</StatusCode>
        <WebServiceTimeStamp>2025-01-15T09:30:12</WebServiceTimeStamp>
        <PagingBookmark/>
      </Header>
      <DataRows>
        <DataRow>
          <OrderNumber>JSE-20250115-0001</OrderNumber>
          <OrderTag>mint-ord-9f8e7d6c-...</OrderTag>
          <ErrorNumber>0</ErrorNumber>
        </DataRow>
      </DataRows>
    </Result>
  </Output>
</OrderCreate3Response>
```

## Sample payload — `OrderAmend2` (simple volume amend)

```xml
<OrderAmend2 xmlns="http://webservices.iress.com.au/v4/">
  <Input>
    <Header>
      <ServiceSessionKey>ef0123ab-...@WebServicesTestA.iress.com.au</ServiceSessionKey>
      <RequestID>amd-1</RequestID>
      <Updates>false</Updates>
      <Timeout>25</Timeout>
      <PageSize>0</PageSize>
      <WaitForResponse>true</WaitForResponse>
      <PagingBookmark/>
      <PagingDirection>0</PagingDirection>
    </Header>
    <Parameters>
      <Order>
        <OrderNumber>JSE-20250115-0001</OrderNumber>
        <Volume>1500</Volume>
      </Order>
    </Parameters>
  </Input>
</OrderAmend2>
```

## Sample payload — `OrderDelete`

```xml
<OrderDelete xmlns="http://webservices.iress.com.au/v4/">
  <Input>
    <Header>
      <ServiceSessionKey>ef0123ab-...@WebServicesTestA.iress.com.au</ServiceSessionKey>
      <RequestID>del-1</RequestID>
      <Updates>false</Updates>
      <Timeout>25</Timeout>
      <PageSize>0</PageSize>
      <WaitForResponse>true</WaitForResponse>
      <PagingBookmark/>
      <PagingDirection>0</PagingDirection>
    </Header>
    <Parameters>
      <OrderNumber>JSE-20250115-0001</OrderNumber>
      <AccountCode>MINT-LIVE-001</AccountCode>
    </Parameters>
  </Input>
</OrderDelete>
```

## Bulk calls

All three methods support bulk — pass an array of `Order` elements. Per-row `ErrorNumber` / `ErrorMessage` distinguishes successes from failures. The OEMS should treat this as an atomic-from-the-client's-perspective but server-side-best-effort pattern: log per-row results, surface failures to the user.

## Idempotency (`OrderTag`)

> **Always populate `OrderTag`** with a unique value (e.g. the OEMS order id). If you retry within a small window (typically 5 minutes), the server will reject the second send with a duplicate-tag error rather than risk a double-fill. See [`../../07-recovery/05-iosplus-order-creation-recovery.md`](../../07-recovery/05-iosplus-order-creation-recovery.md).

## Mint OEMS — wrapper sketch

```ts
type Side = 'BUY' | 'SELL';
type OrderType = 'MKT' | 'LMT' | 'STP' | 'STP_LMT' | ...;

interface MintOrderRequest {
  mintOrderId: string;            // maps to OrderTag
  accountCode: string;
  securityCode: string;
  exchange: string;
  side: Side;
  orderType: OrderType;
  volume: number;
  price?: number;
  stopPrice?: number;
  destination: string;
  timeInForce: 'DAY' | 'GTC' | 'IOC' | 'FOK' | 'GTD';
  expiryDate?: string;
  executionInstructions?: string[];
}

async function placeOrder(req: MintOrderRequest): Promise<{ orderNumber: string }> {
  const response = await iosClient.OrderCreate3({
    Order: {
      AccountCode: req.accountCode,
      SecurityCode: req.securityCode,
      Exchange: req.exchange,
      BuySell: req.side === 'BUY' ? 1 : 2,
      OrderType: req.orderType,
      Volume: req.volume,
      Price: req.price,
      StopPrice: req.stopPrice,
      Destination: req.destination,
      TimeInForce: req.timeInForce,
      ExpiryDate: req.expiryDate,
      OrderTag: req.mintOrderId,
      ExecutionInstructionsArray: req.executionInstructions,
    },
  });
  const row = response.Output.Result.DataRows[0];
  if (row.ErrorNumber !== 0) {
    throw new IressOrderError(row.ErrorNumber, row.ErrorMessage);
  }
  return { orderNumber: row.OrderNumber };
}
```

## See also

- [`02-order-pad.md`](02-order-pad.md) — for the order-pad retrieval and updates stream.
- [`contingent-orders/01-destinations-and-identification.md`](contingent-orders/01-destinations-and-identification.md) — to set up CO destinations before placing contingent orders.
- [`algo-orders/01-destinations.md`](algo-orders/01-destinations.md) — to set up algo destinations.
- [`../../07-recovery/05-iosplus-order-creation-recovery.md`](../../07-recovery/05-iosplus-order-creation-recovery.md) — idempotency and recovery.
