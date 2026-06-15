# MINT OEMS — IRESS ask (2026-06-15)

Supersedes the 2026-06-14 issue list. Scope is now **IRESS market data + IOS+ only**
(IPS and FIX+ are parked on our side). Account `DFM@MINT`, company `Mint`, endpoint
`https://webservices-ct.iress.co.za/v4`.

## Working
- `IRESSSessionStart` — OK (session lands on node `…@IDSA01`).
- `PricingQuoteGet` — OK, live JSE equity quotes.

## Already resolved (thanks)
- Company is `Mint` (confirmed, no change needed).
- `mint_ct` vs `MINT_CT` — not case-sensitive, no impact.

---

## Blocker 1 — IOS+ service session (unlocks orders + blotter)

`ServiceSessionStart(Service=IOSPlus, Server=mint_ct)` fails with the verbatim fault:

> **`Could not locate the session key for this request.`**

…even though the *same* `IRESSSessionKey` works fine for `PricingQuoteGet`. Per the V4
docs a session is sticky to the web server that minted it (our `…@IDSA01` suffix), and
`IRESSSessionStart` takes no server/node parameter — so the OMS layer can't see a session
created on a different node.

**Question:** In the WebServicesTester, choosing `IOSPlus` + `mint_ct` and connecting works.
How does it pin the session to the node that fronts `mint_ct`? Specifically:
- Is there a **load-balancer affinity cookie** we must capture and resend? (Our worker now
  does this — we'll see in logs whether one is issued.)
- Or must the IRESS session be created against a **specific web-server hostname** for the OMS
  (not the shared `webservices-ct…` entry), and if so which?

A single working `ServiceSessionStart` example for `mint_ct` (request + response headers)
would settle it.

## Blocker 2 — TimeSeriesGet2 (unlocks curves / ALSI / indices / macro; needed to drop Yahoo)

Every request is rejected:

> `soap:Receiver — Invalid Parameter Value: 5 as Frequency`

We've tried all integer `Frequency` values **and** the documented `<Interval>Daily</Interval>`
string — same fault. The live CT build appears to differ from the published docs.

**Question:** What is the exact request shape the CT build expects — is the period selector
`Frequency` (long) or `Interval` (string), and what are the valid values? One working
daily-J203 example request/response would unblock us immediately.

---

## Confirmations (quick)
1. **Trading account code(s)** for `OrderPadGetByAccount` / orders once the IOS+ session is up —
   we're on a placeholder (`Z12345`).
2. **PricingQuoteGet coverage** — full JSE board + ETFs (Satrix / Sygnia / 1nvest)? (We want
   IRESS to fully replace our Yahoo price feed.)
3. **L2 depth / time & sales** — available in V4 (`PricingQuoteExGet` or other)? Low priority.

Everything is verifiable on our side via a live diagnostic
(`GET https://iress-worker-production.up.railway.app/debug/iress-methods`), re-runnable after
any change. Happy to hop on a call.
