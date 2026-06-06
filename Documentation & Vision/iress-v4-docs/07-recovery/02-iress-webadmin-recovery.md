# Iress WebAdmin — Recovery

For "set" methods like `AdminUserCreate2`, `AccountCreate`, etc.

## Recommended: `AmendIfExists = true`

Where supported, set `AmendIfExists = true` on the create call. The semantics:

- If a matching record does **not** exist → the record is created.
- If a matching record **does** exist → the record is amended (no error).

This makes the call **idempotent** — safe to retry after a timeout or network drop without worrying about duplicates.

> If the input has a different "match key" than the server's, you may end up creating a new record when you intended to amend. Audit the match semantics per method.

## If `AmendIfExists` is not supported

1. **Retrieve first** to check what already exists.
2. Decide create vs amend based on the result.
3. Apply.

## See also

- [`01-application-recovery.md`](01-application-recovery.md)
- [`03-iosplus-admin-recovery.md`](03-iosplus-admin-recovery.md) — same pattern, different service.
