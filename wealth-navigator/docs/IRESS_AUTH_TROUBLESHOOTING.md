# IRESS Web Services — authentication troubleshooting

Audit of `IRESSSessionStart` requirements vs Mint credentials (`DFM@Mint`) and the live CT error observed on 2026-06-11.

**Observed errors (localhost E2E, `IRESS_MODE=live`, CT):**

| When | SOAP fault (health `/api/iress/health`) | Interpretation |
|------|----------------------------------------|----------------|
| 2026-06-11 before `parseIressUserCode()` | `Login failed. Unknown client/user/password combination.` | Malformed `UserName=DFM@Mint` + `CompanyName=Mint` |
| 2026-06-11 after `parseIressUserCode()` (TEST-LIVE-ALL) | `Login failed. No more licenses available for this login. Please contact Support..` | Credentials accepted; **license cap (25008-class)** — session not started |

**TEST-LIVE-ALL run (same day, post-fix):** `bun run typecheck` pass; `136/136` tests pass; dev server `:3000`; app login `admin`/`admin` 200; health HTTP 500 body `ok:false`; quotes `NPN`/`PRX` `source=seed-fallback` (`liveCount=0`); provenance `session.started=false`. No `CompanyName` retries (error is license, not unknown user).

**Next step for Mint:** Ask Charles/Iress Support to release stale `DFM`@`Mint` sessions or add CT license; use `bun run iress:logout` for a proper client-side release before restarting the worker.

---

## Proper logout (IRESS V4)

IRESS support: **do not stop the worker process without logging out** — an abrupt kill leaves the license seat occupied until idle timeout (up to 2 hours).

### Documented sequence

Sources: `iress-v4-docs/01-foundations/04-getting-started.md` §5, `04-sessions/02-service-sessions.md`, `04-sessions/01-iress-sessions.md`.

| Step | Method | Notes |
|------|--------|-------|
| 1 | `ServiceSessionEnd` | Once per open service session (IOS+, IPS, FIX+). `ServiceSessionKey` in the SOAP header. Timeout ~10s. Best-effort — continue on error. |
| 2 | `IRESSSessionEnd` | `IRESSSessionKey` in the SOAP header. Also cascades to any remaining child service sessions. Timeout ~10s. |
| 3 | Wait | **3 seconds** (`LICENSE_RELEASE_DELAY_MS`) after `IRESSSessionEnd` before starting another `IRESSSessionStart` on CT — seat release is not instantaneous. |

`IRESSSessionEnd` alone is sufficient (it ends all child service sessions), but ending service sessions first frees the license promptly per IRESS best practice.

### What Mint does

| Component | Logout behaviour |
|-----------|------------------|
| Railway worker (`workers/iress-ingest/src/main.ts`) | `SIGTERM` / `SIGINT` → `tearDown()` → `ServiceSessionEnd` × N → `IRESSSessionEnd` → 3s wait → expire `worker_session_metadata` |
| Next.js dev server (`session-manager.ts`) | Same sequence on Ctrl+C / `DELETE /api/iress/session?wait=1` |
| `scripts/iress-logout.ts` | CLI: reads `IRESS_SESSION_KEY` or Supabase `worker_session_metadata`, runs full teardown |
| `scripts/probe-iress-login.ts` | IRESS-only probe (no service sessions) — `IRESSSessionEnd` + 3s wait |

### Release the seat right now

**Local (orphaned dev session):**

```powershell
cd wealth-navigator
bun run iress:logout
```

Or: stop dev server with Ctrl+C (hooks call teardown), or `DELETE http://localhost:3000/api/iress/session?wait=1`.

**Railway (graceful — preferred):**

Railway sends **SIGTERM** on deploy stop / scale-to-zero. The worker handles it on Linux (`process.once("SIGTERM", …)` in `main.ts`). To release without waiting for deploy:

1. Stop the Railway service (or trigger a one-off deploy restart) — SIGTERM runs the teardown hook.
2. Wait **≥ 3 seconds** before starting another IRESS client.
3. If the seat is still stuck (25008), run logout from a machine with credentials + Supabase env:

```powershell
cd wealth-navigator
# .env.local needs IRESS_* and SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
bun run iress:logout
```

Optional override: `IRESS_SESSION_KEY=<key>` if you have the key from logs (prefix only is logged in production).

### 25008 at startup

When all licenses are in use, `IRESSSessionStart` returns SOAP fault **25008** with a `<CurrentSessions>` list in the fault context (`04-sessions/03-user-scenarios.md`).

Mint behaviour:

