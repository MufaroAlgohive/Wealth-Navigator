# IPSUploadDataSet1

Pushes the actual data rows into the upload created by `IPSUploadCreate1`.

- **Service:** IPS.
- **Header token:** `ServiceSessionKey`.

## Parameters

| Name | Type | Description |
|---|---|---|
| `UploadNumber` | string | From `IPSUploadCreate1`. |
| `Rows` | array | The data rows. Column shape depends on the upload type. |

## Return value

Acknowledgement with the count of rows accepted (or per-row errors if the upload is strict).

## Sample payload

```xml
<IPSUploadDataSet1 xmlns="http://webservices.iress.com.au/v4/">
  <Input>
    <Header>
      <ServiceSessionKey>…</ServiceSessionKey>
      <RequestID>up-2</RequestID>
      <Updates>false</Updates>
      <Timeout>25</Timeout>
      <PageSize>0</PageSize>
      <WaitForResponse>true</WaitForResponse>
      <PagingBookmark/>
      <PagingDirection>0</PagingDirection>
    </Header>
    <Parameters>
      <UploadNumber>U1</UploadNumber>
      <Rows>
        <Row>
          <!-- upload-type-specific columns -->
        </Row>
        <!-- ... -->
      </Rows>
    </Parameters>
  </Input>
</IPSUploadDataSet1>
```

## See also

- [`02-ips-upload-create-1.md`](02-ips-upload-create-1.md) — previous step
- [`04-ips-upload-run-1.md`](04-ips-upload-run-1.md) — next step
