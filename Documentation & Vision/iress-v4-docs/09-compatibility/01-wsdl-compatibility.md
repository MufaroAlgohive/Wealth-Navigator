# WSDL Compatibility

## Why version your WSDL

A client application may need to maintain **multiple versions** of the WSDL across an upgrade:

- Newer methods may become available with updated interfaces.
- The IRESS team encourages usage of the newer interface — **older methods may be removed from the new WSDL**.
- The older methods typically **still work** at runtime, but updating to the newer WSDL may produce **compile errors** in your generated code.

### Example

In IOS+ there are three versions of the order-create method:

- `OrderCreate`
- `OrderCreate2`
- `OrderCreate3` ← the current

A WSDL generated today will only show `OrderCreate3`, not `OrderCreate` or `OrderCreate2`.

If your code was generated against an older WSDL that used `OrderCreate`, the new WSDL won't have that method — your build will break.

## What to do

> *"We strongly recommend that clients save a copy of the raw WSDLs for each of the versions used in their projects. When a new WSDL is obtained it should be compared with previous versions to determine the exact differences in the interface and can be used to determine how the changes may impact a client application. A great way to compare the differences are by using a tool such as BeyondCompare, Winmerge or VS Code."*

**Mint OEMS — recommended practice:**

1. **Version the WSDLs.** Store them as `wsdl/iress-prod-{date}.wsdl`, `wsdl/iosplus-prod-{date}.wsdl`, etc.
2. **Diff on every upgrade.** Use Beyond Compare, WinMerge, or VS Code's diff.
3. **Generate code per WSDL version.** Keep multiple generated client libraries if needed (e.g. `v3` and `v4` side by side) during a transition.
4. **Document the gap.** Each upgrade should have a short CHANGELOG entry listing added/removed methods.
5. **Test in pre-prod first.** The SA test endpoint (`webservices-ct.iress.co.za/v4`) typically gets the new WSDL first; smoke-test there.

## The list of methods varies

> *"The list of methods available against a service may vary not only between versions but also based on server configuration. For example, on an IOS+ server additional methods will be returned in the WSDL when the IOS+ Retail Server module is installed."*

Practical implications:

- The WSDL is **negotiated per-server**, not just per-version.
- Different IRESS deployments expose different method sets.
- Don't hardcode "method X exists" in client code — assume it may not; handle missing methods gracefully.

## See also

- [`../01-foundations/04-getting-started.md`](../01-foundations/04-getting-started.md) — WSDL generation.
- [`../01-foundations/03-endpoints.md`](../01-foundations/03-endpoints.md) — endpoints and method filters.
