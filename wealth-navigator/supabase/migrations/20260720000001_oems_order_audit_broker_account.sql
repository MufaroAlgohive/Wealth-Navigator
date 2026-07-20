-- 2026-07-20: OEMS guardrail + force-correction refactor (plan §6).
--
-- Add a typed `broker_account_code text` column to `oems_order_audit` so every
-- query (the BFF limit guard, the worker preflight, future per-client
-- filtering) can filter on the IRESS AccountCode directly. Until today,
-- the IRESS account code lived in two places:
--
--   1. `client_account` — but BFF-seeded rows used the trader's email here
--      while worker-poll rows used the IRESS account code. The BFF runLimitGuard
--      worked around this with `or(client_account.eq.X, payload->>broker_account_code.eq.X)`
--      which is brittle (JSON lookup, easy to break) and slow.
--
--   2. `payload->>broker_account_code` — JSON, not indexable.
--
-- After this migration the typed column is the source of truth. Existing rows
-- are backfilled from `payload.broker_account_code` when present, so the index
-- covers the whole history. New rows are written via `src/lib/orders/submit.ts`
-- which stamps both the typed column and the payload (backwards-compat).
--
-- Idempotent — safe to apply on a database that already has the column.

ALTER TABLE public.oems_order_audit
  ADD COLUMN IF NOT EXISTS broker_account_code text;

-- Backfill from the legacy JSON payload so existing rows participate in the
-- new typed index. WHERE jsonb column present and typed column null guards
-- against re-runs and against rows where the JSON key is missing entirely.
UPDATE public.oems_order_audit
   SET broker_account_code = payload->>'broker_account_code'
 WHERE broker_account_code IS NULL
   AND payload ? 'broker_account_code'
   AND nullif(payload->>'broker_account_code', '') IS NOT NULL;

-- Partial index — most rows will have a broker_account_code now, but the
-- WHERE clause keeps the index small for any straggler rows (legacy,
-- unparseable, etc.) and is a cheap belt-and-braces against NULL noise.
CREATE INDEX IF NOT EXISTS oems_order_audit_broker_account_code_idx
  ON public.oems_order_audit (broker_account_code)
  WHERE broker_account_code IS NOT NULL;
