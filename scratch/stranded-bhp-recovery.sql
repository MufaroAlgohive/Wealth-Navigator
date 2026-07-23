-- ============================================================================
-- Stranded BHP purchase — diagnostic + recovery
-- 2026-07-23 11:33 UTC: wallet debited R1437.78, confirmation email sent to
-- tsiemasilo@gmail.com, but POST /api/admin/orderbook/client-order was
-- rejected at the Vercel BFF by the IRESS_UAT_MODE gate (now removed + redeployed).
-- No oems_order_audit row was written, so the IRESS forward never happened.
--
-- THIS SCRIPT MUST BE RUN ON THE **INSTITUTIONAL** SUPABASE PROJECT
-- (nnwzhxfjpjbzujevwzlh) — that's where oems_order_audit lives.
-- ============================================================================

-- ── STEP 1 ─────────────────────────────────────────────────────────────────
-- Look for ANY audit row that could relate to this transaction:
--   - any BHP / BHPGROUP / BHP.JO row in the last 24h
--   - any row with the user's email in client_account
--   - any row tagged MINT_CLIENT_ORDER source
-- Expected: 0 rows. If non-zero, stop — the order was actually recorded.
-- ────────────────────────────────────────────────────────────────────────────

SELECT
  id,
  order_id,
  created_at,
  status,
  source,
  client_account,
  broker_account_code,
  symbol,
  side,
  quantity,
  price_cents,
  payload->>'holding_id' AS holding_id,
  payload->>'broker' AS broker,
  payload->>'uat_test' AS uat_test,
  payload->>'sent_at'  AS sent_at
FROM oems_order_audit
WHERE
  -- Time window: 1h either side of the wallet-debit log line (11:33 UTC)
  created_at >= (now() - interval '2 hours')
  AND created_at <= (now() + interval '5 minutes')
  AND (
    symbol ILIKE 'BHP%'
    OR client_account = 'tsiemasilo@gmail.com'
    OR source = 'MINT_CLIENT_ORDER'
  )
ORDER BY created_at DESC;

-- If the SELECT above returns zero rows, continue to STEP 2.

-- ============================================================================
-- STEP 2 — recovery audit row insert.
--
-- BEFORE RUNNING THIS YOU NEED FROM THE RETAIL SUPABASE:
--   1. The stock_holdings_c.id for the BHP holding owned by
--      tsiemasilo@gmail.com (likely the most recent BHP buy around 11:33 UTC).
--      This goes into payload.holding_id.
--   2. The securities_c.id for the BHP row (so sec.id matches what the
--      desk workflow expects to filter on).
--
-- Substitute both in the variables below. If you can't find them, paste the
-- result of this SELECT into the institutional SQL editor first:
--
--   -- Run on the RETAIL Supabase (mfxnghmuccevsxwcetej):
--   SELECT h.id AS holding_id, h.user_id, h.symbol, h.quantity,
--          h.price_cents, h.created_at, u.email
--   FROM stock_holdings_c h
--   JOIN auth.users u ON u.id = h.user_id
--   WHERE u.email = 'tsiemasilo@gmail.com'
--     AND h.symbol ILIKE 'BHP%'
--     AND h.created_at >= (now() - interval '2 hours')
--   ORDER BY h.created_at DESC;
--
-- ============================================================================

DO $$
DECLARE
  v_holding_id  text := '<PASTE_HOLDING_ID_HERE>';
  v_security_id text := '<PASTE_SECURITIES_C_ID_HERE>';
  v_symbol      text := 'BHPGROUP.JO';   -- canonical JSE symbol as stored in securities_c
  v_qty         int  := 1;                -- 1 share @ R1398.10 base + R39.68 fee = R1437.78
  v_price_cents bigint := 139810;        -- R1398.10 (matches the wallet debit Base line)
  v_broker_acct text := '56378';          -- IRESS production account code (per Vercel env)
  v_email       text := 'tsiemasilo@gmail.com';
  v_source      text := 'MINT_CLIENT_ORDER';
  v_book_id     text := 'CLIENT-BUY';
  v_broker      text := 'LONGMARK CARE';  -- cosmetic label
  v_order_id    text := 'MINT_CLIENT_ORDER-' || to_char(now() AT TIME ZONE 'UTC',
                                      'YYYYMMDD') || '-RECOVERY-BHP-' ||
                                      floor(extract(epoch from now()))::text;
  v_now         timestamptz := now();
  v_inserted_id uuid;
