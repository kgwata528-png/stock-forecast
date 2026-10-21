// 全上場銘柄について「1年前時点の予測から見て、今の株価が何σの位置か」を計算し screen.json に書き出す
// GitHub Actions(.github/workflows/screen.yml)で毎日実行する。手元では: node tools/screen.mjs
// 計算は画面の「予測の検証」と同じ考え方: 1年前より前の期間で μ・σ を推定し、1年前の株価から予測した1年後の分布と今の株価を比べる
// あわせて直近 1/2/3/5/10 年の μ・σ を sharpe.json に、アナリストの目標株価を target.json に書き出す(画面のランキングで使う)
import { readFileSync, writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const F = 252;            // 年率換算に使う1年の件数(画面側と同じ)
const MIN_EST = 120;      // 推定に最低限必要なリターン数
const CONCURRENCY = 6;
const STALE_DAYS = 10;    // 最終取引日がこれより古い銘柄(売買停止など)は除外
const MARKETS = new Set(['プライム', 'スタンダード', 'グロース']);
const DAY = 86400000;
const PERIODS = [1, 2, 3, 5, 10];  // シャープレシオ用に μ・σ を出す期間(年)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchChart(sym) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=10y&interval=1d&events=split';
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (res.ok) return (((await res.json()).chart || {}).result || [])[0];
    if (res.status === 404) return null;
    if (res.status !== 429 && res.status < 500) throw new Error('HTTP ' + res.status);
    await sleep(2000 * 2 ** attempt);
  }
  throw new Error('retry over');
}

// netlify/functions/prices.js と同じ分割調整
function adjustSplits(ts, closes, splits) {
  Object.values(splits || {}).forEach((s) => {
    const ratio = s.numerator / s.denominator;
    if (!(ratio > 0) || ratio === 1) return;
    const k = ts.findIndex((t) => t >= s.date);
    if (k < 0) return;
    // 分割の日付と実際に値が飛ぶ日は1日ほどずれることがあるので、前後数日から比率に最も近い飛びを探す
    let best = -1, bestJump = 1;
    for (let j = Math.max(1, k - 3); j <= Math.min(closes.length - 1, k + 2); j++) {
      let a = j - 1;
      while (a >= 0 && !(closes[a] > 0)) a--;
      if (a < 0 || !(closes[j] > 0)) continue;
      const jump = closes[a] / closes[j];
      if (best < 0 || Math.abs(Math.log(jump / ratio)) < Math.abs(Math.log(bestJump / ratio))) { best = j; bestJump = jump; }
    }
    if (best > 0 && Math.abs(Math.log(bestJump / ratio)) < Math.abs(Math.log(bestJump))) {
      for (let i = 0; i < best; i++) if (closes[i] > 0) closes[i] /= ratio;
    }
  });
}

// アナリストの目標株価(netlify/functions/target.js と同じ取得方法)。quoteSummary は Cookie と crumb が必要
let auth = null;
async function getAuth() {
  if (auth) return auth;
  const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const cookie = r1.headers.getSetCookie().map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = (await r2.text()).trim();
  if (!cookie || !r2.ok || !crumb || crumb.length > 40) throw new Error('crumb を取得できません');
  return (auth = { cookie, crumb });
}
async function fetchTarget(sym) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const a = await getAuth();
    const url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(sym) + '?modules=financialData&crumb=' + encodeURIComponent(a.crumb);
    const res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: a.cookie, Accept: 'application/json' } });
    if (res.ok) {
      const f = ((((await res.json()).quoteSummary || {}).result || [])[0] || {}).financialData || {};
      const v = (k) => (f[k] && typeof f[k].raw === 'number' ? f[k].raw : null);
      return v('targetMeanPrice') > 0 ? { mean: v('targetMeanPrice'), low: v('targetLowPrice'), high: v('targetHighPrice'), n: v('numberOfAnalystOpinions') } : null;
    }
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) auth = null;  // crumb の期限切れ
    else if (res.status !== 429 && res.status < 500) throw new Error('HTTP ' + res.status);
    await sleep(2000 * 2 ** attempt);
  }
  throw new Error('retry over');
}

function estimate(p) {
  const r = [];
  for (let i = 1; i < p.length; i++) r.push(Math.log(p[i] / p[i - 1]));
  const n = r.length, mean = r.reduce((a, b) => a + b, 0) / n;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sigma = Math.sqrt(v * F);
  return { sigma, mu: mean * F + sigma * sigma / 2 };
}

