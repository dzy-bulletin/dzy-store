import { KEYS } from './config.js';
import { api, setHooks } from './api.js';

export function getSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEYS.session) || 'null');
    if (!s || !s.token) return null;
    if (s.expiresAt && Date.parse(s.expiresAt) <= Date.now()) { clearSession(); return null; }
    return s;
  } catch (e) { return null; }
}
export function setSession(s) { try { sessionStorage.setItem(KEYS.session, JSON.stringify(s)); } catch (e) {} }
export function clearSession() { try { sessionStorage.removeItem(KEYS.session); sessionStorage.removeItem('dzystore_dutyok'); sessionStorage.removeItem('dzystore_dutyone'); } catch (e) {} }
export function rememberedCode() { try { return localStorage.getItem(KEYS.code) || ''; } catch (e) { return ''; } }

export function initAuth(onLost, onMust) {
  setHooks({ onMust: () => { const s = getSession(); if (s) { s.mustChangePassword = true; setSession(s); } onMust(); }, getToken: () => (getSession() || {}).token || null, onAuth: () => { clearSession(); onLost(); } });
}

// 總部自填／央廚固定排班的店才有的欄位（docs/schedule-hq/spec.md §5）：沒有就是 undefined（存進 sessionStorage 時自然掉）
export const schedPart = d => ({ schedMode: d.schedMode || undefined, schedSelfOn: d.schedMode ? !!d.schedSelfOn : undefined, schedApproveOn: d.schedMode ? !!d.schedApproveOn : undefined,
  schedStores: Array.isArray(d.schedStores) && d.schedStores.length ? d.schedStores : undefined });
// 伺服器回的登入結果 → 存進 sessionStorage 的 session。個人登入（管理系統帳號）多帶姓名、各項權限、可進的店
export function toSession(d) {
  const s = { token: d.token, expiresAt: d.expiresAt, code: d.code, name: d.name, role: d.role, brand: d.brand || 'hq',
    mustChangePassword: !!d.mustChangePassword, features: d.features || [] };
  if (d.person) Object.assign(s, { person: d.person, canVoid: !!d.canVoid, isManager: !!d.isManager, scheduleAdmin: !!d.scheduleAdmin, dutyUnlocked: !!d.dutyUnlocked, dutyManager: d.dutyManager !== false, dutyHours: d.dutyHours !== false, stores: d.stores || [], attStores: d.attStores || [], dutyView: d.dutyView || null });
  if (d.person) Object.assign(s, schedPart(d));
  return s;
}
export async function login(code, password) {
  const d = await api('POST', '/login', { code, password });
  try { localStorage.setItem(KEYS.code, d.code); } catch (e) {}   // 只記代號，密碼永不儲存
  setSession(toSession(d));
  return d;
}
// 個人登入：兌換入場券（回 {select_token, stores} 表示多店要選；否則直接是登入結果）、選店、換店
export const ssoRedeem = ticket => api('POST', '/sso', { ticket });
export const ssoSelect = (selectToken, store) => api('POST', '/sso/select', { select_token: selectToken, store });
export const ssoSwitch = store => api('POST', '/sso/switch', { store });
export const isPerson = s => !!(s && s.person);
// 排班管理跨入口：找一家某種排班方式（store｜self｜fixed）的店。store 優先回上次所在的門市（sessionStorage），沒有就第一家有排班權的門市；沒有回 null
const LAST_STORE = 'dzystore_laststore';
export function rememberSchedStore(code) { try { sessionStorage.setItem(LAST_STORE, code); } catch (e) {} }
export function pickSchedStore(s, mode) {
  const list = ((s && s.schedStores) || []).filter(x => x.mode === mode && (mode !== 'store' || x.admin) && x.code !== (s && s.code));
  if (!list.length) return null;
  if (mode === 'store') { let last = ''; try { last = sessionStorage.getItem(LAST_STORE) || ''; } catch (e) {} return list.find(x => x.code === last) || list[0]; }
  return list[0];
}
// 採用新的登入結果。目前已有別的登入（別的人、或門市帳號）→ 先把舊 session 在伺服器端登出再換；
// 嵌入模式每次握手都會收到新券：伺服器回的 sub 跟目前相同（而且是同一家店）→ 採用新 token、把舊 token 登出（新 token 帶最新權限；
// 使用者可能已換過店或在做事，所以不重載畫面，kept=true 代表「同一個人同一家店，不用重載」）。
export async function adoptResult(d, keepSame) {
  const old = getSession();
  const same = !!(old && old.person && d.person && old.person.sub === d.person.sub);
  if (keepSame && same && old.code === d.code) {
    setSession(toSession(d));
    if (old.token && old.token !== d.token) { try { await api('POST', '/logout', {}, old.token); } catch (e) {} }
    return { session: getSession(), kept: true };
  }
  if (old && old.token && old.token !== d.token) {
    try { await api('POST', '/logout', {}, old.token); } catch (e) {}
  }
  clearSession();
  const s = toSession(d); setSession(s);
  return { session: s, kept: false };
}
export async function logout() {
  try { await api('POST', '/logout', {}); } catch (e) {}
  clearSession();
}
export async function changePassword(oldPassword, newPassword) {
  await api('POST', '/password', { oldPassword, newPassword });
  const s = getSession(); if (s) { s.mustChangePassword = false; setSession(s); }
}
