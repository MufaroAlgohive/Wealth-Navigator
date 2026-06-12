-- REVIEW BEFORE APPLY — LIVE PROJECT nnwzhxfjpjbzujevwzlh (MyMint)
-- Previous close in cents (IRESS PrevClose at worker ingest). Used for % change
-- on the Supabase read path without falling back to seed prevClose.
-- Idempotent: ADD COLUMN IF NOT EXISTS only.

ALTER TABLE public.securities_c
  ADD COLUMN IF NOT EXISTS prev_close numeric;

COMMENT ON COLUMN public.securities_c.prev_close IS
  'Previous close in cents (IRESS PrevClose at last worker ingest).';
