-- REVIEW BEFORE APPLY — INSTITUTIONAL PROJECT (nnwz…).
-- Shared, durable cache for company market data fetched from upstream providers
-- (Yahoo today) by the Analysis tab BFFs:
--   /api/company-analysis/:sym          -> cache_key "analysis:<SYM>"   (TTL ~1h)
--   /api/company-analysis/:sym/deep     -> cache_key "deep:<SYM>"       (TTL ~6h)
--   /api/company-analysis/:sym/chart    -> cache_key "chart:<SYM>:<RANGE>" (~6h)
--   /api/company-analysis/search        -> cache_key "search:<query>"   (TTL ~24h)
--
-- Purpose: one fetch is reused by every user / serverless instance so the same
-- symbol does not hit the provider on each view and a free, rate-limited API is
-- never exhausted. The server applies the TTL (it stores `fetched_at`); a stale
-- row is simply re-fetched and upserted. The live price is NOT cached here — the
-- routes overlay a fresh IRESS quote on top of the cached fundamentals.
--
-- Falls back to an in-process tier when this table is absent, so the app works
-- before this migration is applied; applying it makes the cache shared + durable.
-- Idempotent: CREATE ... IF NOT EXISTS only. No DROP/TRUNCATE.

CREATE TABLE IF NOT EXISTS public.company_data_cache_c (
  cache_key   text         PRIMARY KEY,
  payload     jsonb        NOT NULL,
  fetched_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS company_data_cache_c_fetched_at_idx
  ON public.company_data_cache_c (fetched_at DESC);

ALTER TABLE public.company_data_cache_c ENABLE ROW LEVEL SECURITY;

-- Service-role only: written + read by the server BFFs. Cached payloads reach
-- clients through the routes, never via direct anon reads.
DROP POLICY IF EXISTS "company_data_cache_c service all" ON public.company_data_cache_c;
CREATE POLICY "company_data_cache_c service all"
  ON public.company_data_cache_c FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.company_data_cache_c IS
  'Shared cache of upstream company market data (Yahoo) for the Analysis tab BFFs. cache_key = "<dataset>:<SYM>[:<variant>]"; the server enforces a per-dataset TTL against fetched_at. Service-role only.';
