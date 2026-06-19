-- Webhook trigger configuration — run in Supabase SQL editor.
-- Each row tells the /api/webhooks/supabase endpoint which email to send
-- when a matching database event arrives from a Supabase webhook.

CREATE TABLE IF NOT EXISTS email_webhook_triggers (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL,              -- human label, e.g. "Trade confirmed → investor email"
  table_name       TEXT        NOT NULL,              -- Supabase table, e.g. "stock_holdings"
  event_type       TEXT        NOT NULL CHECK (event_type IN ('INSERT','UPDATE','DELETE')),
  email_type       TEXT        NOT NULL,              -- 'trade_confirmation' | 'welcome' | 'wallet_funded'
  user_id_field    TEXT        NOT NULL DEFAULT 'user_id', -- field in the record containing user UUID
  condition_field  TEXT,                              -- optional: only fire if record[condition_field] = condition_value
  condition_value  TEXT,
  enabled          BOOLEAN     NOT NULL DEFAULT true,
  description      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_email_trigger_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_email_trigger_updated_at ON email_webhook_triggers;
CREATE TRIGGER trg_email_trigger_updated_at
  BEFORE UPDATE ON email_webhook_triggers
  FOR EACH ROW EXECUTE FUNCTION set_email_trigger_updated_at();

-- Seed sensible defaults
INSERT INTO email_webhook_triggers (name, table_name, event_type, email_type, user_id_field, description) VALUES
  ('Trade confirmed → investor email',   'stock_holdings',    'INSERT', 'trade_confirmation', 'user_id',   'Send trade confirmation to investor when a new holding is created'),
  ('New profile → welcome email',        'profiles',          'INSERT', 'welcome',             'id',        'Send welcome email when a new investor profile is created'),
  ('Wallet transaction → funded notice', 'wallet_transactions','INSERT', 'wallet_funded',      'user_id',   'Notify investor when funds land in their wallet')
ON CONFLICT DO NOTHING;

-- RLS — only service role may read/write
ALTER TABLE email_webhook_triggers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role only" ON email_webhook_triggers USING (false);
