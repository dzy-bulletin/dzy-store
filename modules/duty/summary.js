// 申請單彙整（2026-11-02，docs/req-print/spec.md §4–§5）：一個月的請假、加班、出差、忘打卡申請＋核定結果，篩選、對帳、合計，
// 印一覽表（A4 橫）、印單張（A4 直，一筆一頁）、匯出 Excel。只讀：這一頁不能核准、退回、作廢任何單據。
// 資料：mgr_req_month {ym}（全部門市走 callAll）；換月份才重讀，其他篩選只在前端。對帳與合計的規則在 summary-calc.js（純函式）。
import { S, call, callAll, h, tipText } from './state.js';
import { taipeiToday, tsLabel, shortDate } from './calc.js';
import { buildRows, filterRows, totals, empKey, defaultYm, ymAdd, ymLabel, xlsSafe, KIND_LABEL, KIND_ORDER, SLIP_TITLE, MERGED, OT_NOTE } from './summary-calc.js';

// 樣式另放 summary.css（畫面、手機卡片、列印），第一次進來才掛上（同耗損登記 loss.css 的掛法）
export function css() {
  if (document.getElementById('smCss')) return;
  const l = document.createElement('link');
  l.id = 'smCss'; l.rel = 'stylesheet'; l.href = new URL('./summary.css', import.meta.url).href;
  document.head.append(l);
}

// 這一頁的狀態：換登入、換門市、換模式（全部門市／單一）就重來
let SM = null;
const ctxKey = () => [S.key, S.all ? 'ALL' : '', S.asStore].join('|');
function state() {
  if (!SM || SM.ck !== ctxKey()) {
    SM = { ck: ctxKey(), ym: defaultYm(taipeiToday()), data: null, rows: [], err: null, tok: 0,
      f: { stores: null, kinds: KIND_ORDER.slice(), status: 'approved', emp: '', check: false }, picked: new Set() };
  }
  return SM;
}

// 舊營運系統不認得這個動作（NOT_FOUND「找不到這個功能」）、或全部門市不支援這個動作：網站先上、伺服器還沒更新（spec §7）
const notReady = e => !!e && ((e.code === 'NOT_FOUND' && /找不到這個功能/.test(e.message || '')) || e.code === 'BAD_ACTION' || (e.code === 'BAD_INPUT' && /不支援全部門市/.test(e.message || '')));

const H = v => (v == null || v === '' ? '—' : String(Math.round(v * 100) / 100));          // 時數文字（沒有＝—）
const dash = v => (v == null || v === '' ? '—' : String(v));
const empText = r => r.name + (r.emp_id ? '（' + r.emp_id + '）' : '（對不到同仁）');
const finalCell = r => (r.finalText ? r.finalText : r.finalHours != null ? H(r.finalHours) : '—');
const attachText = r => (r.attach === true ? '有' : r.attach === false ? '無' : '—');
const ts = v => (v ? tsLabel(v) : '');
const storeNameOf = () => (S.asStore ? S.asName : (SM && SM.defName) || '');

// 一覽表欄位（需求 6A）：畫面、列印、Excel 共用同一份
const COLS = [
  ['date', '日期', r => shortDate(r.date)], ['emp', '同仁', empText], ['kind', '單別', r => r.kindLabel], ['type', '假別／忘打卡類型', r => dash(r.type)],
  ['time', '時段', r => dash(r.time)], ['req', '申請時數', r => H(r.reqHours)], ['fin', '核定時數', finalCell], ['place', '出差地點', r => dash(r.place)],
  ['reason', '事由', r => dash(r.reason)], ['att', '證明', attachText], ['st', '狀態', r => r.statusLabel], ['flag', '標示', r => dash(r.flagLabel)],
  ['at', '送出時間', r => dash(ts(r.created_at))], ['by', '核准人', r => dash(r.decided_by)], ['dat', '核准時間', r => dash(ts(r.decided_at))],
];

