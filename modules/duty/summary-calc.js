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
// 畫面上「單別」的分類（2026-11-23 主管：請假／補休／加班／出差要能分開查）：補休＝請假單裡假別是「補休」的那幾張；原始 kind 不動（單張標題、對帳、合計都照 kind）。
// 假別「補休」兩個字固定（薪資內建假別、打卡 LINE 假別清單、補休提醒 comp-period.js 都用去頭尾空白後整串相等判斷），這裡照同一個寫法，不做模糊比對。
export const COMP_TYPE = '補休';
export const CAT_LABEL = { leave: '請假', comp: '補休', ot: '加班', trip: '出差', miss: '忘打卡' };
export const CAT_ORDER = ['leave', 'comp', 'ot', 'trip', 'miss'];
export const catOf = (kind, type) => (kind === 'leave' && String(type == null ? '' : type).trim() === COMP_TYPE ? 'comp' : kind);
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
    kind, kindLabel: KIND_LABEL[kind] || String(kind), cat: catOf(kind, it.leave_type), catLabel: CAT_LABEL[catOf(kind, it.leave_type)] || String(kind),
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
  const type = trip ? '' : String(lv.type == null ? '' : lv.type).trim(), cat = catOf(trip ? 'trip' : 'leave', type);
  return {
    key: 'L|' + store + '|' + String(lv.id), src: 'final', id: String(lv.id), store, storeName,
    emp_id: String(lv.emp_id || ''), name: String(lv.name || ''), date: String(lv.date || ''),
    kind: trip ? 'trip' : 'leave', kindLabel: trip ? '出差' : '請假', cat, catLabel: CAT_LABEL[cat], type,
    time: '', reqHours: null, finalHours: h, finalText: '',
    place: '', reason: '', attach: null, status: 'finalized', statusLabel: STATUS_LABEL.finalized,
    flag: '', flagLabel: '', created_at: '', decided_by: '', decided_at: '', reject_reason: '', void_reason: '', self: false, standalone: true,
  };
}

const setFlag = (r, f) => { r.flag = f; r.flagLabel = FLAG_LABEL[f] || ''; };

