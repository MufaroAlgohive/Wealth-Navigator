# IPSUploadErrorGet1

Returns the per-row error list for an upload — used to diagnose why some rows failed.

- **Service:** IPS.
- **Header token:** `ServiceSessionKey`.
- **Paging:** Yes (use `PagingBookmark` for large error sets).

## Parameters

| Name | Type | Description |
|---|---|---|
| `UploadNumber` | string | From `IPSUploadCreate1`. |

## Return value

A `DataRow` per error:

- `RowIndex` (which input row failed)
- `ErrorNumber`
- `ErrorMessage`
- (potentially) the offending column/value

## Sample payload

```xml
<IPSUploadErrorGet1 xmlns="http://webservices.iress.com.au/v4/">
  <Input>
    <Header>
      <ServiceSessionKey>…</ServiceSessionKey>
      <RequestID>up-5</RequestID>
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
</IPSUploadErrorGet1>
```

## See also

- [`05-ips-upload-summary-get-2.md`](05-ips-upload-summary-get-2.md) — for the summary view
- [`01-uploads-overview.md`](01-uploads-overview.md)
