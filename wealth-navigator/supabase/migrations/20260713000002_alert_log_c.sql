-- alert_log_c — Research trigger hits surfaced by the worker.
-- Mint OEM Finalisation — alert/email path (transcript 2026-07-13 L:879):
-- "as soon as any of them are hit, we need to get an automated e-mail or what
-- you call, the system needs to flag it." The worker compares each approved
-- research note's `triggers` JSONB against the live IRESS price every cycle
-- and writes a row here whenever a level is breached. The Cockpit banner and
-- /api/alerts route read from this table.
-- Review-only; paste into the institutional Supabase SQL editor.
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS alert_log_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID NOT NULL REFERENCES research_note_c(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('buy_below','add_below','trim_above','sell_above','stop_loss')),
  trigger_price NUMERIC NOT NULL,
  observed_price NUMERIC NOT NULL,
  breached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  email_sent_at TIMESTAMPTZ,
  email_to TEXT,
  payload JSONB
);

CREATE INDEX IF NOT EXISTS idx_alert_log_note ON alert_log_c(note_id);
CREATE INDEX IF NOT EXISTS idx_alert_log_symbol ON alert_log_c(symbol);
CREATE INDEX IF NOT EXISTS idx_alert_log_unacked ON alert_log_c(acknowledged_at) WHERE acknowledged_at IS NULL;
-- Idempotency: the worker uses (note_id, trigger_kind, breached_at::date) as the
-- natural key — never fire the same trigger twice on the same day.
CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_log_daily
  ON alert_log_c(note_id, trigger_kind, (breached_at::date));

ALTER TABLE alert_log_c ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alert_log_service_role ON alert_log_c;
CREATE POLICY alert_log_service_role ON alert_log_c
  FOR ALL TO service_role USING (true) WITH CHECK (true);