- **First attempt:** plain login with sticky `ApplicationID` — no kick.
- **On 25008:** worker backs off 60s and logs `bun run iress:logout` — does **not** mint new `ApplicationID` values in a retry loop.
- **Opt-in kick (destructive):** set `IRESS_SESSION_NUMBER_TO_KICK=<SessionNumber>` or `IRESS_FORCE_KICK_ALL=1` only with explicit approval — ends other sessions for the user.

### SessionNumberToKick viability

**Viable** for recovery when you know which session to end (Scenario 1) or as a nuclear option `SessionNumberToKick=-1` (Scenario 2 — ends **every** session for the user including ViewPoint tabs). Mint wires kick only via env opt-in on a 25008 retry, not on the first login attempt. Parse `<SessionNumber>` from the 25008 fault `<Context>` if building a “kick this session” UI later.

---

## Documented login contract (`IRESSSessionStart`)

Sources:

- `Documentation & Vision/IressWebServicesV4-Programmers_Guide (1).pdf` — §Iress Sessions (pp. 15–20), §End Points (p. 7), §Session error codes (pp. 66–68), §Support queries (p. 71)
- `Documentation & Vision/iress-v4-docs/04-sessions/01-iress-sessions.md`
- `Documentation & Vision/iress-v4-docs/05-services/market-data/01-iress-session-start.md`
- `Documentation & Vision/iress-v4-docs/01-foundations/04-getting-started.md`

| Parameter | Required | Type | Notes |
|-----------|----------|------|-------|
| `UserName` | yes | string | **Iress user name** (login id only) |
| `CompanyName` | yes | string | **Iress company name** (broker/firm code) |
| `Password` | yes | string | Native password for the login |
| `ApplicationID` | yes | string | Unique per logical client process; pattern e.g. `Mint-OEMS-<GUID>` |
| `ApplicationLabel` | no | string | Free text for Iress admin (e.g. `Mint-OEMS-Web`) |
| `AuthenticationType` | no | string | Empty / `0` = native; LDAP/SSO per Iress config |
| `SessionTimeout` | no | int (minutes) | Max 1440 |
| `SessionNumberToKick` | no | int | License reclaim; `-1` ends all sessions |
| `KickLikeSessions` | no | bool | Used with `SessionNumberToKick` |
| `Locale` | no | string | e.g. `en-ZA` |
| `LocalePrivateUseSubtags` | no | string | |

**Request header on first login:** empty `SessionKey`, `Timeout` typically 55s, `WaitForResponse=true`.

**Prerequisites (PDF p. 5, getting-started doc):**

- User must hold **"Web Services"** permission at the **group level** in Iress Web Administration.
- WSDL generation in the browser also requires valid username + company + password (PDF p. 8 — three separate form fields).

**AuthenticationType:** PDF sample uses empty `<AuthenticationType></AuthenticationType>` for native login. No requirement to send LDAP/SSO unless the login is configured for it.

**Endpoints (SA):**

| Environment | URL |
|-------------|-----|
| Production test (CT) | `https://webservices-ct.iress.co.za/v4` |
| Production | `https://webservices.iress.co.za/v4` |

Mint pre-prod should use **CT**. Production credentials do not work on CT unless Iress provisions them there.

**IP allowlisting:** Not documented in our markdown set or the programmers guide PDF. Treat as an open question for Iress (relevant for Vercel dynamic egress).

---

## Credential interpretation — `DFM@Mint`

### What Iress documentation says

1. **SOAP uses two fields**, not one combined string. PDF p. 15: *"UserName: Iress user name"* and *"CompanyName: Iress company name"*. All XML examples use separate values (`username` / `Company`, `buyside` / `Iress`).

2. **`user@company` is a support / display convention**, not the `UserName` field value. PDF p. 71 and `iress-v4-docs/06-errors/04-support-queries.md` list **`Username@company`** as item 6 in support bundles — so Iress ops can look up permissions. Fault detail echoes split fields:

   ```xml
   <UserName>buyside</UserName>
   <CompanyName>Iress</CompanyName>
   ```

3. **WSDL browser form** (PDF p. 8) asks for three separate inputs: *Iress username*, *Iress company name*, *Iress password*.

### How to map Charles's `DFM@Mint`

| Received credential | Intended SOAP mapping |
|--------------------|------------------------|
| Display / env `DFM@Mint` | `UserName` = **`DFM`**, `CompanyName` = **`Mint`** |
| Password (env `IRESS_PASSWORD`) | `Password` = value from env |

**Do not** send `UserName=DFM@Mint` with `CompanyName=Mint` — that duplicates the company and is inconsistent with every official example.

**Case sensitivity:** Docs examples use mixed case (`Iress`, `Company`). Whether CT expects `Mint` vs `MINT` is **not** specified; confirm with Iress if split login still fails.

