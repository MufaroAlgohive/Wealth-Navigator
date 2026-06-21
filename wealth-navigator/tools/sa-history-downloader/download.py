#!/usr/bin/env python3
"""
SA market historical data downloader — for local portfolio-model building.

Downloads the whole South African equity universe + JSE indices + ZAR FX, at
4h / daily / weekly / monthly, with maximum available history, and stores them
locally as Parquet (+ optional CSV mirror) in a clean per-symbol layout.

WHY NOT THE IRESS WORKER?
  The live Railway worker speaks IRESS CT (prod-test), which was probed and
  found to return ONE data point and test-scale values (NPN @ 6.09 vs real
  ~R3,000+) — i.e. no historical depth and not real prices. So real SA history
  today comes from Yahoo (free, unofficial; ~25y of daily, ~2y of hourly).
  When PRODUCTION IRESS access exists, drop in an `iress` source (stub below)
  and re-run — the rest of the pipeline is source-agnostic.

USAGE
  python download.py                      # everything, default ./data output
  python download.py --equities-only      # skip indices/FX
  python download.py --symbols NPN,AGL    # just these (bare or .JO)
  python download.py --no-csv             # Parquet only
  python download.py --out "D:/sa-data"   # custom output dir
  python download.py --timeframes 1d,1wk  # subset

UNIVERSE
  Equities are read live from the retail `securities_c` table (the same ~246
  names the dashboard uses) when RETAIL_SUPABASE_URL + key are set (env or a
  .env file next to this script). Otherwise it falls back to a bundled JSE
  large/mid-cap list. Indices + FX are always included unless disabled.

OUTPUT  (default ./data, git-ignored)
  data/equities/NPN/1d.parquet  + 1d.csv  ... 4h / 1wk / 1mo
  data/indices/J203/...   data/fx/USDZAR/...
  data/manifest.json   (per series: rows, first, last, currency, source, fetched_at)
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

try:
    import requests
except ImportError:
    sys.exit("Missing dependency: pip install -r requirements.txt  (need: requests pandas pyarrow)")

try:
    import pandas as pd
except ImportError:
    sys.exit("Missing dependency: pip install -r requirements.txt  (need: pandas)")

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
SAST = "Africa/Johannesburg"
THROTTLE_SEC = 0.6          # polite delay between Yahoo calls
MAX_RETRIES = 4
INTRADAY_RANGE = "730d"     # Yahoo caps 1h history at ~2y

# Timeframe -> how we fetch it from Yahoo.
#   "1d"/"1wk"/"1mo": full-history daily/weekly/monthly via period1=0
#   "1h": ~2y of hourly (used to derive 4h)
#   "4h": NOT fetched directly — resampled from 1h
TIMEFRAMES = ["4h", "1d", "1wk", "1mo"]

# JSE index tickers on Yahoo (carat-prefixed). label -> yahoo symbol.
INDICES = {
    "J203": "^J203.JO",   # FTSE/JSE All Share (ALSI)
    "J200": "^J200.JO",   # FTSE/JSE Top 40
    "JN0U": "^JN0U.JO",   # FTSE/JSE Top 40 Total Return
}

# ZAR FX + major crosses. label -> yahoo symbol.
FX = {
    "USDZAR": "USDZAR=X",
    "EURZAR": "EURZAR=X",
    "GBPZAR": "GBPZAR=X",
    "ZARUSD": "ZAR=X",
}

# Fallback universe if securities_c isn't reachable (JSE majors, bare codes).
FALLBACK_EQUITIES = [
    "NPN", "PRX", "BTI", "AGL", "BHG", "CFR", "GLN", "FSR", "SBK", "ABG", "NED",
    "CPI", "MTN", "VOD", "SOL", "SHP", "BID", "BVT", "APN", "ANG", "GFI", "IMP",
    "SSW", "KIO", "AMS", "EXX", "ARI", "S32", "WHL", "TFG", "TRU", "MRP", "CLS",
    "SPP", "DSY", "SLM", "OMU", "MTM", "INL", "INP", "REM", "RNI", "OUT", "QLT",
    "NRP", "RDF", "GRT", "RES", "HYP", "VKE", "SAC", "MSP", "TBS", "AVI", "DCP",
    "PIK", "BAW", "MND", "MUR", "RBX", "TGA", "ARL", "SNT", "KAP", "AFE", "AFT",
    "HAR", "PAN", "DRD", "SGL", "THA", "BYI", "MCG", "TKG", "BLU", "EOH", "DTC",
]


# ----------------------------------------------------------------------------
# Small .env loader (no python-dotenv dependency)
# ----------------------------------------------------------------------------
def load_env() -> None:
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


# ----------------------------------------------------------------------------
# Universe
# ----------------------------------------------------------------------------
def bare(sym: str) -> str:
    return sym.upper().replace(".JO", "").replace(".JSE", "").strip()


def fetch_equity_universe(session: requests.Session) -> list[str]:
    """The full ~246 names from retail securities_c (PostgREST), bare codes."""
    url = os.environ.get("RETAIL_SUPABASE_URL")
    key = os.environ.get("RETAIL_SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("RETAIL_SUPABASE_ANON_KEY")
    if not url or not key:
        print("  ! RETAIL_SUPABASE_URL/key not set — using bundled fallback universe "
              f"({len(FALLBACK_EQUITIES)} names). Set them in .env for the full list.")
        return FALLBACK_EQUITIES
    try:
        r = session.get(
            f"{url.rstrip('/')}/rest/v1/securities_c",
            params={"select": "symbol", "order": "symbol"},
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            timeout=30,
        )
        r.raise_for_status()
        syms = sorted({bare(row["symbol"]) for row in r.json() if row.get("symbol")})
        print(f"  ✓ securities_c universe: {len(syms)} symbols")
        return syms or FALLBACK_EQUITIES
    except Exception as e:  # noqa: BLE001
        print(f"  ! securities_c read failed ({e}); using bundled fallback.")
        return FALLBACK_EQUITIES


# ----------------------------------------------------------------------------
# Yahoo fetch
# ----------------------------------------------------------------------------
def yahoo_chart(session: requests.Session, ysym: str, *, interval: str,
                range_: str | None = None) -> pd.DataFrame | None:
    """Fetch an OHLCV frame from Yahoo's chart API. Full history via period1=0
    for daily/weekly/monthly; bounded range for intraday."""
    params: dict[str, str] = {"interval": interval, "includeAdjustedClose": "true", "events": "div,splits"}
    if range_:
        params["range"] = range_
    else:
        params["period1"] = "0"
        params["period2"] = str(int(time.time()))
    last_err = None
    for attempt in range(MAX_RETRIES):
        try:
            r = session.get(YAHOO_CHART.format(sym=ysym), params=params,
                            headers={"User-Agent": UA}, timeout=40)
            if r.status_code == 429:
                time.sleep(2 + attempt * 2)
                continue
            r.raise_for_status()
            res = (r.json().get("chart") or {}).get("result")
            if not res:
                return None
            res = res[0]
            ts = res.get("timestamp")
            if not ts:
                return None
            q = (res.get("indicators", {}).get("quote") or [{}])[0]
            adj = (res.get("indicators", {}).get("adjclose") or [{}])
            adjclose = adj[0].get("adjclose") if adj else None
            df = pd.DataFrame({
                "ts": pd.to_datetime(ts, unit="s", utc=True),
                "open": q.get("open"),
                "high": q.get("high"),
                "low": q.get("low"),
                "close": q.get("close"),
                "adj_close": adjclose if adjclose is not None else q.get("close"),
                "volume": q.get("volume"),
            })
            df = df.dropna(subset=["close"]).reset_index(drop=True)
            df.attrs["currency"] = (res.get("meta") or {}).get("currency")
            return df if not df.empty else None
        except Exception as e:  # noqa: BLE001
            last_err = e
            time.sleep(1 + attempt)
    print(f"    x {ysym} {interval}: {last_err}")
    return None


def resample_4h(df_1h: pd.DataFrame) -> pd.DataFrame:
    """1h -> 4h bars aligned to the JSE trading day (SAST)."""
    if df_1h is None or df_1h.empty:
        return pd.DataFrame()
    d = df_1h.set_index("ts").tz_convert(SAST)
    out = d.resample("4h", offset="9h").agg({
        "open": "first", "high": "max", "low": "min",
        "close": "last", "adj_close": "last", "volume": "sum",
    }).dropna(subset=["close"])
    out = out.tz_convert("UTC").reset_index()
    return out


# ----------------------------------------------------------------------------
# Persist
# ----------------------------------------------------------------------------
def write_series(df: pd.DataFrame, out_dir: Path, category: str, label: str,
                 tf: str, *, write_csv: bool, currency: str | None,
                 source: str, manifest: dict) -> None:
    if df is None or df.empty:
        return
    folder = out_dir / category / label
    folder.mkdir(parents=True, exist_ok=True)
    out = df.copy()
    out["ts"] = out["ts"].dt.strftime("%Y-%m-%dT%H:%M:%S%z")
    pq = folder / f"{tf}.parquet"
    try:
        out.to_parquet(pq, index=False)
    except Exception as e:  # noqa: BLE001 — pyarrow missing etc.
        print(f"    ! parquet write failed ({e}); CSV only for {label} {tf}")
    if write_csv:
        out.to_csv(folder / f"{tf}.csv", index=False, quoting=csv.QUOTE_MINIMAL)
    manifest[f"{category}/{label}/{tf}"] = {
        "rows": int(len(out)),
        "first": out["ts"].iloc[0],
        "last": out["ts"].iloc[-1],
        "currency": currency,
        "source": source,
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def download_symbol(session: requests.Session, ysym: str, out_dir: Path,
                    category: str, label: str, timeframes: list[str], *,
                    write_csv: bool, manifest: dict) -> int:
    """Fetch + store all requested timeframes for one symbol. Returns series written."""
    written = 0
    need_1h = "4h" in timeframes
    interval_map = {"1d": "1d", "1wk": "1wk", "1mo": "1mo"}
    # Daily / weekly / monthly — full history.
    for tf in timeframes:
        if tf in interval_map:
            df = yahoo_chart(session, ysym, interval=interval_map[tf])
            time.sleep(THROTTLE_SEC)
            if df is not None:
                write_series(df, out_dir, category, label, tf, write_csv=write_csv,
                             currency=df.attrs.get("currency"), source="yahoo", manifest=manifest)
                written += 1
    # 4h — resampled from 1h (~2y).
    if need_1h:
        df1h = yahoo_chart(session, ysym, interval="1h", range_=INTRADAY_RANGE)
        time.sleep(THROTTLE_SEC)
        if df1h is not None:
            df4h = resample_4h(df1h)
            write_series(df4h, out_dir, category, label, "4h", write_csv=write_csv,
                         currency=df1h.attrs.get("currency"), source="yahoo(1h→4h)", manifest=manifest)
            if not df4h.empty:
                written += 1
    return written


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Download SA market history for local model-building.")
    p.add_argument("--out", default=str(Path(__file__).resolve().parent / "data"), help="output dir")
    p.add_argument("--symbols", help="comma list of equity codes (bare or .JO); overrides the universe")
    p.add_argument("--timeframes", default=",".join(TIMEFRAMES), help="comma list: 4h,1d,1wk,1mo")
    p.add_argument("--equities-only", action="store_true", help="skip indices + FX")
    p.add_argument("--no-equities", action="store_true", help="skip equities (indices/FX only)")
    p.add_argument("--no-csv", action="store_true", help="Parquet only (no CSV mirror)")
    p.add_argument("--limit", type=int, default=0, help="cap number of equities (smoke test)")
    return p.parse_args()


def main() -> int:
    load_env()
    args = parse_args()
    out_dir = Path(args.out)
    timeframes = [t.strip() for t in args.timeframes.split(",") if t.strip()]
    write_csv = not args.no_csv
    manifest: dict = {}
    session = requests.Session()

    print(f"SA history downloader → {out_dir}")
    print(f"  timeframes: {timeframes}  | format: parquet{'+csv' if write_csv else ''}")

    # Universe
    if args.symbols:
        equities = [bare(s) for s in args.symbols.split(",") if s.strip()]
    elif args.no_equities:
        equities = []
    else:
        equities = fetch_equity_universe(session)
    if args.limit and equities:
        equities = equities[: args.limit]

    total = 0
    # Indices + FX first (cheap, high value).
    if not args.equities_only:
        print(f"\nIndices ({len(INDICES)})")
        for label, ysym in INDICES.items():
            n = download_symbol(session, ysym, out_dir, "indices", label, timeframes,
                                write_csv=write_csv, manifest=manifest)
            print(f"  {label:6} {ysym:12} {n} series")
            total += n
        print(f"\nFX ({len(FX)})")
        for label, ysym in FX.items():
            n = download_symbol(session, ysym, out_dir, "fx", label, timeframes,
                                write_csv=write_csv, manifest=manifest)
            print(f"  {label:6} {ysym:12} {n} series")
            total += n

    # Equities
    if equities:
        print(f"\nEquities ({len(equities)})")
        for i, code in enumerate(equities, 1):
            ysym = f"{code}.JO"
            n = download_symbol(session, ysym, out_dir, "equities", code, timeframes,
                                write_csv=write_csv, manifest=manifest)
            status = f"{n} series" if n else "no data"
            print(f"  [{i:3}/{len(equities)}] {code:8} {status}")
            total += n

    # Manifest
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"\nDone. {total} series across {len(manifest)} files. Manifest: {out_dir / 'manifest.json'}")
    print("Note: equity prices are in ZAc (cents) per Yahoo; FX in the pair's quote currency.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
