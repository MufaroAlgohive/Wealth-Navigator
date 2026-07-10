-- ============================================================================
-- Research & IC — demo seed (INSTITUTIONAL Supabase project, nnwz…)
-- ----------------------------------------------------------------------------
-- Populates the four Research & IC tabs with the OEMS design data so the
-- surface is usable/demoable out of the box:
--   • 6 research notes (NPN, CPI, SOL, MSFT, GLN, AGL) with the full thesis /
--     triggers / valuation JSONB the Research Library renders.
--   • 2 rebalance proposals (one at IC / pending, one IC-approved & ready to
--     release to the order book).
--   • A couple of IC votes on the SOL research-init so the IC tally is non-zero.
--
-- PREREQUISITE — apply these migrations first (Supabase SQL editor, in order):
--   supabase/migrations/20260710000001_research_note_c.sql
--   supabase/migrations/20260710000002_research_vote_c.sql
--   supabase/migrations/20260710000003_ic_session_c.sql
--   supabase/migrations/20260710000004_rebalance_request_c.sql
--
-- Idempotent: fixed UUIDs + ON CONFLICT DO NOTHING, so it is safe to re-run.
-- Prices (CURRENT / upside) are NOT stored here — they come live from
-- /api/quotes; only the target price / weights / fundamentals are seeded.
-- ============================================================================

-- ── Research notes ─────────────────────────────────────────────────────────
INSERT INTO research_note_c
  (id, symbol, author_email, status, thesis, triggers, valuation,
   created_at, updated_at, submitted_at, approved_at)
VALUES
-- NPN — the flagship note (approved), full detail matching the design ---------
('a1000000-0000-4000-8000-000000000001', 'NPN', 'l.ndlovu@mint.co.za', 'approved',
 $j${
   "companyName":"Naspers","sector":"Technology","isin":"ZAE000015889","horizon":"12M",
   "rating":"BUY","style":"BUY & HOLD","conviction":"HIGH CONVICTION","esg":"AMBER",
   "analystName":"L. Ndlovu","analystRole":"Junior Analyst","reviewerName":"You",
   "version":4,"nextReview":"2026-07-15","linkedStrategies":["MINT SA Equity Alpha"],
   "targetPrice":4850,
   "bull":"Naspers is a Tencent proxy trading at a persistent 35-40% NAV discount. Cross-holding unwind with Prosus, aggressive buyback (raised to USD 3.2bn) and Tencent's re-rating on games licensing should close ~10pp of the discount over 12 months. Standalone SA e-commerce (Takealot, Mr D) turning cash-flow positive removes the last drag on group EBITDA.",
   "bear":"China regulatory reset on gaming, or a Tencent dividend cut, kills the underlying. Discount can widen to 45% on risk-off. Prosus dual listing complexity keeps a permanent 15% conglomerate discount even in a bull case.",
   "catalysts":["Tencent Q4 earnings - 18 Mar 2026","Buyback pace update at interims - 25 Jun 2026","Takealot standalone EBITDA disclosure - FY26 results"],
   "risks":["China platform regulation resurgence","ZAR strength vs USD compresses translated NAV","Tencent games pipeline slip (2H 2026)"],
   "fundamentals":[
     {"metric":"Revenue","unit":"ZARbn","prior":388.4,"current":412.8,"forecast":442.1,"trend":"up"},
     {"metric":"HEPS","unit":"c","prior":1035,"current":1284,"forecast":1520,"trend":"up"},
     {"metric":"EBITDA margin","unit":"%","prior":20.1,"current":22.4,"forecast":24,"trend":"up"},
     {"metric":"NAV/share","unit":"R","prior":5240,"current":5810,"forecast":6400,"trend":"up"},
     {"metric":"NAV discount","unit":"%","prior":34.2,"current":28.1,"forecast":20,"trend":"down"}
   ],
   "likesManagement":"Fabricio Bloisi is executing the discount-close mandate credibly - buyback discipline, Takealot ring-fence, and clear KPI reporting. Board renewal in 2024 removed the old guard.",
   "dislikesManagement":"Compensation still cross-listed and opaque. Prosus/Naspers voting structure remains labyrinthine - a permanent governance drag no CEO can fix.",
   "icLog":[
     {"actor":"T. Molefe","initials":"TM","action":"APPROVED","at":"12 Jun, 16:30","note":"IC approved - position stays at 12% target"},
     {"actor":"You","initials":"YO","action":"SUBMITTED","at":"12 Jun, 14:00","note":"Submitted to IC - Q2 review"},
     {"actor":"L. Ndlovu","initials":"LN","action":"EDITED","at":"10 Jun, 11:18","note":"TP raised to R4 850 post interims"},
     {"actor":"You","initials":"YO","action":"COMMENTED","at":"22 Nov, 15:04","note":"Raise TP once Takealot standalone EBITDA disclosed"},
     {"actor":"L. Ndlovu","initials":"LN","action":"CREATED","at":"14 Aug, 09:12","note":"Initiated at R3 920 with BUY / TP R4 500"}
   ]
 }$j$::jsonb,
 $j${
   "buy_below":{"price":4000,"note":"Adds full 2.0pp weight, discount > 32%"},
   "add_below":{"price":3850,"note":"Panic level - Tencent risk-off"},
   "trim_above":{"price":4700,"note":"Discount closes to 22% - trim 1.0pp to target 11%"},
   "sell_above":{"price":5100,"note":"Target hit / discount < 18% - exit"},
   "stop_loss":{"price":3600,"note":"Thesis break - Tencent regulatory event"}
 }$j$::jsonb,
 $j${"pe_multiple":18.4,"peers":[{"name":"Prosus (PRX)","pe":12.1},{"name":"Softbank (9984 JP)","pe":14.3},{"name":"Berkshire (BRK.B)","pe":22.0}]}$j$::jsonb,
 '2025-08-14T09:12:00Z','2026-06-18T00:00:00Z','2026-06-12T14:00:00Z','2026-06-12T16:30:00Z'),