---

## Our env + code mapping

### Environment (`.env.example` / typical `.env.local`)

```env
IRESS_MODE=live
IRESS_USERNAME=DFM@Mint          # display form from Iress — parsed before SOAP
IRESS_PASSWORD=<see IRESS_PASSWORD env var>
IRESS_COMPANY_NAME=Mint           # optional override; suffix from @ used if unset
IRESS_BASE_URL=https://webservices-ct.iress.co.za/v4
```

### Code path

1. `getIressCredentialsFromEnv()` — `src/lib/iress/config.ts`  
   Parses `IRESS_USERNAME` via `parseIressUserCode()` → `{ userName: "DFM", company: "Mint" }`.

2. `bringUpMintSessionFromEnv()` → `bringUpMintSession()` — `src/lib/iress/index.ts`  
   Calls `iress.iressSessionStart({ UserName, CompanyName, Password, ApplicationID, ... })`.

3. `createLiveIressClient().iressSessionStart()` — `src/lib/iress/live.ts`  
   Builds SOAP `<Parameters>` with the fields above; POST to `${IRESS_BASE_URL}/SOAP.aspx`.

### What we sent before the parser fix (likely cause of failure)

| Field | Value sent |
|-------|------------|
| `UserName` | `DFM@Mint` ❌ |
| `CompanyName` | `Mint` |
| `Password` | from `IRESS_PASSWORD` |
| `ApplicationID` | `Mint-OEMS-Prod-web-1-<uuid>` (new each call) |
| `ApplicationLabel` | `Mint-OEMS-Web` |
| `SessionTimeout` | `120` |
| `Locale` | `en-ZA` |
| `AuthenticationType` | omitted (native) |
| Endpoint | `https://webservices-ct.iress.co.za/v4` ✓ |

### What we send after `parseIressUserCode()` fix

| Field | Value sent |
|-------|------------|
| `UserName` | `DFM` ✓ |
| `CompanyName` | `Mint` ✓ |
| (other fields unchanged) | |

---

## Likely root causes — ranked

1. **Malformed SOAP identity (fixed in code)** — Sending `DFM@Mint` as `UserName` while also sending `CompanyName=Mint` does not match the documented contract. Error text *"Unknown client/user/password combination"* is consistent with bad username/company pairing.

2. **Account not provisioned on CT yet** — `mint-iress-email.txt` notes sandbox credentials were **pending IRESS compliance approval**. Login may fail even with correct field split until Iress activates the login on `webservices-ct`.

3. **Missing "Web Services" group permission** — PDF p. 5: without group-level Web Services permission, login/WSDL entitlement fails. Distinct from wrong password; may surface as login failed / permission errors.

4. **Wrong password or typo** — Verify the value in `IRESS_PASSWORD` matches what Iress issued (do not commit to docs or git).

5. **Wrong company string** — If Iress registered the firm as `MINT` or `DFM` (not `Mint`), CT will reject. Only Iress can confirm exact `CompanyName` spelling.

6. **Wrong endpoint** — Prod creds on CT or vice versa. We default to CT correctly; less likely if env is unchanged.

7. **LDAP/SSO login** — If `DFM` is not a native login, empty `AuthenticationType` may be wrong. Unlikely for a sandbox API user unless specified.

8. **IP allowlisting** — Not in docs; ask if CT requires fixed egress.

9. **ApplicationID / concurrent sessions** — Wrong `ApplicationID` does not cause *unknown user/password*; license exhaustion returns **25008** with a different message (*"No more licenses available"*).

10. **TLS / transport** — Would typically not return a structured Iress login fault with that message.

---

## Recommended fixes

### Code (done)

- `parseIressUserCode()` in `src/lib/iress/config.ts` splits `user@company` before SOAP.
- Tests in `src/__tests__/iress-config.test.ts`.

### Config

Keep env as Iress delivered it:

```env
IRESS_USERNAME=DFM@Mint
IRESS_COMPANY_NAME=Mint
```

Or split explicitly (equivalent after parser):

```env
IRESS_USERNAME=DFM
IRESS_COMPANY_NAME=Mint
```

Re-run live E2E after deploy:

```powershell
.\scripts\verify-live-e2e.ps1
```

### Manual WSDL check (no code)

Open `https://webservices-ct.iress.co.za/v4` → **WSDL** → enter **username `DFM`**, **company `Mint`**, password from env. If the form rejects credentials, SOAP will too.

---

## Questions for Charles

1. **Exact SOAP values** — For the CT sandbox login you issued as `DFM@Mint`, should `IRESSSessionStart` use `UserName=DFM` and `CompanyName=Mint` (or `MINT` / another exact company code)?

