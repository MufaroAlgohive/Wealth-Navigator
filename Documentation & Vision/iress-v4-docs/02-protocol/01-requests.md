# 01 — Requests

Every V4 method call is a **SOAP request** with a uniform envelope shape. There are two kinds of requests.

## Two kinds of requests

| Kind | Purpose | Header token used |
|---|---|---|
| **Data Request** | Fetch historical / snapshot data, or send data, optionally subscribing to live updates | `SessionKey` (Iress) **or** `ServiceSessionKey` (service) |
| **Updates Request** | Subscribe to / retrieve updates for a prior Data Request | Same `RequestID` as the original data call |

> The naming convention: any *Updates* method (`PricingQuoteGetUpdates`, `OrderPadGetByAccountUpdates`) is an Updates Request that pairs with its base method (`PricingQuoteGet`, `OrderPadGetByAccount`).

## Request shape

```
soap:Envelope
└─ soap:Body
   └─ <v4:MethodName>                    ← e.g. <v4:IRESSSessionStart>
      └─ <v4:Input>
         ├─ <v4:Header>                   ← always present
         │   ├─ SessionKey | ServiceSessionKey
         │   ├─ WaitForResponse
         │   ├─ PageSize
         │   ├─ RequestID
         │   ├─ Timeout
         │   ├─ Updates
         │   ├─ PagingBookmark
         │   └─ PagingDirection
         │
         └─ <v4:Parameters>               ← method-specific inputs
```

> Note: in some methods (e.g. the older `IPSAccountGetAll1`) the pagination parameters appear inside `<v4:Parameters>` rather than the header. See [`../03-paging-and-updates/04-paging-in-ips.md`](../03-paging-and-updates/04-paging-in-ips.md).

## Header fields

| Field | Type | Default | Description |
|---|---|---|---|
| `SessionKey` | string | *(none)* | **Iress** session token. Use for Iress Pro / WebAdmin methods. |
| `ServiceSessionKey` | string | *(none)* | **Service** session token. Use for IOS+ / IPS / FIX+ methods. |
| `WaitForResponse` | bool | `true` | If `false`, server returns immediately with `StatusCode=1`. See [`03-sync-vs-async.md`](03-sync-vs-async.md). |
| `PageSize` | int | `1000` | Max rows per page. The data server may impose a smaller limit. |
| `RequestID` | GUID | auto | **Unique per active request.** Use a GUID. Reused for paging and updates. |
| `Timeout` | int (sec) | `25` (or `55` for `IRESSSessionStart`) | How long to wait for the data server to reply. |
| `Updates` | bool | `false` | If `true`, the request subscribes to updates after the snapshot. |
| `PagingBookmark` | complex | empty | Opaque cursor from the previous page's response. See [`../03-paging-and-updates/02-paging-with-bookmarks.md`](../03-paging-and-updates/02-paging-with-bookmarks.md). |
| `PagingDirection` | enum | `forward` (`0`) | `backward` is documented but **not implemented**. |
| `InputLocalizationType` | enum | `0` | Localization hint for the request. |
| `OutputLocalizationType` | enum | `0` | Localization hint for the response. |

## Data type per request

The `Header` differs between an **Iress** request and a **Service** request:

- **Iress request** → uses `SessionKey` (from `IRESSSessionStart`).
- **Service request** → uses `ServiceSessionKey` (from `ServiceSessionStart`).
- All other header fields are identical.

> Most clients wrap the request object to keep this distinction implicit. Keep your typed client focused on **what** the call is, not the session it lives in.

## Linking a Data Request to its Updates Request

If `Updates=true` on the data call, the matching `*Updates` method **must** be called with the **same `RequestID`**. The server uses this to associate queued updates with the originating subscription.

```text
PricingQuoteGet(
  Header.RequestID = "R-001",
  Header.Updates   = true
) → status=3 watching

PricingQuoteGetUpdates(
  Header.RequestID = "R-001"   ← same
) → update rows

PricingQuoteGetUpdates(
  Header.RequestID = "R-001"   ← same, again
) → update rows

... (poll continuously)
```

## Mint OEMS — implementation tips

- **Generate the `RequestID` server-side**, not client-side, if you can — that gives you a stable per-process correlation ID you can use in logs and support tickets.
- **Persist `RequestID` per logical subscription** (e.g. one per `OrderPadGetByAccount` view per account) — when the user reloads the page, you can re-subscribe using the same `RequestID` and the server will replay buffered updates.
- **Use the largest practical `PageSize`** for bulk fetches (matches `MaxPageSize` of 1000 by default). Reduces per-call overhead.
- **Always set `Accept-Encoding: gzip`** at the HTTP layer — it's separate from the SOAP header.