-- CPI — approved --------------------------------------------------------------
('a1000000-0000-4000-8000-000000000002', 'CPI', 'l.ndlovu@mint.co.za', 'approved',
 $j${
   "companyName":"Capitec Bank","sector":"Banks","horizon":"12M","rating":"ACCUMULATE",
   "conviction":"HIGH CONVICTION","esg":"GREEN","analystName":"You","analystRole":"Fund Manager",
   "version":6,"linkedStrategies":["MINT SA Equity Alpha"],"targetPrice":3200,
   "bull":"Best-in-class retail bank compounding earnings mid-teens; digital cost base and AvaFin consumer-credit optionality extend the runway. Deposit franchise funds growth cheaply.",
   "bear":"Valuation premium leaves no room for a consumer-credit cycle miss; unsecured book sensitive to SA unemployment.",
   "catalysts":["Interim results - Sep 2026","Transaction-fee re-pricing"],
   "risks":["SA consumer stress","Regulatory cap on fees"],
   "fundamentals":[
     {"metric":"HEPS","unit":"c","prior":9800,"current":11250,"forecast":12800,"trend":"up"},
     {"metric":"ROE","unit":"%","prior":26,"current":27.5,"forecast":28,"trend":"up"}
   ],
   "icLog":[{"actor":"You","initials":"YO","action":"APPROVED","at":"05 Jun, 14:20","note":"IC approved at 6.5% target"}]
 }$j$::jsonb,
 $j${"trim_above":{"price":3300,"note":"Trim into strength"},"stop_loss":{"price":2400,"note":"Credit cycle break"}}$j$::jsonb,
 $j${"pe_multiple":21.0,"peers":[{"name":"FirstRand","pe":10.2},{"name":"Standard Bank","pe":8.4}]}$j$::jsonb,
 '2025-09-02T09:00:00Z','2026-06-10T00:00:00Z','2026-06-04T14:00:00Z','2026-06-05T14:20:00Z'),

