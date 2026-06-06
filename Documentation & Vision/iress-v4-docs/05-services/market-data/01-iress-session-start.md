# IRESSSessionStart

The first method any V4 client calls. Returns the `IRESSSessionKey` that authenticates every subsequent request.

- **Service:** Iress (no service session required).
- **Header token:** `SessionKey` (none on this first call).
- **Updates support:** No.
- **Paging:** No.
- **Timeout:** Defaults to 55 seconds (the source PDF calls this out specifically).
- **Async (`WaitForResponse=false`):** Allowed, but synchronous is normal for login.

## Parameters (request `<Parameters>`)

| Name | Type | Required | Description |
|---|---|---|---|
| `UserName` | string | yes | Iress user name. |
| `CompanyName` | string | yes | |
| `Password` | string | yes | |
| `ApplicationID` | string | yes | **Unique per call.** Use a GUID or `Mint-OEMS-<guid>`. |
| `ApplicationLabel` | string | no | Free text; surfaced in IRESS admin. |
| `PreviousSessionKey` | string | no | Reserved; not used in this version. |
| `SessionTimeout` | int | no | Minutes. Max `1440` (24h). May be off by ~1 minute. |
| `AuthenticationType` | string | no | e.g. `0` (native), or per IRESS config. |
| `SessionNumberToKick` | int | no | Used to reclaim a license. See [User Scenarios](../../04-sessions/03-user-scenarios.md). |
| `KickLikeSessions` | bool | no | See [User Scenarios](../../04-sessions/03-user-scenarios.md). |
| `Locale` | string | no | e.g. `en-ZA`. |
| `LocalePrivateUseSubtags` | string | no | |

## Return value

`IRESSSessionKey` (string, often suffixed with the originating web-server hostname).

## Common errors

| Code | Meaning | Action |
|---|---|---|
| `25008` | Out of licenses | Follow [User Scenarios](../../04-sessions/03-user-scenarios.md). |
| `25013` | No session key in request | Bug — you sent `IRESSSessionStart` with a stale `SessionKey` in the header. |
| `25014` | Invalid session key | Re-create the Iress session from scratch. |
| `25016` | Server has hit its 20 000-active-session cap. | Fail; inform IRESS. |
| `25020` | Login failed (bad credentials or no permission) | Fail; check credentials and the "Web Services" group permission. |
| `666` | Internal: server can't locate IDS for this request | Retry with a fresh Iress session. |

## Sample payload

Request (full):
```xml
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
               xmlns:xsd="http://www.w3.org/2001/XMLSchema"
               xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <IRESSSessionStart xmlns="http://webservices.iress.com.au/v4/">
      <Input>
        <Header>
          <SessionKey></SessionKey>
          <RequestID>init-1</RequestID>
          <Updates>false</Updates>
          <Timeout>55</Timeout>
          <PageSize>0</PageSize>
          <WaitForResponse>true</WaitForResponse>
          <PagingBookmark></PagingBookmark>
          <PagingDirection>0</PagingDirection>
        </Header>
        <Parameters>
          <UserName>username</UserName>
          <CompanyName>Company</CompanyName>
          <Password>Password</Password>
          <ApplicationID>Mint-OEMS-f9b1c2a3-...</ApplicationID>
          <ApplicationLabel>Mint-OEMS-Production</ApplicationLabel>
          <SessionTimeout>120</SessionTimeout>
          <Locale>en-ZA</Locale>
        </Parameters>
      </Input>
    </IRESSSessionStart>
  </soap:Body>
</soap:Envelope>
```

Response (excerpt — success):
```xml
<IRESSSessionStartResponse xmlns="http://webservices.iress.com.au/v4/">
  <Output>
    <Input> <!-- echo --> </Input>
    <Result>
      <Header>
        <RequestID>init-1</RequestID>
        <StatusCode>2</StatusCode>
        <WebServiceTimeStamp>2020-09-23T22:04:12</WebServiceTimeStamp>
        <PagingBookmark/>
      </Header>
      <DataRows>
        <DataRow>
          <IRESSSessionKey>ABCD1234-...@WebServicesTestA.iress.com.au</IRESSSessionKey>
        </DataRow>
      </DataRows>
    </Result>
  </Output>
</IRESSSessionStartResponse>
```

