// 日次終値を返す Netlify Function
// GET /.netlify/functions/prices?symbol=7203.T&from=2024-10-14&to=2026-10-14
//   symbol: Yahoo Finance のコード(株・ETF・指数 ^N225・先物 GC=F・為替 JPY=X など)
//   fund  : 投資信託は ISIN_協会コード(例 JP90C000H1T1_0331418A)。基準価額を終値として返す
//   from/to 省略時は直近1年。期間は最長約10年
// 取得元: Yahoo Finance(非公式チャートAPI) / 投資信託協会(投信総合検索ライブラリー)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const DAY = 86400000;
const MAX_SPAN = 10 * 366 * DAY + 7 * DAY;

async function fromYahoo(sym, from, to) {
  const p1 = Math.floor((Date.parse(from) - DAY) / 1000), p2 = Math.floor((Date.parse(to) + 2 * DAY) / 1000);
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?period1=' + p1 + '&period2=' + p2 + '&interval=1d';
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (res.status === 404) throw new Error('銘柄が見つかりません');
  if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) throw new Error('Yahoo: データなし');
  const closes = r.indicators.quote[0].close;
  const off = (r.meta && r.meta.gmtoffset) || 0;
  const prices = [];
  r.timestamp.forEach((ts, i) => {
    const c = closes[i];
    if (c == null || !(c > 0)) return;
    const date = new Date((ts + off) * 1000).toISOString().slice(0, 10);
    if (date < from || date > to) return;
    if (prices.length && prices[prices.length - 1].date === date) prices.pop(); // 同じ日付の重複は後勝ち
    prices.push({ date, close: +c.toFixed(4) });
  });
  const m = r.meta || {};
  return { source: 'Yahoo Finance', name: m.longName || m.shortName || '', currency: m.currency || '', type: m.instrumentType || '', prices };
}

async function fromFund(fund, from, to) {
  const [isin, assoc] = fund.split('_');
  const url = 'https://toushin-lib.fwg.ne.jp/FdsWeb/FDST030000/csv-file-download?isinCd=' + encodeURIComponent(isin) + '&associFundCd=' + encodeURIComponent(assoc);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('投資信託協会 HTTP ' + res.status);
  // ヘッダは utf-8 と名乗るが中身は Shift_JIS
  const lines = new TextDecoder('shift_jis').decode(await res.arrayBuffer()).trim().split(/\r?\n/);
  const prices = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    const m = /^(\d{4})年(\d{2})月(\d{2})日$/.exec(p[0]);
    const c = parseFloat(p[1]);
    if (!m || !(c > 0)) continue;
    const date = m[1] + '-' + m[2] + '-' + m[3];
    if (date >= from && date <= to) prices.push({ date, close: c });
  }
  if (!prices.length) throw new Error('投資信託協会: データなし');
  return { source: '投資信託協会', name: '', currency: 'JPY', type: 'FUND', prices };
}

const json = (code, body, extra) => ({
  statusCode: code,
  headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {}),
  body: JSON.stringify(body),
});
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const sym = (q.symbol || '').trim().toUpperCase();
  const fund = (q.fund || '').trim().toUpperCase();
  if (fund ? !/^JP[0-9A-Z]{10}_[0-9A-Z]{8}$/.test(fund) : !/^[0-9A-Z.\-^=]{1,15}$/.test(sym)) return json(400, { error: '銘柄コードが不正です' });

  const to = q.to || ymd(Date.now());
  const from = q.from || ymd(Date.parse(to) - 365 * DAY);
  if (!isYmd(from) || !isYmd(to) || from >= to) return json(400, { error: '期間の指定が不正です' });
  if (Date.parse(to) - Date.parse(from) > MAX_SPAN) return json(400, { error: '期間は最長10年までです' });

  try {
    const out = fund ? await fromFund(fund, from, to) : await fromYahoo(sym, from, to);
    if (out.prices.length < 3) return json(404, { error: 'この期間のデータが3件未満です' });
    return json(200, Object.assign({ symbol: fund || sym, from, to }, out), { 'Cache-Control': 'public, max-age=600' });
  } catch (e) {
    return json(502, { error: '取得できませんでした (' + e.message + ')' });
  }
};
