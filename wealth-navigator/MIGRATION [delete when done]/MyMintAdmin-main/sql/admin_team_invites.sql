-- Adds invite-token columns to support the signup-from-invite flow.
-- Run this once in the Supabase SQL editor.

ALTER TABLE admin_team
  ADD COLUMN IF NOT EXISTS invite_token            text,
  ADD COLUMN IF NOT EXISTS invite_token_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS admin_team_invite_token_idx
  ON admin_team(invite_token);
