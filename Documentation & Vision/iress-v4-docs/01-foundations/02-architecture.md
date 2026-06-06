# 02 — Architecture

## Request flow

```
Client                        Iress Web Server                  Iress Data Server
──────                        ────────────────                  ────────────────
  │  SOAP / HTTP(S) (gzip)        │                                  │
  │ ────────────────────────────► │  Translate XML → internal        │
  │                               │ ────────────────────────────────►│
  │                               │                                  │
  │                               │ ◄────────────────────────────────│
  │                               │  Translate internal → XML        │
  │ ◄──────────────────────────── │                                  │
  │  SOAP response (or fault)     │                                  │
```

- The web server **holds the HTTP connection** open for the duration of the SOAP request.
- The web server **translates the SOAP XML payload** to and from the Iress internal systems.
- The web server is **stateless from the client's perspective** apart from the `IRESSSessionKey` and `ServiceSessionKey` carried in each request's header.

## Internal layers

```
┌──────────────────────────────────────────────────────────────┐
│                        Iress Web Server                       │
│  (soap endpoint, e.g. https://webservices.iress.co.za/v4)    │
│  • parses SOAP / writes response XML                          │
│  • manages RequestID, PagingBookmark, Updates queue           │
│  • enforces client-side limits (page size, queue depth, etc.) │
│  • routes to correct Iress data server (Phoenix)              │
└──────────────┬────────────────────────────┬──────────────────┘
               │                            │
       ┌───────▼─────────┐         ┌────────▼────────┐
       │  Phoenix / Iress │         │   Phoenix / IOS+│
       │  market data IDS │         │   trading engine│
       │  (Pro methods)   │         │  (orders, etc.) │
       └──────────────────┘         └────────┬────────┘
                                            │
                                     ┌──────▼──────┐
                                     │ Phoenix IPS │
                                     │ (portfolio) │
                                     └─────────────┘
```

## Two session types

| Type | Token | Lifetime | Purpose |
|---|---|---|---|
| Iress session | `IRESSSessionKey` | 2h idle, 24h max | Authenticates the user; allows creation of service sessions and Iress Pro market-data calls |
| Service session | `ServiceSessionKey` | Tied to parent Iress session | Required to call IOS+, IPS, or FIX+ methods |

## Service routing (which service session for what)

| Service name in `ServiceSessionStart` | What you can call |
|---|---|
| `IOSPlus` | `OrderCreate3`, `OrderAmend2`, `OrderDelete`, `OrderPadGetBy*`, `BookingGetByOrganisation2`, `ETCGetByOrganisation`, … |
| `IPS` | `IPSTransactionGetByAccount5`, `IPSAccountGetAll1`, `IPSPositionGetAll1`, `IPSUploadCreate1`, … |
| `FIXPlus` | `TargetIDGet`, `TargetIDStatusGet` |

## Long-polling updates architecture

```
Client                                Iress Web Server
──────                                ────────────────
  │  call X (Updates=True, RequestID=R1)              │
  │ ─────────────────────────────────────────────────►│
  │ ◄─────────────────────────────────────────────────│
  │   status=3 (watching)                             │
  │                                                    │
  │  call XUpdates(RequestID=R1)                      │   long-poll
  │ ─────────────────────────────────────────────────►│  (server holds
  │                                                    │   the connection
  │ ◄─── data update 1 ───────────────────────────────│   up to
  │                                                    │   NoUpdateBlockTime)
  │  call XUpdates(RequestID=R1)                      │
  │ ─────────────────────────────────────────────────►│
  │ ◄─── data update 2 ───────────────────────────────│
  │   ...                                              │
  │  SessionRequestEnd(RequestID=R1)                  │
  │ ─────────────────────────────────────────────────►│
```

Key knobs:
- **Update queue limit:** 10 000 queued updates per request (default).
- **Request expiry:** 30 min of inactivity.
- **NoUpdateBlockTime:** 1000s — how long the server blocks before returning an empty response.

## Statelessness & horizontal scale

- Web servers are stateless. They can be load-balanced.
- Session keys carry a server affinity hint (e.g. `key@WebServicesTestA.iress.com.au`); the client should reuse the same logical web server when possible. The IRESS team re-routes as needed; if a key is rejected, follow the recovery flow.

## Compression

- Set `Accept-Encoding: gzip` on every request.
- If the server negotiates compression, the response will include `Content-Encoding: gzip`.
- Always enable in production — SOAP envelopes for bookings and order pads can be several hundred KB.
