# 02 — Paging with Bookmarks

Some methods support **explicit bookmarks** in the `PagingBookmark` header. This lets a client request data starting from a particular point — e.g. resume a failed backfill from the last successfully retrieved record rather than starting over.

## Identifying bookmark-supported methods

The method reference marks supported methods with a bookmark icon next to the output fields that make up the bookmark. In raw SOAP, the bookmark is opaque to the client — you just echo it back.

## Example: `AuditTrailGetByAccount`

Request:
```xml
<v4:AuditTrailGetByAccount>
  <v4:Input>
    <v4:Header>
      <v4:ServiceSessionKey>22A4C1EE-48DE-477D-A02F-3E9D2CE39D77@WebServicesTestA.iress.com.au</v4:ServiceSessionKey>
      <v4:RequestID>test123</v4:RequestID>
      <v4:Updates>false</v4:Updates>
      <v4:Timeout>25</v4:Timeout>
      <v4:PageSize>0</v4:PageSize>
      <v4:WaitForResponse>true</v4:WaitForResponse>
      <v4:PagingBookmark>
        <v4:AuditTrailNumber>LastAudittrailNumberFromPreviousResponse</v4:AuditTrailNumber>
      </v4:PagingBookmark>
      <v4:PagingDirection>0</v4:PagingDirection>
    </v4:Header>
    <v4:Parameters>
      <v4:AuditLogDateTimeFrom>2018-01-01</v4:AuditLogDateTimeFrom>
      <v4:AuditLogDateTimeTo>2020-09-24</v4:AuditLogDateTimeTo>
      <v4:AccountCodeArray>
        <v4:AccountCode>AccCode</v4:AccountCode>
      </v4:AccountCodeArray>
    </v4:Parameters>
  </v4:Input>
</v4:AuditTrailGetByAccount>
```

Each page response returns a new `PagingBookmark` — pass it into the next call's `<v4:PagingBookmark>` block.

## When to use bookmarks

| Use case | Why bookmarks help |
|---|---|
| Long-running backfill that may be interrupted (e.g. nightly EOD pull) | Resume from last record instead of redoing hours of work. |
| App restart after crash mid-sync | Same. |
| Reconciliation job that needs deterministic cursoring | Allows strict forward progress without gaps. |

## What to persist

- The `PagingBookmark` from the **last successful** page.
- The `RequestID` and the parent `ServiceSessionKey` (or `IRESSSessionKey`).
- The original input parameters (so the resumed call is identical to the original except for the bookmark).

> Save these to durable storage (DB, not memory) — the whole point is to survive a process restart.
