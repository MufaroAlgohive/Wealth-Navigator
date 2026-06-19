-- ============================================================
-- Rebalance Tables Migration
-- Creates rebalance_batch and rebalance_event tables
-- Separates trade intent (pending) from settled stock_holdings
-- ============================================================

-- 1. rebalance_batch
--    One row per committed rebalance action.
--    Holds snapshots for clean reversal and batch-level metadata.
CREATE TABLE IF NOT EXISTS rebalance_batch (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id               uuid        NOT NULL REFERENCES strategies(id),
  status                    text        NOT NULL DEFAULT 'PENDING'
                                        CHECK (status IN ('PENDING', 'SETTLED', 'REVERSED')),

  -- Pre-rebalance snapshots (for reversal)
  holdings_snapshot_before   jsonb,      -- strategy.holdings JSON before this rebalance
  wallet_snapshot_before     jsonb,      -- { userId: balance } map before this rebalance

  -- Sell leg
  sell_security_id           uuid        REFERENCES securities_c(id),
  sell_isin_code             text,
  total_sell_quantity         numeric     NOT NULL DEFAULT 0,

  -- Primary buy leg
  buy_security_id            uuid        REFERENCES securities_c(id),
  buy_isin_code              text,
  total_buy_quantity          numeric     NOT NULL DEFAULT 0,

  -- Secondary buy leg (wallet-funded, optional)
  extra_buy_security_id      uuid        REFERENCES securities_c(id),
  extra_buy_isin_code        text,
  total_extra_buy_quantity    numeric     NOT NULL DEFAULT 0,

  -- Financial summary
  net_proceeds               numeric(18,2) NOT NULL DEFAULT 0,

  -- Metadata
  strategy_name_snapshot     text,
  created_by                 uuid        REFERENCES auth.users(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),

  -- Settlement tracking
  settled_at                 timestamptz,
  settled_by                 uuid        REFERENCES auth.users(id),

  -- Reversal tracking
  is_reversed                boolean     NOT NULL DEFAULT false,
  reversed_at                timestamptz,
  reversed_by                uuid        REFERENCES auth.users(id),
  reversed_reason            text
);

-- 2. rebalance_event
--    Individual per-client per-security trade intent.
--    Stays PENDING until the batch is filled & settled.
CREATE TABLE IF NOT EXISTS rebalance_event (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id                   uuid        NOT NULL REFERENCES rebalance_batch(id) ON DELETE CASCADE,
  user_id                    uuid        NOT NULL REFERENCES auth.users(id),
  security_id                uuid        NOT NULL REFERENCES securities_c(id),
  trade_side                 text        NOT NULL CHECK (trade_side IN ('BUY', 'SELL')),
  quantity                   numeric     NOT NULL,
  price_at_commit            integer,            -- price in cents at commit time (audit)
  avg_fill                   integer,            -- broker fill price in cents (NULL until filled)
  fill_date                  date,               -- date broker filled (NULL until filled)
  closed_reason              text,               -- REBALANCE_EVENT_SELL | REBALANCE_EVENT_BUY | REBALANCE_EVENT_BUY_WALLET
  strategy_name_snapshot     text,
  settled_holding_id         uuid,               -- FK to stock_holdings.id after settlement (NULL until settled)
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_rebalance_batch_strategy_status
  ON rebalance_batch(strategy_id, status);

CREATE INDEX IF NOT EXISTS idx_rebalance_event_batch
  ON rebalance_event(batch_id);

CREATE INDEX IF NOT EXISTS idx_rebalance_event_user
  ON rebalance_event(user_id);

CREATE INDEX IF NOT EXISTS idx_rebalance_event_security
  ON rebalance_event(security_id);

-- 4. Row Level Security
ALTER TABLE rebalance_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE rebalance_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users full access" ON rebalance_batch
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users full access" ON rebalance_event
  FOR ALL USING (auth.role() = 'authenticated');
