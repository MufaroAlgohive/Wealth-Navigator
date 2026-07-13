-- alert_log_c — Research trigger hits surfaced by the worker.
-- Mint OEM Finalisation — alert/email path (transcript 2026-07-13 L:879):
-- "as soon as any of them are hit, we need to get an automated e-mail or what
-- you call, the system needs to flag it." The worker compares each approved
-- research note's `triggers` JSONB against the live IRESS price every cycle
-- and writes a row here whenever a level is breached. The Cockpit banner and
-- /api/alerts route read from this table.
-- Review-only; paste into the institutional Supabase SQL editor.
-- Idempotent — safe to re-run.
--
-- v2 (2026-07-13 patch): Postgres rejected `uq_alert_log_daily` because
-- `breached_at::date` is `STABLE`, not `IMMUTABLE` — and index expressions
-- must be IMMUTABLE. Pinning the timezone to UTC inside a STORED-generated
-- column makes the expression row-local and PG happily indexes it. The
-- natural key (note_id, trigger_kind, breached_date) is computed in the
-- generated column on every insert so the worker stays a vanilla
-- `.insert(...)` write; if a second insert hits the same key Postgres raises
-- unique_violation (SQLSTATE 23505) and the worker treats it as
-- "already fired today".

CREATE TABLE IF NOT EXISTS alert_log_c (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID NOT NULL REFERENCES research_note_c(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('buy_below','add_below','trim_above','sell_above','stop_loss')),
  trigger_price NUMERIC NOT NULL,
  observed_price NUMERIC NOT NULL,
  breached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Buckets the day in UTC. Date math over a `timestamptz` depends on the
  -- session timezone unless we pin it; pinning to UTC makes the expression
  -- IMMUTABLE inside a STORED generated column and indexable. The desk lives
  -- in Africa/Johannesburg but the alert_date is global UTC, which matches
  -- the worker's `recordWorkerEvent` timestamps.
  breached_date DATE GENERATED ALWAYS AS ((breached_at AT TIME ZONE 'UTC')::date) STORED,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by TEXT,
  email_sent_at TIMESTAMPTZ,
  email_to TEXT,
  payload JSONB
);

CREATE INDEX IF NOT EXISTS idx_alert_log_note ON alert_log_c(note_id);
CREATE INDEX IF NOT EXISTS idx_alert_log_symbol ON alert_log_c(symbol);
CREATE INDEX IF NOT EXISTS idx_alert_log_date ON alert_log_c(breached_date);
CREATE INDEX IF NOT EXISTS idx_alert_log_unacked ON alert_log_c(acknowledged_at) WHERE acknowledged_at IS NULL;
-- Idempotency: the worker uses (note_id, trigger_kind, breached_date) as the
-- natural key — never fire the same trigger twice on the same day. The
-- generated `breached_date` column is IMMUTABLE so this index builds cleanly
-- (the previous index `uq_alert_log_daily` used `(breached_at::date)` which
-- Postgres correctly refused as STABLE → cannot be indexed).
CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_log_daily
  ON alert_log_c(note_id, trigger_kind, breached_date);

ALTER TABLE alert_log_c ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS alert_log_service_role ON alert_log_c;
CREATE POLICY alert_log_service_role ON alert_log_c
  FOR ALL TO service_role USING (true) WITH CHECK (true);