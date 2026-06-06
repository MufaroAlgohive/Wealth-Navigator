# Quick Reference — IPS

| Method | Updates | Pagination | Notes |
|---|---|---|---|
| `ServiceSessionStart` | – | – | Service = `"IPS"`, Server = e.g. `"IPSAPI"`. |
| `IPSAccountGetAll1` | – | **Legacy** (params) | Use `PreviousAccountCode` cursor. |
| `IPSPositionGetAll1` | – | **Legacy** (params) | Use a similar cursor. |
| `IPSTransactionGetByAccount5` | – | Modern (header) | Paging via `PagingBookmark`. |
| `IPSUploadCreate1` | – | – | Create upload. |
| `IPSUploadDataSet1` | – | – | Push data rows. |
| `IPSUploadRun1` | – | – | Run upload. |
| `IPSUploadSummaryGet2` | – | – | Summary. |
| `IPSUploadErrorGet1` | – | yes | Per-row errors. |

See [`../../05-services/ips/`](../../05-services/ips/).
