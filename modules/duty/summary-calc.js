// 申請單彙整（2026-11-02，docs/req-print/spec.md §4.1）：把整月申請單＋核定結果（mgr_req_month）合併成一列一列、對帳、篩選、合計。
// 純函式（不碰畫面），伺服器端測試 test/server/summary-calc.test.js 也直接 import。
//
// 名詞：申請列＝requests 分頁一筆；核定列＝leave 分頁一筆（主管核定工時送出才寫，薪資讀這份）。
// 對帳組：鍵 <store>|<emp_id>|<date>|<type>；只有請假（type＝假別）、出差（type＝'出差'）參與；核定列假別＝出差歸出差，其他歸請假。
//   組內有 approved 申請：核定列不另成一列，核定時數掛在組內第一張 approved 申請列，其他 approved 申請列核定欄寫「併上列」
//     A＝F 不標；A≠F 標 diff「時數不同」；沒有核定 → unfinal「還沒核定」
//   組內沒有 approved、有核定：核定列自成一列；組內有作廢申請 → voided_final，沒有 → no_request
//   核定列 emp_id 空（姓名對不到名冊）→ unmatched，自成一列、不進對帳組

export const KIND_LABEL = { leave: '請假', ot: '加班', trip: '出差', miss: '忘打卡' };
export const KIND_ORDER = ['leave', 'ot', 'trip', 'miss'];
export const SLIP_TITLE = { leave: '請假單', ot: '加班單', trip: '出差單', miss: '忘打卡單' };
export const STATUS_LABEL = { pending: '待審', approved: '已核准', rejected: '已退回', cancelled: '本人取消', voided: '已作廢', finalized: '已核定' };
export const FLAG_LABEL = { diff: '時數不同', unfinal: '還沒核定', voided_final: '申請已作廢、核定還在', no_request: '沒有申請單', unmatched: '對不到同仁' };
export const MISS_LABEL = { in: '上班', out: '下班', both: '上下班' };
export const MERGED = '併上列';
export const OT_NOTE = '實際加班費以薪資計算為準';

const r2 = n => Math.round(n * 100) / 100;
const num = v => (typeof v === 'number' && isFinite(v) ? v : v === '' || v == null ? null : isFinite(Number(v)) ? Number(v) : null);

// 出差地點：reason 格式「地點：…；事由：…」（打卡 LINE 出差單）；拆不出來回 ''
export function tripPlace(reason) {
  const m = /^地點：(.*?)；事由：/.exec(String(reason || ''));
  return m ? m[1].trim() : '';
}
// 出差事由：拆得出來就只留「事由：」後面那段，拆不出來原樣
export function tripWhy(reason) {
  const s = String(reason || ''), m = /^地點：.*?；事由：([\s\S]*)$/.exec(s);
  return m ? m[1].trim() : s;
}

// 時段文字：請假／出差沒有起訖＝「整天」；加班「起–訖」；忘打卡「上班 09:00、下班 18:00」
export function timeText(it) {
  if (it.kind === 'miss') {
    const p = [];
    if ((it.miss_type === 'in' || it.miss_type === 'both') && it.start) p.push('上班 ' + it.start);
    if ((it.miss_type === 'out' || it.miss_type === 'both') && it.end) p.push('下班 ' + it.end);
    return p.join('、');
  }
  if (it.start && it.end) return it.start + '–' + it.end;
  return it.kind === 'leave' || it.kind === 'trip' ? '整天' : '';
}

// 一位同仁的鍵（同仁篩選用）：同店同員編；員編空（對不到同仁）用姓名
export const empKey = r => (r.store || '') + '|' + (r.emp_id ? r.emp_id : '?' + (r.name || ''));

