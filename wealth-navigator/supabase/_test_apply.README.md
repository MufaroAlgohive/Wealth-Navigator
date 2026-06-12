# THROWAWAY TEST PROJECT — Apply Instructions

**Target:** Supabase test project ref `nnwzhxfjpjbzujevwzlh` (URL `https://nnwzhxfjpjbzujevwzlh.supabase.co`)

**File:** `supabase/_test_apply.sql` — combined migration script, idempotent.

## Why this file exists
The Supabase CLI cannot reach this project (no `SUPABASE_ACCESS_TOKEN` set in env, and the
configured MCP only knows about a different "Eververse" project). The cleanest path is a
single paste into the Supabase SQL editor.

## Steps (one-time, ~30s)

1. Open https://supabase.com/dashboard/project/nnwzhxfjpjbzujevwzlh/sql
2. Click **New query**
3. Copy the entire contents of `wealth-navigator/supabase/_test_apply.sql`
4. Paste into the editor
5. Click **Run** (or Cmd/Ctrl+Enter)
6. Expect: `Success. No rows returned` (DDL only, no INSERTs/SELECTs)

## What gets created

| Order | Object | Purpose |
|------:|--------|---------|
| 1 | `public.integration_worker_health` | Heartbeat rows from the worker (one row per `worker_id`) |
| 2 | `public.worker_session_metadata` | Sticky ApplicationID + IRESS session key per worker |
| 3 | `public.oems_order_audit` | Read-only audit mirror of `OrderPadGetByAccount` |
| 4 | RLS policies on `stock_intraday_c` + `securities_c` | anon/authenticated SELECT, service_role writes |
| 5 | `public.securities_with_latest_quote` (view) | Latest intraday price per security |

All 5 are idempotent (`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` + `CREATE POLICY`,
`CREATE OR REPLACE VIEW`). No `DROP`/`TRUNCATE`/`DELETE` on tables.

## After the run

- Confirm tables exist:
  ```sql
  select table_name from information_schema.tables
  where table_schema = 'public' and table_name in
    ('integration_worker_health','worker_session_metadata','oems_order_audit','stock_intraday_c','securities_c')
  order by table_name;
  ```
- Confirm view exists:
  ```sql
  select * from information_schema.views
  where table_schema = 'public' and table_name = 'securities_with_latest_quote';
  ```
- Then report "applied" to the worker and it will continue with Phase 3+.
