// 值班核定：四個分頁共用的狀態與呼叫。換了登入就整包重來（不留上一個人的資料）。
import { api } from '../../js/api.js';

const FLAG = 'dzystore_dutyok';
export const S = { key: null, meta: { clockStore: '', label: '', breakStart: '', breakEnd: '' }, date: null, dayCache: {}, dayTok: 0,
  pend: null, pendAll: false, focusEmp: null, rerender: null };

export function reset(key) {
  S.key = key; S.meta = { clockStore: '', label: '', breakStart: '', breakEnd: '' }; S.date = null; S.dayCache = {}; S.dayTok++;
  S.pend = null; S.pendAll = false; S.focusEmp = null;
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