export function renderSummary(ctx) {
  css();
  const st = state();
  st.defName = ctx.session && ctx.session.name || '';
  const el = ctx.el;
  el.innerHTML = '';
  const bar = h('div', 'card sm-bar'), out = h('div', 'sm-out', null, { id: 'smOut' });
  el.append(bar, out);
  drawBar(bar, out);
  if (st.data || st.err) drawOut(out); else load(out);
}

function load(out) {
  const st = SM, tok = ++st.tok, ck = st.ck;
  out.innerHTML = '';
  out.append(h('div', 'card du-center', '載入中…'));
  (S.all ? callAll('mgr_req_month', { ym: st.ym }) : call('mgr_req_month', { ym: st.ym })).then(r => {
    if (!SM || SM.ck !== ck || tok !== st.tok) return;
    st.err = null; st.data = r || {};
    st.rows = buildRows(st.data, { store: '', storeName: storeNameOf() });
    st.storeList = S.all ? (Array.isArray(st.data.stores) ? st.data.stores.filter(x => x && x.ok).map(x => ({ code: x.store, name: x.storeName })) : []) : [];
    if (st.f.stores) st.f.stores = st.f.stores.filter(c => st.storeList.some(x => x.code === c));
    if (st.f.emp && !st.rows.some(r => empKey(r) === st.f.emp)) st.f.emp = '';
    st.picked = new Set([...st.picked].filter(k => st.rows.some(r => r.key === k)));
    if (out.isConnected) { const bar = out.previousElementSibling; if (bar) drawBar(bar, out); drawOut(out); }
  }, e => {
    if (!SM || SM.ck !== ck || tok !== st.tok) return;
    st.err = e; st.data = null; st.rows = [];
    if (out.isConnected) drawOut(out);
  });
}

