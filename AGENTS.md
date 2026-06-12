## Learned User Preferences

- IRESS Web Services credentials (`IRESS_USERNAME`, `IRESS_PASSWORD`, `IRESS_COMPANY_NAME`) are server-side SOAP session creds only — never application user login or browser pre-fill
- App login stays dev-only `admin`/`admin` until real auth (Supabase or similar); personas live at `/oems`, `/wm`, `/strategist`, `/admin`, `/business`, `/fc/overview`
- `/oems` is the main entry after login, not a marketing landing page
- Login page should not show demo persona cards or institutional marketing pitch blocks
- Theme: purple accent on white (light) and dark slate-purple (dark)
- Prefer basic IRESS endpoint lists (method names grouped by namespace) over verbose rationales for email attachments
- IRESS follow-up emails to Charles should be reply-toned on the existing thread, not cold first-contact
- Cannot test IRESS locally reliably; prioritize production Railway worker + Supabase ingestion over local dev polish
- Clear LIVE vs MOCK/SEED labeling in the UI wherever data source matters
- Dispatches multi-agent workers for larger implementation batches
- Wants explicit opt-in for LIVE writes (worker defaults `IRESS_WORKER_DRY_RUN=1` and `SUPABASE_ALLOW_WRITES=0`; production flips consciously)
- Production go-live step 1: Railway `iress-ingest` worker connected to IRESS with endpoints verified before dashboard/UI work

## Learned Workspace Facts

- Next.js app lives in `wealth-navigator/`; root `package.json` delegates `npm run dev` via `npm --prefix wealth-navigator`
- Stack: Vercel (Next.js 16 + Bun) + Supabase (auth/DB/audit/realtime quotes) + Railway `workers/iress-ingest/` (holds the single IRESS CT license seat; DB-first ingest path)
- OEMS trading desk is the primary product surface; IRESS V4 SOAP integration is the technical centerpiece
- Rebuilt from Lovable Codebase (Vite/React) to Next.js 16, React 19, Bun, TypeScript strict, Tailwind, shadcn/ui
- IRESS adapter switches mock vs live via `IRESS_MODE`; live SOAP targets `webservices-ct.iress.co.za/v4` with 17-method `IressClient` surface; `IRESSSessionStart` uses separate `UserName` + `CompanyName` (use `parseIressUserCode()` in `src/lib/iress/config.ts` to split `user@company`)
- Product vision and IRESS reference docs live under `Documentation & Vision/` (`iress-v4-docs`, `Email`, programmers guide PDF)
- IRESS email deliverables include `mint-iress-email.txt` plus basic endpoint lists (`mint-iress-v4-endpoints-*-basic.txt`)
- Stack/data-source docs: `wealth-navigator/docs/STACK_ARCHITECTURE.md`, `docs/DATA_PROVENANCE.md`; go-live runbook `docs/MINT_GO_LIVE_RUNBOOK.html`
- Never put IRESS passwords or API keys in `AGENTS.md`, client bundles, or `NEXT_PUBLIC_*` variables
- IRESS CT is single-seat; SOAP error 25008 = "No more licenses available" (orphaned sessions); probe + worker must call `IRESSSessionEnd` and wait 3s (`LICENSE_RELEASE_DELAY_MS`); if license held on another machine, log off there before starting worker
- Supabase LIVE project ref `mfxnghmuccevsxwcetej`; TEST/E2E project ref `nnwzhxfjpjbzujevwzlh`; `supabase_creds` (gitignored) holds TEST keys (`TEST_SUPABASE_*`); LIVE keys kept separate; MyMint MCP (`user-supabase - MyMint`) for test migrations — not `plugin-supabase-supabase` (wrong project)
- All Supabase migrations are review-only and user-pasted in SQL editor (worker never auto-applies DDL on LIVE); idempotent SQL only; ingest targets `securities_c` + `stock_intraday_c` (cents, `supabase_realtime`); `USE_SUPABASE_QUOTES=true` routes UI quote reads to Supabase