function reqRow(it, store, storeName) {
  const kind = KIND_LABEL[it.kind] ? it.kind : it.kind;
  const trip = kind === 'trip';
  return {
    key: 'R|' + store + '|' + String(it.id), src: 'req', id: String(it.id), store, storeName,
    emp_id: String(it.emp_id || ''), name: String(it.name || ''), date: String(it.date || ''),
    kind, kindLabel: KIND_LABEL[kind] || String(kind),
    type: kind === 'leave' ? String(it.leave_type || '') : kind === 'miss' ? (MISS_LABEL[it.miss_type] || '') : '',
    time: timeText(it), reqHours: kind === 'miss' ? null : num(it.hours), finalHours: null, finalText: '',
    place: trip ? tripPlace(it.reason) : '', reason: trip ? tripWhy(it.reason) : String(it.reason || ''),
    attach: it.has_attach === true, status: String(it.status || ''), statusLabel: STATUS_LABEL[it.status] || String(it.status || ''),
    flag: '', flagLabel: '', created_at: String(it.created_at || ''), decided_by: String(it.decided_by || ''), decided_at: String(it.decided_at || ''),
    reject_reason: String(it.reject_reason || ''), void_reason: String(it.void_reason || ''), self: it.self === true, standalone: false,
  };
}

function finalRow(lv, store, storeName) {
  const trip = String(lv.type == null ? '' : lv.type).trim() === '出差';
  const h = num(lv.hours) || 0;   // 核定時數空白＝0（同薪資 payCollect）
  return {
    key: 'L|' + store + '|' + String(lv.id), src: 'final', id: String(lv.id), store, storeName,
    emp_id: String(lv.emp_id || ''), name: String(lv.name || ''), date: String(lv.date || ''),
    kind: trip ? 'trip' : 'leave', kindLabel: trip ? '出差' : '請假', type: trip ? '' : String(lv.type || ''),
    time: '', reqHours: null, finalHours: h, finalText: '',
    place: '', reason: '', attach: null, status: 'finalized', statusLabel: STATUS_LABEL.finalized,
    flag: '', flagLabel: '', created_at: '', decided_by: '', decided_at: '', reject_reason: '', void_reason: '', self: false, standalone: true,
  };
}

const setFlag = (r, f) => { r.flag = f; r.flagLabel = FLAG_LABEL[f] || ''; };

// 排序：門市 → 日期 → 員編 → 單別 → 送出時間（核定列沒有送出時間，排在同鍵申請列後面）
export function sortRows(rows) {
  const ko = k => { const i = KIND_ORDER.indexOf(k); return i < 0 ? 9 : i; };
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return rows.slice().sort((a, b) => cmp(a.store, b.store) || cmp(a.date, b.date) || cmp(a.emp_id, b.emp_id) || ko(a.kind) - ko(b.kind)
    || cmp(a.created_at || '￿', b.created_at || '￿') || cmp(a.name, b.name) || cmp(a.key, b.key));
}

// data＝mgr_req_month 回應 {ym, items, leaves}；opts.store／storeName＝列上沒帶 store 時用的門市（單一門市＝''）
export function buildRows(data, opts) {
  const o = opts || {}, dStore = o.store || '', dName = o.storeName || '';
  const items = Array.isArray(data && data.items) ? data.items : [], leaves = Array.isArray(data && data.leaves) ? data.leaves : [];
  const rows = [], groups = new Map();
  const grp = k => { if (!groups.has(k)) groups.set(k, { reqs: [], finals: [] }); return groups.get(k); };
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const st = typeof it.store === 'string' ? it.store : dStore, nm = typeof it.storeName === 'string' ? it.storeName : dName;
    const r = reqRow(it, st, nm);
    rows.push(r);
    if (r.kind === 'leave' || r.kind === 'trip') grp(st + '|' + r.emp_id + '|' + r.date + '|' + (r.kind === 'trip' ? '出差' : r.type.trim())).reqs.push(r);
  }
  for (const lv of leaves) {
    if (!lv || typeof lv !== 'object') continue;
    const st = typeof lv.store === 'string' ? lv.store : dStore, nm = typeof lv.storeName === 'string' ? lv.storeName : dName;
    const r = finalRow(lv, st, nm);
    if (!r.emp_id) { setFlag(r, 'unmatched'); rows.push(r); continue; }
    grp(st + '|' + r.emp_id + '|' + r.date + '|' + String(lv.type == null ? '' : lv.type).trim()).finals.push(r);   // 假別去頭尾空白（手填）
  }
  for (const g of groups.values()) {
    const appr = sortRows(g.reqs.filter(r => r.status === 'approved'));
    const A = r2(appr.reduce((a, r) => a + (r.reqHours || 0), 0));
    if (A > 0) {                                                // spec §4.1：A＝核准申請時數加總 > 0 才對帳（時數 0／空白的核准單照一般申請列，不掛核定）
      if (!g.finals.length) { appr.forEach(r => { setFlag(r, 'unfinal'); r.finalText = '—'; }); continue; }
      const F = r2(g.finals.reduce((a, r) => a + (r.finalHours || 0), 0));
      appr.forEach((r, i) => { if (A !== F) setFlag(r, 'diff'); if (i === 0) r.finalHours = F; else r.finalText = MERGED; });
      continue;                                                 // 核定列併進申請列，不另成一列
    }
    const voided = g.reqs.some(r => r.status === 'voided');
    g.finals.forEach(r => { setFlag(r, voided ? 'voided_final' : 'no_request'); rows.push(r); });
  }
  return sortRows(rows);
}

