-- admin_dismissed_notifications — per-user dismissals of the action-items bar.
-- Mint OEM Finalisation Phase B6. Review-only.
--
-- Idempotent — safe to re-run.
--
-- The action-items bar surfaces pending work (admin_approvals, EFT deposits,
-- IC-approved rebalances, manual funds credits, MM top-ups) on every page.
-- Dismissing an item should NOT remove it from the underlying queue — the
-- user simply opts out of seeing it in the bar. Each row records who hid what
-- and when so we can:
--   1. filter the bar feed on read (`GET /api/admin/action-items`)
--   2. audit later if needed (who dismissed what, when)
--
-- Composite key (user_email, item_id, item_type) so the same item can be
-- re-dismissed by another user without conflict.

CREATE TABLE IF NOT EXISTS admin_dismissed_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_type TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_email, item_id, item_type)
);

CREATE INDEX IF NOT EXISTS idx_admin_dismissed_user ON admin_dismissed_notifications(user_email);
CREATE INDEX IF NOT EXISTS idx_admin_dismissed_item ON admin_dismissed_notifications(item_id, item_type);

ALTER TABLE admin_dismissed_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_dismissed_service_role ON admin_dismissed_notifications;
CREATE POLICY admin_dismissed_service_role ON admin_dismissed_notifications
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE admin_dismissed_notifications IS
  'Per-user dismissals of items in the action-items bar. Dismissing hides the item from the bar but keeps it in the underlying queue.';