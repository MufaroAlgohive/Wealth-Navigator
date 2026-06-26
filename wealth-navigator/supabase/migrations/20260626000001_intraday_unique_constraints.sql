-- REVIEW BEFORE APPLY — LIVE PROJECT nnwzhxfjpjbzujevwzlh (MyMint)
-- Make index_intraday_c / sector_intraday_c idempotent on (code, timestamp).
--
-- The worker (workers/iress-ingest/src/timeseries.ts) re-fetches a multi-day
-- window each cycle and now UPSERTs with onConflict "(index_code|sector_code,
-- timestamp)". PostgREST needs a real UNIQUE constraint on those columns for
-- the upsert to resolve. The original create migrations (20260612000006 /
-- 20260612000008) only added a non-unique btree index, so this adds the
-- constraint.
--
-- One-time dedup: a UNIQUE constraint cannot be added while duplicate
-- (code, timestamp) rows exist. The tables are currently dormant (the JSE index
-- DataSource is not yet enabled on CT, so the worker writes 0 index rows), so
-- this DELETE affects little or nothing today; it exists so the migration is
-- safe to apply even if the plain-INSERT path had already stacked duplicates.
-- The DELETE keeps the highest id per (code, timestamp) group.
--
-- Idempotent: the dedup is naturally a no-op once unique, and the constraints
-- are guarded by pg_constraint existence checks.

-- index_intraday_c -----------------------------------------------------------
DELETE FROM public.index_intraday_c a
USING public.index_intraday_c b
WHERE a.index_code = b.index_code
  AND a.timestamp  = b.timestamp
  AND a.id < b.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'index_intraday_c_code_ts_key'
  ) THEN
    ALTER TABLE public.index_intraday_c
      ADD CONSTRAINT index_intraday_c_code_ts_key UNIQUE (index_code, timestamp);
  END IF;
END $$;

-- sector_intraday_c ----------------------------------------------------------
DELETE FROM public.sector_intraday_c a
USING public.sector_intraday_c b
WHERE a.sector_code = b.sector_code
  AND a.timestamp   = b.timestamp
  AND a.id < b.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sector_intraday_c_code_ts_key'
  ) THEN
    ALTER TABLE public.sector_intraday_c
      ADD CONSTRAINT sector_intraday_c_code_ts_key UNIQUE (sector_code, timestamp);
  END IF;
END $$;
