-- ============================================================================
-- PHANTOM CHILD RETURNS — review + cleanup   (RETAIL prod, mfxng)
-- ----------------------------------------------------------------------------
-- FOUND 2026-07-25: the returns pipeline wrote rows for a family member that holds
-- NOTHING. Verified:
--
--   child "amara"  family_member_id 27e0588e-8448-4ccd-af74-729c8c69ba96
--   filled holdings : 0
--   returns rows    : 30   (2026-05-27 .. 2026-07-23)
--   latest basket   : R5 272,00   <-- a portfolio value invented from no holdings
--
-- Any screen reading client_strategy_returns_c for that child will show a R5 272
-- portfolio and a P&L derived from nothing. This is BAD DATA, not a UI bug.
--
-- DO NOT run the DELETE until step 1 and 2 are reviewed. These rows are
-- client-adjacent, so treat them like client data: inspect, export, then delete.
-- ============================================================================

-- 1) CONFIRM the scope: every family member with returns rows but no filled holdings.
SELECT fm.first_name AS child, fm.id AS family_member_id, fm.primary_user_id,
       (SELECT count(*) FROM stock_holdings_c h
          WHERE h.family_member_id = fm.id AND h.avg_fill > 0)      AS filled_holdings,
       (SELECT count(*) FROM stock_holdings_c h
          WHERE h.family_member_id = fm.id)                          AS any_holdings,
       count(r.id)                                                   AS returns_rows,
       min(r.as_of_date) AS first_row, max(r.as_of_date) AS last_row,
       round(max(r.basket_value)/100.0, 2)                           AS latest_basket_rands
FROM family_members fm
JOIN client_strategy_returns_c r ON r.family_member = fm.id
GROUP BY fm.first_name, fm.id, fm.primary_user_id
HAVING (SELECT count(*) FROM stock_holdings_c h
          WHERE h.family_member_id = fm.id AND h.avg_fill > 0) = 0
ORDER BY count(r.id) DESC;

-- 2) EXPORT before deleting (keep the evidence; also lets you restore).
--    Run this and save the output, or snapshot into a scratch table:
CREATE TABLE IF NOT EXISTS public._phantom_child_returns_backup_20260725 AS
SELECT r.*
FROM client_strategy_returns_c r
WHERE r.family_member IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM stock_holdings_c h
     WHERE h.family_member_id = r.family_member AND h.avg_fill > 0
  );

SELECT count(*) AS rows_backed_up FROM public._phantom_child_returns_backup_20260725;

-- 3) DELETE only the rows with no backing holdings. Re-run step 1 afterwards; it must
--    return zero rows.
DELETE FROM client_strategy_returns_c r
WHERE r.family_member IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM stock_holdings_c h
     WHERE h.family_member_id = r.family_member AND h.avg_fill > 0
  );

-- 4) VERIFY (expect 0 rows):
SELECT count(*) AS remaining_phantom_rows
FROM client_strategy_returns_c r
WHERE r.family_member IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM stock_holdings_c h
     WHERE h.family_member_id = r.family_member AND h.avg_fill > 0
  );

-- ROLLBACK (if the delete was wrong):
--   INSERT INTO client_strategy_returns_c
--   SELECT * FROM public._phantom_child_returns_backup_20260725;

-- ============================================================================
-- ROOT CAUSE — this WILL come back without a publisher-side guard.
-- The returns writer creates a row per (user, family_member, strategy) without first
-- checking that the family member actually has a FILLED holding. The durable fix is a
-- guard in that job: skip any (user, family_member, strategy) with no filled holding.
-- Until that lands, re-run step 1 periodically — new phantom rows will reappear.
-- Related: docs/VALUATION_POLICY.md
-- ============================================================================
