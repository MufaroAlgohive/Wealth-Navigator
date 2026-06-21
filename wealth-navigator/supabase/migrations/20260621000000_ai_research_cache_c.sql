-- REVIEW BEFORE APPLY — INSTITUTIONAL PROJECT (nnwz…).
-- Global-per-symbol cache for AI equity research (GET /api/research-ai).
-- Lives on the INSTITUTIONAL DB (research/desk tooling), separate from the
-- retail customer DB the research BFF gathers securities_c / News_articles from.
--
-- Purpose: reuse a prior AI answer when nothing material changed for a symbol
-- (no new news, no big price move, fundamentals unchanged, not stale) so we do
-- NOT spend model tokens regenerating identical research. The cache is GLOBAL
-- PER SYMBOL (primary key = symbol) — research about an asset is the same for
-- everyone, so all users searching one ticker reuse one entry.
--
-- `signal` holds the materiality fingerprint compared on each request
-- (latestNewsTs, newsCount, lastPrice, fundamentalsHash). `outlook` / `sources`
-- / `gathered` hold the cached answer payload returned verbatim on a hit.
--
-- Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only. No DROP/TRUNCATE.

CREATE TABLE IF NOT EXISTS public.ai_research_cache_c (
  symbol        text         PRIMARY KEY,
  name          text,
  provider      text,
  model         text,
  generated_at  timestamptz,
  outlook       jsonb,
  sources       jsonb,
  gathered      jsonb,
  signal        jsonb,
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_research_cache_c_updated_at_idx
  ON public.ai_research_cache_c (updated_at DESC);

ALTER TABLE public.ai_research_cache_c ENABLE ROW LEVEL SECURITY;

-- Service-role only: the cache is written + read by the server BFF. No anon
-- read policy (the answer reaches clients through the route, not direct reads).
DROP POLICY IF EXISTS "ai_research_cache_c service all" ON public.ai_research_cache_c;
CREATE POLICY "ai_research_cache_c service all"
  ON public.ai_research_cache_c FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ai_research_cache_c IS
  'Global-per-symbol AI equity-research cache for GET /api/research-ai. signal = materiality fingerprint (latestNewsTs/newsCount/lastPrice/fundamentalsHash) compared per request to reuse prior answers and save model tokens. Service-role only.';
