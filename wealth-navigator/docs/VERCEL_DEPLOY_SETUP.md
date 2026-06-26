# Vercel Deploy Setup — Mint Wealth Navigator

> Step-by-step bring-up of the **Next.js 16** frontend on Vercel, talking to the
> MyMint Supabase project (`nnwzhxfjpjbzujevwzlh`). The IRESS SOAP worker runs on
> Railway (separate surface — see `docs/GO_LIVE_RUNBOOK.md`).
>
> **Goal:** `vercel --scope autonama-group --prod` ships the app, `/api/quotes` returns live Supabase
> rows, and the OEMS desk renders without 127 / 404 / 500 walls.

---

## 1. Prereqs

| What | Version | Why |
|---|---|---|
| Bun | `>= 1.1.0` | Local install + build parity. Vercel auto-detects `bun.lock`; the lockfile is gitignored, so set **Package Manager = bun** in the dashboard. |
| Node | `>= 20.0.0` | Vercel Functions runtime (Vercel provides Node 22 by default). |
| Vercel account | Hobby or Pro | One project per repo. |
| GitHub | `edgeza/Wealth-Navigator` (or fork) | Vercel connects via the GitHub App. |
| Supabase (MyMint) project | `nnwzhxfjpjbzujevwzlh` | Anon + service-role keys (see §4). |

Local sanity before touching Vercel:

```bash
cd "c:/Users/juan/OneDrive/Documents/GitHub/MINT/Wealth Navigator/wealth-navigator"
bun install
bun run test    # 172 tests must pass
bun run build   # must finish with "Generating static pages (20/20)"
```

If `bun run build` errors with `useSearchParams() should be wrapped in a suspense
boundary`, you forgot the Suspense refactor in `src/app/oems/{security,strategies}/page.tsx`.

---

## 2. Vercel Project Settings (do these FIRST, before the first push)

> Vercel will guess wrong if you let it — the Next.js app is a **sub-directory**
> (`wealth-navigator/`), and the package manager is **Bun**, not npm. Set both
> before the first deploy, or you'll burn the 100 free build-minute budget
> fixing the same exit-127 loop.

### 2a. General → Root Directory

```
Root Directory:    wealth-navigator
```

Why: the root `package.json` is a thin delegator (e.g. `npm --prefix wealth-navigator run build`).
If Vercel uses the repo root as project root, the install step resolves the
wrong manifest, `next` is never installed, and `npm run build` exits **127
(command not found)**. Pointing Vercel at `wealth-navigator/` makes install +
build run against the real Next.js manifest.

### 2b. Build & Development Settings

```
Framework Preset:        Next.js
Build Command:           next build                       (default — leave blank)
Install Command:         bun install                      (override — see below)
Development Command:     next dev                         (default)
Package Manager:         bun                              (override — auto-detect fails because bun.lock is gitignored)
Node.js Version:         22.x                             (matches engines.node)
```

If the **Package Manager** dropdown is greyed out (Vercel auto-detected npm
from the root), override the **Install Command** explicitly to `bun install`
and select bun in the framework preset. Either path works; the dashboard
setting is the durable one.

### 2c. Root `package.json` delegation (already in place)

Repo root delegates to the sub-directory; do not remove these:

```json
{
  "scripts": {
    "dev":   "npm --prefix wealth-navigator run dev",
    "build": "npm --prefix wealth-navigator run build",
    "start": "npm --prefix wealth-navigator run start"
  }
}
```

`wealth-navigator/package.json` defines the real Next.js scripts:

```json
{
  "scripts": {
    "dev":   "next dev -p 3000",
    "build": "next build",
    "start": "next start -p 3000"
  }
}
```

If Root Directory is set correctly, Vercel never reads the root `package.json`
at all — the `wealth-navigator/` manifest is the source of truth.

---

## 3. Create / link the Vercel project

### Option A — Dashboard (recommended for first-time)

1. <https://vercel.com/new> → **Import** the `edgeza/Wealth-Navigator` repo.
2. Project name: `mint-wealth-navigator` (or your choice).
3. **Override** the Root Directory to `wealth-navigator` before clicking
   *Deploy* (see §2a).
