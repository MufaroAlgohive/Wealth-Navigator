# 01 — Iress Sessions

The first thing any V4 client must do is obtain an **`IRESSSessionKey`** by calling `IRESSSessionStart`. The key is a token that tells the system **who you are** and **what operations you are allowed to execute**.

## What an Iress session lets you do

- Call any **Iress Pro** market-data / WebAdmin method (no service session needed).
- Create **service sessions** for IOS+, IPS, and FIX+.

## What an Iress session does **not** let you do

- Place / amend / cancel orders (you need an IOS+ service session).
- Read portfolio data (you need an IPS service session).
- Read FIX+ target status (you need a FIX+ service session).

## `IRESSSessionStart` parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `UserName` | string | yes | Iress login. |
| `CompanyName` | string | yes | |
| `Password` | string | yes | |
| `ApplicationID` | string | yes | **Must be unique per call** (e.g. `Mint-OEMS-<GUID>`). The same `UserName + CompanyName + ApplicationID` will return the same existing session if one exists; otherwise a new one is created. |
| `ApplicationLabel` | string | no | Free-text marker, e.g. `Mint-OEMS-Production`. Useful in IRESS admin. |
| `AuthenticationType` | string | no | `0`/`""` = native, others depend on IRESS configuration (LDAP, SSO). |
| `SessionTimeout` | int (minutes) | no | Overrides group-level default. Max `1440` (24h). May be off by up to 1 minute. |
| `SessionNumberToKick` | int | no | When the user is out of licenses, the session number to forcibly end. See [User Scenarios](03-user-scenarios.md). `-1` ends all. |
| `KickLikeSessions` | bool | no | Used with `SessionNumberToKick`. If true, a "like" session of the same login type as the nominated one will be ended if the nominated one has already ended. |
| `Locale` | string | no | e.g. `en-ZA` |
| `LocalePrivateUseSubtags` | string | no | |

## Return value

On success the response contains an `IRESSSessionKey` (a string), typically suffixed with the originating web-server hostname, e.g. `ABCD1234-…@WebServicesTestA.iress.com.au`.

The source hostname suffix is significant:

- It tells you which web server the session lives on.
- The same `ApplicationID + UserName + CompanyName` always returns the session on the same server (sticky).
- If you call from a different web server (e.g. test-A vs test-C), the session may be returned or may not — see [User Scenarios](03-user-scenarios.md).

## License accounting

- **One `IRESSSessionKey` consumes one user license.**
- If you need many concurrent processes, ask your IRESS account exec to raise the license cap for the login.
- The total active session cap on the server is `20000` (default). If you hit it, error `25016` is returned.

## Concurrent request limit

- **50 active requests per `IRESSSessionKey`.** Including both data requests and any updates subscriptions.
- If you hit it, error `25026` is returned.
- See [`../08-performance/02-server-side-limits.md`](../08-performance/02-server-side-limits.md).

## `IRESSSessionEnd` parameters

None. The `IRESSSessionKey` goes in the request header.

It also ends **every** service session that was created from this Iress session.

## Example (success)

Request:
```xml
<v4:IRESSSessionStart>
  <v4:Input>
    <v4:Header>
      <v4:SessionKey/>
      <v4:RequestID>init-1</v4:RequestID>
      <v4:Updates>false</v4:Updates>
      <v4:Timeout>55</v4:Timeout>
      <v4:PageSize>0</v4:PageSize>
      <v4:WaitForResponse>true</v4:WaitForResponse>
      <v4:PagingBookmark/>
      <v4:PagingDirection>0</v4:PagingDirection>
    </v4:Header>
    <v4:Parameters>
      <v4:UserName>username</v4:UserName>
      <v4:CompanyName>Company</v4:CompanyName>
      <v4:Password>Password</v4:Password>
      <v4:ApplicationID>Mint-OEMS-f9b1c2a3-…</v4:ApplicationID>
      <v4:ApplicationLabel>Mint-OEMS-Production</v4:ApplicationLabel>
      <v4:PreviousSessionKey/>
      <v4:SessionTimeout>120</v4:SessionTimeout>
      <v4:AuthenticationType/>
      <v4:SessionNumberToKick/>
      <v4:KickLikeSessions/>
      <v4:Locale>en-ZA</v4:Locale>
      <v4:LocalePrivateUseSubtags/>
    </v4:Parameters>
  </v4:Input>
</v4:IRESSSessionStart>
```

Response (excerpt):
```xml
<IRESSSessionStartResponse xmlns="http://webservices.iress.com.au/v4/">
  <Output>
    <v4:Input> <!-- echo --> </v4:Input>
    <Result>
      <Header>
        <RequestID>init-1</RequestID>
        <StatusCode>2</StatusCode>
        <WebServiceTimeStamp>2020-09-23T22:04:12</WebServiceTimeStamp>
        <PagingBookmark/>
      </Header>
      <DataRows>
        <DataRow>
          <IRESSSessionKey>ABCD1234-…@WebServicesTestA.iress.com.au</IRESSSessionKey>
        </DataRow>
      </DataRows>
    </Result>
  </Output>
</IRESSSessionStartResponse>
```

## Session lifetime

| Event | Effect |
|---|---|
| 2h of inactivity | Server expires the session. |
| 24h since creation | Server expires the session. |
| `IRESSSessionEnd` called | Session ends immediately; statistics returned. |
| App restart / network drop | Session remains valid on the server for up to 2h; re-issue calls using the same `ApplicationID + UserName + CompanyName` to recover. |

## Best practices

- Generate `ApplicationID` server-side (or as a stable GUID per process) and **persist it** — re-using the same `ApplicationID` after a restart returns the same session.
- Persist the `IRESSSessionKey` to durable storage (encrypted at rest) if you need to survive process restarts. Or just re-create and let the old one expire.
- Set `SessionTimeout` to a value slightly shorter than your expected client idle window — saves you the surprise of mid-call 25014s.
- Treat every Iress session as **a user license** — close them on shutdown, monitor for orphans.

## Mint OEMS recommendation

- **One Iress session per OEMS node.** Use a per-node `ApplicationID` (`Mint-OEMS-Node-A-<hostname>`) so you can identify rogue nodes in IRESS admin.
- **Open the session lazily** — on first user login, not at server start. The 2h idle clock is per session, not per server.
- **Re-login in the background** before the 2h mark if you expect a long idle window (e.g. overnight).
