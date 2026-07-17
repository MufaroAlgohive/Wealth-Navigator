-- REVIEW BEFORE APPLY — LIVE PROJECT nnwzhxfjpjbzujevwzlh (MyMint / institutional prod)
-- Apply by pasting into the Supabase SQL editor (no auto-DDL on the live project).
--
-- position_reconciliation_c — book-level position drift scoreboard.
--
-- Compares OUR source of truth (oems_position_c, net of IOS+ fills — see
-- workers/iress-ingest/src/orders.ts::derivePositions) against EXTERNAL position
-- sources, per (business date, account, symbol, source):
--   * source = 'iress_portfolio'    -> IRESS retail-portfolio / IPSPositionGetAll1
--                                      mirror (DORMANT until Charles entitles it)
--   * source = 'longmark_statement' -> Longmark/Hermes statement import
--                                      (manual file import — writer out of scope now)
--
-- Since there is ONE omnibus Longmark account (all clients net in), reconciliation
-- is BOOK-LEVEL: sum of our positions per symbol on the desk account vs the broker
-- net. This is the audit/backup so a corrupted OUR-side ledger is caught against
-- the broker's real holdings. This table NEVER writes back to oems_position_c.
-- No DROP / TRUNCATE / DELETE (DROP POLICY IF EXISTS only).

CREATE TABLE IF NOT EXISTS public.position_reconciliation_c (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of_date             date NOT NULL,
  account_code           text NOT NULL,
  security_code          text NOT NULL,
  source                 text NOT NULL
    CHECK (source IN ('iress_portfolio', 'longmark_statement')),
  our_qty                numeric NOT NULL DEFAULT 0,
  external_qty           numeric,
  diff                   numeric,
  our_market_value       numeric,
  external_market_value  numeric,
  currency               text,
  tolerance_qty          numeric NOT NULL DEFAULT 0,
  status                 text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('ok', 'mismatch', 'missing_external', 'missing_ours', 'pending')),
  recon_run_id           text,
  notes                  text,
  payload                jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at             timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (as_of_date, account_code, security_code, source)
);

COMMENT ON TABLE public.position_reconciliation_c IS
  'Book-level position drift: oems_position_c (ours) vs iress_portfolio / longmark_statement. service_role writes; RLS denies anon/auth. Never writes oems_position_c.';

CREATE INDEX IF NOT EXISTS position_reconciliation_c_status_idx
  ON public.position_reconciliation_c (status);
CREATE INDEX IF NOT EXISTS position_reconciliation_c_asof_idx
  ON public.position_reconciliation_c (as_of_date DESC);
CREATE INDEX IF NOT EXISTS position_reconciliation_c_account_idx
  ON public.position_reconciliation_c (account_code);
CREATE INDEX IF NOT EXISTS position_reconciliation_c_security_idx
  ON public.position_reconciliation_c (security_code);
CREATE INDEX IF NOT EXISTS position_reconciliation_c_source_idx
  ON public.position_reconciliation_c (source);

ALTER TABLE public.position_reconciliation_c ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS position_reconciliation_service_role ON public.position_reconciliation_c;
CREATE POLICY position_reconciliation_service_role ON public.position_reconciliation_c
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── external staging: where BOTH external sources deposit their raw positions ──
-- Source-agnostic so the recon compute is one code path. Empty today (no writer
-- wired) -> every compared symbol lands status='pending'/'missing_external',
-- proving the pipeline end-to-end before any entitlement.
CREATE TABLE IF NOT EXISTS public.position_recon_external_c (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text NOT NULL
    CHECK (source IN ('iress_portfolio', 'longmark_statement')),
  as_of_date    date NOT NULL,
  account_code  text NOT NULL,
  security_code text NOT NULL,
  quantity      numeric NOT NULL DEFAULT 0,
  market_value  numeric,
  currency      text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, as_of_date, account_code, security_code)
);

COMMENT ON TABLE public.position_recon_external_c IS
  'External position mirror for reconciliation. iress_portfolio rows written by the worker (IPSPositionGetAll1, DORMANT until entitled); longmark_statement rows written by a manual file import (out of scope now).';

CREATE INDEX IF NOT EXISTS position_recon_external_c_lookup_idx
  ON public.position_recon_external_c (as_of_date, account_code, security_code);
CREATE INDEX IF NOT EXISTS position_recon_external_c_source_idx
  ON public.position_recon_external_c (source);

ALTER TABLE public.position_recon_external_c ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS position_recon_external_service_role ON public.position_recon_external_c;
CREATE POLICY position_recon_external_service_role ON public.position_recon_external_c
  FOR ALL TO service_role USING (true) WITH CHECK (true);