// ---- 篩選列 ----
function drawBar(bar, out) {
  const st = SM;
  bar.innerHTML = '';
  bar.append(h('h2', 'sm-h', '申請單彙整'));
  { const t = h('p', 'hint'); t.append(tipText('一個月的申請與核定結果（只能看、印、匯出）', '包含請假、加班、出差、忘打卡申請，以及核定工時送出的核定結果（薪資讀的是核定結果）。核准或退回請到「申請審核」。')); bar.append(t); }
  const g = h('div', 'sm-filters');
  // 月份：往前兩年到下個月（伺服器最遠收到下個月）
  const fm = h('div', 'fld sm-f'); fm.append(h('label', null, '月份', { for: 'smYm' }));
  const ym = h('select', null, null, { id: 'smYm' });
  const cur = taipeiToday().slice(0, 7);
  for (let i = 1; i >= -24; i--) { const v = ymAdd(cur, i); const o = h('option', null, ymLabel(v), { value: v }); if (v === st.ym) o.selected = true; ym.append(o); }
  if (![...ym.options].some(o => o.value === st.ym)) { const o = h('option', null, ymLabel(st.ym), { value: st.ym }); o.selected = true; ym.append(o); }
  ym.onchange = () => { st.ym = ym.value; st.data = null; st.err = null; load(out); };
  fm.append(ym); g.append(fm);
  // 門市：全部門市＝多選（讀得到的店）；單一門市＝目前這家
  const fs = h('div', 'fld sm-f sm-f-wide'); fs.append(h('label', null, '門市'));
  if (S.all) {
    const box = h('div', 'sm-checks');
    for (const x of st.storeList || []) {
      const lab = h('label', 'sm-chk'), c = h('input', 'sm-store', null, { type: 'checkbox', 'data-k': x.code });
      c.checked = !st.f.stores || st.f.stores.indexOf(x.code) >= 0;
      c.onchange = () => { const on = [...box.querySelectorAll('.sm-store')].filter(i => i.checked).map(i => i.dataset.k); st.f.stores = on.length === (st.storeList || []).length ? null : on; drawOut(out); };
      lab.append(c, document.createTextNode(x.name)); box.append(lab);
    }
    if (!(st.storeList || []).length) box.append(h('span', 'sm-muted', st.data ? '沒有讀得到的門市' : '讀取中…'));
    fs.append(box);
  } else fs.append(h('div', 'sm-store-one', storeNameOf() || '目前這家店'));
  g.append(fs);
  // 單別：四個勾選
  const fk = h('div', 'fld sm-f sm-f-wide'); fk.append(h('label', null, '單別'));
  const kb = h('div', 'sm-checks');
  for (const k of KIND_ORDER) {
    const lab = h('label', 'sm-chk'), c = h('input', 'sm-kind', null, { type: 'checkbox', 'data-k': k });
    c.checked = st.f.kinds.indexOf(k) >= 0;
    c.onchange = () => { st.f.kinds = [...kb.querySelectorAll('.sm-kind')].filter(i => i.checked).map(i => i.dataset.k); drawOut(out); };
    lab.append(c, document.createTextNode(KIND_LABEL[k])); kb.append(lab);
  }
  fk.append(kb); g.append(fk);
  // 狀態
  const ft = h('div', 'fld sm-f'); ft.append(h('label', null, '狀態', { for: 'smStatus' }));
  const ss = h('select', null, null, { id: 'smStatus' });
  ss.append(h('option', null, '已核准（含已核定）', { value: 'approved' }), h('option', null, '全部（含待審、退回、取消、作廢）', { value: 'all' }));
  ss.value = st.f.status;
  ss.onchange = () => { st.f.status = ss.value; drawOut(out); };
  ft.append(ss); g.append(ft);
  // 同仁：依讀到的資料產生
  const fe = h('div', 'fld sm-f'); fe.append(h('label', null, '同仁', { for: 'smEmp' }));
  const es = h('select', null, null, { id: 'smEmp' });
  es.append(h('option', null, '全部同仁', { value: '' }));
  const seen = new Map();
  for (const r of st.rows) { const k = empKey(r); if (!seen.has(k)) seen.set(k, r); }
  const multi = new Set(st.rows.map(r => r.store)).size > 1;
  [...seen.entries()].sort((a, b) => (a[1].store + '|' + a[1].emp_id + a[1].name < b[1].store + '|' + b[1].emp_id + b[1].name ? -1 : 1))
    .forEach(([k, r]) => es.append(h('option', null, empText(r) + (multi && r.storeName ? '・' + r.storeName : ''), { value: k })));
  es.value = st.f.emp;
  es.onchange = () => { st.f.emp = es.value; drawOut(out); };
  fe.append(es); g.append(fe);
  // 只看要確認
  const fc = h('label', 'sm-chk sm-only');
  const cc = h('input', null, null, { type: 'checkbox', id: 'smCheck' }); cc.checked = st.f.check;
  cc.onchange = () => { st.f.check = cc.checked; drawOut(out); };
  fc.append(cc, document.createTextNode('只看要確認'));
  g.append(fc);
  bar.append(g);
}

