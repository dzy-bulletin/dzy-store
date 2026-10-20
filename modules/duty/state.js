// 出勤核定：四個分頁共用的狀態與呼叫。換了登入就整包重來（不留上一個人的資料）。
import { api } from '../../js/api.js';

const FLAG = 'dzystore_dutyok';
// 管理者（2026-10-11 Eason：看得到所有門市、也能代核）：asStore＝正在看的門市代號，每次呼叫自動帶上；stores＝各店總覽讀到的門市清單。
export const S = { key: null, admin: false, asStore: '', asName: '', stores: null, meta: { clockStore: '', label: '', breakStart: '', breakEnd: '' }, date: null, dayCache: {}, dayTok: 0,
  pend: null, pendAll: false, focusEmp: null, rerender: null, leave: null, leaveP: null,
  all: false, metaBy: {}, leaveBy: {} };   // all＝個人登入「全部門市」模式（2026-10-19）；metaBy／leaveBy＝各店的休息帶與假別額度（以營運系統門市代號為鍵）

export function reset(key) {
  S.key = key; S.asStore = ''; S.asName = ''; S.stores = null; S.meta = { clockStore: '', label: '', breakStart: '', breakEnd: '' }; S.date = null; S.dayCache = {}; S.dayTok++;
  S.pend = null; S.pendAll = false; S.focusEmp = null; S.leave = null; S.leaveP = null; S.reqCount = 0; S.reqAt = 0; S.metaBy = {}; S.leaveBy = {};
}

// ---- 全部門市（個人登入、可核的人分布在兩家以上打卡店；2026-10-19）----
// session.attStores＝伺服器算好的那幾家店（少於兩家是空陣列）。預設進「全部門市」；選了單一門市之後記在 sessionStorage（綁當時的 token，換店會換 token，所以換店時要由換店的程式重記）。
const ONE_KEY = 'dzystore_dutyone';
export const multiStores = s => (s && s.person && Array.isArray(s.attStores) && s.attStores.length >= 2 ? s.attStores : []);
export function allModeOf(s) {
  if (!multiStores(s).length) return false;
  try { return sessionStorage.getItem(ONE_KEY) !== s.token; } catch (e) { return true; }
}
export function rememberOne(token) { try { if (token) sessionStorage.setItem(ONE_KEY, token); else sessionStorage.removeItem(ONE_KEY); } catch (e) {} }
// 換模式就整包重來（不同模式的名單、快取、額度不混）
export function setAll(on) { on = !!on; if (S.all !== on) { reset(S.key); S.all = on; } }
// 合併各店的讀取：伺服器 /m/duty/all，op＝要讀的單店動作。回應的 failed＝讀不到的店、stores[].meta＝各店休息帶
export async function callAll(op, body) {
  const k = S.key;
  const r = await call('all', Object.assign({ op }, body || {}));
  if (r && Array.isArray(r.stores) && S.key === k && S.all) for (const st of r.stores) if (st.ok && st.meta) S.metaBy[st.store] = st.meta;
  return r;
}
// 每一列自己的店（全部門市時列上有 store）：休息帶與假別額度各用各的店
export const leaveFor = store => (S.all ? (S.leaveBy[store] || null) : S.leave);
export const rowKey = r => (r && r.store ? r.store + '|' : '') + String(r && r.emp_id);
// 某店讀不到的提示條（全部門市時，其他店照常顯示）
export function failedStores(el, failed, retry) {
  if (!failed || !failed.length) return;
  const bar = h('div', 'du-fail du-fail-stores');
  bar.append(h('span', 'du-fail-msg', failed.map(f => f.storeName + '暫時讀不到').join('、') + '（其他門市照常顯示）'));
  if (retry) { const b = h('button', 'btn sm ghost', '重新載入', { type: 'button' }); b.onclick = () => { b.disabled = true; b.textContent = '載入中…'; retry(); }; bar.append(b); }
  el.append(bar);
}

// 管理者換門市：清掉上一家店的資料（日期、核定快取、假別額度、待審數），只保留門市清單
export function setStore(code, name) {
  const stores = S.stores;
  reset(S.key);
  S.stores = stores; S.asStore = code || ''; S.asName = name || '';
}

// 呼叫 /m/duty/<action>；回應裡的 meta（店別與休息帶）順手記下。核定通行碼失效（後台重設、換了登入）就退回輸入畫面。
export async function call(action, body) {
  try {
    const k = S.key, st = S.asStore;
    const r = await api('POST', '/m/duty/' + action, st ? Object.assign({}, body || {}, { asStore: st }) : (body || {}));
    if (r && r.meta && S.key === k && S.asStore === st) S.meta = r.meta;   // 管理者已經換店／換登入：上一家店晚到的回應不寫進來（2026-10-12 Codex 審查）
    return r;
  } catch (e) {
    if (e.code === 'FORBIDDEN' && /核定通行碼/.test(e.message)) { try { sessionStorage.removeItem(FLAG); } catch (x) {} if (S.rerender) S.rerender(); }
    else if (e.code === 'DUTY_MUST_CHANGE') { try { sessionStorage.setItem(FLAG, 'm'); } catch (x) {} if (S.rerender) S.rerender(); }
    throw e;
  }
}

