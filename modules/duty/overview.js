// 出勤核定：管理者的「各店總覽」與門市切換（2026-10-11 Eason：系統管理員看得到所有門市的出勤核定狀況、也能代核）。
// 總覽每家店一列：本月沒核定幾天、待審申請幾筆、待核准手機幾支（跟首頁待辦同三支查詢）；點數字或「進入」就切到那家店的分頁。
// 其他分頁上方有門市選單；選了之後每次呼叫都帶 asStore，伺服器照那家店的打卡對照轉送。
import { S, call, setStore, h, failBar, multiStores, rememberOne } from './state.js';
import { ssoSwitch, setSession, toSession } from '../../js/auth.js';
import { api } from '../../js/api.js';

function loadStores() {
  if (S.stores) return Promise.resolve(S.stores);
  const k = S.key;
  return call('admin_stores').then(r => { const list = Array.isArray(r && r.stores) ? r.stores : []; if (S.key === k) S.stores = list; return list; });
}

const COLS = [
  { k: 'approve', label: '本月沒核定', unit: '天', action: 'mgr_pending_approvals', count: r => (Array.isArray(r && r.items) ? new Set(r.items.map(x => x && x.date)).size : null) },
  { k: 'request', label: '待審申請', unit: '筆', action: 'mgr_req_pending', count: r => (Array.isArray(r && r.items) ? r.items.filter(it => !(it && it.self === true)).length : null) },
  { k: 'device', label: '待核准手機', unit: '支', action: 'mgr_pending_devices', count: r => (Array.isArray(r && r.pending) ? r.pending.length : null) },
];

function go(st, tab) { setStore(st.code, st.name); location.hash = '#/duty/' + tab; }

export function renderOverview(ctx) {
  const el = ctx.el;
  el.innerHTML = '';
  const card = h('div', 'card');
  card.append(h('h2', null, '各店出勤核定狀況'));
  card.append(h('p', 'hint', '每家店本月還沒核定的天數、待審的加班請假申請、等核准的新手機。點數字或「進入」可以直接看那家店，也可以替該店核定。'));
  const box = h('div', 'du-ov'); card.append(box);
  const row = h('div', 'row mt');
  const reload = h('button', 'btn sm ghost', '重新整理', { type: 'button', id: 'duOvReload' });
  reload.onclick = () => { S.stores = null; renderOverview(ctx); };
  row.append(reload); card.append(row);
  el.append(card);
  box.append(h('p', 'hint', '讀取中…'));
  const tok = ++S.dayTok;
  loadStores().then(stores => {
    if (tok !== S.dayTok || !el.isConnected) return;
    box.innerHTML = '';
    if (!stores.length) { box.append(h('p', 'hint', '還沒有門市設定打卡系統（後台管理 › 門市對照）。')); return; }
    const tbl = h('table', 'du-ov-tbl', null, { id: 'duOvTbl' });
    const thr = h('tr');
    thr.append(h('th', null, '門市'));
    COLS.forEach(c => thr.append(h('th', 'num', c.label)));
    thr.append(h('th'));
    tbl.append(h('thead')); tbl.tHead.append(thr);
    const tb = h('tbody'); tbl.append(tb);
    for (const st of stores) {
      const tr = h('tr', null, null, { 'data-store': st.code });
      const nm = h('td'); nm.append(h('b', null, st.name)); nm.append(h('div', 'du-hint', st.code + '・' + st.label));
      tr.append(nm);
      const cells = COLS.map(() => { const td = h('td', 'num', '…'); tr.append(td); return td; });
      const act = h('td', 'num');
      const enter = h('button', 'btn sm du-ov-enter', '進入', { type: 'button' });
      enter.onclick = () => go(st, 'approve');
      act.append(enter); tr.append(act);
      tb.append(tr);
      COLS.forEach((c, i) => {
        api('POST', '/m/duty/' + c.action, { asStore: st.code }).then(r => {
          if (tok !== S.dayTok) return;
          const n = c.count(r);
          cells[i].textContent = '';
          if (n == null) { cells[i].append(h('span', 'du-ov-bad', '讀不到')); return; }
          if (!n) { cells[i].append(h('span', 'du-ov-zero', '0')); return; }
          const b = h('button', 'du-ov-go', n + ' ' + c.unit, { type: 'button', 'data-k': c.k });
          b.onclick = () => go(st, c.k);
          cells[i].append(b);
        }, e => {
          if (tok !== S.dayTok) return;
          cells[i].textContent = '';
          cells[i].append(h('span', 'du-ov-bad', '讀不到', { title: (e && e.message) || '' }));
        });
      });
    }
    box.append(tbl);
  }, e => { if (tok === S.dayTok && el.isConnected) failBar(box, '門市清單', e, () => renderOverview(ctx)); });
}

