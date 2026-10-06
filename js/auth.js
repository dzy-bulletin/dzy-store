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
export function clearSession() { try { sessionStorage.removeItem(KEYS.session); sessionStorage.removeItem('dzystore_dutyok'); } catch (e) {} }
export function rememberedCode() { try { return localStorage.getItem(KEYS.code) || ''; } catch (e) { return ''; } }

export function initAuth(onLost, onMust) {
  setHooks({ onMust: () => { const s = getSession(); if (s) { s.mustChangePassword = true; setSession(s); } onMust(); }, getToken: () => (getSession() || {}).token || null, onAuth: () => { clearSession(); onLost(); } });
}

export async function login(code, password) {
  const d = await api('POST', '/login', { code, password });
  try { localStorage.setItem(KEYS.code, d.code); } catch (e) {}   // 只記代號，密碼永不儲存
  setSession({ token: d.token, expiresAt: d.expiresAt, code: d.code, name: d.name, role: d.role, brand: d.brand || 'hq',
    mustChangePassword: !!d.mustChangePassword, features: d.features || [] });
  return d;
}
export async function logout() {
  try { await api('POST', '/logout', {}); } catch (e) {}
  clearSession();
}
export async function changePassword(oldPassword, newPassword) {
  await api('POST', '/password', { oldPassword, newPassword });
  const s = getSession(); if (s) { s.mustChangePassword = false; setSession(s); }
}