Response (excerpt — license exhaustion):
```xml
<soap:Body>
  <soap:Fault>
    <faultcode>soap:Receiver</faultcode>
    <faultstring>Error: Login failed. No more licenses available for this login. Please contact Support..</faultstring>
    <detail>
      <IRESSFaultDetail xmlns="http://webservices.iress.com.au/v4/">
        <Message>Error: Login failed. No more licenses available for this login. Please contact Support..</Message>
        <Number>25008</Number>
        <Context><![CDATA[<CurrentSessions>
          <Session>
            <SessionNumber>1041878485</SessionNumber>
            <LoginType>NetIressPro</LoginType>
            <LoginDateTime>2020-09-23T21:55:54</LoginDateTime>
            <LoginDuration>00:08:17</LoginDuration>
            <ConnectionDescription>IP = 203.19.128.30:55303, LanIP = 172.25.224.43:55</ConnectionDescription>
            <PhysicalDescription>THIRUVIKRAM.MANTHU@AU02-TMANTH-NB3</PhysicalDescription>
          </Session>
          <Session>
            <SessionNumber>1041878583</SessionNumber>
            <LoginType>NetIressPro</LoginType>
            <LoginDateTime>2020-09-23T21:56:25</LoginDateTime>
            <LoginDuration>00:07:46</LoginDuration>
            <ConnectionDescription>IP = 203.19.128.30:50353, LanIP = 172.25.224.43:50</ConnectionDescription>
            <PhysicalDescription>THIRUVIKRAM.MANTHU@AU02-TMANTH-NB3</PhysicalDescription>
          </Session>
          <Session>
            <SessionNumber>1041878998</SessionNumber>
            <LoginType>ViewPoint</LoginType>
            <LoginDateTime>2020-09-23T21:58:48</LoginDateTime>
            <LoginDuration>00:05:23</LoginDuration>
            <ConnectionDescription>IP = 59.102.98.169</ConnectionDescription>
            <PhysicalDescription>Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWeb</PhysicalDescription>
          </Session>
        </CurrentSessions>]]></Context>
        <Service>IRESS</Service>
        <Server>AU1-T-MASTERA:4501 (PHOENIX)</Server>
        <UserName>buyside</UserName>
        <CompanyName>Iress</CompanyName>
        <EndPoint>https://webservicestesta.iress.com.au/v4/SOAP.aspx</EndPoint>
        <RequestID>Login/Logout - E1B41264-6E13-4E47-A325-45ABDF502DF5</RequestID>
        <WebServiceTimeStamp>2020-09-23T22:04:12</WebServiceTimeStamp>
        <WebServiceServer>AU1-T-WEBSRVRA:46301</WebServiceServer>
        <WebServiceConnection>AU1-T-MASTERA:4501 (PHOENIX)</WebServiceConnection>
      </IRESSFaultDetail>
    </detail>
  </soap:Fault>
</soap:Body>
```

## Mint OEMS — wrapper sketch

```ts
async function openIressSession(opts: {
  userName: string;
  companyName: string;
  password: string;
  applicationId: string;        // pass a stable per-process GUID
  applicationLabel?: string;
  sessionTimeoutMinutes?: number;
  locale?: string;              // default 'en-ZA'
}): Promise<string> {
  const response = await iressClient.IRESSSessionStart({
    UserName: opts.userName,
    CompanyName: opts.companyName,
    Password: opts.password,
    ApplicationID: opts.applicationId,
    ApplicationLabel: opts.applicationLabel ?? 'Mint-OEMS',
    SessionTimeout: opts.sessionTimeoutMinutes ?? 120,
    Locale: opts.locale ?? 'en-ZA',
  });
  if (isFault(response)) {
    if (response.detail.IRESSFaultDetail.Number === 25008) {
      // license exhaustion — see 04-sessions/03-user-scenarios.md
      throw new IressLicenseExhausted(response.detail.IRESSFaultDetail.Context);
    }
    throw new IressFault(response.detail.IRESSFaultDetail);
  }
  const key = response.Output.Result.DataRows[0].IRESSSessionKey;
  return key;
}
```