// ---- 結果：缺店、要確認、合計卡、按鈕、表格 ----
function drawOut(out) {
  const st = SM;
  out.innerHTML = '';
  if (st.err) {
    if (notReady(st.err)) { out.append(h('div', 'card du-center sm-updating', '系統還在更新，請稍後再試', { id: 'smUpdating' })); return; }
    const bar = h('div', 'du-fail');
    bar.append(h('span', 'du-fail-msg', '申請單彙整沒載入成功：' + (st.err.message || '網路或伺服器忙碌')));
    const b = h('button', 'btn sm ghost', '重新載入', { type: 'button', id: 'smRetry' });
    b.onclick = () => { st.err = null; load(out); };
    bar.append(b); out.append(bar); return;
  }
  const failed = Array.isArray(st.data && st.data.failed) ? st.data.failed : [];
  if (failed.length) {
    const fb = h('div', 'sm-failed', null, { role: 'alert' });
    fb.append(h('span', null, missText(failed)));
    const b = h('button', 'btn sm ghost', '重新載入', { type: 'button', id: 'smRetry' });
    b.onclick = () => { st.data = null; load(out); };
    fb.append(b); out.append(fb);
  }
  const rows = filterRows(st.rows, st.f), t = totals(rows);
  const nCheck = filterRows(st.rows, Object.assign({}, st.f, { check: true })).length;
  const top = h('div', 'sm-top');
  const cb = h('button', 'sm-checkbtn' + (nCheck ? ' warn' : ''), '要確認 ' + nCheck + ' 筆', { type: 'button', id: 'smCheckBtn' });
  cb.disabled = !nCheck;
  cb.title = '時數不同、還沒核定、申請已作廢但核定還在、沒有申請單、對不到同仁';
  cb.onclick = () => { st.f.check = true; const c = document.getElementById('smCheck'); if (c) c.checked = true; drawOut(out); };
  top.append(cb, h('span', 'sm-muted', ymLabel(st.ym) + '・目前列出 ' + rows.length + ' 筆' + (st.f.check ? '（只看要確認）' : '')));
  out.append(top);
  out.append(totCards(t));
  // 按鈕
  const acts = h('div', 'sm-acts');
  const pl = h('button', 'btn', '列印一覽表', { type: 'button', id: 'smPrintList' });
  const picked = rows.filter(r => st.picked.has(r.key));
  const ps = h('button', 'btn ghost', '列印單張（' + (picked.length ? '已勾 ' + picked.length + ' 筆' : '全部 ' + rows.length + ' 筆') + '）', { type: 'button', id: 'smPrintSlip' });
  const xl = h('button', 'btn ghost', '匯出 Excel', { type: 'button', id: 'smXlsx' });
  pl.disabled = ps.disabled = xl.disabled = !rows.length && !failed.length;
  if (!rows.length) ps.disabled = true;
  const msg = h('div', 'sm-msg', null, { role: 'status', id: 'smMsg' });
  pl.onclick = () => doPrint('list', listDoc(rows, failed));
  ps.onclick = () => doPrint('slip', slipDoc(picked.length ? picked : rows));
  xl.onclick = () => exportXlsx(rows, failed, xl, msg);
  acts.append(pl, ps, xl);
  out.append(acts, msg);
  if (!rows.length) { out.append(h('div', 'card du-center sm-empty', st.rows.length ? '目前的篩選沒有符合的資料。' : ymLabel(st.ym) + '沒有申請單或核定結果。')); return; }
  out.append(table(rows, out));
}

const missText = failed => '缺：' + failed.map(f => f.storeName || f.store).join('、') + '（讀不到）';

function totCards(t) {
  const wrap = h('div', 'sm-tots');
  const card = (cls, title, big, lines) => {
    const c = h('div', 'sm-tot ' + cls); c.append(h('div', 'sm-tot-t', title), h('div', 'sm-tot-n', big));
    (lines || []).forEach(x => c.append(h('div', 'sm-tot-l', x))); wrap.append(c);
  };
  const types = Object.keys(t.leaveByType).sort();
  card('leave', '請假（核定時數）', H(t.leaveHours) === '—' ? '0' : H(t.leaveHours) + ' 小時', [t.count.leave + ' 筆'].concat(types.map(k => k + ' ' + H(t.leaveByType[k]) + ' 小時')));
  card('trip', '出差（核定時數）', H(t.tripHours) + ' 小時', [t.count.trip + ' 筆']);
  card('ot', '加班（已核准申請時數）', H(t.otHours) + ' 小時', [t.count.ot + ' 筆', OT_NOTE]);
  card('miss', '忘打卡', t.missCount + ' 筆', []);
  return wrap;
}

