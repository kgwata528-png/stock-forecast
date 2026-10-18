// アナリストの目標株価(コンセンサス)を返す Netlify Function
// GET /.netlify/functions/target?symbol=7203.T
// 取得元: Yahoo Finance(非公式 quoteSummary API の financialData)。証券会社ごとの内訳は日本株では提供されていない
// 目標株価が無い銘柄(小型株・指数・投信など)は { none: true } を返す
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

// quoteSummary は Cookie と crumb が必要。関数が温まっている間は使い回す
let auth = null;
async function getAuth() {
  if (auth) return auth;
  const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const cookie = (r1.headers.getSetCookie ? r1.headers.getSetCookie() : [r1.headers.get('set-cookie') || ''])
    .map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  if (!cookie) throw new Error('Cookie を取得できません');
  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.length > 40) throw new Error('crumb を取得できません');
  auth = { cookie, crumb };
  return auth;
}

async function summary(sym) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const a = await getAuth();
    const url = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(sym) + '?modules=financialData&crumb=' + encodeURIComponent(a.crumb);
    const res = await fetch(url, { headers: { 'User-Agent': UA, Cookie: a.cookie, Accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) { auth = null; continue; }  // crumb の期限切れ
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
    const j = await res.json();
    return (((j.quoteSummary || {}).result || [])[0] || {}).financialData || null;
  }
  throw new Error('認証に失敗しました');
}

const json = (code, body, extra) => ({
  statusCode: code,
  headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {}),
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  const sym = ((event.queryStringParameters || {}).symbol || '').trim().toUpperCase();
  if (!/^[0-9A-Z.\-^=]{1,15}$/.test(sym)) return json(400, { error: '銘柄コードが不正です' });
  try {
    const f = await summary(sym);
    const v = (k) => (f && f[k] && typeof f[k].raw === 'number' ? f[k].raw : null);
    const mean = v('targetMeanPrice'), n = v('numberOfAnalystOpinions');
    const cache = { 'Cache-Control': 'public, max-age=3600' };
    if (!(mean > 0)) return json(200, { symbol: sym, none: true }, cache);
    return json(200, {
      symbol: sym, source: 'Yahoo Finance',
      mean, median: v('targetMedianPrice'), low: v('targetLowPrice'), high: v('targetHighPrice'),
      n, rec: (f.recommendationKey && f.recommendationKey !== 'none') ? f.recommendationKey : null, recMean: v('recommendationMean'),
      price: v('currentPrice'), currency: f.financialCurrency || '',
    }, cache);
  } catch (e) {
    return json(502, { error: '取得できませんでした (' + e.message + ')' });
  }
};
