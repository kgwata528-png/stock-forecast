// 銘柄名検索の Netlify Function
// GET /.netlify/functions/search?q=オルカン
//   投資信託: 投資信託協会のファンド検索(名称・愛称)
//   英字のとき: Yahoo Finance の検索(米国株・指数など)も併用
// 日本株は stocks-jp.json を画面側で検索するので、ここでは扱わない
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

// 協会の検索はスペース区切りで AND 検索になる。1ページ20件
async function fundSearch(q, startNo) {
  const body = 's_keyword=' + encodeURIComponent(q) + '&s_kensakuKbn=1&startNo=' + (startNo || 0) + '&draw=1';
  const res = await fetch('https://toushin-lib.fwg.ne.jp/FdsWeb/FDST999900/fundDataSearch', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
    body,
  });
  if (!res.ok) throw new Error('投資信託協会 HTTP ' + res.status);
  const j = await res.json();
  const r = (j && j.searchResultInfo) || {};
  return { list: r.resultInfoMapList || [], total: +r.recordsTotal || 0 };
}

// 「・」や空白・括弧の有無、全角半角、大文字小文字を無視して比べるための正規化
const PUNCT = /[\s・･\-‐－()（）\[\]【】「」/、。,.]/g;
const loose = (s) => (s || '').normalize('NFKC').toLowerCase().replace(PUNCT, '');
const toKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

// 協会の検索は完全な部分一致なので、「グローバルロボティクス」(正式名は「グローバル・ロボティクス」)のように
// 「・」を省いたり、ひらがなで入れたりすると0件になる。そのときは
// 入力をカタカナにして記号を除き、4文字ずつの断片で検索 → ヒットした断片どうしを AND で検索し直す
async function looseFundSearch(q) {
  const base = toKata(q.normalize('NFKC')).replace(PUNCT, '');
  const key = base.toLowerCase();
  if (base.length < 3) return [];
  const pos = new Set();
  const n = Math.max(0, base.length - 4);
  for (let k = 0; k <= 7; k++) pos.add(Math.round((n * k) / 7)); // 先頭から末尾まで最大8か所
  const pieces = [...pos].map((p) => base.slice(p, p + 4));
  const hits = (await Promise.all(pieces.map((w) => fundSearch(w).then((r) => ({ w, total: r.total }), () => ({ w, total: 0 })))))
    .filter((x) => x.total > 0);
  if (!hits.length) return [];
  const isMatch = (f) => loose(f.fundNm).includes(key) || loose(f.fundStNm).includes(key);
  // 先頭側の断片から1つずつ AND に加え、0件になる断片(別のファンドにだけ当たるもの)は外す
  let and = null;
  const used = [];
  for (const x of hits) {
    if (used.includes(x.w)) continue;
    const r = used.length ? await fundSearch(used.concat(x.w).join(' ')) : await fundSearch(x.w);
    if (r.total > 0) { used.push(x.w); and = r; }
    if (r.total > 0 && r.total <= 20 && r.list.some(isMatch)) break;
  }
  if (and && and.list.some(isMatch)) return and.list.filter(isMatch);
  if (and && and.total <= 20) return and.list;
  // 断片が別々のファンドにしか当たらないときは、いちばん絞れた断片の結果(最大3ページ)から名前で探す
  const best = hits.sort((a, b) => a.total - b.total)[0].w;
  const pages = await Promise.all([0, 20, 40].map((s) => fundSearch(best, s).then((r) => r.list, () => [])));
  return [].concat(...pages).filter(isMatch);
}

async function searchFunds(q) {
  let list = (await fundSearch(q)).list;
  if (!list.length) list = await looseFundSearch(q);
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
