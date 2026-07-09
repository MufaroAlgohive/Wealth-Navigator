-- 20260710000011_modeling_input_c.sql
-- Mint Phase C5 — per-user DCF modeling inputs persisted in the INSTITUTIONAL
-- DB so analysts can resume a sandbox without losing their last set of
-- assumptions. The ModelingTab (analysis-tabs.tsx) writes through
-- `POST /api/admin/modeling-inputs` and hydrates from
-- `GET /api/admin/modeling-inputs?symbol=…`; localStorage remains as the
-- offline fallback so the tab still works before the migration lands.
--
-- Schema notes:
--   - `user_id` is the auth-context email (TEXT, not a FK) so we can swap to
--     Supabase Auth user IDs later without a column rewrite.
--   - `inputs` is a JSONB snapshot for forward-compat — adding a new field
--     shouldn't force a DDL change.
--   - UNIQUE(user_id, symbol) means POST is upsert-by-key; saves a separate
--     "is this a create vs update" check.
--   - All writes are user-pasted in the Supabase SQL editor (no auto-DDL on
--     LIVE per AGENTS.md).

CREATE TABLE IF NOT EXISTS modeling_input_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  growth_pct NUMERIC(8,4),
  years INTEGER,
  risk_free_pct NUMERIC(8,4),
  market_premium_pct NUMERIC(8,4),
  beta NUMERIC(8,4),
  cost_of_debt_pct NUMERIC(8,4),
  exit_multiple NUMERIC(8,4),
  inputs JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, symbol)
);

ALTER TABLE modeling_input_c ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS modeling_input_service_role ON modeling_input_c;
CREATE POLICY modeling_input_service_role ON modeling_input_c
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);