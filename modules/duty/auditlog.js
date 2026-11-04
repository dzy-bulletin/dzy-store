// 核定紀錄（2026-11-04）：誰在什麼時候核了什麼——工時核定（含重核）、申請的送出／核准／退回／取消／作廢、裝置核准／拒絕。
// 資料：mgr_req_month 的 log 欄位（和申請單彙整同一支，伺服器已依人過濾）；換月份才重讀，其他篩選只在前端。只讀。
import { S, call, callAll, h } from './state.js';
import { taipeiToday, tsLabel, shortDate } from './calc.js';
import { defaultYm, ymAdd, ymLabel, xlsSafe } from './summary-calc.js';
import { css, loadXlsx } from './summary.js';

export const ACTION_LABEL = { hours: '工時核定', rehours: '工時重核', recheck: '系統重算', submit: '申請送出', approve: '申請核准', reject: '申請退回',
  cancel: '申請取消', void: '申請作廢', device_ok: '裝置核准', device_no: '裝置拒絕' };
// 篩選用的分組
export const GROUPS = [['', '全部動作'], ['hours', '工時核定（含重核）'], ['approve', '申請核准'], ['reject', '申請退回'], ['void', '申請作廢'], ['submit', '申請送出／取消'], ['device', '裝置核准／拒絕']];
const GROUP_OF = { hours: 'hours', rehours: 'hours', recheck: 'hours', approve: 'approve', reject: 'reject', void: 'void', submit: 'submit', cancel: 'submit', device_ok: 'device', device_no: 'device' };

export const contentOf = e => {
  const d = e.detail || {};
  if (e.kind === 'hours') return (d.hours != null ? Math.round(d.hours * 100) / 100 + ' 小時' : '') + (d.status ? '・' + d.status : '') + (d.periods ? '（' + d.periods + '）' : '');
  if (e.kind === 'req') return [d.summary, d.reason ? '原因：' + d.reason : ''].filter(Boolean).join('・');
  return '';
};
export const byText = e => (e.by || '—') + (e.system ? '（系統重算）' : '');
export function filterLog(log, f) {
  const emp = String(f.emp || '').trim().toLowerCase(), by = String(f.by || '').trim().toLowerCase();
  return log.filter(e => (!f.stores || f.stores.indexOf(e.store) >= 0) && (!f.group || GROUP_OF[e.action] === f.group)
    && (!emp || (e.name + ' ' + e.emp_id).toLowerCase().indexOf(emp) >= 0) && (!by || String(e.by || '').toLowerCase().indexOf(by) >= 0));
}

let AL = null;
const ctxKey = () => [S.key, S.all ? 'ALL' : '', S.asStore].join('|');
function state() {
  if (!AL || AL.ck !== ctxKey()) AL = { ck: ctxKey(), ym: defaultYm(taipeiToday()), data: null, log: [], err: null, tok: 0, open: new Set(), f: { stores: null, group: '', emp: '', by: '' } };
  return AL;
}
const notReady = e => !!e && ((e.code === 'NOT_FOUND' && /找不到這個功能/.test(e.message || '')) || e.code === 'BAD_ACTION' || (e.code === 'BAD_INPUT' && /不支援全部門市/.test(e.message || '')));

export function renderAuditLog(ctx) {
  css();
  const st = state(), el = ctx.el;
  el.innerHTML = '';
  const bar = h('div', 'card sm-bar'), out = h('div', 'sm-out', null, { id: 'alOut' });
  el.append(bar, out);
  drawBar(bar, out);
  if (st.data || st.err) drawOut(out); else load(out);
}

function load(out) {
  const st = AL, tok = ++st.tok, ck = st.ck;
  out.innerHTML = ''; out.append(h('div', 'card du-center', '載入中…'));
  (S.all ? callAll('mgr_req_month', { ym: st.ym }) : call('mgr_req_month', { ym: st.ym })).then(r => {
    if (!AL || AL.ck !== ck || tok !== st.tok) return;
    st.err = null; st.data = r || {};
    const one = S.all ? '' : (S.asStore ? S.asName : '');
    st.log = (Array.isArray(st.data.log) ? st.data.log : []).map(e => Object.assign({ store: '', storeName: one }, e));
    st.storeList = S.all ? (Array.isArray(st.data.stores) ? st.data.stores.filter(x => x && x.ok).map(x => ({ code: x.store, name: x.storeName })) : []) : [];
    if (st.f.stores) st.f.stores = st.f.stores.filter(c => st.storeList.some(x => x.code === c));
    if (out.isConnected) { const bar = out.previousElementSibling; if (bar) drawBar(bar, out); drawOut(out); }
  }, e => {
    if (!AL || AL.ck !== ck || tok !== st.tok) return;
    st.err = e; st.data = null; st.log = [];
    if (out.isConnected) drawOut(out);
  });
}