2. **CT provisioning status** — Is `DFM` active on `webservices-ct.iress.co.za` yet, or still awaiting compliance? If not active, what is the expected activation date?

3. **Web Services permission** — Is the **Web Services** group permission enabled for this login? Any method-level entitlements still pending for the definite 17-method list?

4. **IP allowlisting** — Does CT require allowlisted egress IPs for SOAP from Mint's dev machines / Vercel?

5. **Password confirmation** — Can you confirm the password was set and is not a placeholder pending first-login reset? (Do not send password by email — confirm activation only.)

---

## Related errors (for comparison)

| Code | Typical message | Meaning |
|------|-----------------|---------|
| 25008 | Login failed. No more licenses… | License cap; not wrong password |
| 25020 | Login failed | Bad credentials or permissions |
| (fault string) | Unknown client/user/password combination | Invalid user/company/password triple |

Match on **error number** when present; fault strings can change (PDF session error codes preamble).

---

## References

| Document | Path |
|----------|------|
| Programmers guide (PDF) | `Documentation & Vision/IressWebServicesV4-Programmers_Guide (1).pdf` |
| Session start | `Documentation & Vision/iress-v4-docs/04-sessions/01-iress-sessions.md` |
| Endpoints | `Documentation & Vision/iress-v4-docs/01-foundations/03-endpoints.md` |
| Session errors | `Documentation & Vision/iress-v4-docs/06-errors/01-session-error-codes.md` |
| Support bundle | `Documentation & Vision/iress-v4-docs/06-errors/04-support-queries.md` |
| SOAP example | `Documentation & Vision/iress-v4-docs/13-soap-examples/iress-session-start.request.xml` |
| Mint config | `wealth-navigator/src/lib/iress/config.ts`, `index.ts`, `live.ts` |
| Last E2E note | `wealth-navigator/docs/DATA_PROVENANCE.md` |

---

## CT vs Production

| Question | Answer |
|----------|--------|
| Which URL does Mint SOAP use? | **`IRESS_BASE_URL` only** — `createLiveIressClient()` / `createSoapTransport()` POST to ``${IRESS_BASE_URL}/SOAP.aspx``. |
| What is `IRESS_PROD_URL` for? | **Metadata** on `iressConfig.prodUrl` (integration UI / docs). It does **not** switch the live adapter unless you set `IRESS_BASE_URL` to the prod URL. |
| Prod creds on CT / CT creds on prod? | Iress docs: environments are separate; **production credentials do not work on CT unless provisioned there** (and vice versa). |
| Safe prod smoke test | One-off: ``$env:IRESS_BASE_URL="https://webservices.iress.co.za/v4"; bun run scripts/probe-iress-login.ts`` — loads username/password from `.env.local` only; does not log password. Restore CT in shell or omit override after test. |

**Probe results (2026-06-11, `DFM` / `Mint`, post `parseIressUserCode()`):**

| Endpoint | `IRESSSessionStart` | Notes |
|----------|---------------------|--------|
| CT `https://webservices-ct.iress.co.za/v4` | Fail | `Login failed. No more licenses available for this login` (SOAP fault; not unknown user/password) |
| Prod `https://webservices.iress.co.za/v4` | Fail | **Same license message** — identity appears recognized on prod too; session still not started |

**Should Mint dev point at production?** **No, not yet.** Prod carries live JSE/market and compliance obligations; Charles indicated web-services logins are still moving through compliance. Use **CT** for build/test until Iress confirms CT (or separate prod) credentials and license headroom.

**Ask Charles:** (1) Are `DFM`@`Mint` and password intended for **CT only**, **prod only**, or **both**? (2) Please clear stale sessions or increase CT license count for `DFM`. (3) When will compliance-approved **prod** web-services credentials be issued (if different from CT)?

### Local testing workflow (single CT seat)

`DFM@Mint` appears to allow **one concurrent** session. Only one process should hold the license at a time.

1. **Stop** any `npm run dev` on `:3000` (orphaned sessions block login until IRESS timeout).
2. **Release** app session: `DELETE http://localhost:3000/api/iress/session?wait=1` (with `mint-auth` cookie), or Ctrl+C dev server — shutdown hooks call `IRESSSessionEnd` when `IRESS_MODE=live`.
3. **Probe** (standalone): `bun run scripts/probe-iress-login.ts` — not while dev server is running.
4. **App test**: start dev server → `GET /api/iress/health` → quotes. End with `DELETE /api/iress/session?wait=1` before switching to probe.

Disable auto teardown: `IRESS_SHUTDOWN_HOOKS=0` in `.env.local`.

