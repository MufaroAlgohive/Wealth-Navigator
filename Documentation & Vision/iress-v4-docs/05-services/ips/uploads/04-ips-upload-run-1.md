# IPSUploadRun1

Executes the upload. Call after the dataset has been pushed via `IPSUploadDataSet1`.

- **Service:** IPS.
- **Header token:** `ServiceSessionKey`.

## Parameters

| Name | Type | Description |
|---|---|---|
| `UploadNumber` | string | From `IPSUploadCreate1`. |
| (other) | various | Per the WSDL (e.g. `CommitMode`, `ValidationOnly`). |

## Return value

Status (success / failed) and a summary count. For full details, follow up with `IPSUploadSummaryGet2` and `IPSUploadErrorGet1`.

## Sample payload

```xml
<IPSUploadRun1 xmlns="http://webservices.iress.com.au/v4/">
  <Input>
    <Header>
      <ServiceSessionKey>…</ServiceSessionKey>
      <RequestID>up-3</RequestID>
      <Updates>false</Updates>
      <Timeout>55</Timeout>            <!-- longer timeout; uploads can take a while -->
      <PageSize>0</PageSize>
      <WaitForResponse>true</WaitForResponse>
      <PagingBookmark/>
      <PagingDirection>0</PagingDirection>
    </Header>
    <Parameters>
      <UploadNumber>U1</UploadNumber>
    </Parameters>
  </Input>
</IPSUploadRun1>
```

## See also

- [`03-ips-upload-data-set-1.md`](03-ips-upload-data-set-1.md) — previous step
- [`05-ips-upload-summary-get-2.md`](05-ips-upload-summary-get-2.md) — next step