function drawBar(bar, out) {
  const st = AL;
  bar.innerHTML = '';
  bar.append(h('h2', 'sm-h', '核定紀錄'));
  bar.append(h('p', 'hint', '每一筆核定是誰、什麼時候做的：工時核定（含重核）、申請的送出、核准、退回、取消、作廢，以及裝置核准。只能看、匯出，不能在這裡改。申請單的紀錄看得到的範圍和「申請單彙整」一樣；裝置核准從 11/4 起才開始記。'));
  const g = h('div', 'sm-filters');
  const fm = h('div', 'fld sm-f'); fm.append(h('label', null, '月份', { for: 'alYm' }));
  const ym = h('select', null, null, { id: 'alYm' });
  const cur = taipeiToday().slice(0, 7);
  for (let i = 1; i >= -24; i--) { const v = ymAdd(cur, i); const o = h('option', null, ymLabel(v), { value: v }); if (v === st.ym) o.selected = true; ym.append(o); }
  ym.onchange = () => { st.ym = ym.value; st.data = null; st.err = null; st.open = new Set(); load(out); };
  fm.append(ym); g.append(fm);
  if (S.all) {
    const fs = h('div', 'fld sm-f sm-f-wide'); fs.append(h('label', null, '門市'));
    const box = h('div', 'sm-checks');
    for (const x of st.storeList || []) {
      const lab = h('label', 'sm-chk'), c = h('input', 'sm-store', null, { type: 'checkbox', 'data-k': x.code });
      c.checked = !st.f.stores || st.f.stores.indexOf(x.code) >= 0;
      c.onchange = () => { const on = [...box.querySelectorAll('.sm-store')].filter(i => i.checked).map(i => i.dataset.k); st.f.stores = on.length === (st.storeList || []).length ? null : on; drawOut(out); };
      lab.append(c, document.createTextNode(x.name)); box.append(lab);
    }
    if (!(st.storeList || []).length) box.append(h('span', 'sm-muted', st.data ? '沒有讀得到的門市' : '讀取中…'));
    fs.append(box); g.append(fs);
  }
  const fa = h('div', 'fld sm-f'); fa.append(h('label', null, '動作', { for: 'alGroup' }));
  const gs = h('select', null, null, { id: 'alGroup' });
  for (const [v, t] of GROUPS) gs.append(h('option', null, t, { value: v }));
  gs.value = st.f.group; gs.onchange = () => { st.f.group = gs.value; drawOut(out); };
  fa.append(gs); g.append(fa);
  const fe = h('div', 'fld sm-f'); fe.append(h('label', null, '同仁', { for: 'alEmp' }));
  const ei = h('input', null, null, { id: 'alEmp', type: 'search', placeholder: '姓名或員編', autocomplete: 'off' });
  ei.value = st.f.emp; ei.oninput = () => { st.f.emp = ei.value; drawOut(out); };
  fe.append(ei); g.append(fe);
  const fb = h('div', 'fld sm-f'); fb.append(h('label', null, '核定人', { for: 'alBy' }));
  const bi = h('input', null, null, { id: 'alBy', type: 'search', placeholder: '姓名或帳號', autocomplete: 'off' });
  bi.value = st.f.by; bi.oninput = () => { st.f.by = bi.value; drawOut(out); };
  fb.append(bi); g.append(fb);
  bar.append(g);
}