function analyze(r) {
  if (!r || !r.timestamp) return null;
  const closes = r.indicators.quote[0].close.slice(), off = (r.meta && r.meta.gmtoffset) || 0;
  adjustSplits(r.timestamp, closes, r.events && r.events.splits);
  const P = [], D = [];
  r.timestamp.forEach((ts, i) => {
    const c = closes[i];
    if (c == null || !(c > 0)) return;
    const d = new Date((ts + off) * 1000).toISOString().slice(0, 10);
    if (D.length && D[D.length - 1] === d) { P.pop(); D.pop(); }
    P.push(c); D.push(d);
  });
  // 30日以上取引が無い区間(上場廃止→再上場、長期の売買停止)があれば、それより前は別物として捨てる
  for (let i = P.length - 1; i > 0; i--) {
    if (Date.parse(D[i]) - Date.parse(D[i - 1]) > 30 * DAY) { P.splice(0, i); D.splice(0, i); break; }
  }
  const n = P.length;
  if (n < 2 || Date.now() - Date.parse(D[n - 1]) > STALE_DAYS * DAY) return null;
  // 最終日のちょうど1年前(以前で最も近い営業日)を予測時点にする
  const target = new Date(Date.parse(D[n - 1]) - 365 * DAY).toISOString().slice(0, 10);
  let T0 = -1;
  for (let i = n - 1; i >= 0; i--) if (D[i] <= target) { T0 = i; break; }
  const rd = (x, k) => +x.toFixed(k);
  const px = (x) => rd(x, x >= 100 ? 0 : 2);
  // 直近 y 年の μ・σ(上場が新しく期間に足りない銘柄は null)
  const sr = PERIODS.map((y) => {
    const from = new Date(D[n - 1]);
    from.setUTCFullYear(from.getUTCFullYear() - y);
    const fd = from.toISOString().slice(0, 10);
    if (Date.parse(D[0]) - Date.parse(fd) > 7 * DAY) return null;
    let s = 0;
    for (let i = n - 1; i >= 0; i--) if (D[i] <= fd) { s = i; break; }
    if (n - 1 - s < 200 * y) return null;
    const e = estimate(P.slice(s));
    return e.sigma > 0 ? [rd(e.mu, 4), rd(e.sigma, 4)] : null;
  });
  // 直近の株式分割日(目標株価に分割前の値が混ざることがあるので target.json に残す)
  const sp = Math.max(0, ...Object.values((r.events && r.events.splits) || {}).map((s) => s.date));
  const sharpe = { price: px(P[n - 1]), sr, split: sp ? new Date((sp + off) * 1000).toISOString().slice(0, 10) : null };
  if (T0 < MIN_EST) return { sharpe };
  // 推定は予測時点からさらに1年前まで(10年分取得しても、以前の range=2y と同じ長さにそろえる)
  const fromEst = new Date(Date.parse(D[T0]) - 365 * DAY).toISOString().slice(0, 10);
  let E0 = 0;
  while (E0 < T0 && D[E0] < fromEst) E0++;
  if (T0 - E0 < MIN_EST) return { sharpe };
  const est = estimate(P.slice(E0, T0 + 1));
  if (!(est.sigma > 0)) return { sharpe };
  const lr = Math.log(P[n - 1] / P[T0]), sd = est.sigma;  // t = 1年
  const z = (lr - (est.mu - sd * sd / 2)) / sd;           // 当時の推定 μ を使った位置
  const z0 = (lr + sd * sd / 2) / sd;                     // μ = 0 とした位置
  return { sharpe, screen: { price: px(P[n - 1]), base: px(P[T0]), date: D[n - 1], baseDate: D[T0], ret: rd(Math.exp(lr) - 1, 4), mu: rd(est.mu, 4), sig: rd(est.sigma, 4), z: rd(z, 2), z0: rd(z0, 2) } };
}

const list = JSON.parse(readFileSync('stocks-jp.json', 'utf8')).items.filter((x) => MARKETS.has(x[2]));
const out = [], srOut = [], tgOut = [];
let failed = 0, tgFailed = 0, next = 0, done = 0;
async function worker() {
  while (next < list.length) {
    const [code, name, market] = list[next++];
    try {
      const a = analyze(await fetchChart(code + '.T'));
      if (a && a.screen) out.push(Object.assign({ code, name, market }, a.screen));
      if (a && a.sharpe.sr.some(Boolean)) srOut.push([code, name, market, a.sharpe.price].concat(a.sharpe.sr));
      if (a) {
        try {
          const t = await fetchTarget(code + '.T');
          const px = (x) => (x > 0 ? +x.toFixed(x >= 100 ? 0 : 2) : null);
          if (t) tgOut.push([code, name, market, a.sharpe.price, px(t.mean), px(t.low), px(t.high), t.n, a.sharpe.split]);
        } catch (e) {
          if (++tgFailed <= 20) console.error(code, 'target', e.message);
        }
      }
    } catch (e) {
      failed++;
      if (failed <= 20) console.error(code, e.message);
    }
    if (++done % 500 === 0) console.log(done, '/', list.length);
    await sleep(50);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

if (out.length < list.length * 0.5) {
  console.error('取得できた銘柄が少なすぎるため保存しません:', out.length, '/', list.length);
  process.exit(1);
}
out.sort((a, b) => a.z - b.z);
const asof = out.reduce((m, x) => (x.date > m ? x.date : m), '');
writeFileSync('screen.json', JSON.stringify({ generated: new Date().toISOString(), asof, count: out.length, universe: list.length, failed, items: out }));
// items: [コード, 名前, 市場, 株価, 期間ごとの [μ, σ] または null(periods の順)]
writeFileSync('sharpe.json', JSON.stringify({ generated: new Date().toISOString(), asof, periods: PERIODS, items: srOut }));
// items: [コード, 名前, 市場, 株価(終値), 平均目標株価, 最低, 最高, アナリスト数, 直近10年で最後の株式分割日 または null]
if (tgOut.length >= 300) writeFileSync('target.json', JSON.stringify({ generated: new Date().toISOString(), asof, items: tgOut }));
else console.error('目標株価の取得が少なすぎるため target.json は保存しません:', tgOut.length);
console.log('targets', tgOut.length, '; failed', tgFailed);
console.log('saved', out.length, 'items; asof', asof, '; failed', failed);
