// 出勤核定：四個分頁共用的狀態與呼叫。換了登入就整包重來（不留上一個人的資料）。
import { api } from '../../js/api.js';

const FLAG = 'dzystore_dutyok';
export const S = { key: null, meta: { clockStore: '', label: '', breakStart: '', breakEnd: '' }, date: null, dayCache: {}, dayTok: 0,
  pend: null, pendAll: false, focusEmp: null, rerender: null, leave: null, leaveP: null };

export function reset(key) {
  S.key = key; S.meta = { clockStore: '', label: '', breakStart: '', breakEnd: '' }; S.date = null; S.dayCache = {}; S.dayTok++;
  S.pend = null; S.pendAll = false; S.focusEmp = null; S.leave = null; S.leaveP = null; S.reqCount = 0; S.reqAt = 0;
}

// 呼叫 /m/duty/<action>；回應裡的 meta（店別與休息帶）順手記下。核定通行碼失效（後台重設、換了登入）就退回輸入畫面。
export async function call(action, body) {
  try {
    const r = await api('POST', '/m/duty/' + action, body || {});
    if (r && r.meta) S.meta = r.meta;
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
}
export function refreshReqBadge() {
  if (S.reqAt && Date.now() - S.reqAt < 60000) return setReqBadge(S.reqCount || 0);
  const k = S.key;
  call('mgr_req_pending').then(r => { if (S.key === k) setReqBadge(Array.isArray(r && r.items) ? r.items.length : 0); }, () => {});
}

export const brk = () => ({ start: S.meta.breakStart, end: S.meta.breakEnd });

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
  if (!S.leaveP) {
    const k = S.key;
    S.leaveP = call('payroll_leave_options').then(r => { if (S.key === k) { S.leave = r && Array.isArray(r.types) ? r : null; if (!S.leave) S.leaveP = null; } return S.leave; },
      () => { if (S.key === k) S.leaveP = null; return null; });
  }
  return S.leaveP;
}
export function staleLeave() { S.leave = null; S.leaveP = null; }