// 管理者在一般分頁：上方畫門市選單。回傳放分頁內容的容器；還沒選門市就回 null（只畫選單與說明）。
export function storeBar(ctx) {
  const el = ctx.el;
  el.innerHTML = '';
  const bar = h('div', 'du-store-bar');
  bar.append(h('label', null, '正在看的門市', { for: 'duStoreSel' }));
  const sel = h('select', null, null, { id: 'duStoreSel' });
  sel.append(h('option', null, S.stores ? '請選門市…' : '讀取中…', { value: '' }));
  for (const st of S.stores || []) {
    const o = h('option', null, st.name + '（' + st.code + '）', { value: st.code });
    if (st.code === S.asStore) o.selected = true;
    sel.append(o);
  }
  sel.onchange = () => {
    const st = (S.stores || []).find(x => x.code === sel.value);
    setStore(st ? st.code : '', st ? st.name : '');
    ctx.rerender();
  };
  bar.append(sel);
  bar.append(h('a', 'du-ov-back', '← 回各店總覽', { href: '#/duty/overview' }));
  el.append(bar);
  if (!S.stores) loadStores().then(() => { if (sel.isConnected) ctx.rerender(); }, e => { if (sel.isConnected) { const f = h('div'); el.append(f); failBar(f, '門市清單', e, () => ctx.rerender()); } });
  if (!S.asStore) {
    const c = h('div', 'card');
    c.append(h('p', 'hint', '先選一家門市，就能看那家店的核定工時、申請審核、裝置、名冊與公告，也可以直接替該店核定。'));
    el.append(c);
    return null;
  }
  bar.append(h('div', 'du-hint', '你正以管理者身分看「' + S.asName + '」：在這裡核定、核准或修改，會直接寫進該店的打卡系統。'));
  const body = h('div');
  el.append(body);
  return body;
}

// 個人登入、可核的人分布在兩家以上打卡店（2026-10-19）：上方門市選單，最上面「全部門市（N 家）」、預設選它。
// 選單一門市＝回到原本的單店畫面（目前登入的店直接切；別家店走「換店」換新 token）。回傳放分頁內容的容器。
export function personStoreBar(ctx) {
  const s = ctx.session, list = multiStores(s), el = ctx.el;
  el.innerHTML = '';
  const bar = h('div', 'du-store-bar');
  bar.append(h('label', null, '正在看的門市', { for: 'duStoreSel' }));
  const sel = h('select', null, null, { id: 'duStoreSel' });
  sel.append(h('option', null, '全部門市（' + list.length + ' 家）', { value: 'ALL' }));
  const opts = list.some(x => x.code === s.code) ? list : [{ code: s.code, name: s.name }, ...list];
  for (const st of opts) sel.append(h('option', null, st.name, { value: st.code }));
  sel.value = S.all ? 'ALL' : s.code;
  sel.onchange = async () => {
    if (sel.value === 'ALL') { rememberOne(''); return ctx.rerender(); }
    if (sel.value === s.code) { rememberOne(s.token); return ctx.rerender(); }
    sel.disabled = true;
    try {
      const d = await ssoSwitch(sel.value);
      setSession(toSession(d)); rememberOne(d.token);
      location.reload();
    } catch (e) { sel.disabled = false; sel.value = S.all ? 'ALL' : s.code; bar.append(h('div', 'du-fail-msg', '換店失敗：' + ((e && e.message) || '請稍後再試'))); }
  };
  bar.append(sel);
  el.append(bar);
  if (S.all) bar.append(h('div', 'du-hint', '合併顯示你可核定的 ' + list.length + ' 家門市，每位同仁標出打卡地點。打卡 QR、公告、員工名冊、裝置核准、新增同仁這些整店功能，請切到單一門市。'));
  const body = h('div');
  el.append(body);
  return body;
}
