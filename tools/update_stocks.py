# JPX の上場銘柄一覧(data_j.xlsx)から、銘柄名検索用の stocks-jp.json を作る
# 使い方: pip install openpyxl && python tools/update_stocks.py
import io, json, unicodedata, urllib.request
import openpyxl

URL = 'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx'
MARKETS = {'プライム': 'プライム', 'スタンダード': 'スタンダード', 'グロース': 'グロース', 'ETF': 'ETF', 'REIT': 'REIT'}

req = urllib.request.Request(URL, headers={'User-Agent': 'Mozilla/5.0'})
data = urllib.request.urlopen(req).read()
ws = openpyxl.load_workbook(io.BytesIO(data), read_only=True).active
out, asof = [], ''
for i, r in enumerate(ws.iter_rows(values_only=True)):
    if i == 0 or not r[1]:
        continue
    asof = str(r[0])
    mk = next((v for k, v in MARKETS.items() if k in str(r[3])), None)
    if not mk:
        continue  # PRO Market などは除外
    name = unicodedata.normalize('NFKC', str(r[2])).strip()
    out.append([str(r[1]), name, mk])
with open('stocks-jp.json', 'w', encoding='utf-8') as f:
    json.dump({'asof': asof, 'items': out}, f, ensure_ascii=False, separators=(',', ':'))
print(len(out), 'items, asof', asof)
