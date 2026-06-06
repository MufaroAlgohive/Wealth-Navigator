# IPSUploadCreate1

Creates an upload job. The method declares **what kind of upload** this is, sets its metadata (date, description, etc.), and returns an `UploadNumber` that all subsequent calls reference.

- **Service:** IPS.
- **Header token:** `ServiceSessionKey`.

## Parameters

| Name | Type | Description |
|---|---|---|
| `UploadType` | string | e.g. `SECURITY_LIST`, `HOLDINGS`, `PRICES`. Confirm with the WSDL. |
| `UploadDate` | date | The "as-of" date for the upload. |
| `Description` | string | Free text. |
| (other) | various | Per the WSDL. |

## Return value

`UploadNumber` — a server-generated identifier for this upload.

## Sample payload

```xml
<IPSUploadCreate1 xmlns="http://webservices.iress.com.au/v4/">
  <Input>
    <Header>
      <ServiceSessionKey>…</ServiceSessionKey>
      <RequestID>up-1</RequestID>
      <Updates>false</Updates>
      <Timeout>25</Timeout>
      <PageSize>0</PageSize>
      <WaitForResponse>true</WaitForResponse>
      <PagingBookmark/>
      <PagingDirection>0</PagingDirection>
    </Header>
    <Parameters>
      <UploadType>SECURITY_LIST</UploadType>
      <UploadDate>2025-01-15</UploadDate>
      <Description>Mint — daily security list</Description>
    </Parameters>
  </Input>
</IPSUploadCreate1>
```

## See also

- [`01-uploads-overview.md`](01-uploads-overview.md)
- [`03-ips-upload-data-set-1.md`](03-ips-upload-data-set-1.md) — next step
