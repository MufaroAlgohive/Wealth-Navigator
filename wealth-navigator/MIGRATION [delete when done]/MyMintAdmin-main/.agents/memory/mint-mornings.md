---
name: Mint Mornings integration
description: How Mint Mornings newsletter is wired in this app — sources, scheduler, routing, duplicate guard
---

## What it is
Daily morning newsletter emailed to all confirmed Supabase Auth users. Fetches `News_articles` rows with `content_types cs {ALLBRF}` from Supabase, builds branded HTML, sends via Resend from `mornings@mymint.co.za`.

## Key files
- `api/mint-mornings.js` — CommonJS handler + `runMintMornings()` export for scheduler
- `server.js` — route `/api/mint-mornings` + `startMintMorningsScheduler()` called in `startServer()`
- `public/mint-mornings.html` — admin UI (status, manual send, test send)
- `sql/mint_mornings_log.sql` — must be run in Supabase SQL editor to create duplicate-send log table

## Scheduler
Runs every 60 seconds, fires at `MINT_MORNINGS_SEND_HOUR_UTC` (default 5) / `MINT_MORNINGS_SEND_MINUTE_UTC` (default 0) = 07:00 SAST. Date-keyed to fire at most once per day.

## Duplicate guard
Checks `mint_mornings_log` table (`send_date` UNIQUE). If table doesn't exist, silently skips guard. Use `?force=true` to override.

## Test mode
`POST /api/mint-mornings?test=email@example.com` — sends only to that address, does not log.

## Env vars needed
- `RESEND_API_KEY` — already set as secret
- `SUPABASE_SERVICE_ROLE_KEY` — needed for listing auth users and writing log
- `MINT_MORNINGS_FROM` — optional, defaults to `MINT Mornings <mornings@mymint.co.za>`
- `MINT_MORNINGS_SEND_HOUR_UTC` / `MINT_MORNINGS_SEND_MINUTE_UTC` — optional schedule override

**Why CommonJS + fetch:** rest of codebase uses require/module.exports and plain fetch; no Resend SDK or Supabase JS SDK installed.
