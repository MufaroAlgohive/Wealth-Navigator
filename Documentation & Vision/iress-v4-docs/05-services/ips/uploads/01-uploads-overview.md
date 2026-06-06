# IPS Uploads — Overview

IPS supports **bulk uploads** of data — security lists, holdings, prices, transactions, etc. Uploads are a **multi-step workflow**:

```
1. IPSUploadCreate1    — declare what kind of upload + metadata
2. IPSUploadDataSet1   — push the data rows
3. IPSUploadRun1       — execute the upload
4. IPSUploadSummaryGet2 — get the summary (how many rows processed, errors, etc.)
5. IPSUploadErrorGet1  — get the per-row errors (if any)
```

- **Service:** IPS.
- **Header token:** `ServiceSessionKey` (the parent Iress session, as always, must be alive).

## The five methods

| Method | Purpose |
|---|---|
| `IPSUploadCreate1` | Create the upload job: name, type, date, etc. Returns an `UploadNumber`. |
| `IPSUploadDataSet1` | Push the data rows. |
| `IPSUploadRun1` | Run the upload. |
| `IPSUploadSummaryGet2` | Retrieve the upload summary (rows processed, success/fail counts). |
| `IPSUploadErrorGet1` | Retrieve the per-row error details. |

## When to use uploads

| Use case | Upload type |
|---|---|
| Nightly holdings push (Mint → IPS) | Security holdings |
| Daily price import (vendor → IPS) | Prices |
| Bulk security reference data | Security list |
| Manual adjustments / corrections | (various) |

> The exact upload type strings are server-side configuration. The PDF gives "security list upload" as an example. Confirm the full set of supported upload types with the IRESS Vol-2 docs.

## Workflow

```text
IPSUploadCreate1(...)
  → UploadNumber = U1

IPSUploadDataSet1(UploadNumber = U1, rows = [...])
  → ack

IPSUploadRun1(UploadNumber = U1)
  → status

IPSUploadSummaryGet2(UploadNumber = U1)
  → { rowsProcessed, rowsSucceeded, rowsFailed }

if rowsFailed > 0:
    IPSUploadErrorGet1(UploadNumber = U1)
    → [{ RowIndex, ErrorNumber, ErrorMessage }]
```

## See also

- [`02-ips-upload-create-1.md`](02-ips-upload-create-1.md)
- [`03-ips-upload-data-set-1.md`](03-ips-upload-data-set-1.md)
- [`04-ips-upload-run-1.md`](04-ips-upload-run-1.md)
- [`05-ips-upload-summary-get-2.md`](05-ips-upload-summary-get-2.md)
- [`06-ips-upload-error-get-1.md`](06-ips-upload-error-get-1.md)
- [`../../../../13-soap-examples/ips-uploads.xml`](../../../../13-soap-examples/ips-uploads.xml) — full SOAP examples.