BEGIN
  IF v_holding_id = '<PASTE_HOLDING_ID_HERE>' THEN
    RAISE EXCEPTION 'Edit v_holding_id (and v_security_id) before running. See comments above.';
  END IF;

  -- Idempotency: refuse to create a duplicate recovery row.
  PERFORM 1
  FROM oems_order_audit
  WHERE payload->>'holding_id' = v_holding_id
    AND source = v_source
    AND status = 'parked';
  IF FOUND THEN
    RAISE NOTICE 'A parked MINT_CLIENT_ORDER row already exists for holding_id=% — skipping.', v_holding_id;
    RETURN;
  END IF;

  INSERT INTO oems_order_audit (
    order_id,
    client_account,
    broker_account_code,
    symbol,
    side,
    quantity,
    price_cents,
    status,
    source,
    payload,
    result_payload,
    created_at,
    updated_at
  ) VALUES (
    v_order_id,
    v_email,
    v_broker_acct,
    v_symbol,
    'buy',
    v_qty,
    v_price_cents,
    'parked',           -- preflight will be re-derived on release
    v_source,
    jsonb_build_object(
      'book_id',           v_book_id,
      'broker',            v_broker,
      'order_type',        'limit',                 -- limit @ R1398.10, not market
      'strategy',          v_book_id,
      'security_id',       v_security_id,
      'isin',              null,                    -- fill from securities_c if known
      'holding_id',        v_holding_id,
      'limitPrice',        v_price_cents / 100.0,
      'sent_by',           v_email,
      'sent_at',           v_now,
      'trader',            v_email,
      'uat_test',          false,                   -- PRODUCTION lane
      'broker_account_code', v_broker_acct,
      'recovery',          jsonb_build_object(
        'reason',   'stranded-by-2026-07-23-uat-gate',
        'fix',      'commit ae65876 — client-order IRESS_UAT_MODE gate removed',
        'wallet_debit_cents',   143778,
        'wallet_fee_cents',       3968,
        'logged_from',  'mint-app wallet debit line 11:33:00.454'
      )
    ),
    jsonb_build_object(
      'broker',   v_broker,
      'venue',    'JSE',
      'tif',      'DAY',
      'arrivalMid', 1398.10,
      'uat_test', false,
      'preflight', jsonb_build_object(
        'ok', true,
        'verdict', 'pass',
        'code', 'pass',
        'message', 'Recovery row — preflight deferred to release time.'
      )
    ),
    v_now,
    v_now
  )
  RETURNING id INTO v_inserted_id;

  RAISE NOTICE 'Inserted recovery audit row id=%  order_id=%', v_inserted_id, v_order_id;
END $$;

-- ── STEP 3 ─────────────────────────────────────────────────────────────────
-- Confirm the row landed and inspect it.
-- ────────────────────────────────────────────────────────────────────────────

SELECT
  id,
  order_id,
  status,
  symbol,
  side,
  quantity,
  price_cents,
  client_account,
  broker_account_code,
  payload->>'holding_id'   AS holding_id,
  payload->>'uat_test'     AS uat_test,
  payload->'recovery'      AS recovery
FROM oems_order_audit
WHERE order_id LIKE 'MINT_CLIENT_ORDER-%RECOVERY-BHP-%'
ORDER BY created_at DESC
LIMIT 5;

-- After confirming the row exists:
--   1. Review the holding_id + price in the admin UI.
--   2. From /admin/order-book, click "Send to Market" — this calls
--      /api/admin/orderbook/release-to-market, which re-derives preflight
--      from the row's stored columns and fans out to the worker on the
--      production IRESS seat. Current market price may differ from the
--      R1398.10 limit; amend the limit first if needed (use the desk
--      amend flow on the parked row before releasing).
--   3. If the price has moved materially, contact the client before
--      releasing so they can choose to retry at current market.
