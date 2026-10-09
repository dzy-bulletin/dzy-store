// 耗損登記的計算與統計：全部純函式，不碰 DOM。邏輯照抄原系統 eason0728.github.io/mzt-loss（存檔 ~/mala-store-ops/spike/live/mzt-loss.html），
// 金額只在 makeRecord 算一次；統計一律直接加總每筆存下的「金額」，不回頭查成本表重算（歷史金額永不重算）。
export const CATEGORIES = ['肉類', '海鮮', '蔬菜', '豆製品・加工品', '乾貨・南北貨', '調味料', '飲品・酒水', '包材・耗材', '其他'];   // 原系統第 421 行
export const REASONS = ['報廢', '過期', '備料失誤', '客訴重做', '試菜', '盤點差異', '其他'];                                              // 原系統第 422 行

const pad = (n, w) => String(n).padStart(w, '0');
export const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);

// 格式：L-<YYYYMMDDHHmmss>-<8 碼小寫英數>（原系統第 434–442 行）
export function newId(now) {
  const d = now || new Date();
  const t = '' + d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) + pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2);
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  for (let i = 0; i < 8; i++) r += chars.charAt(Math.floor(Math.random() * chars.length));
  return 'L-' + t + '-' + r;
}

// 金額算式：Math.round(qty * cost * 100) / 100——來源：原系統 spike/live/mzt-loss.html 第 448 行（calc.makeRecord；登記頁即時顯示在第 939 行 calcAmount 同一式）
export const amountOf = (qty, cost) => Math.round(Number(qty) * Number(cost) * 100) / 100;

// 原系統全專案唯一一處把耗損量乘上單位成本的地方（第 444–464 行 makeRecord）
export function makeRecord(input, item, now) {
  const d = now || new Date();
  const qty = Number(input.耗損量), cost = Number(item.單位成本);
  return {
    id: input.id || newId(d), 日期: input.日期, 店別: input.店別 || '', 品類: input.品類 || item.品類, 品名: item.品名,
    耗損量: qty, 單位: item.單位, 單位成本: cost, 金額: amountOf(qty, cost),
    原因: input.原因,
    原因說明: input.原因 === '其他' ? (input.原因說明 || '') : '',   // 說明欄只屬於「其他」；改選別的原因時殘留的字不存
    備註: input.備註 || '', 建立時間: d.toISOString(), 作廢: false,
  };
}

const r2 = n => Math.round(n * 100) / 100;
export const live = (records, from, to) => records.filter(r => r.作廢 !== true && !(from && r.日期 < from) && !(to && r.日期 > to));
const bucket = v => v || '（未填）';

// 分組排行（原系統第 489–507 行）；subField 給了就多算一層：每項掛一個「明細」（佔比是該項內部佔比）
export function rank(records, field, subField) {
  const map = {}, groups = {};
  let total = 0;
  for (const r of records) {
    const k = bucket(r[field]);
    if (!map[k]) { map[k] = { 名稱: k, 金額: 0, 筆數: 0 }; groups[k] = []; }
    map[k].金額 = r2(map[k].金額 + r.金額);
    map[k].筆數 += 1;
    groups[k].push(r);
    total = r2(total + r.金額);
  }
  const list = Object.values(map).sort((a, b) => b.金額 - a.金額);
  for (const x of list) {
    x.佔比 = total ? Math.round(x.金額 / total * 1000) / 10 : 0;
    if (subField) x.明細 = rank(groups[x.名稱], subField);
  }
  return list;
}

// 現場填的「原因說明」去重計數：同一句話出現幾次就是幾筆，多的排前面，同樣多照先出現的順序（原系統 notes）
export function notes(records) {
  const map = {}, list = [];
  for (const r of records) {
    const t = String(r.原因說明 || '').trim();
    if (!t) continue;
    if (!map[t]) { map[t] = { 說明: t, 筆數: 0, 順序: list.length }; list.push(map[t]); }
    map[t].筆數 += 1;
  }
  list.sort((a, b) => b.筆數 - a.筆數 || a.順序 - b.順序);
  return list.map(x => ({ 說明: x.說明, 筆數: x.筆數 }));
}

