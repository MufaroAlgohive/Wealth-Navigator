-- REVIEW BEFORE APPLY — LIVE PROJECT mfxnghmuccevsxwcetej
-- Helper view: latest intraday snapshot per security.
--   Joins securities_c (instrument ref) with the most-recent stock_intraday_c row
--   per security_id so the UI can do a single query instead of a window function
--   per tick.
--
-- Idempotent: CREATE OR REPLACE VIEW.
-- No DROP / TRUNCATE / DELETE; view definition only. RLS is inherited from the
-- base tables (stock_intraday_c, securities_c) — anon / authenticated reads only
-- work after 20260612000003_intraday_read_policies.sql is applied.

CREATE OR REPLACE VIEW public.securities_with_latest_quote AS
SELECT
  s.id            AS security_id,
  s.symbol,
  s.name,
  s.sector,
  s.asset_type,
  s.last_price,
  s.ytd_start_price,
  i.current_price AS latest_intraday_price,
  i.timestamp     AS latest_intraday_at
FROM public.securities_c s
LEFT JOIN LATERAL (
  SELECT current_price, timestamp
  FROM public.stock_intraday_c si
  WHERE si.security_id = s.id
  ORDER BY si.timestamp DESC
  LIMIT 1
) i ON true;

COMMENT ON VIEW public.securities_with_latest_quote IS
  'Latest stock_intraday_c snapshot per security_id; pairs with securities_c for OEMS read path. RLS inherited from base tables.';
