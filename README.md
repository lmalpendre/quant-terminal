# Quant Terminal: metals & crypto tracker with price forecasts

A static website that follows **copper, gold, silver, Bitcoin and BNB** with live prices,
technical indicators, macro drivers (US dollar index, US 10Y yield, S&P 500), a correlation
matrix and statistical price forecasts with an honest walk-forward backtest.

> Educational tool. The forecasts are statistical models, not financial advice.

## What's inside

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The website (no build step, no framework) |
| `vendor/chart.umd.js` | Chart.js 4.4.3 (bundled so the site has no CDN dependency) |
| `scripts/fetch_data.py` | Downloads ~5 years of daily prices into `data/market.json` (Python standard library only) |
| `.github/workflows/update-data.yml` | Runs the script every 6 hours on GitHub and commits fresh data |

## Data sources (all free, no API keys)

- **Daily history**: Yahoo Finance (`HG=F`, `GC=F`, `SI=F`, `BTC-USD`, `BNB-USD`, `DX-Y.NYB`, `^TNX`, `^GSPC`), falling back to Stooq.
  Fetched server-side by the script, because these sites can't be called from a browser.
- **Live crypto**: Binance public market data (falls back to CoinGecko), every 20 seconds.
  If `market.json` is missing, Bitcoin/BNB history is also pulled live from Binance.
- **Live metals**: gold-api.com spot prices, every 60 seconds (rejected if it disagrees with the latest close by more than 20%).

If no history can be loaded at all, the site shows clearly-labelled **synthetic demo data** so the layout still works.

## The prediction engine

All models are fitted in your browser on each asset's daily history:

- **Random walk**: "no change" baseline. Median = today's price.
- **Trend**: exponentially weighted recent drift (half-life 60 days), shrunk by half.
- **Ridge ML**: ridge regression on 8 features (5/20/60-day returns, RSI, distance to SMA50/200, 20-day volatility, MACD histogram) trained on up to 3 years, predicting the log return over the horizon.
- **Ensemble**: average of Ridge and Trend.

Ranges (P10–P90 and P25–P75) come from a blend of EWMA and long-run volatility. The **walk-forward backtest**
re-fits the model at each past date using only data available then, and compares it with "no change"
(direction hit rate, average error, skill, and whether the 80% range held ~80% of the time).
If a model can't beat "no change", the page says so.

The **signal score** (0–100) blends trend, momentum, RSI mean reversion and the model's probability of rising;
you can change the weights with the sliders.

## Put it online (free) with GitHub Pages: about 10 minutes

1. Create a free account at github.com, then click **New repository**. Name it e.g. `quant-terminal`, set it **Public**, and create it.
2. On the new repo page click **uploading an existing file** and drag in *everything* in this folder
   (including the hidden `.github` folder: on macOS press `Cmd+Shift+.` in Finder to show it). Click **Commit changes**.
   - If the `.github` folder won't upload by drag-and-drop, use **Add file → Create new file**, type
     `.github/workflows/update-data.yml` as the name, and paste the contents of that file.
3. **Settings → Actions → General → Workflow permissions**: choose **Read and write permissions** and save.
4. **Actions** tab → **Update market data** → **Run workflow**. After ~1 minute `data/market.json` appears in the repo.
5. **Settings → Pages**: Source = **Deploy from a branch**, Branch = `main`, folder = `/ (root)`. Save.
6. After a minute your site is live at `https://<your-username>.github.io/quant-terminal/`.

The workflow then refreshes the history every 6 hours by itself; live prices update in the browser.

**Other hosts** (Netlify, Cloudflare Pages, Vercel) work too: upload the folder as a static site.
To keep the history fresh there, run `python3 scripts/fetch_data.py` on a schedule and redeploy, or keep using GitHub Actions.

## Run it on your computer

```bash
python3 scripts/fetch_data.py      # creates data/market.json
python3 -m http.server 8000        # then open http://localhost:8000
```

Opening `index.html` by double-clicking won't load the data file (browsers block that); use the small server above.

## Customising

- Add or change assets in the `ASSETS` object at the top of `app.js` and in `scripts/fetch_data.py`.
- Change colours in `styles.css` (`:root` variables) and the `accent` of each asset in `app.js`.
