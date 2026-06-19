-- Run this in your Supabase SQL editor to enable Mint Mornings duplicate-send prevention.

CREATE TABLE IF NOT EXISTS mint_mornings_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  send_date    DATE NOT NULL UNIQUE,   -- SAST date (YYYY-MM-DD), enforces one send per day
  articles_sent INT  NOT NULL DEFAULT 0,
  users_sent    INT  NOT NULL DEFAULT 0,
  sent_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only service-role can write; no RLS needed for server-side writes.
ALTER TABLE mint_mornings_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role only" ON mint_mornings_log USING (false);
