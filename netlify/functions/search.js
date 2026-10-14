// 銘柄名検索の Netlify Function
// GET /.netlify/functions/search?q=オルカン
//   投資信託: 投資信託協会のファンド検索(名称・愛称)
//   英字のとき: Yahoo Finance の検索(米国株・指数など)も併用
// 日本株は stocks-jp.json を画面側で検索するので、ここでは扱わない
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

async function searchFunds(q) {
  const body = 's_keyword=' + encodeURIComponent(q) + '&s_kensakuKbn=1&startNo=0&draw=1';
  const res = await fetch('https://toushin-lib.fwg.ne.jp/FdsWeb/FDST999900/fundDataSearch', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    body,
  });
  if (!res.ok) throw new Error('投資信託協会 HTTP ' + res.status);
  const j = await res.json();
  const list = (j && j.searchResultInfo && j.searchResultInfo.resultInfoMapList) || [];
  return list.slice(0, 15).map((f) => ({
    kind: 'fund',
    fund: f.isinCd + '_' + f.associFundCd,
    name: (f.fundNm || f.fundStNm || '').normalize('NFKC'),
    label: '投信' + (f.entrustCmpNm ? '・' + f.entrustCmpNm.normalize('NFKC') : ''),
  }));
}

const TYPES = { EQUITY: '株式', ETF: 'ETF', INDEX: '指数', MUTUALFUND: '投信', FUTURE: '先物', CURRENCY: '為替', CRYPTOCURRENCY: '暗号資産' };
async function searchYahoo(q) {
  const url = 'https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(q) + '&quotesCount=10&newsCount=0';
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
  const j = await res.json();
  return ((j && j.quotes) || []).filter((x) => x.symbol && TYPES[x.quoteType]).map((x) => ({
    kind: 'yahoo',
    symbol: x.symbol,
    name: x.longname || x.shortname || x.symbol,
    label: TYPES[x.quoteType] + (x.exchDisp ? '・' + x.exchDisp : ''),
  }));
}

exports.handler = async (event) => {
  const q = ((event.queryStringParameters && event.queryStringParameters.q) || '').trim().slice(0, 50);
  if (q.length < 2) return { statusCode: 400, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ error: '2文字以上入力してください' }) };
  const jobs = [searchFunds(q)];
  if (/^[\x20-\x7E]+$/.test(q)) jobs.push(searchYahoo(q));
  const results = await Promise.allSettled(jobs);
  const items = [].concat(...results.filter((r) => r.status === 'fulfilled').map((r) => r.value));
  const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason.message);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
    body: JSON.stringify({ items, errors }),
  };
};
