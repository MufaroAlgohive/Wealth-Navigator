# IOS+ Admin — Recovery

For "set" methods like `UserCreate`, `AccountCreate`, etc. in the IOS+ Admin service.

## Recommended: `AmendIfExists = true`

Same pattern as Iress WebAdmin — many IOS+ Admin "set" methods support `AmendIfExists`. Use it for idempotent retry.

## If not supported

1. Retrieve to check existence.
2. Branch on the result: create vs amend.
3. Apply.

## See also

- [`01-application-recovery.md`](01-application-recovery.md)
- [`02-iress-webadmin-recovery.md`](02-iress-webadmin-recovery.md)
