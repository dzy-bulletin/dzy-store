// 耗損登記模組的共用狀態與呼叫層。分頁切換會整個重畫，資料與草稿放這裡（模組層），不放 DOM。
import { api } from '../../js/api.js';
import { CATEGORIES, REASONS } from './calc.js';

export const S = {
  key: null, loaded: false, loading: null, retrying: false,
  mode: 'own', storeLabel: '', categories: CATEGORIES, reasons: REASONS,
  items: [], pending: null, draft: null, day: '', editingName: null, statKind: 'week', statFrom: '', statTo: '', rankOpen: {}, itemAll: false,
};
export function resetState(key) {
  Object.assign(S, { key, loaded: false, loading: null, retrying: false, mode: 'own', storeLabel: '', categories: CATEGORIES, reasons: REASONS,
    items: [], pending: null, draft: null, day: '', editingName: null, statKind: 'week', statFrom: '', statTo: '', rankOpen: {}, itemAll: false });
}

const MESSAGES = {
  NETWORK: '連不上伺服器，請確認網路後再試',
  TIMEOUT: '等太久了，這次不一定有送出；重按同一筆不會重複登記，也可以先到「登記」下方的清單確認。',
};
export function msgOf(err) {
  const code = (err && (err.code || err.message)) || 'SERVER_ERROR';
  return MESSAGES[code] || (err && err.message && !/^[A-Z_]+$/.test(err.message) ? err.message : '出錯了：' + code);
}

const CLIENT_TIMEOUT_MS = 35000;   // 後端自己會在 20～30 秒回 TIMEOUT；這是連後端都沒回時的保險
function once(action, body) {
  let timer;
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })), CLIENT_TIMEOUT_MS); });
  return Promise.race([api('POST', '/m/loss/' + action, body || {}), guard]).finally(() => clearTimeout(timer));
}
// 只有讀取（bootstrap／listLoss）逾時或連不上時重送一次；寫入由使用者決定要不要重按（同一筆有固定 id，重按不會重複）
const READONLY = new Set(['bootstrap', 'listLoss']);
export async function call(action, body) {
  try { return await once(action, body); }
  catch (e) {
    if (!READONLY.has(action) || (e.code !== 'TIMEOUT' && e.code !== 'NETWORK')) throw e;
    S.retrying = true;
    try { return await once(action, body); } finally { S.retrying = false; }
  }
}

export async function loadAll() {
  const d = await call('bootstrap', {});
  S.items = d.items || [];
  S.mode = d.mode || 'own'; S.storeLabel = d.storeLabel || '';
  if (Array.isArray(d.categories) && d.categories.length) S.categories = d.categories;
  if (Array.isArray(d.reasons) && d.reasons.length) S.reasons = d.reasons;
  S.loaded = true;
}
export const findItem = name => S.items.find(i => i.品名 === name) || null;
