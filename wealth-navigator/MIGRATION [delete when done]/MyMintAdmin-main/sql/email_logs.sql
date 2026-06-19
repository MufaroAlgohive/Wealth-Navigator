-- Unified email send log — run in Supabase SQL editor.
-- Tracks every outbound email across all types (trade confirmations, EFT, Mint Mornings, webhooks).

CREATE TABLE IF NOT EXISTS email_logs (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email_type     TEXT        NOT NULL,        -- 'trade_confirmation' | 'eft' | 'mint_mornings' | 'welcome' | 'wallet_funded'
  recipient      TEXT        NOT NULL,        -- recipient email address
  subject        TEXT,
  resend_id      TEXT,                        -- Resend message ID for delivery tracking
  status         TEXT        NOT NULL DEFAULT 'sent',  -- 'sent' | 'failed'
  trigger_source TEXT        NOT NULL DEFAULT 'manual', -- 'manual' | 'scheduler' | 'webhook'
  metadata       JSONB,                       -- extra context: holding_id, wallet_id, article_count, etc.
  error_message  TEXT,                        -- populated when status = 'failed'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_logs_type_idx        ON email_logs (email_type);
CREATE INDEX IF NOT EXISTS email_logs_recipient_idx   ON email_logs (recipient);
CREATE INDEX IF NOT EXISTS email_logs_created_at_idx  ON email_logs (created_at DESC);

-- Only server-side (service role) may write; read via service role in admin portal.
ALTER TABLE email_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role only" ON email_logs USING (false);