// 子清單只列前 n 項，尾巴收成一列「其餘」（原系統 topN）；佔比照 rank 的算法（rest/total）
export function topN(list, n) {
  if (!list || list.length <= n) return list || [];
  let total = 0, rest = 0, cnt = 0;
  for (const x of list) total = r2(total + x.金額);
  for (let i = n; i < list.length; i++) { rest = r2(rest + list[i].金額); cnt += list[i].筆數; }
  return list.slice(0, n).concat([{ 其餘: list.length - n, 金額: rest, 筆數: cnt, 佔比: total ? Math.round(rest / total * 1000) / 10 : 0 }]);
}

export function daily(records, from, to) {
  const map = {};
  for (const r of records) map[r.日期] = r2((map[r.日期] || 0) + r.金額);
  const out = [], cur = new Date(from + 'T00:00:00'), end = new Date(to + 'T00:00:00');
  while (cur <= end) { const key = ymd(cur); out.push({ 日期: key, 金額: map[key] || 0 }); cur.setDate(cur.getDate() + 1); }
  return out;
}

// 原系統三份獨立排行（第 556–590 行）：按品類（→品名）、按品名（→原因）、按原因（→品名）；「其他」的原因說明掛在 品名×其他 那一格
export function summarize(records, from, to) {
  const rows = live(records, from, to);
  let total = 0;
  for (const r of rows) total = r2(total + r.金額);
  const byCat = rank(rows, '品類', '品名'), byItem = rank(rows, '品名', '原因'), byReason = rank(rows, '原因', '品名');
  const others = rows.filter(r => r.原因 === '其他');
  const notesOf = item => notes(others.filter(r => bucket(r.品名) === item));
  byItem.forEach(it => it.明細.forEach(m => { if (m.名稱 === '其他') m.說明 = notesOf(it.名稱); }));
  byReason.forEach(rs => { if (rs.名稱 === '其他') rs.明細.forEach(m => { m.說明 = notesOf(m.名稱); }); });
  return { 總金額: total, 筆數: rows.length, 按品類: byCat, 按品名: byItem, 按原因: byReason, 每日: from && to ? daily(rows, from, to) : [], rows };
}

export function dateRange(kind, todayStr) {
  const t = new Date(todayStr + 'T00:00:00');
  if (kind === 'today') return { from: todayStr, to: todayStr };
  if (kind === 'week') { const wd = (t.getDay() + 6) % 7; const s = new Date(t); s.setDate(t.getDate() - wd); return { from: ymd(s), to: todayStr }; }   // 週一為第一天
  if (kind === 'month') return { from: ymd(new Date(t.getFullYear(), t.getMonth(), 1)), to: todayStr };
  return { from: todayStr, to: todayStr };
}
export function shift(dateStr, n) { const x = new Date(dateStr + 'T00:00:00'); x.setDate(x.getDate() + n); return ymd(x); }
export const days = (from, to) => Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000) + 1;
// 上一個同樣長度的期間（本期 vs 上期）
export function prevRange(from, to) { const len = days(from, to), pTo = shift(from, -1); return { from: shift(pTo, -(len - 1)), to: pTo }; }

export const money = n => '$' + r2(Number(n)).toLocaleString('zh-TW', { maximumFractionDigits: 2 });

const CSV_COLS = ['id', '日期', '店別', '品類', '品名', '耗損量', '單位', '單位成本', '金額', '原因', '原因說明', '備註', '建立時間'];
export function csv(records) {
  // 文字開頭是 = + - @ 補一個空白，避免 Excel 把品名、備註當公式（同庫存匯出；2026-10-10 Codex 審查）。數字欄（負數）不動
  const esc = v => { const num = typeof v === 'number'; v = v == null ? '' : String(v); if (!num && /^[=+\-@\t\r]/.test(v)) v = ' ' + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return '﻿' + [CSV_COLS.join(','), ...records.map(r => CSV_COLS.map(c => esc(r[c])).join(','))].join('\r\n');   // BOM：Excel 開才不亂碼
}
