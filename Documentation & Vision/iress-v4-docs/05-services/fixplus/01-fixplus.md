# FIX+ — TargetIDGet, TargetIDStatusGet

The **FIX+** service in V4 is a thin wrapper around the FIX+ engine — used to check the status of FIX+ **targets** (drop-copy endpoints, FIX sessions).

- **Service:** FIX+ (service session required).
- **Header token:** `ServiceSessionKey`.

## Method index

| Method | Purpose |
|---|---|
| `TargetIDGet` | List FIX+ targets visible to the user. |
| `TargetIDStatusGet` | Check whether a specific FIX+ target is logged in / connected. |

## `TargetIDGet`

Returns the list of FIX+ target IDs the user can see. Use this to enumerate drop-copy endpoints or FIX sessions to monitor.

> The PDF is light on parameter details. Confirm with the WSDL.

## `TargetIDStatusGet`

> Per the source PDF: "This method checks if a FIX+ session is logged in."

### Parameters

| Name | Type | Description |
|---|---|---|
| `TargetID` | string | The FIX+ target id (from `TargetIDGet`). |

### Return value

The current status of the target:

- `LoggedIn` (or similar — confirm with the WSDL)
- `LoggedOut`
- `Connecting` / `Disconnecting`
- `Unknown` (server can't determine)

The exact state strings are WSDL-defined. Use this method as a heartbeat / connectivity probe.

## Typical usage in Mint

```text
-- 1) Get the targets
TargetIDGet
  → ["DROP-COPY-1", "DROP-COPY-2", "BROKER-FIX-A", ...]

-- 2) For each, periodically check status
TargetIDStatusGet(TargetID = "DROP-COPY-1")
  → status

-- 3) If a critical target goes LoggedOut:
--    page someone / failover to a backup / suppress downstream delivery
```

## Sample payload — `TargetIDStatusGet`

```xml
<TargetIDStatusGet xmlns="http://webservices.iress.com.au/v4/">
  <Input>
    <Header>
      <ServiceSessionKey>…</ServiceSessionKey>
      <RequestID>fix-1</RequestID>
      <Updates>false</Updates>
      <Timeout>25</Timeout>
      <PageSize>0</PageSize>
      <WaitForResponse>true</WaitForResponse>
      <PagingBookmark/>
      <PagingDirection>0</PagingDirection>
    </Header>
    <Parameters>
      <TargetID>DROP-COPY-1</TargetID>
    </Parameters>
  </Input>
</TargetIDStatusGet>
```

## Mint OEMS — usage notes

- A FIX+ target being down means **downstream drop-copy is broken**. Don't let the OEMS pretend everything's fine.
- For the JSE, the typical setup is one or more broker FIX drop-copies plus the JSE's own. Confirm with the IRESS Vol-2 docs which targets are exposed.
- The "session is logged in" check is a **server-side** view. Even if the target is up at IRESS, your downstream consumer of the drop-copy feed may be down. Don't conflate the two.
- The actual FIX message stream comes over a **separate** FIX TCP connection — V4 FIX+ is for status/control only, not for streaming the messages themselves.

## See also

- [`../../06-errors/01-session-error-codes.md`](../../06-errors/01-session-error-codes.md) — for session-level errors when the FIX+ service session dies.
- [`../../13-soap-examples/target-id-status-get.xml`](../../13-soap-examples/target-id-status-get.xml) — full SOAP example.
