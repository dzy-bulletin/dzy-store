// 門市調撥模組的共用狀態與呼叫層。分頁切換時畫面會整個重畫，所以資料與草稿放在這裡（模組層），不放 DOM。
import { api } from '../../js/api.js';

export const S = {
  key: null, loaded: false, loading: null, me: null, nodes: [], reasons: [], mem: [], cats: ['食材', '包材', '雜貨'], today: '',
  tab: '', form: null, editNo: '', docNo: '', doc: null, mode: '', from: '',
  q: { f: { kw: '', from: '', to: '', st: '' }, rows: [], total: 0, sum: null, offset: 0, searched: false },
};

const FORM_KEY = 'dzystore_xfer_form';
const nameKey = () => 'dzystore_xfer_name_' + (S.key || '');
export const getName = () => { try { return localStorage.getItem(nameKey()) || ''; } catch (e) { return ''; } };
export const setName = v => { try { localStorage.setItem(nameKey(), v); } catch (e) {} };
export const saveForm = () => { try { sessionStorage.setItem(FORM_KEY + ':' + S.key, JSON.stringify(S.form)); } catch (e) {} };
const loadForm = () => { try { return JSON.parse(sessionStorage.getItem(FORM_KEY + ':' + S.key) || 'null'); } catch (e) { return null; } };

export function resetState(key) {
  Object.assign(S, { key, loaded: false, loading: null, me: null, nodes: [], reasons: [], mem: [], today: '', tab: '', form: null, editNo: '', docNo: '', doc: null, mode: '', from: '',
    q: { f: { kw: '', from: '', to: '', st: '' }, rows: [], total: 0, sum: null, offset: 0, searched: false } });
  S.form = loadForm();
}
export const todayISO = () => S.today || new Date().toISOString().slice(0, 10);
export const blankItem = () => ({ name: '', spec: '', unit: '', price: '', qty: '', cat: '' });
export const blankForm = () => ({ editNo: '', to: '', date: todayISO(), eta: todayISO(), packer: getName(), note: '', items: [blankItem()] });

const MESSAGES = {
  TIMEOUT: '等太久了，這次不一定有送出去。請先到「查單」確認，不要直接再按一次。',
  NETWORK: '連不上伺服器，請確認網路後再試',
};
export function msgOf(err) {
  const code = (err && (err.code || err.message)) || 'SERVER_ERROR';
  if (err && err.code === 'TIMEOUT' && err.message && err.message.length > 12) return err.message;
  return MESSAGES[code] || (err && err.message && !/^[A-Z_]+$/.test(err.message) ? err.message : '出錯了：' + code);
}

// 呼叫轉送器。讀取類由伺服器自動重送；寫入類（createDraft／updateDraft／ship／receive／amend／deleteDoc）永遠不自動重送，
// 重送可能開出兩張單或出兩次貨。
const CLIENT_TIMEOUT_MS = 55000;
export function call(action, body) {
  let timer;
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })), CLIENT_TIMEOUT_MS); });
  return Promise.race([api('POST', '/m/transfer/' + action, body || {}), guard]).finally(() => clearTimeout(timer));
}

// 品項記憶依使用次數多→少排（後端已排好，這裡再保險一次；次數一樣維持後端順序）
export const sortMem = list => list.map((m, i) => [m, i]).sort((a, b) => (b[0].uses || 0) - (a[0].uses || 0) || a[1] - b[1]).map(x => x[0]);

export async function loadBoot() {
  const d = await call('bootstrap', {});
  S.me = d.me || null; S.nodes = d.nodes || []; S.reasons = d.reasons || []; S.mem = sortMem(d.items || []); S.cats = d.itemCats || S.cats; S.today = d.today || '';
  S.loaded = true;
}
export async function refreshMem() { try { const d = await call('bootstrap', {}); S.mem = sortMem(d.items || []); S.reasons = d.reasons || S.reasons; } catch (e) { /* 沒網路就沿用舊的 */ } }
export const shortOf = name => (S.nodes.find(n => n.name === name) || {}).short || name;
export const reasonName = code => { const r = S.reasons.find(x => x.code === code); return r ? r.name : (code || ''); };
export const STIDX = { '草稿': 0, '已出貨': 1, '已簽收': 2, '已刪除': 3 };
