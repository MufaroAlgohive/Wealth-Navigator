-- ──────────────────────────────────────────────────────────────────────────
-- RETAIL prod project (mfxnghmuccevsxwcetej) — REVIEW-ONLY.
-- Paste this into the Supabase SQL editor for the RETAIL project when ready.
-- The worker NEVER applies DDL; this is operator-pasted.
--
-- Purpose: tag which feed last wrote a price so we can see and prefer IRESS vs
-- Yahoo per symbol during the cut-over. Additive + idempotent. Touches NO data,
-- NO customer tables — adds one nullable column to securities_c.
--
-- After applying, set RETAIL_PRICE_SOURCE_COL=1 on the Railway worker so it
-- stamps price_source='iress' on the rows it writes. Until then the worker
-- omits the column, so this migration is optional for the first shadow runs.
-- ──────────────────────────────────────────────────────────────────────────

alter table public.securities_c
  add column if not exists price_source text;

comment on column public.securities_c.price_source is
  'Feed that last wrote last_price: ''iress'' | ''yahoo'' | null. Set by the IRESS worker when RETAIL_PRICE_SOURCE_COL=1.';