// 「申請審核」分頁名稱旁的待審筆數（2026-10-09）。在申請審核分頁讀到清單、或核准／退回後直接更新；在其他分頁則背景問一次（60 秒內不重問）。
export function setReqBadge(n) {
  S.reqCount = n; S.reqAt = Date.now();
  const a = document.querySelector('nav.tabs a[data-tab="request"]');
  if (!a) return;
  a.querySelectorAll('.badge').forEach(b => b.remove());
  if (n > 0) { const i = document.createElement('i'); i.className = 'badge'; i.textContent = String(n); i.setAttribute('aria-label', n + ' 筆待審'); a.append(i); }
  window.dispatchEvent(new Event('dzystore-nav'));   // 嵌入管理系統時：頁頂分頁的數字跟著更新（shell.js postNav）
}
export function refreshReqBadge() {
  if (S.admin && !S.asStore) return;
  if (S.reqAt && Date.now() - S.reqAt < 60000) return setReqBadge(S.reqCount || 0);
  const k = S.key;
  (S.all ? callAll('mgr_req_pending') : call('mgr_req_pending')).then(r => { if (S.key === k) setReqBadge(Array.isArray(r && r.items) ? r.items.length : 0); }, () => {});
}

export const brk = store => { const m = (S.all && store && S.metaBy[store]) || S.meta; return { start: m.breakStart, end: m.breakEnd }; };

// 小工具：建元素（文字一律用 textContent，不拼 innerHTML）
export function h(tag, cls, text, attrs) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
  return e;
}

// 載入失敗提示條 + 重新載入（伺服器已自動重試過一次，這裡交給人按）
export function failBar(el, label, e, retry) {
  el.innerHTML = '';
  const bar = h('div', 'du-fail');
  bar.append(h('span', 'du-fail-msg', label + '沒載入成功：' + ((e && e.message) || '網路或伺服器忙碌')));
  const b = h('button', 'btn sm ghost', '重新載入', { type: 'button' });
  b.onclick = () => { b.disabled = true; b.textContent = '載入中…'; retry(); };
  bar.append(b);
  el.append(bar);
}

// 假別清單與額度（payroll_leave_options）：整個登入期間抓一次；抓不到靜默退回內建清單、只是沒有額度提示與硬擋（原頁同樣不擋人，manager.html:644–652）。
// 抓失敗不快取，下次進核定頁再試。核定了有假別的人之後，額度就舊了，同樣清掉讓下次重抓。
export function loadLeave() {
  if (S.leave) return Promise.resolve(S.leave);
  if (!S.leaveP && S.all) {                                               // 全部門市：各店各一份（by_store），讀不到的店安靜略過、只是沒有額度提示
    const k = S.key;
    const p = callAll('payroll_leave_options').then(r => {
      if (S.key !== k || S.leaveP !== p) return null;
      const by = {}; for (const [c, v] of Object.entries((r && r.by_store) || {})) if (v && Array.isArray(v.types)) by[c] = v;
      S.leaveBy = by; S.leave = Object.keys(by).length ? by : null; if (!S.leave) S.leaveP = null; return S.leave;
    }, () => { if (S.key === k && S.leaveP === p) S.leaveP = null; return null; });
    S.leaveP = p;
  }
  if (!S.leaveP) {
    const k = S.key, st = S.asStore;
    const same = () => S.key === k && S.asStore === st;                   // 管理者換店後，上一家店的假別不能套到新店
    const p = call('payroll_leave_options').then(r => { if (same() && S.leaveP === p) { S.leave = r && Array.isArray(r.types) ? r : null; if (!S.leave) S.leaveP = null; } return same() ? S.leave : null; },
      () => { if (same() && S.leaveP === p) S.leaveP = null; return null; });
    S.leaveP = p;
  }
  return S.leaveP;
}
export function staleLeave() { S.leave = null; S.leaveP = null; S.leaveBy = {}; S.leaveStale = true; }   // leaveStale：下次換日期先重抓額度再畫名單

// 個人登入且不是店長／人資主管／管理員：伺服器會擋打卡 QR、公告、新增同仁、設離職（proxy/duty.js manager_only），畫面就不顯示；門市帳號維持原樣
export const dutyManager = s => !(s && s.person && s.dutyManager === false);