// 排序（2026-11-23 主管：結果要依日期依序）：日期 → 送出時間 → 門市 → 員編 → 單別 → 姓名 → key（升冪）。
// 核定列沒有送出時間，排在同一天所有申請列的後面（同一天的核定列之間再照 門市 → 員編 → 單別）。
// 原本是 門市 → 日期 → 員編 → 單別 → 送出時間：只是把門市從第一鍵移到送出時間後面、送出時間提前，其餘相對順序不變；單別照畫面上的五類（請假、補休、加班、出差、忘打卡）。
export function sortRows(rows) {
  const co = r => { const i = CAT_ORDER.indexOf(r.cat || r.kind); return i < 0 ? 9 : i; };
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return rows.slice().sort((a, b) => cmp(a.date, b.date) || cmp(a.created_at || '￿', b.created_at || '￿') || cmp(a.store, b.store) || cmp(a.emp_id, b.emp_id)
    || co(a) - co(b) || cmp(a.name, b.name) || cmp(a.key, b.key));
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

// 篩選（只在前端）：f.stores＝門市代號陣列（null／undefined＝不限）、f.kinds＝單別（畫面上五類 cat：leave／comp／ot／trip／miss）陣列、f.status＝'approved'（含已核定）｜'all'、
//   f.emp＝empKey（選定的一位同仁）、f.q＝同仁搜尋字（姓名或員編的一部分，英文不分大小寫）、f.check＝只看要確認
export const isApprovedView = r => r.status === 'approved' || r.status === 'finalized';
export const empMatch = (r, q) => { const t = String(q || '').trim().toLowerCase(); return !t || String(r.name || '').toLowerCase().indexOf(t) >= 0 || String(r.emp_id || '').toLowerCase().indexOf(t) >= 0; };
export function filterRows(rows, f) {
  const o = f || {};
  const stores = Array.isArray(o.stores) ? o.stores : null, kinds = Array.isArray(o.kinds) ? o.kinds : null;
  return (rows || []).filter(r => (!stores || stores.indexOf(r.store) >= 0) && (!kinds || kinds.indexOf(r.cat) >= 0)
    && (o.status === 'all' || isApprovedView(r)) && (!o.emp || empKey(r) === o.emp) && empMatch(r, o.q) && (!o.check || !!r.flag));
}

// 序號：照傳進來的列（畫面上篩選＋排序後的結果）從 1 連續編到最後一筆；不存進資料、不影響 key，換篩選就重編。畫面、列印、Excel 共用
export const numbered = rows => (rows || []).map((r, i) => ({ seq: i + 1, r }));

// 同仁搜尋框（原本是下拉）：選項依讀到的資料產生，同店同員編一位；資料有兩家以上的店時後面加「・店名」，同名不同店才分得開。
// empText＝畫面上「姓名（員編）」的寫法（summary.js 的 empText）。回 [{ key, label, name, emp_id, store, storeName }]，照 門市 → 員編 → 姓名 排
export const ALL_EMP = '全部同仁';
export function empOptions(rows, empText) {
  const seen = new Map();
  for (const r of rows || []) { const k = empKey(r); if (!seen.has(k)) seen.set(k, r); }
  const multi = new Set((rows || []).map(r => r.store)).size > 1;
  return [...seen.entries()].sort((a, b) => (a[1].store + '|' + a[1].emp_id + a[1].name < b[1].store + '|' + b[1].emp_id + b[1].name ? -1 : 1))
    .map(([key, r]) => ({ key, label: empText(r) + (multi && r.storeName ? '・' + r.storeName : ''), name: r.name, emp_id: r.emp_id, store: r.store, storeName: r.storeName }));
}
// 搜尋框打的字 → 篩選條件：空白或「全部同仁」＝不篩；跟某一位的選項文字一模一樣（從清單點選）＝那一位（emp）；其他＝姓名或員編的一部分（q）
export function empResolve(options, text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || t === ALL_EMP) return { emp: '', q: '' };
  const hit = (options || []).find(o => o.label === t);
  return hit ? { emp: hit.key, q: '' } : { emp: '', q: t };
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

// ---- 本月補休帳總表（2026-11-14 Eason：門市主管查正職同仁當月的加班、補休時數）----
// 資料：payroll_leave_options {ym}（薪資系統 payCompMonthBook：已核准加班 − 補休（含審核中的補休單）＝剩／欠；只有正職 allowed）＋ mgr_roster（姓名、在職）。
// stores：[{ code, name, opts, roster }]（單一門市一筆）。回 [{ code, name, rows:[{emp_id, name, ot_h, used_h, balance_h, active}] }]；
// 這家店沒有補休帳（薪資沒開補休）＝ rows 為 null。名冊沒有的人照樣列（顯示員編）；離職的人只在本月有加班或補休才列。排序：欠的在前、再照姓名。
export function compBankRows(stores) {
  return (stores || []).map(st => {
    const q = (st.opts && st.opts.quotas) || {};
    const ros = new Map((Array.isArray(st.roster) ? st.roster : []).map(r => [String(r.emp_id), r]));
    let any = false;
    const rows = [];
    for (const [emp, byCode] of Object.entries(q)) {
      const c = Object.values(byCode || {}).find(v => v && v.comp);
      if (!c) continue;
      any = true;
      if (!c.allowed) continue;                                        // 計時同仁沒有補休
      const r = ros.get(String(emp)), active = r ? String(r.active).toLowerCase() !== 'false' && r.active !== false : !ros.size;      // 名冊讀不到：分不出在不在職，一律當在職
      const ot = r2(Number(c.ot_h) || 0), used = r2(Number(c.used_h) || 0), bal = r2(c.balance_h != null ? Number(c.balance_h) || 0 : ot - used);
      if (!active && !ot && !used) continue;
      const nm = r && r.name ? String(r.name) : (st.names && st.names.get(String(emp))) || String(emp);
      rows.push({ emp_id: String(emp), name: nm, ot_h: ot, used_h: used, balance_h: bal, active });
    }
    rows.sort((a, b) => (a.balance_h < 0) !== (b.balance_h < 0) ? (a.balance_h < 0 ? -1 : 1) : a.name.localeCompare(b.name, 'zh-Hant'));
    // none＝為什麼沒有補休帳（2026-11-16 Eason）：nomaster＝薪資主檔沒有這家店在職的同仁（額度整份是空的，例 墨竹亭光復、六張犁、美村還沒建檔）；off＝有同仁但沒有補休假別
    return { code: st.code || '', name: st.name || '', rows: any ? rows : null, none: any ? '' : (Object.keys(q).length ? 'off' : 'nomaster') };
  });
}

// 補休帳 Excel 分頁（2026-11-14 Eason）：groups＝compBankRows 的結果（rows 不是 null 的門市）；fallback＝單一門市的店名。
// 數字欄放數字（不帶「小時」），剩／欠：正數＝剩、負數＝欠；文字欄照 xlsSafe（開頭 = + - @ 補單引號）。
// 沒有補休帳時的提示（groups＝compBankRows 全部的結果，含 rows 為 null 的店）：主檔沒同仁要請會計建檔；真的沒開補休才寫「薪資沒有開補休」
export function compNoneText(all) {
  const list = (all || []).filter((g) => g.rows === null);
  const nm = list.filter((g) => g.none === 'nomaster'), names = (l) => l.map((g) => g.name || g.code).filter(Boolean).join('、');
  if (list.length && nm.length === list.length) return (list.length > 1 && names(nm) ? names(nm) + '的' : '這家店的') + '薪資主檔還沒有同仁，補休明細要等會計在「薪酬」把同仁建進員工薪資主檔才看得到。';
  if (nm.length) return names(nm) + '的薪資主檔還沒有同仁（請會計建檔）；' + names(list.filter((g) => g.none !== 'nomaster')) + '薪資沒有開補休。';
  return '這裡的門市沒有補休明細（薪資沒有開補休）。';
}

export function compSheet(groups, fallback) {
  const out = [['門市', '同仁', '員編', '加班', '補休', '補休還剩／還欠']];
  for (const g of groups || []) {
    const st = g.name || fallback || g.code || '';
    for (const r of g.rows || []) out.push([xlsSafe(st), xlsSafe(r.name + (r.active ? '' : '（離職）')), xlsSafe(r.emp_id), r.ot_h, r.used_h, r.balance_h]);
  }
  if (out.length === 1) out.push(['本月沒有正職同仁的加班或補休']);
  out.push([], ['單位：小時。補休還剩／還欠＝加班 − 補休，負數＝欠；補休含審核中的補休單，跟薪資的補休明細同一份。']);
  return out;
}
