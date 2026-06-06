# 02 — Service Sessions (IOS+ / IPS / FIX+)

To call methods on **IOS+**, **IPS**, or **FIX+** you need a **`ServiceSessionKey`** in addition to the `IRESSSessionKey`.

## `ServiceSessionStart` parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `IRESSSessionKey` | string | yes | The token you got from `IRESSSessionStart`. Pass it in the request header. |
| `Service` | enum | yes | One of `"IOSPlus"`, `"IPS"`, `"FIXPlus"`. |
| `Server` | string | yes | The Phoenix server name to connect to, e.g. `IOSPLUSAPI`, `IPSAPI`, `FIXPLUSAPI`. |

> Some deployments expose multiple servers (e.g. multiple `IOSPLUSAPI` nodes for load-balancing). Talk to your IRESS contact to find out which server names your environment exposes.

## Return value

On success the response contains a `ServiceSessionKey` (string).

## Lifetime

A service session's lifetime is **tied to its parent Iress session**:

- When the parent Iress session ends (idle timeout, explicit `IRESSSessionEnd`, server expiry), **all** child service sessions also end.
- Service sessions do not have an independent idle timer.

## Ending a service session

There are two ways:

1. **Direct** — call `ServiceSessionEnd`. The `ServiceSessionKey` goes in the request header. No parameters.
2. **Indirect** — call `IRESSSessionEnd` on the parent. All service sessions under it are torn down.

Always end service sessions first, then the Iress session, to free the license promptly.

## Restrictions

- ❌ You **cannot** create multiple service sessions of the **same service type** to the **same server** with the same Iress session. Error `25011` is returned.
- ❌ Server name must be valid. Invalid name → `25012`.
- ❌ The parent Iress session must still be alive. Expired parent → `25014`, `25019`, or `25022`.

## Example (IOS+)

Request:
```xml
<v4:ServiceSessionStart>
  <v4:Input>
    <v4:Header>
      <v4:SessionKey>ABCD1234-…@WebServicesTestA.iress.com.au</v4:SessionKey>
      <v4:RequestID>svc-1</v4:RequestID>
      <v4:Updates>false</v4:Updates>
      <v4:Timeout>25</v4:Timeout>
      <v4:PageSize>0</v4:PageSize>
      <v4:WaitForResponse>true</v4:WaitForResponse>
      <v4:PagingBookmark/>
      <v4:PagingDirection>0</v4:PagingDirection>
    </v4:Header>
    <v4:Parameters>
      <v4:Service>IOSPlus</v4:Service>
      <v4:Server>IOSPLUSAPI</v4:Server>
    </v4:Parameters>
  </v4:Input>
</v4:ServiceSessionStart>
```

Response (excerpt):
```xml
<ServiceSessionStartResponse xmlns="http://webservices.iress.com.au/v4/">
  <Output>
    <Result>
      <DataRows>
        <DataRow>
          <ServiceSessionKey>ef0123ab-…@WebServicesTestA.iress.com.au</ServiceSessionKey>
        </DataRow>
      </DataRows>
    </Result>
  </Output>
</ServiceSessionStartResponse>
```

## Example (IPS)

Same shape; pass `Service = "IPS"` and the IPS server name.

## Example (FIX+)

Same shape; pass `Service = "FIXPlus"` and the FIX+ server name.

## When the service session dies (server-side)

A service session can be ended by the **server** for many reasons, not just the client:

- Permission changes for the user.
- Idle time limit reached (inherited from parent Iress session).
- Server (e.g. IOS+) goes offline.
- IOS+ group access settings changed.

When this happens, subsequent calls using the now-stale `ServiceSessionKey` will fail with codes `25006`, `25009`, `25019`, or `25033`. The correct response is to **create a new service session** (using the still-valid `IRESSSessionKey` if possible) and retry.

If even `ServiceSessionStart` fails with `25014`, `25019`, or `25022`, the parent Iress session has also died — you need a new Iress session from `IRESSSessionStart`.

## Mint OEMS — multi-service pattern

For a typical Mint OEMS node:

1. Open Iress session at user login.
2. Open **one** IOS+ service session (for trading).
3. Open **one** IPS service session (for portfolio reads / uploads).
4. Open **one** FIX+ service session (for target/status polling).
5. Each session is held in its own long-lived object; on service-session death, transparently rebuild only that one.
6. On user logout / node shutdown: end all service sessions, then end the Iress session.

> Don't multiplex multiple users onto a single Iress session — they each consume a license and IRESS billing attributes sessions to users.
