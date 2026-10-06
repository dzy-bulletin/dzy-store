// 庫存計算（前端）。逐行照原系統線上正本 spike/live/inventory.html（eason0728.github.io/mala）搬，註解寫的是正本行號。
// S 是正本的資料形狀：{ products:{類別:[{id,name,price,spec,unit}]}, cartCats, stockCats, cartItems:{類別:[{id,pid,name,spec,qty}]}, stockItems, thresholds:{pid:{low,high}} }
// 門檻 low／high 的單位是「元」（盤點列金額），不是數量（正本第 1167–1210 行）。伺服器端同一份規則在 server/inventory-calc.js（首頁「偏低 N 項」用）。

export function findProduct(S, pid) {                          // 635–641
  for (const c in S.products) { const f = (S.products[c] || []).find(p => p.id === pid); if (f) return f; }
  return null;
}
export function allProducts(S) { const l = []; for (const c in S.products) (S.products[c] || []).forEach(p => l.push(p)); return l; }   // 642–646
export function pgForProduct(p) { const eff = p.spec; return eff > 0 ? p.price / eff : p.price; }   // 622–625：單位成本＝price/spec
export function itemValue(S, item) {                           // 626–634：金額＝數量×該列規格×單位成本
  const p = findProduct(S, item.pid);
  if (!p) return 0;
  const pg = pgForProduct(p);
  const spec = parseFloat(item.spec) || 1;
  const qty = parseFloat(item.qty) || 0;
  return qty * spec * pg;
}
export const fmt = n => '$' + Math.round(n).toLocaleString();                                            // 647
export function fmtpg(n) { return n >= 1 ? n.toFixed(2) : n.toFixed(4); }                               // 648–651
export function grandTotal(S) {                                // 661–666
  let t = 0;
  (S.cartCats || []).forEach(c => (S.cartItems[c] || []).forEach(i => { t += itemValue(S, i); }));
  (S.stockCats || []).forEach(c => (S.stockItems[c] || []).forEach(i => { t += itemValue(S, i); }));
  return t;
}
export const getThresh = (S, pid) => (S.thresholds && S.thresholds[pid]) ? S.thresholds[pid] : null;   // 1118–1120

// 1167–1210：逐盤點列比對閾值（攤車＋現場各自掃）＋「攤車與現場都沒數量」的未盤點
export function checkAlerts(S) {
  const alerts = [];
  const scan = (cats, items, mode) => (cats || []).forEach(cat => (items[cat] || []).forEach(item => {
    const t = getThresh(S, item.pid);
    if (!t) return;
    const v = itemValue(S, item);
    if (t.low !== null && t.low !== undefined && v < t.low) alerts.push({ item, val: v, thresh: t.low, type: 'low', mode });
    else if (t.high !== null && t.high !== undefined && v > t.high) alerts.push({ item, val: v, thresh: t.high, type: 'high', mode });
  }));
  scan(S.cartCats, S.cartItems, 'cart');
  scan(S.stockCats, S.stockItems, 'stock');
  const has = (cats, items, pid) => (cats || []).some(c => (items[c] || []).some(i => i.pid === pid && parseFloat(i.qty || 0) > 0));
  for (const cat in S.products) (S.products[cat] || []).forEach(p => {
    if (!has(S.cartCats, S.cartItems, p.id) && !has(S.stockCats, S.stockItems, p.id)) alerts.push({ item: { id: p.id, pid: p.id, name: p.name }, val: 0, thresh: 0, type: 'missing', mode: 'both' });
  });
  return alerts;
}