function table(rows, out) {
  const st = SM, multi = S.all || new Set(st.rows.map(r => r.store)).size > 1;
  const wrap = h('div', 'sm-tblwrap');
  const tbl = h('table', 'sm-tbl', null, { id: 'smTbl' });
  const thr = h('tr');
  const th0 = h('th', 'sm-c-pick'), all = h('input', null, null, { type: 'checkbox', id: 'smAll', 'aria-label': '全選目前列出的' });
  all.checked = rows.every(r => st.picked.has(r.key)); all.indeterminate = !all.checked && rows.some(r => st.picked.has(r.key));
  all.onchange = () => { rows.forEach(r => (all.checked ? st.picked.add(r.key) : st.picked.delete(r.key))); drawOut(out); };
  th0.append(all); thr.append(th0);
  if (multi) thr.append(h('th', null, '門市'));
  COLS.forEach(([k, label]) => thr.append(h('th', 'sm-c-' + k, label)));
  tbl.append(h('thead')); tbl.tHead.append(thr);
  const tb = h('tbody');
  for (const r of rows) {
    const tr = h('tr', 'sm-row' + (r.flag ? ' sm-flag-' + r.flag : '') + (r.src === 'final' ? ' sm-final' : ''), null, { 'data-key': r.key, 'data-kind': r.kind, 'data-status': r.status });
    if (r.flag) tr.setAttribute('data-flag', r.flag);
    const td0 = h('td', 'sm-c-pick');
    const c = h('input', 'sm-pick', null, { type: 'checkbox', 'aria-label': '勾選 ' + r.name + ' ' + shortDate(r.date) + ' ' + r.kindLabel });
    c.checked = st.picked.has(r.key);
    c.onchange = () => { if (c.checked) st.picked.add(r.key); else st.picked.delete(r.key); drawOut(out); };
    td0.append(c); tr.append(td0);
    if (multi) tr.append(h('td', 'sm-c-store', r.storeName || '—', { 'data-l': '門市' }));
    COLS.forEach(([k, label, f]) => {
      const td = h('td', 'sm-c-' + k, null, { 'data-l': label });
      if (k === 'flag' && r.flag) td.append(h('span', 'sm-flag ' + r.flag, r.flagLabel));
      else if (k === 'st') td.append(h('span', 'sm-st ' + r.status, r.statusLabel));
      else td.textContent = f(r);
      tr.append(td);
    });
    tb.append(tr);
  }
  tbl.append(tb); wrap.append(tbl);
  return wrap;
}

// ---- 列印（spec §5 A、B）：把列印內容放在 body 底下的 #smPrint，body 加 class 讓列印時只印它；@page 動態插入，印完（afterprint）全部移掉 ----
function cleanupPrint() {
  document.body.classList.remove('sm-print-list', 'sm-print-slip');
  const a = document.getElementById('smPrint'); if (a) a.remove();
  const b = document.getElementById('smPageStyle'); if (b) b.remove();
}
function doPrint(mode, node) {
  cleanupPrint();
  document.body.append(node);
  const stl = document.createElement('style');
  stl.id = 'smPageStyle';
  stl.textContent = '@page{size:A4 ' + (mode === 'list' ? 'landscape' : 'portrait') + ';margin:10mm}';
  document.head.append(stl);
  document.body.classList.add(mode === 'list' ? 'sm-print-list' : 'sm-print-slip');
  const done = () => { window.removeEventListener('afterprint', done); if (node.isConnected) cleanupPrint(); };
  window.addEventListener('afterprint', done);
  // 印不出來，或 afterprint 不會來（部分手機內嵌瀏覽器）：也要收掉列印內容，免得之後用瀏覽器自己的列印印到舊資料（2026-11-02 審查）
  try { window.print(); } catch (e) { done(); return; }
  setTimeout(done, 60000);
}
const printDate = () => { const d = taipeiToday(); return d.slice(0, 4) + '/' + d.slice(5, 7) + '/' + d.slice(8, 10); };
const statusWord = () => (SM.f.status === 'all' ? '全部' : '已核准');