-- SOL — IC PENDING (research-init on the IC agenda), SELL --------------------
('a1000000-0000-4000-8000-000000000003', 'SOL', 'l.ndlovu@mint.co.za', 'ic_pending',
 $j${
   "companyName":"Sasol","sector":"Energy","horizon":"6M","rating":"SELL",
   "conviction":"HIGH CONVICTION","esg":"RED","analystName":"L. Ndlovu","analystRole":"Junior Analyst",
   "version":2,"linkedStrategies":["MINT SA Equity Alpha"],"targetPrice":130,
   "bull":"Deep value on normalised oil; any Secunda efficiency win or rand weakness is upside.",
   "bear":"Structural short. Balance sheet stretched, Secunda emissions capex accelerates, oil pricing rolling over. Cautionary flagged partial divestment - dilutive outcomes on the table.",
   "catalysts":["Production update","Emissions capex guidance"],
   "risks":["Emissions capex over-run","Refinancing at higher rates","Oil price recovery (to thesis)"],
   "fundamentals":[{"metric":"Net debt/EBITDA","unit":"x","prior":1.4,"current":1.9,"forecast":2.3,"trend":"down"}],
   "icLog":[
     {"actor":"You","initials":"YO","action":"SUBMITTED","at":"09 Jul, 13:40","note":"Submitted SELL for IC vote"},
     {"actor":"L. Ndlovu","initials":"LN","action":"CREATED","at":"02 Jul, 10:05","note":"Initiated SELL / TP R130"}
   ]
 }$j$::jsonb,
 $j${"sell_above":{"price":170,"note":"Fade rallies"},"stop_loss":{"price":210,"note":"Thesis break on oil spike"}}$j$::jsonb,
 $j${"pe_multiple":6.1,"peers":[{"name":"Exxaro","pe":6.8},{"name":"Glencore","pe":9.2}]}$j$::jsonb,
 '2026-07-02T10:05:00Z','2026-07-09T13:40:00Z','2026-07-09T13:40:00Z', NULL),

-- MSFT — approved -------------------------------------------------------------
('a1000000-0000-4000-8000-000000000004', 'MSFT', 'you@mint.co.za', 'approved',
 $j${
   "companyName":"Microsoft","sector":"Technology","horizon":"18M","rating":"BUY",
   "conviction":"HIGH CONVICTION","esg":"GREEN","analystName":"You","analystRole":"Fund Manager",
   "version":3,"linkedStrategies":["MINT Global Quality"],"targetPrice":520,
   "bull":"Azure + Copilot monetisation inflecting; capex peak visibility improves FCF trajectory. Durable enterprise moat.",
   "bear":"AI capex outrunning near-term revenue; multiple sensitive to rate path.",
   "catalysts":["FY quarterly - cloud growth","Copilot seat disclosure"],
   "risks":["AI capex digestion","Regulatory scrutiny"],
   "fundamentals":[{"metric":"Cloud rev growth","unit":"%","prior":28,"current":31,"forecast":30,"trend":"up"}],
   "icLog":[{"actor":"You","initials":"YO","action":"APPROVED","at":"20 Jun, 14:00","note":"Approved to full weight"}]
 }$j$::jsonb,
 $j${"add_below":{"price":380,"note":"Add on capex-fear dips"},"trim_above":{"price":540,"note":"Trim above TP"}}$j$::jsonb,
 $j${"pe_multiple":32.0,"peers":[{"name":"Apple","pe":29.0},{"name":"Alphabet","pe":22.0}]}$j$::jsonb,
 '2026-05-20T09:00:00Z','2026-06-20T00:00:00Z','2026-06-18T14:00:00Z','2026-06-20T14:00:00Z'),

-- GLN — in_review -------------------------------------------------------------
('a1000000-0000-4000-8000-000000000005', 'GLN', 'l.ndlovu@mint.co.za', 'in_review',
 $j${
   "companyName":"Glencore","sector":"Mining","horizon":"12M","rating":"BUY",
   "conviction":"MEDIUM","esg":"AMBER","analystName":"L. Ndlovu","analystRole":"Junior Analyst",
   "version":1,"linkedStrategies":["MINT Resources Tilt"],"targetPrice":560,
   "bull":"Copper deficit + capital return re-rate; energy-transition demand underpins the book.",
   "bear":"Coal ESG overhang and China demand risk.",
   "catalysts":["Copper guidance","Buyback update"],
   "risks":["China slowdown","ESG de-rating"],
   "icLog":[{"actor":"L. Ndlovu","initials":"LN","action":"CREATED","at":"08 Jul, 09:30","note":"Draft - copper re-rate thesis"}]
 }$j$::jsonb,
 $j${"buy_below":{"price":500,"note":"Accumulate on copper dips"}}$j$::jsonb,
 $j${"pe_multiple":9.2,"peers":[{"name":"Anglo American","pe":10.0},{"name":"BHP","pe":11.5}]}$j$::jsonb,
 '2026-07-08T09:30:00Z','2026-07-09T09:30:00Z', NULL, NULL),

