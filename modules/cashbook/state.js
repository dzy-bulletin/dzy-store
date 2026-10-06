// 收支登記模組的共用狀態與呼叫層。分頁切換時畫面會整個重畫，所以資料與草稿都放在這裡（模組層），不放 DOM。
import { api } from '../../js/api.js';

export const S = {
  key: null, loaded: false, loading: null, retrying: false,
  month: '', settings: { store: '', expenseSubjects: [], incomeSubjects: [] },
  frequent: [], lockedMonths: [], rows: [],
  kind: '支出', draft: null, openId: null, editingId: null,
};

export const todayISO = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
export const monthOf = date => String(date || '').slice(0, 7);
export const blankDraft = () => ({ date: todayISO(), name: '', subject: '', amount: '', hasInvoice: false, photoBase64: '' });

export function resetState(key) {
  Object.assign(S, { key, loaded: false, loading: null, retrying: false, month: monthOf(todayISO()),
    settings: { store: '', expenseSubjects: [], incomeSubjects: [] }, frequent: [], lockedMonths: [], rows: [],
    kind: '支出', draft: blankDraft(), openId: null, editingId: null });
}

// 錯誤碼 → 給店長看的話。後端有給白話訊息的（BAD_INPUT／LOCKED／NOT_FOUND／READONLY…）直接用後端的，這裡只補前端才知道的情況。
const MESSAGES = {
  TIMEOUT: '等太久了，這次可能沒送出去。請先到明細確認，不要直接再按一次。',
  NOT_SAVED: '已經確認這筆沒有送出去，請再按一次。',
  TIMEOUT_UNSURE: '等太久了，而且現在連不上後端，無法確認這筆有沒有記進去。請稍後到明細看一下再決定要不要重記。',
  NETWORK: '連不上伺服器，請確認網路後再試',
  PHOTO_FAIL: '這張照片讀不到，換一張或先不拍。',
};
export function msgOf(err) {
  const code = (err && (err.code || err.message)) || 'SERVER_ERROR';
  return MESSAGES[code] || (err && err.message && !/^[A-Z_]+$/.test(err.message) ? err.message : '出錯了：' + code);
}

const CLIENT_TIMEOUT_MS = 30000;   // 後端 25 秒會自己回 TIMEOUT；這是連後端都沒回時的保險
function once(action, body) {
  let timer;
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })), CLIENT_TIMEOUT_MS); });
  return Promise.race([api('POST', '/m/cashbook/' + action, body || {}), guard]).finally(() => clearTimeout(timer));
}
// 只有唯讀動作（bootstrap／list）在逾時或連不上時自動重送一次；寫入動作（create／update／void／lock／unlock）永遠不自動重送——
// 重送會記成兩筆帳。後端有明確回話的錯誤（LOCKED／BAD_INPUT…）重送也是同一個答案，不重送。
const READONLY = new Set(['bootstrap', 'list']);
const RETRY_ON = new Set(['TIMEOUT', 'NETWORK']);
export async function call(action, body) {
  try { return await once(action, body); }
  catch (e) {
    if (!READONLY.has(action) || !RETRY_ON.has(e.code)) throw e;
    S.retrying = true;
    try { return await once(action, body); } finally { S.retrying = false; }
  }
}

// 登入後只打一趟：bootstrap 帶 month，設定／常用項目／鎖定月份／當月明細一次拿齊
export async function loadAll(month) {
  const d = await call('bootstrap', { month });
  S.settings = d.settings || S.settings;
  S.frequent = d.frequent || [];
  S.lockedMonths = d.lockedMonths || [];
  S.month = month; S.rows = d.rows || [];
  S.loaded = true;
}
export async function loadMonth(month) {
  const d = await call('list', { month });
  S.month = month; S.rows = d.rows || []; S.openId = S.editingId = null;
}
export const isLocked = month => S.lockedMonths.indexOf(month) >= 0;
export const subjectsOf = kind => (kind === '收入' ? S.settings.incomeSubjects : S.settings.expenseSubjects) || [];
