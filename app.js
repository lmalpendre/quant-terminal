/* Quant Terminal: live indicators and statistical forecasts for copper, gold, silver, Bitcoin and BNB.
 * Everything runs in the browser. History comes from data/market.json (built by scripts/fetch_data.py),
 * crypto history can also be fetched live from Binance/CoinGecko, and live prices are polled from
 * Binance/CoinGecko (crypto) and gold-api.com (metals).
 * Forecasts are statistical models, not financial advice.
 */
'use strict';

/* ------------------------------------------------------------------ config */
const ASSETS = {
  copper: { name: 'Copper', ticker: 'HG', unit: 'USD / lb', accent: '#e76f51', dec: 4, crypto: false, goldApi: 'HG',
    category: 'Industrial metal',
    driver: 'China demand, mine supply and exchange inventories (COMEX, LME, SHFE). Usually falls when the dollar rises.',
    notes: ['<strong>Demand:</strong> grids, EVs, data centres and Chinese construction set the cycle.',
            '<strong>Supply:</strong> mine disruptions and smelter fees (TC/RCs) tighten or loosen the market.'] },
  gold: { name: 'Gold', ticker: 'XAU', unit: 'USD / oz', accent: '#eab308', dec: 2, crypto: false, goldApi: 'XAU',
    category: 'Precious metal · reserve asset',
    driver: 'Real interest rates, central-bank buying and ETF flows. Tends to move against the dollar and real yields.',
    notes: ['<strong>Real yields:</strong> lower real rates reduce the cost of holding a non-yielding asset.',
            '<strong>Official demand:</strong> central-bank reserve diversification puts a floor under dips.'] },
  silver: { name: 'Silver', ticker: 'XAG', unit: 'USD / oz', accent: '#a3b1c6', dec: 3, crypto: false, goldApi: 'XAG',
    category: 'Precious + industrial metal',
    driver: 'High-beta follower of gold, plus solar and electronics demand. Swings harder than gold both ways.',
    notes: ['<strong>Gold beta:</strong> silver usually amplifies gold moves by roughly 1.3 to 2 times.',
            '<strong>Industrial use:</strong> solar panels and electronics are about half of demand.'] },
  btc: { name: 'Bitcoin', ticker: 'BTC', unit: 'USD', accent: '#f7931a', dec: 0, crypto: true, binance: 'BTCUSDT', gecko: 'bitcoin',
    category: 'Crypto · digital store of value',
    driver: 'Global liquidity, spot-ETF flows and risk appetite. Often trades like a high-beta tech stock.',
    notes: ['<strong>Liquidity:</strong> easier financial conditions and a weaker dollar tend to help.',
            '<strong>Flows:</strong> ETF creations/redemptions and leverage drive short-term swings.'] },
  bnb: { name: 'BNB', ticker: 'BNB', unit: 'USD', accent: '#2dd4bf', dec: 2, crypto: true, binance: 'BNBUSDT', gecko: 'binancecoin',
    category: 'Crypto · exchange ecosystem token',
    driver: 'Bitcoin beta plus BNB Chain activity, token burns and Binance-specific news.',
    notes: ['<strong>BTC beta:</strong> most of BNB\'s daily move is explained by the wider crypto market.',
            '<strong>Ecosystem:</strong> on-chain activity, burns and exchange news add idiosyncratic risk.'] },
};
const MACRO = {
  dxy: { name: 'DXY', label: 'US dollar index', accent: '#60a5fa' },
  us10y: { name: 'US10Y', label: 'US 10Y yield', accent: '#c084fc', isYield: true },
  spx: { name: 'S&P 500', label: 'S&P 500', accent: '#4ade80' },
};
const KEYS = Object.keys(ASSETS);
const HORIZONS = {
  w: { label: '1W', long: '1 week', cal: 7, metal: 5 },
  m: { label: '1M', long: '1 month', cal: 30, metal: 21 },
  q: { label: '3M', long: '3 months', cal: 91, metal: 63 },
};
const MODELS = {
  ensemble: 'Average of the Ridge ML and Trend forecasts. Usually the most stable choice.',
  ridge: 'Ridge regression trained on this asset\'s past: 5/20/60-day returns, RSI, distance to SMA50/200, volatility and MACD, predicting the return over the horizon.',
  trend: 'Extrapolates the recent exponentially weighted drift (half-life 60 days), shrunk by half to avoid over-confidence.',
  rw: 'Baseline "no change" model: the median is today\'s price and the range comes only from volatility.',
};
const DEFAULT_WEIGHTS = { trend: 30, momentum: 25, meanrev: 15, model: 30 };
const WEIGHT_LABELS = { trend: 'Trend (SMA 50/200)', momentum: 'Momentum (60d + MACD)', meanrev: 'Mean reversion (RSI)', model: 'Model probability' };
const Z80 = 1.2816, Z50 = 0.6745;

/* ------------------------------------------------------------------ state */
const state = {
  asset: 'gold', range: 365, showMA: true, sub: 'rsi', corrWin: 90, horizon: 'm', model: 'ensemble',
  weights: { ...DEFAULT_WEIGHTS },
};
try { Object.assign(state, JSON.parse(localStorage.getItem('qt-prefs') || '{}')); } catch (e) { /* ignore */ }
if (!ASSETS[state.asset]) state.asset = 'gold';
const savePrefs = () => { try { localStorage.setItem('qt-prefs', JSON.stringify(state)); } catch (e) { /* ignore */ } };

const DATA = { assets: {}, macro: {}, updated: null, demo: new Set(), sources: {} };
const LIVE = {};          // key -> { price, chg24, ts, src }
let lastLiveOk = 0;
const cache = new Map();  // memo for heavy computations
let mainChart = null, subChart = null;

/* ------------------------------------------------------------------ utils */
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const std = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const todayUTC = () => new Date().toISOString().slice(0, 10);
const isWeekend = (d) => { const g = new Date(d + 'T00:00:00Z').getUTCDay(); return g === 0 || g === 6; };
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
const normCdf = (x) => { // Abramowitz-Stegun
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
};
function fmtPrice(key, v) {
  if (v == null || !isFinite(v)) return '—';
  const dec = ASSETS[key] ? ASSETS[key].dec : 2;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtPct(v, dec = 2) {
  if (v == null || !isFinite(v)) return '—';
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(dec) + '%';
}
const cls = (v) => (v == null || !isFinite(v) || Math.abs(v) < 1e-9 ? 'flat' : v > 0 ? 'up' : 'down');
const fmtDate = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtShort = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });

async function getJSON(url, timeout = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status + ' ' + url);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* ------------------------------------------------------------------ indicators */
function smaArr(a, n) {
  const out = new Array(a.length).fill(null); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) out[i] = s / n; }
  return out;
}
function emaArr(a, n) {
  const k = 2 / (n + 1); const out = new Array(a.length); let e = a[0];
  for (let i = 0; i < a.length; i++) { e = i === 0 ? a[0] : a[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function rsiArr(a, n = 14) {
  const out = new Array(a.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < a.length; i++) {
    const d = a[i] - a[i - 1]; const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; if (i === n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function macdArr(a) {
  const e12 = emaArr(a, 12), e26 = emaArr(a, 26);
  const m = a.map((_, i) => e12[i] - e26[i]);
  const s = emaArr(m, 9);
  return { macd: m, signal: s, hist: m.map((x, i) => x - s[i]) };
}
function logRets(a) { const r = [0]; for (let i = 1; i < a.length; i++) r.push(Math.log(a[i] / a[i - 1])); return r; }
function rollStd(r, n) {
  const out = new Array(r.length).fill(null); let s = 0, s2 = 0;
  for (let i = 1; i < r.length; i++) {
    s += r[i]; s2 += r[i] * r[i];
    if (i > n) { s -= r[i - n]; s2 -= r[i - n] ** 2; }
    if (i >= n) out[i] = Math.sqrt(Math.max(0, (s2 - s * s / n) / (n - 1)));
  }
  return out;
}
function ewmaVolArr(r, lambda = 0.94) {
  const out = new Array(r.length).fill(null);
  if (r.length < 32) return out;
  let v = mean(r.slice(1, 31).map((x) => x * x));
  for (let i = 31; i < r.length; i++) { v = lambda * v + (1 - lambda) * r[i] * r[i]; out[i] = Math.sqrt(v); }
  return out;
}
function bollPctB(a, n = 20) {
  const sm = smaArr(a, n); const out = new Array(a.length).fill(null);
  for (let i = n - 1; i < a.length; i++) {
    const sd = std(a.slice(i - n + 1, i + 1)); if (sd === 0) continue;
    out[i] = (a[i] - (sm[i] - 2 * sd)) / (4 * sd);
  }
  return out;
}

/* ------------------------------------------------------------------ series with live merge */
function series(key) {
  const base = DATA.assets[key];
  if (!base) return null;
  const live = LIVE[key];
  const ck = 'series:' + key + ':' + base.close.length + ':' + (live ? live.price + live.ts : '');
  if (cache.has(ck)) return cache.get(ck);
  const dates = base.dates.slice(), close = base.close.slice();
  if (live && live.price > 0) {
    const d = new Date(live.ts || Date.now()).toISOString().slice(0, 10);
    const last = dates[dates.length - 1];
    if (d === last) close[close.length - 1] = live.price;
    else if (d > last && (ASSETS[key].crypto || !isWeekend(d))) { dates.push(d); close.push(live.price); }
  }
  const s = { key, dates, close };
  cache.set(ck, s);
  return s;
}

function analytics(key) {
  const s = series(key); if (!s) return null;
  const ck = 'an:' + key + ':' + s.dates.length + ':' + s.close[s.close.length - 1];
  if (cache.has(ck)) return cache.get(ck);
  const c = s.close;
  const r = logRets(c);
  const a = {
    s, r,
    sma20: smaArr(c, 20), sma50: smaArr(c, 50), sma200: smaArr(c, 200),
    rsi: rsiArr(c, 14), macd: macdArr(c), pctB: bollPctB(c, 20),
    vol20: rollStd(r, 20), ewma: ewmaVolArr(r),
    ppy: ASSETS[key].crypto ? 365 : 252,
  };
  cache.set(ck, a);
  return a;
}

function valueAtOrBefore(s, date) {
  // binary search last index with s.dates[i] <= date
  let lo = 0, hi = s.dates.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s.dates[m] <= date) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? s.close[ans] : null;
}
function perf(key) {
  const s = series(key); if (!s) return {};
  const n = s.close.length, p = s.close[n - 1], last = s.dates[n - 1];
  const ref = (days) => valueAtOrBefore(s, addDays(last, -days));
  const ytdRef = valueAtOrBefore(s, (Number(last.slice(0, 4)) - 1) + '-12-31');
  const ch = (x) => (x ? p / x - 1 : null);
  const yr = s.close.slice(-(ASSETS[key].crypto ? 365 : 252));
  return {
    price: p, date: last, d1: n > 1 ? p / s.close[n - 2] - 1 : null,
    w1: ch(ref(7)), m1: ch(ref(30)), m3: ch(ref(91)), ytd: ch(ytdRef), y1: ch(ref(365)),
    hi52: Math.max(...yr), lo52: Math.min(...yr),
  };
}

/* ------------------------------------------------------------------ models */
const FEAT_START = 200;
function features(a, t) {
  const c = a.s.close, p = c[t];
  return [
    Math.log(p / c[t - 5]), Math.log(p / c[t - 20]), Math.log(p / c[t - 60]),
    (a.rsi[t] - 50) / 50, Math.log(p / a.sma50[t]), Math.log(p / a.sma200[t]),
    a.vol20[t], a.macd.hist[t] / p,
  ];
}
function solve(A, b) { // Gaussian elimination with partial pivoting
  const n = b.length; const M = A.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let piv = i; for (let k = i + 1; k < n; k++) if (Math.abs(M[k][i]) > Math.abs(M[piv][i])) piv = k;
    [M[i], M[piv]] = [M[piv], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) continue;
    for (let k = i + 1; k < n; k++) { const f = M[k][i] / M[i][i]; for (let j = i; j <= n; j++) M[k][j] -= f * M[i][j]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = Math.abs(M[i][i]) < 1e-12 ? 0 : s / M[i][i]; }
  return x;
}
// Fit ridge on samples whose target ends at or before index `until`, predict H-step log return at origin `t`.
function ridgePredict(a, H, t, until) {
  const c = a.s.close;
  const end = until - H;
  const start = Math.max(FEAT_START, end - 750);
  if (end - start < 120) return null;
  const X = [], y = [];
  for (let i = start; i <= end; i++) { X.push(features(a, i)); y.push(Math.log(c[i + H] / c[i])); }
  const k = X[0].length;
  const mu = new Array(k).fill(0), sd = new Array(k).fill(0);
  for (const row of X) row.forEach((v, j) => { mu[j] += v / X.length; });
  for (const row of X) row.forEach((v, j) => { sd[j] += (v - mu[j]) ** 2 / X.length; });
  for (let j = 0; j < k; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const ym = mean(y);
  const A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    const z = X[i].map((v, j) => (v - mu[j]) / sd[j]);
    for (let p = 0; p < k; p++) { b[p] += z[p] * (y[i] - ym); for (let q = 0; q < k; q++) A[p][q] += z[p] * z[q]; }
  }
  const lambda = 2.0 * X.length; // strong shrinkage: overlapping targets, noisy data
  for (let p = 0; p < k; p++) A[p][p] += lambda;
  const beta = solve(A, b);
  const zt = features(a, t).map((v, j) => (v - mu[j]) / sd[j]);
  const pred = 0.5 * ym + zt.reduce((s, v, j) => s + v * beta[j], 0);
  return clamp(pred, -0.6, 0.6);
}
function trendPredict(a, H, t) {
  const r = a.r; const n = Math.min(250, t);
  const hl = 60, lam = Math.pow(0.5, 1 / hl);
  let w = 1, sw = 0, s = 0;
  for (let i = t; i > t - n; i--) { s += w * r[i]; sw += w; w *= lam; }
  return clamp(0.5 * (s / sw) * H, -0.6, 0.6);
}
function sigmaAt(a, H, t) {
  const e = a.ewma[t] || a.vol20[t] || 0.02;
  const lr = std(a.r.slice(Math.max(1, t - 500), t + 1));
  const w = H <= 7 ? 0.8 : H <= 30 ? 0.6 : 0.4;
  return Math.sqrt(w * e * e + (1 - w) * lr * lr) * Math.sqrt(H);
}
function predictAt(a, H, t, model, until) {
  let mu;
  if (model === 'rw') mu = 0;
  else if (model === 'trend') mu = trendPredict(a, H, t);
  else {
    const rg = ridgePredict(a, H, t, until);
    if (model === 'ridge') mu = rg == null ? 0 : rg;
    else { const tr = trendPredict(a, H, t); mu = rg == null ? tr : (rg + tr) / 2; }
  }
  return { mu, sigma: sigmaAt(a, H, t) };
}
function horizonSteps(key, h) { return ASSETS[key].crypto ? HORIZONS[h].cal : HORIZONS[h].metal; }

function forecast(key, h = state.horizon, model = state.model) {
  const a = analytics(key); if (!a) return null;
  const n = a.s.close.length, t = n - 1;
  const ck = 'fc:' + key + ':' + h + ':' + model + ':' + n + ':' + a.s.close[t];
  if (cache.has(ck)) return cache.get(ck);
  if (n < FEAT_START + 150) return null;
  const H = horizonSteps(key, h);
  const { mu, sigma } = predictAt(a, H, t, model, t);
  const p = a.s.close[t];
  const q = (z) => p * Math.exp(mu + z * sigma);
  // forecast path
  const dates = [], med = [], p10 = [], p90 = [], p25 = [], p75 = [];
  let d = a.s.dates[t], k = 0;
  while (k < H) {
    d = addDays(d, 1);
    if (!ASSETS[key].crypto && isWeekend(d)) continue;
    k++;
    const f = k / H, sg = sigma * Math.sqrt(f);
    dates.push(d); med.push(p * Math.exp(mu * f));
    p10.push(p * Math.exp(mu * f - Z80 * sg)); p90.push(p * Math.exp(mu * f + Z80 * sg));
    p25.push(p * Math.exp(mu * f - Z50 * sg)); p75.push(p * Math.exp(mu * f + Z50 * sg));
  }
  const out = {
    H, mu, sigma, price: p, median: q(0), p10: q(-Z80), p90: q(Z80), p25: q(-Z50), p75: q(Z50),
    probUp: sigma > 0 ? normCdf(mu / sigma) : 0.5, endDate: dates[dates.length - 1],
    path: { dates, med, p10, p90, p25, p75 },
  };
  cache.set(ck, out);
  return out;
}

function backtest(key, h = state.horizon, model = state.model) {
  const a = analytics(key); if (!a) return null;
  const n = a.s.close.length;
  const ck = 'bt:' + key + ':' + h + ':' + model + ':' + a.s.dates[n - 1] + ':' + n;
  if (cache.has(ck)) return cache.get(ck);
  const H = horizonSteps(key, h);
  const window = Math.min(ASSETS[key].crypto ? 730 : 504, n - H - FEAT_START - 150);
  if (window < 60) return null;
  const step = Math.max(1, Math.round(H / 4));
  let hits = 0, dirN = 0, aeM = 0, aeR = 0, covM = 0, covR = 0, cnt = 0;
  for (let t = n - 1 - H - window; t <= n - 1 - H; t += step) {
    const actual = Math.log(a.s.close[t + H] / a.s.close[t]);
    const { mu, sigma } = predictAt(a, H, t, model, t);
    if (mu !== 0) { dirN++; if (Math.sign(mu) === Math.sign(actual)) hits++; }
    aeM += Math.abs(actual - mu); aeR += Math.abs(actual);
    if (Math.abs(actual - mu) <= Z80 * sigma) covM++;
    if (Math.abs(actual) <= Z80 * sigma) covR++;
    cnt++;
  }
  const out = {
    n: cnt, hit: dirN ? hits / dirN : null, maeM: aeM / cnt, maeR: aeR / cnt,
    skill: 1 - aeM / aeR, cov: covM / cnt, covR: covR / cnt,
    from: a.s.dates[n - 1 - H - window], to: a.s.dates[n - 1],
  };
  cache.set(ck, out);
  return out;
}

/* signal score 0-100 */
function signal(key) {
  const a = analytics(key); const f = forecast(key);
  if (!a || !f) return null;
  const t = a.s.close.length - 1, p = a.s.close[t];
  const vd = a.ewma[t] || a.vol20[t] || 0.02;
  const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const trend = 0.5 * sgn(p - a.sma200[t]) + 0.5 * sgn(a.sma50[t] - a.sma200[t]);
  const mom = 0.6 * Math.tanh(Math.log(p / a.s.close[t - 60]) / (vd * Math.sqrt(60))) + 0.4 * Math.tanh(a.macd.hist[t] / (p * vd));
  const rsi = a.rsi[t];
  const meanrev = rsi >= 70 ? -clamp((rsi - 65) / 20, 0, 1) : rsi <= 30 ? clamp((35 - rsi) / 20, 0, 1) : (rsi - 50) / 40;
  const model = clamp((f.probUp - 0.5) * 4, -1, 1);
  const comp = { trend, momentum: mom, meanrev, model };
  const W = state.weights; const sw = Object.values(W).reduce((s, x) => s + x, 0) || 1;
  const raw = Object.keys(comp).reduce((s, k) => s + comp[k] * (W[k] || 0), 0) / sw;
  const score = clamp(50 + 50 * raw, 0, 100);
  return { score, comp };
}
function signalMeta(score) {
  if (score >= 65) return { label: 'BULLISH BIAS', cls: 'bull', color: '#10b981' };
  if (score >= 45) return { label: 'NEUTRAL', cls: 'neutral', color: '#f59e0b' };
  return { label: 'BEARISH BIAS', cls: 'bear', color: '#f43f5e' };
}

/* correlations on common dates */
function allSeriesMap() {
  const m = {};
  for (const k of KEYS) { const s = series(k); if (s) m[k] = s; }
  for (const k of Object.keys(MACRO)) { const s = DATA.macro[k]; if (s) m[k] = s; }
  return m;
}
function retsOnDates(s, dates, isYield) {
  const idx = new Map(s.dates.map((d, i) => [d, i]));
  const v = dates.map((d) => s.close[idx.get(d)]);
  const r = [];
  for (let i = 1; i < v.length; i++) r.push(isYield ? v[i] - v[i - 1] : Math.log(v[i] / v[i - 1]));
  return r;
}
function pearson(x, y) {
  const n = Math.min(x.length, y.length); if (n < 10) return null;
  const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
function corrPair(ka, kb, win) {
  const m = allSeriesMap(); const A = m[ka], B = m[kb]; if (!A || !B) return null;
  const setB = new Set(B.dates);
  const common = A.dates.filter((d) => setB.has(d)).slice(-(win + 1));
  if (common.length < 12) return null;
  return pearson(retsOnDates(A, common, MACRO[ka] && MACRO[ka].isYield), retsOnDates(B, common, MACRO[kb] && MACRO[kb].isYield));
}
function rollingCorr(ka, kb, win, fromDate) {
  const m = allSeriesMap(); const A = m[ka], B = m[kb]; if (!A || !B) return { dates: [], r: [] };
  const setB = new Set(B.dates);
  const common = A.dates.filter((d) => setB.has(d));
  const ra = retsOnDates(A, common, MACRO[ka] && MACRO[ka].isYield), rb = retsOnDates(B, common, MACRO[kb] && MACRO[kb].isYield);
  const dates = [], r = [];
  for (let i = win; i <= ra.length; i++) {
    const d = common[i]; if (fromDate && d < fromDate) continue;
    dates.push(d); r.push(pearson(ra.slice(i - win, i), rb.slice(i - win, i)));
  }
  return { dates, r };
}
function corrReading(r) {
  if (r == null) return 'not enough data';
  const a = Math.abs(r);
  const strength = a >= 0.7 ? 'strong' : a >= 0.4 ? 'moderate' : a >= 0.2 ? 'weak' : 'no clear';
  if (strength === 'no clear') return 'no clear link';
  return `${strength} ${r > 0 ? 'positive: move together' : 'negative: move opposite'}`;
}
const corrColor = (r) => {
  if (r == null) return '#101827';
  const a = Math.min(1, Math.abs(r));
  return r >= 0 ? `rgba(8,145,178,${0.12 + a * 0.78})` : `rgba(225,29,72,${0.12 + a * 0.78})`;
};
function beta(ka, kb, win = 250) {
  const m = allSeriesMap(); const A = m[ka], B = m[kb]; if (!A || !B) return null;
  const setB = new Set(B.dates);
  const common = A.dates.filter((d) => setB.has(d)).slice(-(win + 1));
  const ra = retsOnDates(A, common), rb = retsOnDates(B, common, MACRO[kb] && MACRO[kb].isYield);
  const mb = mean(rb), ma = mean(ra); let c = 0, v = 0;
  for (let i = 0; i < ra.length; i++) { c += (ra[i] - ma) * (rb[i] - mb); v += (rb[i] - mb) ** 2; }
  return v ? c / v : null;
}

/* ------------------------------------------------------------------ data loading */
async function loadHistory() {
  try {
    const j = await getJSON('data/market.json?v=' + Math.floor(Date.now() / 3e5));
    for (const [k, v] of Object.entries(j.assets || {})) if (ASSETS[k] && v.dates && v.dates.length > 50) { DATA.assets[k] = { dates: v.dates, close: v.close }; DATA.sources[k] = v.source; }
    for (const [k, v] of Object.entries(j.macro || {})) if (MACRO[k] && v.dates && v.dates.length > 50) DATA.macro[k] = { dates: v.dates, close: v.close };
    DATA.updated = j.updated || null;
  } catch (e) { console.warn('market.json not available', e); }

  // crypto: fetch live history if missing or older than 3 days
  await Promise.all(KEYS.filter((k) => ASSETS[k].crypto).map(async (k) => {
    const cur = DATA.assets[k];
    if (cur && daysBetween(cur.dates[cur.dates.length - 1], todayUTC()) <= 3) return;
    const got = await fetchCryptoHistory(k);
    if (got) { DATA.assets[k] = got.data; DATA.sources[k] = got.src; }
  }));

  // anything still missing falls back to clearly-labelled synthetic demo data
  for (const k of KEYS) if (!DATA.assets[k]) { DATA.assets[k] = demoSeries(k); DATA.demo.add(k); DATA.sources[k] = 'synthetic demo data'; }
  for (const k of Object.keys(MACRO)) if (!DATA.macro[k]) { DATA.macro[k] = demoSeries(k); DATA.demo.add(k); }
}

async function fetchCryptoHistory(k) {
  const sym = ASSETS[k].binance;
  for (const host of ['https://data-api.binance.vision', 'https://api.binance.com']) {
    try {
      const rows = await getJSON(`${host}/api/v3/klines?symbol=${sym}&interval=1d&limit=1000`);
      if (Array.isArray(rows) && rows.length > 300) {
        return { src: 'Binance daily klines', data: { dates: rows.map((r) => new Date(r[0]).toISOString().slice(0, 10)), close: rows.map((r) => +r[4]) } };
      }
    } catch (e) { /* next */ }
  }
  try {
    const j = await getJSON(`https://api.coingecko.com/api/v3/coins/${ASSETS[k].gecko}/market_chart?vs_currency=usd&days=365&interval=daily`);
    const byDate = new Map();
    for (const [ts, p] of j.prices) byDate.set(new Date(ts).toISOString().slice(0, 10), p);
    const dates = [...byDate.keys()].sort();
    if (dates.length > 300) return { src: 'CoinGecko daily', data: { dates, close: dates.map((d) => byDate.get(d)) } };
  } catch (e) { /* give up */ }
  return null;
}

function demoSeries(k) {
  // deterministic geometric random walk so the layout can be explored offline. NOT real prices.
  const P = { copper: [4.6, 0.25], gold: [3600, 0.15], silver: [42, 0.28], btc: [95000, 0.55], bnb: [850, 0.6], dxy: [100, 0.07], us10y: [4.2, 0.2], spx: [6400, 0.17] }[k];
  let seed = [...k].reduce((s, c) => s * 31 + c.charCodeAt(0), 7) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const crypto = ASSETS[k] && ASSETS[k].crypto, ppy = crypto ? 365 : 252, sd = P[1] / Math.sqrt(ppy);
  const dates = []; let d = addDays(todayUTC(), -365 * 5);
  while (d <= todayUTC()) { if (crypto || !isWeekend(d)) dates.push(d); d = addDays(d, 1); }
  const close = new Array(dates.length); close[dates.length - 1] = P[0];
  for (let i = dates.length - 2; i >= 0; i--) close[i] = close[i + 1] / Math.exp(0.0002 + sd * gauss());
  return { dates, close };
}

/* live prices */
async function pollCrypto() {
  let ok = false;
  const syms = encodeURIComponent(JSON.stringify(KEYS.filter((k) => ASSETS[k].crypto).map((k) => ASSETS[k].binance)));
  for (const host of ['https://data-api.binance.vision', 'https://api.binance.com']) {
    try {
      const rows = await getJSON(`${host}/api/v3/ticker/24hr?symbols=${syms}`, 8000);
      for (const r of rows) {
        const k = KEYS.find((x) => ASSETS[x].binance === r.symbol);
        if (k && !DATA.demo.has(k)) setLive(k, +r.lastPrice, +r.priceChangePercent / 100, r.closeTime || Date.now(), 'Binance');
      }
      ok = true; break;
    } catch (e) { /* next */ }
  }
  if (!ok) {
    try {
      const ids = KEYS.filter((k) => ASSETS[k].crypto).map((k) => ASSETS[k].gecko).join(',');
      const j = await getJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`, 8000);
      for (const k of KEYS.filter((x) => ASSETS[x].crypto)) {
        const v = j[ASSETS[k].gecko];
        if (v && !DATA.demo.has(k)) setLive(k, v.usd, v.usd_24h_change / 100, (v.last_updated_at || Date.now() / 1000) * 1000, 'CoinGecko');
      }
      ok = true;
    } catch (e) { /* offline */ }
  }
  if (ok) lastLiveOk = Date.now();
  afterLive();
}
async function pollMetals() {
  let ok = false;
  await Promise.all(KEYS.filter((k) => !ASSETS[k].crypto).map(async (k) => {
    if (DATA.demo.has(k)) return;
    try {
      const j = await getJSON(`https://api.gold-api.com/price/${ASSETS[k].goldApi}`, 8000);
      const base = DATA.assets[k]; const last = base.close[base.close.length - 1];
      // the feed may quote copper per tonne/kg; pick the unit that matches our history, reject outliers
      const cands = [j.price, j.price / 2204.62, j.price / 2.20462, j.price * 0.0311035];
      const px = cands.find((c) => c > 0 && Math.abs(c / last - 1) < 0.2);
      if (!px) return;
      const prevClose = base.dates[base.dates.length - 1] < todayUTC() ? last : base.close[base.close.length - 2];
      setLive(k, px, px / prevClose - 1, j.updatedAt ? Date.parse(j.updatedAt) : Date.now(), 'gold-api.com');
      ok = true;
    } catch (e) { /* ignore */ }
  }));
  if (ok) lastLiveOk = Date.now();
  afterLive();
}
function setLive(k, price, chg24, ts, src) {
  if (!(price > 0)) return;
  const prev = LIVE[k] ? LIVE[k].price : null;
  LIVE[k] = { price, chg24, ts, src, prev };
}
let liveRenderPending = false;
function afterLive() {
  if (liveRenderPending) return;
  liveRenderPending = true;
  requestAnimationFrame(() => { liveRenderPending = false; renderAll(true); });
}

/* ------------------------------------------------------------------ rendering */
function renderTabs() {
  const nav = $('asset-tabs'); nav.innerHTML = '';
  for (const k of KEYS) {
    const A = ASSETS[k];
    const b = document.createElement('button');
    b.className = 'tab' + (k === state.asset ? ' on' : '');
    b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', k === state.asset);
    b.style.setProperty('--tab-accent', A.accent);
    b.innerHTML = `<span class="sw" style="background:${A.accent}"></span>${A.name}<span class="tk">${A.ticker}</span>`;
    b.onclick = () => selectAsset(k);
    nav.appendChild(b);
  }
}
function renderTicker() {
  const el = $('ticker'); const html = [];
  for (const k of KEYS) {
    const p = perf(k); const L = LIVE[k];
    const d1 = L && L.chg24 != null && isFinite(L.chg24) ? L.chg24 : p.d1;
    const fl = L && L.prev != null && L.prev !== L.price ? (L.price > L.prev ? 'flash-up' : 'flash-down') : '';
    html.push(`<span class="t-item" data-k="${k}"><span class="t-name">${ASSETS[k].ticker}</span><span class="t-px ${fl}">${fmtPrice(k, p.price)}</span><span class="${cls(d1)}">${fmtPct(d1)}</span></span>`);
  }
  for (const k of Object.keys(MACRO)) {
    const s = DATA.macro[k]; if (!s) continue; const n = s.close.length;
    const v = s.close[n - 1], ch = MACRO[k].isYield ? null : v / s.close[n - 2] - 1;
    html.push(`<span class="t-item"><span class="t-name">${MACRO[k].name}</span><span class="t-px">${MACRO[k].isYield ? v.toFixed(2) + '%' : v.toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>${ch == null ? `<span class="${cls(v - s.close[n - 2])}">${(v - s.close[n - 2] >= 0 ? '+' : '−') + Math.abs((v - s.close[n - 2]) * 100).toFixed(0)}bp</span>` : `<span class="${cls(ch)}">${fmtPct(ch)}</span>`}</span>`);
  }
  el.innerHTML = html.join('');
  el.querySelectorAll('[data-k]').forEach((n) => { n.onclick = () => selectAsset(n.dataset.k); });
  for (const k of KEYS) if (LIVE[k]) LIVE[k].prev = LIVE[k].price;
}
function renderStatus() {
  const pill = $('status-pill'), txt = $('status-text');
  pill.className = 'pill';
  const demoAssets = KEYS.filter((k) => DATA.demo.has(k));
  if (demoAssets.length === KEYS.length) { pill.classList.add('demo'); txt.textContent = 'Demo data'; }
  else if (Date.now() - lastLiveOk < 150000) { pill.classList.add('live'); txt.textContent = 'Live'; }
  else { pill.classList.add('stale'); txt.textContent = 'Delayed · daily close'; }
  $('data-updated').textContent = DATA.updated ? 'history updated ' + new Date(DATA.updated).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'history from live feeds';

  const banner = $('banner');
  const msgs = [];
  if (demoAssets.length) msgs.push(`<strong>Synthetic demo data</strong> is shown for ${demoAssets.map((k) => ASSETS[k].name).join(', ')} because no price history could be loaded. Run <code>scripts/fetch_data.py</code> (or the GitHub Action) to create <code>data/market.json</code>, and serve the site over http(s), not by opening the file directly.`);
  if (DATA.updated && (Date.now() - Date.parse(DATA.updated)) > 3 * 864e5) msgs.push(`Price history was last refreshed on ${fmtDate(DATA.updated.slice(0, 10))}. Check that the update workflow is running.`);
  banner.innerHTML = msgs.join('<br>');
  banner.classList.toggle('hidden', !msgs.length);
}

function renderKPIs() {
  const k = state.asset, A = ASSETS[k], p = perf(k), a = analytics(k), t = a.s.close.length - 1;
  const L = LIVE[k];
  document.documentElement.style.setProperty('--accent', A.accent);
  $('kpi-unit').textContent = A.unit;
  $('kpi-price').textContent = fmtPrice(k, p.price);
  const d1 = L && L.chg24 != null && isFinite(L.chg24) ? L.chg24 : p.d1;
  $('kpi-day').textContent = fmtPct(d1); $('kpi-day').className = 'mono ' + cls(d1);
  $('kpi-price-note').textContent = DATA.demo.has(k) ? 'DEMO: synthetic series, not a real price.'
    : L ? `Live from ${L.src} · ${new Date(L.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : `Daily close ${fmtDate(p.date)} · ${DATA.sources[k] || ''}`;
  $('kpi-perf').innerHTML = [['1W', p.w1], ['1M', p.m1], ['3M', p.m3], ['YTD', p.ytd], ['1Y', p.y1], ['52w pos', (p.price - p.lo52) / (p.hi52 - p.lo52 || 1)]]
    .map(([l, v]) => `<div><span>${l}</span><span class="${l === '52w pos' ? '' : cls(v)}">${l === '52w pos' ? Math.round(v * 100) + '%' : fmtPct(v, 1)}</span></div>`).join('');
  $('kpi-range').textContent = `52-week range ${fmtPrice(k, p.lo52)} to ${fmtPrice(k, p.hi52)}`;

  const sg = signal(k), f = forecast(k);
  if (sg && f) {
    const m = signalMeta(sg.score);
    $('kpi-score').textContent = sg.score.toFixed(0);
    $('kpi-signal').textContent = m.label; $('kpi-signal').className = 'tag ' + m.cls;
    $('kpi-score-bar').style.width = sg.score + '%'; $('kpi-score-bar').style.background = m.color;
    $('kpi-h-label').textContent = HORIZONS[state.horizon].label;
    $('kpi-target').textContent = fmtPrice(k, f.median);
    $('kpi-target-chg').textContent = '(' + fmtPct(f.median / f.price - 1, 1) + ')';
    $('kpi-target-chg').className = 'mono ' + cls(f.median / f.price - 1);
  }
  const vol = (a.ewma[t] || a.vol20[t]) * Math.sqrt(a.ppy);
  $('kpi-vol').textContent = (vol * 100).toFixed(1) + '%';
  const dd = p.price / p.hi52 - 1;
  $('kpi-dd').textContent = fmtPct(dd, 1); $('kpi-dd').className = 'mono ' + (dd < -0.001 ? 'down' : 'flat');
  const r = corrPair(k, 'dxy', 90);
  $('kpi-dxy').textContent = 'r DXY ' + (r == null ? '—' : (r >= 0 ? '+' : '−') + Math.abs(r).toFixed(2));
  $('kpi-driver').textContent = A.driver;
}

function renderModelPanel() {
  const k = state.asset, f = forecast(k), bt = backtest(k);
  setSeg('horizon-seg', 'h', state.horizon); setSeg('model-seg', 'model', state.model);
  $('model-desc').textContent = MODELS[state.model];
  if (f) {
    $('m-target').textContent = fmtPrice(k, f.median) + ' ';
    $('m-target').insertAdjacentHTML('beforeend', `<span class="small ${cls(f.median / f.price - 1)}">${fmtPct(f.median / f.price - 1, 1)}</span>`);
    $('m-prob').textContent = 'P(up) ' + Math.round(f.probUp * 100) + '%';
    $('m-prob').className = 'tag ' + (f.probUp > 0.55 ? 'bull' : f.probUp < 0.45 ? 'bear' : 'neutral');
    $('m-p10').textContent = `${fmtPrice(k, f.p10)}  (${fmtPct(f.p10 / f.price - 1, 1)})`;
    $('m-iqr').textContent = `${fmtPrice(k, f.p25)} – ${fmtPrice(k, f.p75)}`;
    $('m-p90').textContent = `${fmtPrice(k, f.p90)}  (${fmtPct(f.p90 / f.price - 1, 1)})`;
  }
  const tb = $('bt-table');
  if (bt) {
    $('bt-n').textContent = `${bt.n} forecasts · ${fmtShort(bt.from)} to ${fmtShort(bt.to)}`;
    const rows = [
      ['Direction right', bt.hit == null ? 'n/a (no direction)' : Math.round(bt.hit * 100) + '%', 'coin flip 50%'],
      ['Avg error (log return)', (bt.maeM * 100).toFixed(2) + '%', 'no-change ' + (bt.maeR * 100).toFixed(2) + '%'],
      ['Skill vs no-change', state.model === 'rw' ? 'baseline' : fmtPct(bt.skill, 1), ''],
      ['80% range held', Math.round(bt.cov * 100) + '%', 'target 80%'],
    ];
    tb.innerHTML = '<tr><th>Metric</th><th class="r">Model</th><th class="r">Benchmark</th></tr>' +
      rows.map((r) => `<tr><td>${r[0]}</td><td class="mono r">${r[1]}</td><td class="r small">${r[2]}</td></tr>`).join('');
    let v;
    if (state.model === 'rw') v = 'This is the baseline every other model is judged against.';
    else if (bt.skill > 0.02 && (bt.hit == null || bt.hit > 0.52)) v = `Over the test period this model beat "no change" by ${fmtPct(bt.skill, 1)} on average error. That is a modest edge; past skill can vanish.`;
    else if (bt.skill > -0.02) v = 'This model performed about the same as "no change". Treat the median as roughly today\'s price; the range is the useful part.';
    else v = 'This model did worse than "no change" here. Prefer the Random walk view, or use the range only.';
    $('bt-verdict').textContent = v;
  } else { tb.innerHTML = '<tr><td>Not enough history for a backtest.</td></tr>'; $('bt-verdict').textContent = ''; $('bt-n').textContent = ''; }
}

function renderWeights() {
  const el = $('weights'); el.innerHTML = '';
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    const row = document.createElement('label'); row.className = 'slider';
    row.innerHTML = `<span>${WEIGHT_LABELS[key]}</span><output>${state.weights[key]}</output><input type="range" min="0" max="100" step="5" value="${state.weights[key]}">`;
    const inp = row.querySelector('input'), out = row.querySelector('output');
    inp.oninput = () => { state.weights[key] = +inp.value; out.textContent = inp.value; savePrefs(); renderKPIs(); renderWatchlist(); renderTech(); };
    el.appendChild(row);
  }
}

function renderTech() {
  const k = state.asset, a = analytics(k), t = a.s.close.length - 1, p = a.s.close[t];
  const sg = signal(k);
  const rsi = a.rsi[t], h = a.macd.hist[t], pb = a.pctB[t];
  const lbl = (txt, c) => `<span class="${c}">${txt}</span>`;
  const rows = [
    ['RSI (14)', rsi.toFixed(1), rsi >= 70 ? lbl('overbought', 'down') : rsi <= 30 ? lbl('oversold', 'up') : lbl(rsi >= 50 ? 'firm' : 'soft', 'flat')],
    ['MACD histogram', (h / p * 100).toFixed(2) + '%', h > 0 ? lbl('bullish', 'up') : lbl('bearish', 'down')],
    ['Price vs SMA 50', fmtPct(p / a.sma50[t] - 1, 1), p > a.sma50[t] ? lbl('above', 'up') : lbl('below', 'down')],
    ['Price vs SMA 200', a.sma200[t] ? fmtPct(p / a.sma200[t] - 1, 1) : '—', a.sma200[t] ? (p > a.sma200[t] ? lbl('above', 'up') : lbl('below', 'down')) : ''],
    ['SMA 50 / 200', a.sma200[t] ? (a.sma50[t] > a.sma200[t] ? 'golden cross' : 'death cross') : '—', a.sma200[t] ? (a.sma50[t] > a.sma200[t] ? lbl('uptrend', 'up') : lbl('downtrend', 'down')) : ''],
    ['Bollinger %B', pb == null ? '—' : pb.toFixed(2), pb > 1 ? lbl('above band', 'down') : pb < 0 ? lbl('below band', 'up') : lbl('inside', 'flat')],
    ['Realized vol 20d', (a.vol20[t] * Math.sqrt(a.ppy) * 100).toFixed(1) + '%', 'annualized'],
  ];
  if (sg) for (const [ck, v] of Object.entries(sg.comp)) rows.push([`Score: ${WEIGHT_LABELS[ck].split(' (')[0].toLowerCase()}`, (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2), lbl(v > 0.15 ? 'supports up' : v < -0.15 ? 'supports down' : 'neutral', cls(Math.abs(v) > 0.15 ? v : 0))]);
  $('tech-table').innerHTML = rows.map((r) => `<tr><td>${r[0]}</td><td class="mono r">${r[1]}</td><td class="r small">${r[2]}</td></tr>`).join('');
  $('tech-sub').textContent = `${ASSETS[k].name} · ${ASSETS[k].category} · as of ${fmtDate(a.s.dates[t])}`;
}

function renderWatchlist() {
  const tb = $('watchlist').querySelector('tbody'); tb.innerHTML = '';
  for (const k of KEYS) {
    const p = perf(k), sg = signal(k), L = LIVE[k];
    const d1 = L && L.chg24 != null && isFinite(L.chg24) ? L.chg24 : p.d1;
    const tr = document.createElement('tr'); if (k === state.asset) tr.className = 'sel';
    const m = sg ? signalMeta(sg.score) : null;
    tr.innerHTML = `<td><span class="w-name"><span class="sw" style="background:${ASSETS[k].accent}"></span>${ASSETS[k].name}${DATA.demo.has(k) ? ' <span class="tag">demo</span>' : ''}</span></td>
      <td class="mono r">${fmtPrice(k, p.price)}</td><td class="mono r ${cls(d1)}">${fmtPct(d1, 1)}</td><td class="mono r ${cls(p.m1)}">${fmtPct(p.m1, 1)}</td>
      <td class="mono r"><span class="tag ${m ? m.cls : ''}">${sg ? sg.score.toFixed(0) : '—'}</span></td>`;
    tr.onclick = () => selectAsset(k);
    tb.appendChild(tr);
  }
}

function renderCorrelationStrip() {
  const k = state.asset; $('corr-sel').textContent = ASSETS[k].ticker;
  const others = [...KEYS.filter((x) => x !== k), ...Object.keys(MACRO)];
  $('corr-strip').innerHTML = others.map((o) => {
    const r = corrPair(k, o, 90);
    const name = ASSETS[o] ? ASSETS[o].ticker : MACRO[o].name;
    const w = r == null ? 0 : Math.abs(r) * 50;
    const bar = r == null ? '' : `<i style="${r >= 0 ? 'left:50%' : 'right:50%'};width:${w}%;background:${r >= 0 ? '#0891b2' : '#e11d48'}"></i>`;
    return `<div class="corr-cell"><div class="row-between"><span>${name}</span><span class="rv" style="color:${r == null ? '#64748b' : r >= 0 ? '#67e8f9' : '#fda4af'}">${r == null ? '—' : (r >= 0 ? '+' : '−') + Math.abs(r).toFixed(2)}</span></div><div class="rbar">${bar}</div><span class="rd">${corrReading(r)}</span></div>`;
  }).join('');
}

function renderMatrix() {
  const keys = [...KEYS, ...Object.keys(MACRO)].filter((k) => (ASSETS[k] ? DATA.assets[k] : DATA.macro[k]));
  const nm = (k) => (ASSETS[k] ? ASSETS[k].ticker : MACRO[k].name);
  setSeg('corr-seg', 'win', String(state.corrWin));
  $('corr-window-label').textContent = state.corrWin;
  let h = '<table><tr><th></th>' + keys.map((k) => `<th>${nm(k)}</th>`).join('') + '</tr>';
  for (const a of keys) {
    h += `<tr><th class="rowh">${nm(a)}</th>`;
    for (const b of keys) {
      if (a === b) { h += '<td class="self">1.00</td>'; continue; }
      const r = corrPair(a, b, state.corrWin);
      h += `<td style="background:${corrColor(r)}" title="${nm(a)} vs ${nm(b)}: ${corrReading(r)}">${r == null ? '—' : r.toFixed(2)}</td>`;
    }
    h += '</tr>';
  }
  h += '</table><div class="matrix-legend"><span>−1 opposite</span><i></i><span>+1 together</span></div>';
  $('corr-matrix').innerHTML = h;
}

function setSeg(id, attr, val) { $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset[attr] === val)); }

/* charts */
Chart.defaults.color = '#94a3b8';
Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
Chart.defaults.font.size = 11;
const GRID = { color: 'rgba(148,163,184,0.08)' };
const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };

function rangeStart(s) {
  if (!state.range) return 0;
  const from = addDays(s.dates[s.dates.length - 1], -state.range);
  const i = s.dates.findIndex((d) => d >= from);
  return Math.max(0, i);
}

function renderMainChart(quiet) {
  const k = state.asset, A = ASSETS[k], a = analytics(k), f = forecast(k), s = a.s;
  setSeg('range-seg', 'range', String(state.range));
  $('btn-ma').classList.toggle('on', state.showMA); $('btn-ma').setAttribute('aria-pressed', state.showMA);
  $('main-dot').style.background = A.accent;
  $('main-title').textContent = `${A.name} · price & ${HORIZONS[state.horizon].long} forecast`;
  const i0 = rangeStart(s), n = s.close.length;
  const hist = s.dates.slice(i0);
  const fd = f ? f.path.dates : [];
  const labels = [...hist, ...fd];
  const pad = (arr) => [...arr, ...new Array(fd.length).fill(null)];
  const fut = (arr) => [...new Array(hist.length - 1).fill(null), s.close[n - 1], ...arr];
  const ds = [
    { label: A.name, data: pad(s.close.slice(i0)), borderColor: A.accent, backgroundColor: hexA(A.accent, 0.08), fill: 'origin', borderWidth: 1.8, pointRadius: 0, tension: 0.15, order: 1 },
    { label: 'SMA 50', data: pad(a.sma50.slice(i0)), borderColor: '#38bdf8', borderWidth: 1.1, pointRadius: 0, hidden: !state.showMA, borderDash: [], order: 2 },
    { label: 'SMA 200', data: pad(a.sma200.slice(i0)), borderColor: '#c084fc', borderWidth: 1.1, pointRadius: 0, hidden: !state.showMA, order: 2 },
  ];
  if (f) {
    ds.push(
      { label: 'P90', data: fut(f.path.p90), borderColor: 'transparent', pointRadius: 0, fill: false, order: 5 },
      { label: '80% range', data: fut(f.path.p10), borderColor: 'transparent', backgroundColor: hexA(A.accent, 0.12), pointRadius: 0, fill: '-1', order: 5 },
      { label: 'P75', data: fut(f.path.p75), borderColor: 'transparent', pointRadius: 0, fill: false, order: 4 },
      { label: '50% range', data: fut(f.path.p25), borderColor: 'transparent', backgroundColor: hexA(A.accent, 0.22), pointRadius: 0, fill: '-1', order: 4 },
      { label: 'Model median', data: fut(f.path.med), borderColor: '#f8fafc', borderDash: [5, 4], borderWidth: 1.6, pointRadius: 0, order: 0 },
    );
  }
  const cfg = {
    type: 'line',
    data: { labels, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, spanGaps: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 10, boxHeight: 2, filter: (it) => !['P90', 'P75'].includes(it.text) } },
        tooltip: {
          backgroundColor: '#0b111c', borderColor: '#1e293b', borderWidth: 1, titleFont: { family: 'JetBrains Mono' }, bodyFont: { family: 'JetBrains Mono' },
          filter: (it) => it.raw != null && !(it.dataIndex === hist.length - 1 && it.datasetIndex > 2),
          callbacks: { title: (it) => fmtDate(it[0].label) + (it[0].dataIndex >= hist.length ? ' (forecast)' : ''), label: (c) => ` ${c.dataset.label}: ${fmtPrice(k, c.raw)}` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, callback: function (v) { return fmtShort(this.getLabelForValue(v)); } } },
        y: { position: 'right', grid: GRID, ticks: { callback: (v) => fmtPrice(k, v).replace(/\.0+$/, '') } },
      },
    },
  };
  if (mainChart) { mainChart.data = cfg.data; mainChart.options = cfg.options; mainChart.update(quiet ? 'none' : undefined); }
  else mainChart = new Chart($('mainChart'), cfg);

  const sum = $('forecast-summary');
  if (f) {
    sum.innerHTML = [
      ['Horizon ends', fmtDate(f.endDate)],
      ['Median', `<span class="${cls(f.median / f.price - 1)}">${fmtPrice(k, f.median)}</span>`],
      ['80% range', `${fmtPrice(k, f.p10)} – ${fmtPrice(k, f.p90)}`],
      ['Chance above today', Math.round(f.probUp * 100) + '%'],
    ].map(([l, v]) => `<div><span>${l}</span><span>${v}</span></div>`).join('');
  } else sum.innerHTML = '<div><span>Forecast</span><span>Not enough history</span></div>';
}

function alignTo(dates, s) {
  // carry-forward values of s on the given dates
  const out = []; let j = 0, last = null;
  for (const d of dates) { while (j < s.dates.length && s.dates[j] <= d) { last = s.close[j]; j++; } out.push(last); }
  return out;
}

function renderSubChart(quiet) {
  const k = state.asset, A = ASSETS[k], a = analytics(k), s = a.s;
  setSeg('sub-seg', 'sub', state.sub);
  const i0 = rangeStart(s);
  const labels = s.dates.slice(i0);
  let cfg;
  const baseX = { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, callback: function (v) { return fmtShort(this.getLabelForValue(v)); } } };
  const tip = { backgroundColor: '#0b111c', borderColor: '#1e293b', borderWidth: 1, bodyFont: { family: 'JetBrains Mono' }, callbacks: { title: (it) => fmtDate(it[0].label) } };
  const notes = [...A.notes];

  if (state.sub === 'rsi') {
    $('sub-title').textContent = 'RSI (14)';
    $('sub-subtitle').textContent = 'Above 70 often means stretched (overbought), below 30 washed-out (oversold).';
    const line = (v) => labels.map(() => v);
    cfg = { type: 'line', data: { labels, datasets: [
      { label: 'RSI', data: a.rsi.slice(i0), borderColor: A.accent, borderWidth: 1.5, pointRadius: 0 },
      { label: '70', data: line(70), borderColor: 'rgba(244,63,94,.5)', borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
      { label: '30', data: line(30), borderColor: 'rgba(16,185,129,.5)', borderDash: [4, 4], borderWidth: 1, pointRadius: 0 },
    ] }, options: { scales: { x: baseX, y: { min: 0, max: 100, position: 'right', grid: GRID, ticks: { stepSize: 10 } } }, plugins: { legend: { display: false }, tooltip: { ...tip, filter: (it) => it.datasetIndex === 0 } } } };
  } else if (state.sub === 'macd') {
    $('sub-title').textContent = 'MACD (12, 26, 9)';
    $('sub-subtitle').textContent = 'Histogram above zero = upward momentum building; below zero = fading.';
    const hist = a.macd.hist.slice(i0);
    cfg = { type: 'bar', data: { labels, datasets: [
      { type: 'bar', label: 'Histogram', data: hist, backgroundColor: hist.map((v) => (v >= 0 ? 'rgba(16,185,129,.55)' : 'rgba(244,63,94,.55)')), barPercentage: 1, categoryPercentage: 1 },
      { type: 'line', label: 'MACD', data: a.macd.macd.slice(i0), borderColor: '#38bdf8', borderWidth: 1.3, pointRadius: 0 },
      { type: 'line', label: 'Signal', data: a.macd.signal.slice(i0), borderColor: '#f59e0b', borderWidth: 1.3, pointRadius: 0 },
    ] }, options: { scales: { x: baseX, y: { position: 'right', grid: GRID } }, plugins: { legend: { labels: { boxWidth: 10, boxHeight: 2 } }, tooltip: { ...tip, callbacks: { ...tip.callbacks, label: (c) => ` ${c.dataset.label}: ${fmtPrice(k, c.raw)}` } } } } };
  } else if (state.sub === 'drivers') {
    $('sub-title').textContent = 'Macro drivers';
    $('sub-subtitle').textContent = `${A.name} vs the dollar and stocks, rebased to 100 at the start of the range; US 10Y yield on the right axis.`;
    const reb = (arr) => { const b = arr.find((v) => v != null); return arr.map((v) => (v == null || !b ? null : (v / b) * 100)); };
    const ds = [{ label: A.name, data: reb(s.close.slice(i0)), borderColor: A.accent, borderWidth: 1.8, pointRadius: 0, yAxisID: 'y' }];
    for (const m of ['dxy', 'spx']) if (DATA.macro[m]) ds.push({ label: MACRO[m].name, data: reb(alignTo(labels, DATA.macro[m])), borderColor: MACRO[m].accent, borderWidth: 1.2, pointRadius: 0, yAxisID: 'y' });
    if (DATA.macro.us10y) ds.push({ label: 'US10Y %', data: alignTo(labels, DATA.macro.us10y), borderColor: MACRO.us10y.accent, borderDash: [3, 3], borderWidth: 1.1, pointRadius: 0, yAxisID: 'y2' });
    cfg = { type: 'line', data: { labels, datasets: ds }, options: { scales: { x: baseX, y: { position: 'left', grid: GRID }, y2: { position: 'right', grid: { display: false }, ticks: { callback: (v) => v.toFixed(1) + '%' } } }, plugins: { legend: { labels: { boxWidth: 10, boxHeight: 2 } }, tooltip: { ...tip, callbacks: { ...tip.callbacks, label: (c) => ` ${c.dataset.label}: ${c.raw == null ? '—' : c.raw.toFixed(2)}` } } } } };
    const bD = beta(k, 'dxy'), bS = beta(k, 'spx');
    if (bD != null) notes.push(`<strong>Dollar sensitivity:</strong> over the last year a 1% DXY rise came with a ${fmtPct(bD / 100, 2)} move in ${A.name} on average (beta ${bD.toFixed(2)}).`);
    if (bS != null) notes.push(`<strong>Equity beta:</strong> ${bS.toFixed(2)} vs the S&amp;P 500; correlation ${corrPair(k, 'spx', 250)?.toFixed(2) ?? '—'} over 1 year.`);
  } else {
    const peer = ASSETS[k].crypto ? (k === 'btc' ? 'bnb' : 'btc') : (k === 'gold' ? 'silver' : 'gold');
    $('sub-title').textContent = 'Rolling 60-day correlation';
    $('sub-subtitle').textContent = `How tightly ${A.name}'s daily returns have tracked the dollar, stocks and ${ASSETS[peer].name} over time.`;
    const from = labels[0];
    const ds = [];
    for (const [o, col] of [['dxy', MACRO.dxy.accent], ['spx', MACRO.spx.accent], [peer, ASSETS[peer].accent]]) {
      const rc = rollingCorr(k, o, 60, from);
      const map = new Map(rc.dates.map((d, i) => [d, rc.r[i]]));
      ds.push({ label: ASSETS[o] ? ASSETS[o].name : MACRO[o].name, data: labels.map((d) => (map.has(d) ? map.get(d) : null)), borderColor: col, borderWidth: 1.3, pointRadius: 0, spanGaps: true });
    }
    cfg = { type: 'line', data: { labels, datasets: ds }, options: { scales: { x: baseX, y: { min: -1, max: 1, position: 'right', grid: GRID } }, plugins: { legend: { labels: { boxWidth: 10, boxHeight: 2 } }, tooltip: { ...tip, callbacks: { ...tip.callbacks, label: (c) => ` ${c.dataset.label}: ${c.raw == null ? '—' : c.raw.toFixed(2)}` } } } } };
  }
  cfg.options.responsive = true; cfg.options.maintainAspectRatio = false; cfg.options.animation = false;
  cfg.options.interaction = { mode: 'index', intersect: false };
  $('driver-notes').innerHTML = notes.map((n) => `<li>${n}</li>`).join('');
  if (subChart && subChart.config.type === cfg.type) { subChart.data = cfg.data; subChart.options = cfg.options; subChart.update(quiet ? 'none' : undefined); }
  else { if (subChart) subChart.destroy(); subChart = new Chart($('subChart'), cfg); }
}

function renderAll(quiet) {
  if (!DATA.assets[state.asset]) return;
  renderStatus(); renderTicker(); renderKPIs(); renderModelPanel(); renderTech(); renderWatchlist(); renderCorrelationStrip();
  renderMainChart(quiet); renderSubChart(quiet);
  if (!quiet) renderMatrix();
  $('footer-note').textContent = 'Educational tool. Not financial advice.';
}

/* ------------------------------------------------------------------ interactions */
function selectAsset(k) { state.asset = k; savePrefs(); renderTabs(); renderAll(); }
function bindControls() {
  $('range-seg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.range = +b.dataset.range; savePrefs(); renderMainChart(); renderSubChart(); };
  $('btn-ma').onclick = () => { state.showMA = !state.showMA; savePrefs(); renderMainChart(); };
  $('sub-seg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.sub = b.dataset.sub; savePrefs(); renderSubChart(); };
  $('corr-seg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.corrWin = +b.dataset.win; savePrefs(); renderMatrix(); };
  $('horizon-seg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.horizon = b.dataset.h; savePrefs(); renderAll(); };
  $('model-seg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; state.model = b.dataset.model; savePrefs(); renderAll(); };
  $('btn-reset').onclick = () => { state.weights = { ...DEFAULT_WEIGHTS }; state.model = 'ensemble'; state.horizon = 'm'; savePrefs(); renderWeights(); renderAll(); };
}

async function init() {
  renderTabs(); bindControls(); renderWeights();
  await loadHistory();
  renderAll();
  pollCrypto(); pollMetals();
  setInterval(pollCrypto, 20000);
  setInterval(pollMetals, 60000);
  setInterval(renderStatus, 30000);
  // reload history every 6 hours for long-open tabs
  setInterval(async () => { await loadHistory(); cache.clear(); renderAll(true); }, 6 * 3600e3);
}
init();