// 依門市分節（列已照門市排序）；全部門市時每家店另起新頁
// 全部門市：先照勾選、讀得到的門市開節（篩選後零筆的店也要有一節「這個月沒有符合的資料」，2026-11-03 審查）
function byStore(rows) {
  const m = new Map();
  if (S.all) for (const x of SM.storeList || []) if (!SM.f.stores || SM.f.stores.indexOf(x.code) >= 0) m.set(x.code, { name: x.name, rows: [] });
  for (const r of rows) { if (!m.has(r.store)) m.set(r.store, { name: r.storeName || storeNameOf(), rows: [] }); m.get(r.store).rows.push(r); }
  return [...m.values()];
}
function totLines(t) {
  const types = Object.keys(t.leaveByType).sort();
  return [
    ['筆數', '請假 ' + t.count.leave + '、加班 ' + t.count.ot + '、出差 ' + t.count.trip + '、忘打卡 ' + t.count.miss],
    ['請假核定時數', types.length ? types.map(k => k + ' ' + H(t.leaveByType[k]) + ' 小時').join('、') + '（合計 ' + H(t.leaveHours) + ' 小時）' : '0 小時'],
    ['出差核定時數', H(t.tripHours) + ' 小時'],
    ['加班申請時數（已核准）', H(t.otHours) + ' 小時（' + OT_NOTE + '）'],
    ['要確認', t.check + ' 筆'],
  ];
}
function listDoc(rows, failed) {
  const doc = h('div', 'sm-print sm-print-listdoc', null, { id: 'smPrint' });
  const secs = byStore(rows);
  if (!secs.length) secs.push({ name: S.all ? '全部門市' : storeNameOf(), rows: [] });
  secs.forEach(sec => {
    const s = h('section', 'sm-p-sec');
    const hd = h('div', 'sm-p-head');
    hd.append(h('div', 'sm-p-title', '申請單彙整表'));
    hd.append(h('div', 'sm-p-meta', '門市：' + (sec.name || '—') + '　' + ymLabel(SM.ym) + '　狀態：' + statusWord() + '　列印日期：' + printDate()));
    if (failed.length) hd.append(h('div', 'sm-p-miss', missText(failed)));
    s.append(hd);
    const tbl = h('table', 'sm-p-tbl'), cg = h('colgroup');
    COLS.forEach(([k]) => cg.append(h('col', 'sm-pc-' + k)));
    tbl.append(cg);
    const thr = h('tr'); COLS.forEach(([, label]) => thr.append(h('th', null, label)));
    tbl.append(h('thead')); tbl.tHead.append(thr);
    const tb = h('tbody');
    if (!sec.rows.length) { const tr = h('tr'); tr.append(h('td', 'sm-p-none', '這個月沒有符合的資料', { colspan: String(COLS.length) })); tb.append(tr); }
    sec.rows.forEach(r => { const tr = h('tr', r.flag ? 'sm-flag-' + r.flag : null); COLS.forEach(([k, , f]) => tr.append(h('td', 'sm-p-' + k, f(r)))); tb.append(tr); });
    tbl.append(tb); s.append(tbl);
    const end = h('div', 'sm-p-end');
    const tt = h('table', 'sm-p-tot');
    totLines(totals(sec.rows)).forEach(([a, b]) => { const tr = h('tr'); tr.append(h('th', null, a), h('td', null, b)); tt.append(tr); });
    end.append(h('div', 'sm-p-subt', '合計'), tt, signs(['店長', '人資']));
    s.append(end);
    doc.append(s);
  });
  return doc;
}
function signs(who) {
  const w = h('div', 'sm-p-signs');
  who.forEach(x => { const b = h('div', 'sm-p-sign'); b.append(h('div', 'sm-p-sign-l', x + '簽名'), h('div', 'sm-p-sign-box')); w.append(b); });
  return w;
}
function slipDoc(rows) {
  const doc = h('div', 'sm-print sm-print-slipdoc', null, { id: 'smPrint' });
  rows.forEach(r => {
    const s = h('section', 'sm-slip');
    s.append(h('div', 'sm-s-org', '鼎兆元餐飲集團｜' + (r.storeName || storeNameOf() || '—')));
    s.append(h('div', 'sm-s-title', (SLIP_TITLE[r.kind] || r.kindLabel) + (r.standalone ? '（核定紀錄）' : '')));
    const tbl = h('table', 'sm-s-tbl');
    const add = (a, b) => { const tr = h('tr'); tr.append(h('th', null, a), h('td', null, b == null || b === '' ? '—' : String(b))); tbl.append(tr); };
    add('同仁', empText(r));
    add('日期', r.date ? r.date.replace(/-/g, '/') : '');
    add('時段', r.time);
    add(r.kind === 'miss' ? '忘打卡類型' : '假別', r.kind === 'trip' ? '出差' : r.type);
    add('申請時數', r.reqHours != null ? H(r.reqHours) + ' 小時' : '');
    add('核定時數', r.finalText === MERGED ? MERGED : r.finalHours != null ? H(r.finalHours) + ' 小時' : '');
    add('出差地點', r.place);
    add('事由', r.reason);
    add('證明', attachText(r) === '—' ? '' : attachText(r) === '有' ? '有附證明' : '無');
    add('狀態', r.statusLabel + (r.reject_reason ? '（退回理由：' + r.reject_reason + '）' : '') + (r.void_reason ? '（作廢理由：' + r.void_reason + '）' : ''));
    add('標示', r.flagLabel);
    add('送出時間', ts(r.created_at));
    add('核准人', r.decided_by);
    add('核准時間', ts(r.decided_at));
    s.append(tbl, signs(['申請人', '主管', '人資']));
    s.append(h('div', 'sm-s-foot', '列印日期：' + printDate()));
    doc.append(s);
  });
  return doc;
}