function drawOut(out) {
  const st = AL;
  out.innerHTML = '';
  if (st.err) {
    out.append(h('div', 'card', notReady(st.err) ? '核定紀錄還沒開通（伺服器還沒更新），更新後就會出現。' : ((st.err && st.err.message) || '暫時讀不到，請稍後再試')));
    return;
  }
  const failed = st.data && Array.isArray(st.data.failed) ? st.data.failed : [];
  if (failed.length) out.append(h('div', 'sm-failed', '有 ' + failed.length + ' 家門市暫時讀不到：' + failed.map(x => x.storeName || x.store).join('、') + '（其他門市的紀錄照常顯示）'));
  const rows = filterLog(st.log, st.f);
  const top = h('div', 'sm-top');
  top.append(h('span', 'hint', '共 ' + rows.length + ' 筆・依時間新到舊。「看歷史」會展開同一件事的前後紀錄。'));
  const msg = h('div', 'sm-msg', '', { role: 'status' });
  const ex = h('button', 'btn ghost', '匯出 Excel', { type: 'button', id: 'alExport' });
  ex.disabled = !rows.length; ex.onclick = () => exportXlsx(rows, ex, msg);
  top.append(ex);
  out.append(top, msg);
  if (!rows.length) { out.append(h('div', 'card du-center', st.log.length ? '這些篩選條件下沒有紀錄' : ymLabel(st.ym) + '沒有核定紀錄')); return; }
  const wrap = h('div', 'sm-tblwrap'); wrap.style.overflowX = 'auto';
  const tbl = h('table', 'sm-tbl'); tbl.style.minWidth = '720px';
  const head = ['時間'].concat(S.all ? ['門市'] : [], ['同仁・日期', '動作', '內容', '核定人', '']);
  const thead = h('thead'), hr = h('tr');
  for (const t of head) hr.append(h('th', null, t));
  thead.append(hr); tbl.append(thead);
  const body = h('tbody');
  for (const e of rows) {
    const tr = h('tr', 'al-row');
    tr.append(h('td', null, tsLabel(e.at)));
    if (S.all) tr.append(h('td', null, e.storeName || ''));
    const who = h('td'); who.append(document.createTextNode(e.name + (e.emp_id ? '（' + e.emp_id + '）' : '')), h('div', 'sm-muted', shortDate(e.date)));
    tr.append(who, h('td', null, ACTION_LABEL[e.action] || e.action), h('td', null, contentOf(e) || '—'), h('td', null, byText(e)));
    const k = (e.store || '') + '|' + e.ref;
    const same = st.log.filter(x => (x.store || '') === (e.store || '') && x.ref === e.ref);
    const cell = h('td');
    if (same.length > 1) {
      const b = h('button', 'btn ghost al-hist', st.open.has(k) ? '收起' : '看歷史', { type: 'button', 'aria-expanded': st.open.has(k) ? 'true' : 'false' });
      b.onclick = () => { if (st.open.has(k)) st.open.delete(k); else st.open.add(k); drawOut(out); };
      cell.append(b);
    }
    tr.append(cell); body.append(tr);
    if (same.length > 1 && st.open.has(k)) {
      const dr = h('tr', 'al-detail'), dc = h('td', null, null, { colspan: String(head.length) });
      const ul = h('ul'); ul.style.cssText = 'margin:0;padding:0;list-style:none;display:grid;gap:4px';
      same.slice().sort((a, b) => (a.at < b.at ? 1 : -1)).forEach((x, i) => {
        const li = h('li', null, tsLabel(x.at) + '　' + byText(x) + '：' + (ACTION_LABEL[x.action] || x.action) + (contentOf(x) ? '（' + contentOf(x) + '）' : ''));
        if (i === 0) li.style.fontWeight = '700';
        ul.append(li);
      });
      dc.append(ul); dr.append(dc); body.append(dr);
    }
  }
  tbl.append(body); wrap.append(tbl); out.append(wrap);
}

async function exportXlsx(rows, btn, msg) {
  btn.disabled = true; msg.className = 'sm-msg'; msg.textContent = '產生中…';
  try {
    const X = await loadXlsx();
    const safe = a => a.map(v => xlsSafe(v));
    const head = ['時間', '門市', '同仁', '員編', '工作日期', '動作', '內容', '核定人'];
    const body = rows.map(e => safe([e.at, e.storeName || '', e.name, e.emp_id, e.date, ACTION_LABEL[e.action] || e.action, contentOf(e), byText(e)]));
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([head].concat(body)), '核定紀錄');
    const buf = X.write(wb, { bookType: 'xlsx', type: 'array' });
    const name = '核定紀錄_' + AL.ym + '.xlsx';
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = h('a', null, null, { href: url, download: name }); a.style.display = 'none';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    msg.textContent = '已匯出：' + name;
  } catch (e) { msg.className = 'sm-msg bad'; msg.textContent = '✕ ' + ((e && e.message) || '匯出沒有成功，請再試一次'); }
  btn.disabled = false;
}