// 篩選（只在前端）：f.stores＝門市代號陣列（null／undefined＝不限）、f.kinds＝單別陣列、f.status＝'approved'（含已核定）｜'all'、f.emp＝empKey、f.check＝只看要確認
export const isApprovedView = r => r.status === 'approved' || r.status === 'finalized';
export function filterRows(rows, f) {
  const o = f || {};
  const stores = Array.isArray(o.stores) ? o.stores : null, kinds = Array.isArray(o.kinds) ? o.kinds : null;
  return (rows || []).filter(r => (!stores || stores.indexOf(r.store) >= 0) && (!kinds || kinds.indexOf(r.kind) >= 0)
    && (o.status === 'all' || isApprovedView(r)) && (!o.emp || empKey(r) === o.emp) && (!o.check || !!r.flag));
}

// 合計（依目前篩選後的列；一組只算一次＝核定時數只掛在組內第一張，其他寫「併上列」）
//   count：各單別筆數（每列一筆）；leaveByType：請假依假別的核定時數；tripHours：出差核定時數（兩者不含還沒核定、對不到同仁）
//   otHours：已核准加班申請時數；missCount：忘打卡筆數；check：要確認（flag 非空）列數。待審、退回、取消、作廢只計筆數
export function totals(rows) {
  const t = { rows: 0, count: { leave: 0, ot: 0, trip: 0, miss: 0 }, leaveByType: {}, leaveHours: 0, tripHours: 0, otHours: 0, missCount: 0, check: 0 };
  for (const r of rows || []) {
    t.rows++;
    if (t.count[r.kind] !== undefined) t.count[r.kind]++;
    if (r.flag) t.check++;
    if (r.kind === 'miss') t.missCount++;
    if (r.kind === 'ot' && r.status === 'approved' && r.reqHours != null) t.otHours = r2(t.otHours + r.reqHours);
    const fin = (r.status === 'approved' || r.status === 'finalized') && r.finalHours != null && r.flag !== 'unfinal' && r.flag !== 'unmatched';
    if (!fin) continue;
    if (r.kind === 'trip') t.tripHours = r2(t.tripHours + r.finalHours);
    else if (r.kind === 'leave') { const k = r.type || '（未填假別）'; t.leaveByType[k] = r2((t.leaveByType[k] || 0) + r.finalHours); t.leaveHours = r2(t.leaveHours + r.finalHours); }
  }
  return t;
}

// 月份預設（spec §4）：每月 1–10 號預設上個月，其他日子本月。today＝'YYYY-MM-DD'
export function defaultYm(today) {
  const y = +today.slice(0, 4), m = +today.slice(5, 7), d = +today.slice(8, 10);
  if (d > 10) return today.slice(0, 7);
  return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
}
// 月份加減：ym＝'YYYY-MM'
export function ymAdd(ym, n) {
  const t = +ym.slice(0, 4) * 12 + (+ym.slice(5, 7) - 1) + n;
  return Math.floor(t / 12) + '-' + String((t % 12) + 1).padStart(2, '0');
}
export const ymLabel = ym => +ym.slice(0, 4) + ' 年 ' + +ym.slice(5, 7) + ' 月';

// Excel 公式注入防護：文字開頭是 = + - @ 前面補單引號
export const xlsSafe = v => (typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v);