// ---- 匯出 Excel（spec §5 C）：SheetJS mini 版按了才載入；明細＋合計兩個分頁；讀不到的店寫在兩個分頁第一列；文字開頭 = + - @ 補單引號 ----
let xlsxP = null;
export function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (xlsxP) return xlsxP;
  xlsxP = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = new URL('../../vendor/xlsx.mini.min.js', import.meta.url).href;
    s.onload = () => (window.XLSX ? res(window.XLSX) : rej(new Error('Excel 元件載入失敗')));
    s.onerror = () => rej(new Error('Excel 元件載入失敗，請檢查網路後再試'));
    document.head.append(s);
  }).catch(e => { xlsxP = null; throw e; });
  return xlsxP;
}
async function exportXlsx(rows, failed, btn, msg) {
  btn.disabled = true; msg.className = 'sm-msg'; msg.textContent = '產生中…';
  try {
    const X = await loadXlsx();
    const safe = a => a.map(v => xlsSafe(v));
    const miss = failed.length ? [[missText(failed)]] : [];
    const head = ['門市'].concat(COLS.map(c => c[1]));
    const body = rows.map(r => safe([r.storeName || storeNameOf(), r.date].concat(COLS.slice(1).map(([k, , f]) => (k === 'req' ? (r.reqHours != null ? r.reqHours : '—')
      : k === 'fin' ? (r.finalText ? r.finalText : r.finalHours != null ? r.finalHours : '—') : f(r))))));
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(miss.concat([head], body)), '明細');
    const tot = [['申請單彙整合計'], ['月份', ymLabel(SM.ym)], ['狀態篩選', statusWord()]];
    const secs = byStore(rows);
    const block = (title, rs) => { tot.push([]); tot.push(safe([title])); totLines(totals(rs)).forEach(x => tot.push(safe(x))); };
    if (secs.length > 1) secs.forEach(sec => block(sec.name || '—', sec.rows));
    block(secs.length > 1 ? '全部合計' : (secs[0] ? secs[0].name : storeNameOf()) || '合計', rows);
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet(miss.concat(tot)), '合計');
    const buf = X.write(wb, { bookType: 'xlsx', type: 'array' });
    const one = S.all ? (secs.length === 1 && SM.f.stores && SM.f.stores.length === 1 ? secs[0].name : '全部') : storeNameOf() || '門市';
    const name = '申請單彙整_' + String(one).replace(/[\\/:*?"<>|]/g, '') + '_' + SM.ym + '.xlsx';
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = h('a', null, null, { href: url, download: name }); a.style.display = 'none';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    msg.textContent = '已匯出：' + name;
  } catch (e) { msg.className = 'sm-msg bad'; msg.textContent = '✕ ' + ((e && e.message) || '匯出沒有成功，請再試一次'); }
  btn.disabled = false;
}