// 1239–1340 renderPrint：庫存彙整（同商品攤車＋現場合併、每個 pid 只出現一次）、未盤點、食材／包材小計
const fmtQ = n => { n = +(+n || 0).toFixed(2); return n.toString(); };
export function buildSummary(S) {
  const map = {};
  const acc = (item, mode) => {
    if (!map[item.pid]) map[item.pid] = { name: item.name, pid: item.pid, total: 0, cartQty: 0, stockQty: 0, cartBase: 0, stockBase: 0, cartSpecs: new Set(), stockSpecs: new Set() };
    const e = map[item.pid];
    e.total += itemValue(S, item);
    const q = parseFloat(item.qty) || 0, sp = parseFloat(item.spec) || 1;
    e[mode + 'Qty'] += q; e[mode + 'Base'] += q * sp;
    if (q > 0) e[mode + 'Specs'].add(sp);
  };
  S.cartCats.forEach(cat => (S.cartItems[cat] || []).forEach(item => acc(item, 'cart')));
  S.stockCats.forEach(cat => (S.stockItems[cat] || []).forEach(item => acc(item, 'stock')));
  // 同一側各列規格一致時顯示輸入的數量；不一致時改以「數量×規格」基準單位顯示
  const qtyLine = e => {
    const side = pre => {
      if (e[pre + 'Specs'].size > 1) { const p2 = findProduct(S, e.pid); return fmtQ(e[pre + 'Base']) + (p2 ? p2.unit : ''); }
      return fmtQ(e[pre + 'Qty']);
    };
    return `攤車 ${side('cart')}　現場 ${side('stock')}`;
  };
  const visible = e => e.total > 0 || e.cartQty > 0 || e.stockQty > 0;     // 有數量但金額 0 的也要顯示
  const row = e => {
    const v = e.total, t = getThresh(S, e.pid);
    let badge = '';
    if (t) {
      if (t.low !== null && t.low !== undefined && v < t.low) badge = 'low';
      else if (t.high !== null && t.high !== undefined && v > t.high) badge = 'high';
    }
    return { pid: e.pid, name: e.name, total: v, qty: qtyLine(e), badge };
  };
  const shown = new Set(), groups = [];
  let total = 0;
  Object.keys(S.products).forEach(cat => {
    const rows = []; let ct = 0;
    (S.products[cat] || []).forEach(p => {
      if (shown.has(p.id)) return;
      const e = map[p.id];
      if (!e || !visible(e)) return;
      shown.add(p.id); rows.push(row(e)); ct += e.total;
    });
    if (rows.length) { groups.push({ cat, subtotal: ct, rows }); total += ct; }
  });
  const extra = []; let extraCt = 0;
  Object.values(map).forEach(e => { if (shown.has(e.pid) || !visible(e)) return; shown.add(e.pid); extra.push(row(e)); extraCt += e.total; });
  if (extra.length) { groups.push({ cat: '其他', subtotal: extraCt, rows: extra }); total += extraCt; }
  const alerts = checkAlerts(S);
  const missing = alerts.filter(a => a.type === 'missing').map(a => a.item);
  // 食材 & 包材：攤車一律算食材；現場依商品所屬分類（包材、清潔用品）判定，食材＋包材＝全店總金額
  const packPids = new Set();
  ['包材', '清潔用品'].forEach(c => (S.products[c] || []).forEach(p => packPids.add(p.id)));
  let food = 0, pack = 0;
  (S.cartCats || []).forEach(c => (S.cartItems[c] || []).forEach(i => { food += itemValue(S, i); }));
  (S.stockCats || []).forEach(c => (S.stockItems[c] || []).forEach(i => { const v = itemValue(S, i); if (packPids.has(i.pid)) pack += v; else food += v; }));
  return { groups, total, missing, food, pack, grand: grandTotal(S),
    low: alerts.filter(a => a.type === 'low').length, high: alerts.filter(a => a.type === 'high').length, missingCount: missing.length };
}

// 1358–1391 exportExcel 的列（區域、分類、品名、規格、數量、單位、金額）
export function excelRows(S, storeName, ts) {
  const rows = [['麻的小辛辣｜庫存金額彙整報表'], ['門市：' + ((storeName || '').trim() || '（未填寫）')], ['盤點時間：' + ts], [], ['區域', '分類', '品名', '規格', '數量', '單位', '金額(元)']];
  const part = (label, cats, items) => cats.forEach(cat => (items[cat] || []).forEach(item => {
    const p = findProduct(S, item.pid);
    rows.push([label, cat, item.name, item.spec, item.qty || 0, p ? p.unit : '—', Math.round(itemValue(S, item))]);
  }));
  part('攤車庫存', S.cartCats, S.cartItems); rows.push([]);
  part('現場庫存', S.stockCats, S.stockItems); rows.push([]);
  rows.push(['', '', '', '', '', '全店總計', Math.round(grandTotal(S))]);
  return rows;
}
// 開頭為 = + - @ 的文字補一個空白，避免 Excel 把品名當公式（正本 CSV injection 防護）
const cell = c => { let s = String(c); if (typeof c === 'string' && /^[=+\-@]/.test(s)) s = ' ' + s; return '"' + s.replace(/"/g, '""') + '"'; };
export const toCsv = rows => '﻿' + rows.map(r => r.map(cell).join(',')).join('\n');
// 656–660 exportBaseName：門市名稱（過濾檔名非法字元）＋ 庫存管理 ＋ YYYYMMDD
export function exportBaseName(storeName, now) {
  const store = (storeName || '').trim().replace(/[\\/:*?"<>|]/g, '');
  const d = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
  return (store ? store + '_' : '') + '庫存管理' + d;
}
