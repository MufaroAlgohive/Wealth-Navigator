-- Keep UAT research fully separate from LIVE research and its voting roster.
-- Existing institutional notes predate UAT notes and remain LIVE by default.
ALTER TABLE research_note_c
  ADD COLUMN IF NOT EXISTS environment_scope TEXT NOT NULL DEFAULT 'live'
  CHECK (environment_scope IN ('live', 'uat'));

CREATE INDEX IF NOT EXISTS idx_research_note_environment_scope
  ON research_note_c (environment_scope, updated_at DESC);