-- AGL — approved (HOLD) -------------------------------------------------------
('a1000000-0000-4000-8000-000000000006', 'AGL', 'you@mint.co.za', 'approved',
 $j${
   "companyName":"Anglo American","sector":"Mining","horizon":"12M","rating":"HOLD",
   "conviction":"MEDIUM","esg":"AMBER","analystName":"You","analystRole":"Fund Manager",
   "version":5,"linkedStrategies":["MINT SA Equity Alpha","MINT Resources Tilt"],"targetPrice":560,
   "bull":"Demerger unlock and copper pivot; De Beers separation crystallises value.",
   "bear":"Demerger execution risk; diamond market weak.",
   "catalysts":["De Beers vote - 14 Feb 2026","PGM price recovery"],
   "risks":["Demerger vote uncertainty","PGM oversupply"],
   "icLog":[{"actor":"You","initials":"YO","action":"APPROVED","at":"01 Jun, 14:00","note":"Hold at policy weight into the vote"}]
 }$j$::jsonb,
 $j${"trim_above":{"price":620,"note":"Trim ahead of demerger vote"},"stop_loss":{"price":460,"note":"Vote fails"}}$j$::jsonb,
 $j${"pe_multiple":10.0,"peers":[{"name":"Glencore","pe":9.2},{"name":"BHP","pe":11.5}]}$j$::jsonb,
 '2025-11-10T09:00:00Z','2026-06-01T00:00:00Z','2026-05-28T14:00:00Z','2026-06-01T14:00:00Z')
ON CONFLICT (id) DO NOTHING;

-- ── Rebalance proposals ──────────────────────────────────────────────────────
INSERT INTO rebalance_request_c
  (id, strategy_id, requested_by, current_composition, proposed_composition,
   status, research_note_id, created_at, updated_at)
VALUES
-- REB-2026-013 — submitted, at IC (pending) ----------------------------------
('b1000000-0000-4000-8000-000000000013', 'MINT SA Equity Alpha', 'you@mint.co.za',
 $j$[
   {"ticker":"NPN","name":"Naspers","shares":2,"weight":34.0},
   {"ticker":"CPI","name":"Capitec Bank","shares":3,"weight":34.7},
   {"ticker":"AGL","name":"Anglo American","shares":4,"weight":9.0},
   {"ticker":"SOL","name":"Sasol","shares":13,"weight":8.6}
 ]$j$::jsonb,
 $j$[
   {"ticker":"SOL","name":"Sasol","action":"remove","fromWeight":5.1,"toWeight":0.0,"researchRef":"R-SOL-08","rating":"SELL","rationale":"SELL rating, cautionary risk, ESG red"},
   {"ticker":"GLN","name":"Glencore","action":"add","fromWeight":0.0,"toWeight":3.0,"researchRef":"R-GLN-01","rating":"BUY","rationale":"Copper deficit + capital return re-rate"},
   {"ticker":"AGL","name":"Anglo American","action":"decrease","fromWeight":6.8,"toWeight":4.5,"researchRef":"R-AGL-19","rating":"HOLD","rationale":"Trim ahead of demerger vote uncertainty"},
   {"ticker":"CPI","name":"Capitec Bank","action":"increase","fromWeight":5.2,"toWeight":6.5,"researchRef":"R-CPI-11","rating":"ACCUMULATE","rationale":"Recycle proceeds into highest-conviction compounder"}
 ]$j$::jsonb,
 'pending', 'a1000000-0000-4000-8000-000000000003',
 '2026-07-09T13:45:00Z','2026-07-09T13:45:00Z'),

-- REB-2026-012 — IC-approved, ready for the order book -----------------------
('b1000000-0000-4000-8000-000000000012', 'MINT Global Quality', 'you@mint.co.za',
 $j$[{"ticker":"MSFT","name":"Microsoft","shares":5,"weight":6.0}]$j$::jsonb,
 $j$[{"ticker":"MSFT","name":"Microsoft","action":"increase","fromWeight":6.0,"toWeight":7.5,"researchRef":"R-MSFT-02","rating":"BUY","rationale":"TP raised, capex clarity"}]$j$::jsonb,
 'ic_approved', 'a1000000-0000-4000-8000-000000000004',
 '2026-07-06T11:00:00Z','2026-07-07T14:45:00Z')
ON CONFLICT (id) DO NOTHING;

-- ── IC votes on the SOL research-init (so the IC tally is non-zero) ───────────
INSERT INTO research_vote_c (id, note_id, voter_email, vote, rationale, voted_at)
VALUES
('c1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', 't.molefe@mint.co.za', 'yes', 'Agree - ESG + balance-sheet risk', '2026-07-09T14:05:00Z'),
('c1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000003', 'l.ndlovu@mint.co.za', 'yes', 'Thesis holds', '2026-07-09T14:06:00Z')
ON CONFLICT (note_id, voter_email) DO NOTHING;
