-- ============================================================================
-- Immutable price-scale anchor for the IRESS retail cutover  (RETAIL prod, mfxng)
-- ----------------------------------------------------------------------------
-- WHY: securities_c.last_price is CENTS but IRESS quotes don't self-describe their
-- scale, so a sub-R45 name delivered on the cents-schema can be mis-scaled 100x.
-- Today the only backstop is a divergence guard against the MUTABLE last_price —
-- which the ingest loop overwrites, so a corrupted value can "confirm" its own
-- wrong scale (self-perpetuating anchor). This column is an IMMUTABLE, human-
-- checkable magnitude the tick loop NEVER overwrites; chooseDisplayCents prefers
-- it (trustedRefCents) to disambiguate cents-vs-Rands and FAIL-CLOSED (skip the
-- write) when no anchor verifies the scale.  See
-- docs/IRESS_INTEGRATION_AND_SCALE_SAFETY.md (fragile spots S1/S3/S4).
--
-- SAFETY: additive + idempotent. Adds ONE nullable column and seeds it; touches no
-- existing money field, no customer table. Reversible: DROP COLUMN scale_ref_cents.
-- The worker only READS this column when RETAIL_SCALE_REF_COL=1, so it is inert
-- until you flip that flag — apply this first, verify, then enable the flag.
-- Run in a low-traffic window (the seed does 1 indexed lookup per security).
-- ============================================================================

-- 1) Add the immutable anchor (cents). Nullable — a NULL means "not yet verified".
ALTER TABLE public.securities_c
  ADD COLUMN IF NOT EXISTS scale_ref_cents integer;

COMMENT ON COLUMN public.securities_c.scale_ref_cents IS
  'Immutable price-scale anchor in CENTS (ZAc). Used ONLY to disambiguate IRESS cents-vs-Rands (chooseDisplayCents trustedRefCents). The tick loop must NEVER overwrite this. NULL = scale unverified (writers fail-closed).';

-- 2) Seed from the freshest trustworthy CENTS magnitude: the latest live
--    stock_intraday_c tick (Yahoo-sourced today), else the frozen-but-correct-
--    magnitude last_price. Only sets rows that are still NULL, so re-running is safe
--    and a hand-corrected value is never clobbered.
UPDATE public.securities_c s
SET scale_ref_cents = COALESCE(
      (SELECT si.current_price
         FROM public.stock_intraday_c si
        WHERE si.security_id = s.id
          AND si.current_price > 0
        ORDER BY si."timestamp" DESC
        LIMIT 1),                       -- freshest live cents (uses idx_stock_intraday_sec_ts)
      NULLIF(s.last_price, 0)           -- fallback: frozen but correct-magnitude cents
    )
WHERE s.scale_ref_cents IS NULL;

-- 3) VERIFY before trusting it. (a) coverage; (b) eyeball any anchor that disagrees
--    with last_price by >3x — those are the ones a human should confirm before the
--    worker starts anchoring to them.
SELECT count(*) AS total,
       count(scale_ref_cents) AS seeded,
       count(*) FILTER (WHERE scale_ref_cents IS NULL) AS unseeded
FROM public.securities_c;

SELECT symbol, last_price, scale_ref_cents,
       round(scale_ref_cents::numeric / NULLIF(last_price,0), 2) AS ratio_vs_lastprice
FROM public.securities_c
WHERE scale_ref_cents IS NOT NULL AND last_price > 0
  AND (scale_ref_cents::numeric / last_price > 3 OR scale_ref_cents::numeric / last_price < 0.33)
ORDER BY ratio_vs_lastprice DESC
LIMIT 50;

-- ROLLBACK (if ever needed):
--   ALTER TABLE public.securities_c DROP COLUMN scale_ref_cents;
