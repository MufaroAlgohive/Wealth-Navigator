-- =============================================================
-- Find the holding_id + security_id for the stranded BHP buy
-- Run on RETAIL Supabase (mfxnghmuccevsxwcetej)
-- =============================================================

-- 1. stock_holdings_c.id (→ v_holding_id in the recovery script)
--    Joins to securities_c to filter by symbol, since stock_holdings_c
--    has no `symbol` column itself (only `security_id` → securities_c).
SELECT
  h.id                              AS holding_id,
  h.user_id,
  s.symbol                          AS security_symbol,
  s.id                              AS security_id,
  h.quantity,
  h.avg_fill                        AS avg_fill_cents,
  h."Expected_fill"                 AS expected_fill_cents,
  h.trade_side,
  h.is_active,
  h.created_at,
  u.email
FROM stock_holdings_c h
JOIN auth.users u       ON u.id = h.user_id
JOIN securities_c s      ON s.id = h.security_id
WHERE u.email = 'tsiemasilo@gmail.com'
  AND s.symbol ILIKE 'BHP%'
  AND h.created_at >= (now() - interval '4 hours')
ORDER BY h.created_at DESC
LIMIT 10;

-- 2. securities_c.id (→ v_security_id in the recovery script)
SELECT
  s.id   AS security_id,
  s.symbol,
  s.name,
  s.isin,
  s.last_price
FROM securities_c s
WHERE s.symbol ILIKE 'BHP%' OR s.isin = 'ZAE000071980'
LIMIT 5;
