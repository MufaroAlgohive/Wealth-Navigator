-- 20260710000010_corp_action_c.sql
-- Mint Phase C3 — corporate actions table on RETAIL prod (`mfxng…`).
--
-- Holds dividends, splits, spinoffs, rights issues, and mergers so the OEMS
-- Cockpit News Flow + the per-symbol Analysis page can render a real
-- corporate-actions surface without re-deriving it from a vendor each request.
--
-- All writes are user-pasted in the Supabase SQL editor (per AGENTS.md — no
-- auto-DDL on LIVE). The corresponding BFF routes gracefully degrade to an
-- empty array when the table is missing, so this migration can land before
-- the worker-side ingest is wired.
--
-- `amount_cents` is BIGINT to cover total distributions + special dividends
-- without float drift; non-cash events (splits) leave it null.

CREATE TABLE IF NOT EXISTS corp_action_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  ex_date DATE NOT NULL,
  pay_date DATE,
  record_date DATE,
  amount_cents BIGINT,
  currency TEXT NOT NULL DEFAULT 'ZAR',
  action_type TEXT NOT NULL CHECK (action_type IN ('dividend','split','spinoff','rights','merger')),
  notes TEXT,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_corp_action_symbol ON corp_action_c(symbol);
CREATE INDEX IF NOT EXISTS idx_corp_action_ex_date ON corp_action_c(ex_date);
CREATE INDEX IF NOT EXISTS idx_corp_action_type ON corp_action_c(action_type);

ALTER TABLE corp_action_c ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS corp_action_service_role ON corp_action_c
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);