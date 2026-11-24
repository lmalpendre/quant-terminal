#!/usr/bin/env python3
"""
Quant Terminal data builder.

Downloads ~5 years of daily closing prices for the tracked assets and a few
macro drivers, and writes them to data/market.json for the website to read.

Uses only the Python standard library, so it runs anywhere (including the
GitHub Actions workflow in .github/workflows/update-data.yml).

Primary source: Yahoo Finance chart API.  Fallback: Stooq CSV downloads.

Usage:
    python3 scripts/fetch_data.py            # writes data/market.json
    python3 scripts/fetch_data.py --years 3  # shorter history
"""
import argparse
import csv
import io
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"

# key: (yahoo symbol, stooq symbol, label, unit)
ASSETS = {
    "copper": ("HG=F", "hg.f", "Copper (COMEX front month)", "USD / lb"),
    "gold": ("GC=F", "xauusd", "Gold", "USD / oz"),
    "silver": ("SI=F", "xagusd", "Silver", "USD / oz"),
    "btc": ("BTC-USD", "btcusd", "Bitcoin", "USD"),
    "bnb": ("BNB-USD", None, "BNB", "USD"),
}
MACRO = {
    "dxy": ("DX-Y.NYB", None, "US Dollar Index (DXY)", "index"),
    "us10y": ("^TNX", "10usy.b", "US 10Y Treasury yield", "%"),
    "spx": ("^GSPC", "^spx", "S&P 500", "index"),
}


def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8")


def from_yahoo(symbol, years):
    rng = f"{years}y" if years in (1, 2, 5, 10) else "5y"
    last_err = None
    for host in ("query1.finance.yahoo.com", "query2.finance.yahoo.com"):
        url = f"https://{host}/v8/finance/chart/{urllib.request.quote(symbol)}?range={rng}&interval=1d&includePrePost=false"
        try:
            payload = json.loads(http_get(url))
            res = payload["chart"]["result"][0]
            ts = res.get("timestamp") or []
            closes = res["indicators"]["quote"][0].get("close") or []
            out = {}
            for t, c in zip(ts, closes):
                if c is None:
                    continue
                d = datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d")
                out[d] = float(c)  # last value of the day wins
            if len(out) > 50:
                return out
            last_err = "too few rows"
        except Exception as e:  # noqa: BLE001
            last_err = e
        time.sleep(1)
    raise RuntimeError(f"yahoo {symbol}: {last_err}")


def from_stooq(symbol):
    url = f"https://stooq.com/q/d/l/?s={urllib.request.quote(symbol)}&i=d"
    text = http_get(url)
    out = {}
    for row in csv.DictReader(io.StringIO(text)):
        try:
            out[row["Date"]] = float(row["Close"])
        except (KeyError, ValueError):
            continue
    if len(out) < 50:
        raise RuntimeError(f"stooq {symbol}: too few rows")
    return out


def build_series(key, spec, years, cutoff):
    ysym, ssym, label, unit = spec
    source = None
    data = None
    try:
        data = from_yahoo(ysym, years)
        source = f"Yahoo Finance ({ysym})"
    except Exception as e:  # noqa: BLE001
        print(f"  ! {key}: {e}", file=sys.stderr)
        if ssym:
            try:
                data = from_stooq(ssym)
                source = f"Stooq ({ssym})"
            except Exception as e2:  # noqa: BLE001
                print(f"  ! {key}: {e2}", file=sys.stderr)
    if not data:
        return None
    dates = sorted(d for d in data if d >= cutoff)
    closes = [round(data[d], 6) for d in dates]
    print(f"  ✓ {key}: {len(dates)} rows from {source}, last {dates[-1]} = {closes[-1]}")
    return {"label": label, "unit": unit, "source": source, "dates": dates, "close": closes}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=int, default=5)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "market.json"))
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    cutoff = f"{now.year - args.years}-{now.month:02d}-{now.day:02d}"

    out_path = os.path.abspath(args.out)
    previous = {}
    if os.path.exists(out_path):
        try:
            with open(out_path, encoding="utf-8") as f:
                previous = json.load(f)
        except Exception:  # noqa: BLE001
            previous = {}

    result = {"updated": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "assets": {}, "macro": {}}
    for group, specs in (("assets", ASSETS), ("macro", MACRO)):
        print(f"{group}:")
        for key, spec in specs.items():
            s = build_series(key, spec, args.years, cutoff)
            if s is None:
                # keep the previous copy rather than losing the series
                s = previous.get(group, {}).get(key)
                if s:
                    print(f"  ~ {key}: kept previous data")
            if s:
                result[group][key] = s
            time.sleep(0.5)

    if not result["assets"]:
        print("No asset data could be downloaded; not writing file.", file=sys.stderr)
        sys.exit(1)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, separators=(",", ":"))
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
