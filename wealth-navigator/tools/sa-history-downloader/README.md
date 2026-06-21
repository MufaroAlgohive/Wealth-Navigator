# SA Market History Downloader

Local tool to download the **whole South African equity universe + JSE indices
+ ZAR FX** at **4h / daily / weekly / monthly** with maximum available history,
stored on your machine as **Parquet (+ CSV)** for portfolio-model building.

## Why not the IRESS worker?
The live Railway worker speaks **IRESS CT (prod-test)**. It was probed directly
and returns **one data point** with **test-scale values** (NPN @ 6.09 vs the real
~R3,000+) — i.e. **no historical depth and not real prices**. So real SA history
today comes from **Yahoo** (free, unofficial; ~25y daily, ~2y hourly).

When **production IRESS** access exists, add an `iress` source and re-run — the
storage/resample pipeline is source-agnostic. (The `sources` split is a
follow-on; today everything is Yahoo.)

## Install
```bash
cd tools/sa-history-downloader
python -m pip install -r requirements.txt      # requests, pandas, pyarrow
```

## Run
```bash
python download.py                       # everything → ./data
python download.py --equities-only       # skip indices/FX
python download.py --no-equities         # indices + FX only
python download.py --symbols NPN,AGL,SOL # just these
python download.py --timeframes 1d,1wk   # subset of 4h,1d,1wk,1mo
python download.py --no-csv              # Parquet only
python download.py --out "D:/sa-data"    # custom output dir
python download.py --limit 10            # first 10 equities (smoke test)
```

## Full universe (optional)
By default equities come from a bundled JSE large/mid-cap list (~80 names). To
pull the **full ~246-name universe** (the same one the dashboard uses), copy
`.env.example` → `.env` and set `RETAIL_SUPABASE_URL` + a key. The downloader
then reads `securities_c` directly.

## Output layout (git-ignored)
```
data/
  equities/NPN/4h.parquet  1d.parquet  1wk.parquet  1mo.parquet   (+ .csv)
  indices/J203/...   J200/...   JN0U/...
  fx/USDZAR/...      EURZAR/...  GBPZAR/...  ZARUSD/...
  manifest.json      # per series: rows, first, last, currency, source, fetched_at
```

Each OHLCV file has columns: `ts` (UTC ISO8601), `open, high, low, close,
adj_close, volume`. Use `adj_close` for return series (it's split/dividend
adjusted); `close` is the raw print.

## Notes / limits
- **Currency:** equities are **ZAc (cents)** per Yahoo — divide by 100 for Rands.
  FX is in the pair's quote currency. Recorded per-series in `manifest.json`.
- **4h history** is resampled from Yahoo 1h, which Yahoo caps at **~2 years**.
  Daily/weekly/monthly go back to listing (often 10–25y).
- **4h bars** are aligned to the JSE session (09:00 SAST open) then stored UTC.
- **Throttled** ~0.6s/request with retry/back-off to respect Yahoo. A full
  ~246 × 4-timeframe run takes roughly 20–40 min.
- **Re-runs overwrite** each series with the latest full pull (simple + safe).
  Incremental append is a possible enhancement.
- **Not yet included:** SARB rate history (repo/prime/JIBAR/ZARONIA) and the
  govt bond-yield curve history — Yahoo doesn't carry them; these need the SARB
  historical API or production IRESS. Flag me to add a SARB historical fetcher.
- Source is **unofficial Yahoo endpoints** — fine for research/modelling; not a
  licensed redistribution feed.
```
