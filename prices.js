// 1年分の日次終値を返す Netlify Function
// GET /.netlify/functions/prices?symbol=7203.T  (米国株は AAPL など)
// 取得元: Yahoo Finance(非公式チャートAPI) → 失敗時は Stooq(CSV)
const UA = 'Mozilla/5.0 (compatible; stock-forecast/1.0)';

function toStooq(sym) {
  if (/\.T$/.test(sym)) return sym.replace(/\.T$/, '').toLowerCase() + '.jp';
  if (/^[A-Z.\-]+$/.test(sym)) return sym.replace(/\./g, '-').toLowerCase() + '.us';
  return null;
}

async function fromYahoo(sym) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1y&interval=1d';
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
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
    prices.push({ date: new Date((ts + off) * 1000).toISOString().slice(0, 10), close: +c.toFixed(4) });
  });
  return { source: 'Yahoo Finance', name: (r.meta && (r.meta.longName || r.meta.shortName)) || '', currency: (r.meta && r.meta.currency) || '', prices };
}

async function fromStooq(sym) {
  const s = toStooq(sym);
  if (!s) throw new Error('Stooq: 非対応のコード');
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const end = new Date(), start = new Date(Date.now() - 366 * 86400000);
  const url = 'https://stooq.com/q/d/l/?s=' + encodeURIComponent(s) + '&i=d&d1=' + fmt(start) + '&d2=' + fmt(end);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('Stooq HTTP ' + res.status);
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  if (!/^Date,/i.test(lines[0] || '')) throw new Error('Stooq: データなし');
  const prices = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    const c = parseFloat(p[4]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(p[0]) && c > 0) prices.push({ date: p[0], close: c });
  }
  return { source: 'Stooq', name: '', currency: '', prices };
}

const json = (code, body, extra) => ({
  statusCode: code,
  headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {}),
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  const sym = ((event.queryStringParameters && event.queryStringParameters.symbol) || '').trim().toUpperCase();
  if (!/^[0-9A-Z.\-^=]{1,12}$/.test(sym)) return json(400, { error: '銘柄コードが不正です' });
  const errors = [];
  for (const fn of [fromYahoo, fromStooq]) {
    try {
      const out = await fn(sym);
      if (out.prices.length >= 3) {
        return json(200, Object.assign({ symbol: sym }, out), { 'Cache-Control': 'public, max-age=600' });
      }
      errors.push(fn.name + ': 件数不足');
    } catch (e) {
      errors.push(e.message);
    }
  }
  return json(502, { error: '取得できませんでした (' + errors.join(' / ') + ')' });
};