4. Skip the env-var screen — set them via CLI in §4 (the dashboard's paste
   box doesn't handle multi-line values well).

### Option B — CLI (faster for repeat deploys)

```powershell
# Install once
npm i -g vercel

# Login (opens browser, single sign-on)
vercel login

# Link the repo — answers:
#   "Set up and deploy?" → Y
#   "Which scope?"        → your team / personal
#   "Link to existing project?" → N
#   "Project name?"       → mint-wealth-navigator
#   "In which directory is your code located?" → wealth-navigator
#   "Override settings?"  → Y for Root Directory + Package Manager
#                           (or do it in the dashboard — §2)
vercel link
```

`vercel link` writes `.vercel/project.json` (gitignored) and creates
`.vercel/README.md`. Commit the README, ignore the rest.

---

## 4. Environment variables (Production + Preview)

Set these with `vercel env add` — answer "Production" first, then repeat for
"Preview". **Do not** put any of these in `vercel.json`, `next.config.ts`, or
any committed file.

| Variable | Required | Example / value | Where it lives |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | `https://nnwzhxfjpjbzujevwzlh.supabase.co` | Anon-safe — exposed to the browser |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | `eyJhbGciOi…` (MyMint anon JWT) | Anon-safe — exposed to the browser |
| `SUPABASE_URL` | ✅ | `https://nnwzhxfjpjbzujevwzlh.supabase.co` | Server only — API routes, server components |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | `eyJhbGciOi…` (MyMint service-role JWT) | Server only — bypasses RLS, **never** anon |
| `USE_SUPABASE_QUOTES` | ⚠️ flag | `true` (LIVE) / `false` (mock preview) | Server — gates `live-queries.ts` to read `stock_intraday_c` |
| `IRESS_MODE` | ⚠️ flag | `mock` (preview / demo) / `live` (only with creds) | Server — adapter selector |
| `IRESS_BASE_URL` | optional | `https://webservices-ct.iress.co.za/v4` | Server — defaults to CT; set per region |
| `IRESS_WORKER_URL` | server-only | `https://iress-ingest-1.up.railway.app` (Railway **public** domain) | Server - Path B BFF base URL. Falls back to `RAILWAY_SERVICE_URL`, then 503 `not_configured`. **Never** the `*.railway.internal` hostname - that is internal-only and does not resolve from Vercel. |
| `WORKER_HTTP_TOKEN` | optional, paired on Vercel + Railway worker | long random string, e.g. `openssl rand -hex 32` | Server - BFF sends `Authorization: Bearer <token>`; worker 401s on mismatch. Leave unset for single-tenant deploys. |

| `IRESS_PROD_URL` | optional | `https://webservices.iress.co.za/v4` | Server — production endpoint |
| `IRESS_USERNAME` | live only | `user@company` (split by `parseIressUserCode`) | Server — **never** `NEXT_PUBLIC_*` |
| `IRESS_PASSWORD` | live only | (LIVE password) | Server — encrypted at rest by Vercel |
| `IRESS_COMPANY_NAME` | live only | `Mint` | Server — splits `user@company` if `@` is missing |
| `IRESS_REGION` | optional | `ZA` | Server — surfaced to IRESS admin tooling |
| `IRESS_APPLICATION_LABEL` | optional | `Mint-OEMS-Production` | Server — shows up in IRESS console |
| `NEXT_PUBLIC_APP_NAME` | optional | `Mint Wealth Navigator` | Client — header / OG tags |
| `NEXT_PUBLIC_APP_REGION` | optional | `ZA` | Client — region badge |
| `NEXT_PUBLIC_TICK_STREAM` | optional | `/api/ticks` | Client — SSE endpoint |
| `NEXT_PUBLIC_TICK_INTERVAL_MS` | optional | `1100` | Client — UI tick cadence |

> **Secret source-of-truth:** MyMint keys for Vercel live in repo-root
> `supabase_creds` (`TEST_SUPABASE_URL`, `TEST_SUPABASE_ANON_KEY`,
> `TEST_SUPABASE_SERVICE_ROLE_KEY` - all for `nnwzhxfjpjbzujevwzlh`) or in the
> Supabase dashboard -> Settings -> API for that project. Never commit JWTs.



### UAT phase: price source is Yahoo, not IRESS

While Mint is on the IRESS **UAT** endpoint (`webservices-ct`), IRESS quotes are
test data, so the live app sources prices from Yahoo:

| Var | Value (UAT) | Effect |
|---|---|---|
| `IRESS_PRICE_OVERLAY` | `0` (Vercel) | App ignores IRESS quotes (analysis, board, ticker) and shows Yahoo. |
| `YAHOO_FUNDAMENTALS_WRITE` | `1` (Vercel) | The `/api/cron/yahoo-fundamentals` cron writes `securities_c` (incl. last_price + change during UAT). |
| `CRON_SECRET` | random (Vercel) | Authenticates the scheduled cron. |
| `IRESS_RETAIL_DRY_RUN` | `1` (Railway) | Worker does not write IRESS test prices to the retail DB. |

The cron is scheduled in `vercel.json` (`*/30` on JSE weekdays). At the production
cutover, set `IRESS_PRICE_OVERLAY=1` (or unset) and `IRESS_RETAIL_DRY_RUN=0` so
IRESS becomes the live price source and owns `last_price` again.

> Vercel env-var changes only take effect on a REDEPLOY. After changing any of the
> above, push to `main` or use Vercel -> Redeploy.

### IRESS_MODE=mock on Vercel is not mock quotes

Production Vercel should keep **`IRESS_MODE=mock`**: the Railway `iress-ingest`
worker holds the single IRESS CT seat, and serverless must not open live SOAP
sessions.

That flag does **not** force mock prices on the OEMS desk when
**`USE_SUPABASE_QUOTES=true`**. `/api/quotes` reads `stock_intraday_c` via
`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`; a healthy response shows
`"mode": "supabase"` and per-row `"source": "supabase"`. You only get
`"mode": "mock"` when `USE_SUPABASE_QUOTES` is off or Supabase env vars are
missing/wrong.

`IRESS_MODE` still governs `/api/iress/*` and any in-process IRESS adapter
calls from the Next.js app - separate from the Supabase quote path.

### Align Railway SUPABASE_URL with Vercel

The ingest worker writes intraday rows using **its** `SUPABASE_URL`. If Railway
still targets a different project ref than Vercel, Production will show
`supabaseCount: 0` (or stale rows). Set Railway to the same host as Vercel:
`https://nnwzhxfjpjbzujevwzlh.supabase.co` plus the matching service-role key.
The worker README still shows the eventual LIVE ref (`mfxnghmuccevsxwcetej`) in
its live-write example - use that only when you intentionally cut Vercel + worker
over to LIVE together.

### CLI workflow (paste the value when prompted)

> From repo root: `vercel --scope autonama-group env add ...` (project `autonama-group/wealth-navigator`, prod alias `https://wealth-navigator-one.vercel.app`).


```powershell
# Production
vercel env add NEXT_PUBLIC_SUPABASE_URL      production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add SUPABASE_URL                 production
vercel env add SUPABASE_SERVICE_ROLE_KEY    production
vercel env add USE_SUPABASE_QUOTES          production   # value: true
vercel env add IRESS_MODE                   production   # value: mock  (keeps Vercel off IRESS CT; quotes still from Supabase when USE_SUPABASE_QUOTES=true)
vercel env add IRESS_BASE_URL               production   # value: https://webservices-ct.iress.co.za/v4

# Preview (default to mock — preview builds should not hit LIVE IRESS)
vercel env add NEXT_PUBLIC_SUPABASE_URL      preview
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY preview
vercel env add SUPABASE_URL                 preview
vercel env add SUPABASE_SERVICE_ROLE_KEY    preview
vercel env add USE_SUPABASE_QUOTES          preview       # value: false (mock seed data)
vercel env add IRESS_MODE                   preview       # value: mock

# Optional — only if you're enabling live IRESS from the Vercel side
# (today the worker holds the only CT seat, so leave these off Vercel)
# vercel env add IRESS_USERNAME              production
# vercel env add IRESS_PASSWORD              production
# vercel env add IRESS_COMPANY_NAME          production
```

`vercel env add` prompts for the value with a hidden input — paste, hit Enter.
Repeat per environment. To **edit** a value: `vercel env rm NAME <env>` then
re-add.

### Verify (downloads the resolved env to `.env.local`)

```powershell
vercel env pull .env.local
# .env.local is gitignored — never commit it.
Get-Content .env.local | Select-String "SUPABASE_URL|IRESS_MODE|USE_SUPABASE"
```

You should see the MyMint Supabase URL (nnwzhxfjpjbzujevwzlh), `IRESS_MODE=mock`, and
`USE_SUPABASE_QUOTES=true` (Production) / `false` (Preview).

---

## 5. First deploy

```powershell
# Preview (dry run, gives you a *.vercel.app URL)
vercel

# Look for "Build successful" + "Preview deployment ready"
# Open the URL — expect a redirect to /login and the dark-slate login page.

# Promote to production
vercel --scope autonama-group --prod
```

What success looks like in the dashboard (Build tab):

- **Build time:** ~15–20s (Bun install) + ~6s (`next build`).
- **Status:** ✅ Ready
- **Source:** `main` (Production) / `<branch>` (Preview)
- **Region:** `iad1` (default; override with `vercel.json` `regions` if needed)

What success looks like in the runtime:

- `/login` renders the split-screen sign-in (admin/admin still works in dev;
  real auth comes with Supabase wiring).
- `/api/quotes?symbols=NPN,PRX,FSR&exchange=JSE` returns JSON like:

  ```json
  {
    "mode": "supabase",
    "useSupabase": true,
    "quotes": [
      { "symbol": "NPN", "last_price": 245800, "source": "supabase" },
      { "symbol": "PRX", "last_price":  92340, "source": "supabase" }
    ],
    "supabaseCount": 2,
    "liveCount": 0,
    "fallbackCount": 0,
    "mockCount": 0
  }
  ```

  Source taxonomy: `supabase` (worker-fed), `live` (IRESS SOAP), `seed-fallback`
  (network blip), `mock` (when USE_SUPABASE_QUOTES is false — not because IRESS_MODE=mock on Vercel).
- `/oems` loads the trading desk; the per-row **Source** badge shows
  `SUPABASE` once the worker has written `stock_intraday_c` rows.

---

## 6. Post-deploy smoke test

```powershell
# 1. Replace the placeholder with your real production URL
$url = "https://wealth-navigator-one.vercel.app"

# 2. Health
curl.exe "$url/api/health" | Select-String "ok"

# 3. Quotes (LIVE Supabase path)
curl.exe "$url/api/quotes?symbols=NPN,PRX,FSR,SBK,AGL&exchange=JSE" |
  Select-String "mode|source|supabaseCount|liveCount"

# 4. IRESS session (mock on Vercel - worker holds CT seat)
curl.exe "$url/api/iress/session" | Select-String "mode|entitled|seat"

# 5. Login → cookie round-trip
curl.exe -X POST "$url/api/auth/login" `
  -H "Content-Type: application/json" `
  -d '{"username":"admin","password":"admin"}' -i |
  Select-String "set-cookie|HTTP/"

# 6. Hit a gated route with the cookie
curl.exe "$url/oems" -H "Cookie: mint-auth=1" -i |
  Select-String "HTTP/"
```

If step 3 returns `"mode": "mock"` instead of `"supabase"`:
- `USE_SUPABASE_QUOTES` is unset or `false` in that env — fix with
  `vercel env add USE_SUPABASE_QUOTES production` (value `true`) and re-deploy.
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` not set — check with
  `vercel env ls production`.

If step 3 returns `500 "USE_SUPABASE_QUOTES=true but Supabase not configured"`,
the service-role key is missing or mistyped — re-add it.

---

## 7. Continuous deploy

- Push to `main` → Production deploy.
- Push to any other branch → Preview deploy (uses Preview env, defaults to
  `IRESS_MODE=mock` and `USE_SUPABASE_QUOTES=false`).
- PR branches get a unique `*.vercel.app` URL posted back to GitHub by the
  Vercel GitHub App.

To pause deploys: Vercel dashboard → Project → Settings → Git → *Ignored
Build Step* (e.g. `[ "$VERCEL_GIT_COMMIT_MESSAGE" = *"skip-deploy"* ]`).

To roll back: Deployments tab → click a previous green build → **Promote to
Production**. No git reverts needed.

---

## 8. Troubleshooting exit 127 / build failures

| Symptom | Cause | Fix |
|---|---|---|
| `Build failed — exit 127` | Root Directory = repo root (so `next` is not installed) | Set Root Directory = `wealth-navigator` (§2a), then redeploy |
| `Build failed — exit 127` on a clean repo | `bun` not selected; Vercel fell back to npm but `next` was installed at the wrong level | Set Package Manager = `bun` in Project Settings (§2b) |
| `useSearchParams() should be wrapped in a suspense boundary` | Pre-Next-16 page missing `<Suspense>` around the consumer | Already fixed in `src/app/{login,oems/security,oems/strategies}/page.tsx` — pull latest `main` |
| `Property 'dir' does not exist on type 'ImportMeta'` | Bun-specific extension without Bun types | Already fixed: `import.meta.dir` → `import.meta.dirname` (Node 20.11+ standard) in `scripts/*.ts` |
| `Property 'Service' does not exist on type` in tests | Stale mock shape | Already fixed in `src/__tests__/worker-session.test.ts` |
| `Warning: The "middleware" file convention is deprecated. Please use "proxy"` | Next.js 16 deprecation | Cosmetic; fix tracked in a follow-up. Build still succeeds. |
| `Cannot find module '@/...'` during build | `tsconfig.json` paths not picked up | `tsconfig.json` already has `baseUrl: "."` + `paths: { "@/*": ["./src/*"] }` — no action |

---


## 8a. Railway public networking + Path B bring-up

Railway exposes two DNS surfaces for each service:

- **Internal**: `<service>.railway.internal` (e.g. `iress-worker.railway.internal`) - resolvable only from **other Railway services** in the same project. Vercel is not on Railway's network, so this hostname **does not resolve** from Vercel functions and returns `ENOTFOUND` / `EAI_AGAIN`.
- **Public**: a generated `<service>-<n>.up.railway.app` domain on a public TCP port. This is the only address the Vercel BFF can use to call the worker.

For Vercel <-> Railway you need the **public domain** (free on all Railway plans). True private connectivity requires Railway TCP Proxy / VPC peering, which is paid-tier only.

### Step-by-step

1. Open the Railway project (`https://railway.com/project/dacf9008-a4e8-450c-b5f0-f8a749ec47b4`) and select the `Iress-Worker` service.
2. **Settings** -> **Networking** -> **Public Networking** -> **Generate Domain**. Railway creates something like `https://iress-ingest-1.up.railway.app`.
3. Confirm the port: the worker listens on `WORKER_HTTP_PORT=8765` (default in `workers/iress-ingest/.env.example`). When you generate the public domain, Railway exposes that domain on the worker's primary port - set **Port = 8765** in **Settings** -> **Networking** if Railway does not pick it up automatically.
4. Smoke-test from your laptop:

   ```powershell
   curl.exe -i https://<service>-<n>.up.railway.app/health
   ```

   Expect `200 OK` with JSON `{"ok":true,"workerId":"iress-ingest",...}`. If you get `404`, the public port is not 8765 (Railway public networking maps 443 to the service port you choose - confirm in the service Networking tab).
5. Copy that exact URL (including the `https://`) and set it on Vercel **production**:

   ```powershell
   # From repo root
   vercel --scope autonama-group env add IRESS_WORKER_URL production --value "https://<service>-<n>.up.railway.app" --yes
   ```

   - If your value happens to begin with `-`, PowerShell treats it as a flag - quote it: ``--value `"https://...`"`` `(outer backticks escape the leading `-`).
   - ``--yes`` skips the interactive confirmation prompt and the hidden value prompt (the value is passed as ``--value`` instead of being typed in).


6. **(Optional, recommended)** generate a shared bearer token so the worker 401s on unauthenticated calls. Run on Vercel and on the Railway worker with the **same** value:

   ```powershell
   $tok = [guid]::NewGuid().ToString() + ":" + [DateTime]::UtcNow.Ticks   # or: openssl rand -hex 32
   vercel --scope autonama-group env add WORKER_HTTP_TOKEN production --value $tok --yes
   # Paste $tok into Railway -> Iress-Worker -> Variables -> WORKER_HTTP_TOKEN
   ```

7. **Do not** set `IRESS_WORKER_URL` to the `*.railway.internal` hostname, do **not** flip `IRESS_MODE` to `live` on Vercel (the worker holds the only IRESS CT seat), and do **not** commit the token.

### Re-test after the redeploy

Vercel must redeploy for env changes to take effect. Either push to `main` (CI) or run:

```powershell
vercel --scope autonama-group --prod
```

Then, from your laptop:

```powershell
$url = "https://wealth-navigator-one.vercel.app"

# 1. Unauthenticated probe - expect 307/302 to /login (the route is gated)
curl.exe -i "$url/api/integration/health" | Select-Object -First 1

# 2. After signing in at https://wealth-navigator-one.vercel.app/login, open:
#      https://wealth-navigator-one.vercel.app/oems/integration
#    The workerHealth panel should show:
#      - workerId    : iress-ingest
#      - iressMode   : live
#      - sessionCached: true (after the first successful SOAP session)
#      - services    : [IOSPlus] (or whatever the worker started)
#      - accounts    : [ACC1, ACC2, ...] (split from IRESS_ACCOUNT_CODE)
#      - lastQuoteSyncAt: a recent ISO timestamp
#      - uptimeSec   : > 0

# 3. If the panel shows 503 not_configured - IRESS_WORKER_URL is unset or empty on Vercel:
vercel --scope autonama-group env ls | Select-String IRESS_WORKER_URL

# 4. If 503 unreachable - the public domain is wrong, the port is not 8765, or the
#    Railway service crashed. Check Railway -> Iress-Worker -> Logs for [iress-ingest] boot lines.

# 5. If 401 unauthorized - WORKER_HTTP_TOKEN on Vercel does not match the Railway one.
vercel --scope autonama-group env ls | Select-String WORKER_HTTP_TOKEN

# 6. Live ticker spot-check (Path A - worker -> Supabase -> BFF):
curl.exe "$url/api/quotes?symbols=NPN,BHG,AGL&exchange=JSE" | Select-String mode,supabaseCount,source

# 7. Live orders spot-check (Path B - BFF -> worker -> IRESS SOAP):
curl.exe "$url/api/orders/live?account=ACC1&filter=2" | Select-String ok,code,error
```

Successful shape from `/api/integration/health` (after a few seconds warmup):

```json
{
  "ok": true,
  "workerId": "iress-ingest",
  "iressMode": "live",
  "sessionCached": true,
  "services": ["IOSPlus"],
  "accounts": ["ACC1"],
  "lastQuoteSyncAt": "2026-06-12T19:32:11.000Z",
  "uptimeSec": 412
}
```

---

## 9. Related docs

- `docs/GO_LIVE_RUNBOOK.md` — full bring-up: Supabase migrations, Railway worker, Vercel deploy.
- `docs/CLOUD_DEPLOYMENT.md` — topology + env contract (single source of truth for variable names).
- `docs/STACK_ARCHITECTURE.md` — why Vercel + Supabase + Railway, not all-in-one.
- `docs/DATA_PROVENANCE.md` — `live` vs `mock` vs `seed-fallback` vs `supabase` badge semantics.
- `TABLES.md` (repo root) — Supabase schema reference for the LIVE project.

