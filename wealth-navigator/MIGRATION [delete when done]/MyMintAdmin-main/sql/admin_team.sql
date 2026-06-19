-- Admin team members table
-- role: 'admin' (full access) | 'staff' (restricted to page_access list)
-- page_access: array of page keys e.g. ['clients','dashboard','factsheets']
-- status: 'pending' (invite sent, not yet accepted) | 'active'

CREATE TABLE IF NOT EXISTS admin_team (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  email         text NOT NULL UNIQUE,
  full_name     text,
  role          text NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  page_access   text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  invited_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- RLS: only service role key can read/write (all access goes via server.js)
ALTER TABLE admin_team ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON admin_team USING (true) WITH CHECK (true);

-- Index for fast user_id lookups on every page load
CREATE INDEX IF NOT EXISTS admin_team_user_id_idx ON admin_team(user_id);
CREATE INDEX IF NOT EXISTS admin_team_email_idx  ON admin_team(email);
