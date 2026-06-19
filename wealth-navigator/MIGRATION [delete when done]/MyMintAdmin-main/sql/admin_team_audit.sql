-- Audit log for the admin team. Records who invited / edited / removed
-- each member, plus self-service signup events. Run once in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS admin_team_audit (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  action          text        NOT NULL,   -- invite | update | remove | signup
  target_email    text        NOT NULL,
  target_member_id uuid,
  actor_email     text,                   -- null when actor is the invitee themselves (signup)
  actor_user_id   uuid,
  details         jsonb       DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_team_audit_created_at_idx
  ON admin_team_audit (created_at DESC);

CREATE INDEX IF NOT EXISTS admin_team_audit_target_email_idx
  ON admin_team_audit (target_email);
