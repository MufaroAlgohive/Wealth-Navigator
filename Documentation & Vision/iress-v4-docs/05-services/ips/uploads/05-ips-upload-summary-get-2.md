# IPSUploadSummaryGet2

Returns the summary of a completed upload — total rows processed, succeeded, failed.

- **Service:** IPS.
- **Header token:** `ServiceSessionKey`.

## Parameters

| Name | Type | Description |
|---|---|---|
| `UploadNumber` | string | From `IPSUploadCreate1`. |

## Return value

A summary row with:

- `UploadNumber`
- `UploadType`, `UploadDate`
- `RowsProcessed`
- `RowsSucceeded`
- `RowsFailed`
- `Status` (e.g. `COMPLETED`, `FAILED`, `PARTIAL`)
- `ErrorRows` count (or pointer to detail)

## Sample payload

```xml
<IPSUploadSummaryGet2 xmlns="http://webservices.iress.com.au/v4/">
  <Input>
    <Header>
      <ServiceSessionKey>…</ServiceSessionKey>
      <RequestID>up-4</RequestID>
      <Updates>false</Updates>
      <Timeout>25</Timeout>
      <PageSize>0</PageSize>
      <WaitForResponse>true</WaitForResponse>
      <PagingBookmark/>
      <PagingDirection>0</PagingDirection>
    </Header>
    <Parameters>
      <UploadNumber>U1</UploadNumber>
    </Parameters>
  </Input>
</IPSUploadSummaryGet2>
```

## See also

- [`04-ips-upload-run-1.md`](04-ips-upload-run-1.md) — previous step
- [`06-ips-upload-error-get-1.md`](06-ips-upload-error-get-1.md) — for per-row error detail
