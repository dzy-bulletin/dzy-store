// 庫存盤點的共用狀態、存檔引擎。畫面切分頁會整個重畫，所以資料與「還沒存的變更」都放在這裡（模組層），不放 DOM。
// 存檔規則（取代舊版的 localStorage 即時存）：輸入後停手 3 秒自動存、切頁／換系統／登出立即存、狀態燈「已存 HH:MM／存檔中／存檔失敗」、
// 關閉或離開網頁時還有沒存完的會跳出提醒。存失敗時變更不會丟，按狀態燈或再改一次就重送。
import { api } from '../../js/api.js';

export const AUTOSAVE_MS = 3000;
export const S = { key: null, loaded: false, loading: null, loadedAt: 0, data: null, at: '', lastFinish: null,
  dirty: { cart: new Set(), stock: new Set() }, deleted: { cart: new Set(), stock: new Set() }, inflight: null,
  timer: null, saving: 0, status: { kind: 'idle', hm: '', msg: '' }, retry: new Map(), warn: '', collapsed: new Set(), device: '' };

const hm = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);       // 正本 652
export { uid };

function deviceId() {
  try { let d = localStorage.getItem('dzystore_inv_device'); if (!d) { d = 'dv-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('dzystore_inv_device', d); } return d; }
  catch (e) { return 'dv-' + Math.random().toString(36).slice(2, 10); }
}
export function resetState(key) {
  clearTimeout(S.timer);
  Object.assign(S, { key, loaded: false, loading: null, loadedAt: 0, data: null, at: '', lastFinish: null, inflight: null, timer: null, saving: 0,
    status: { kind: 'idle', hm: '', msg: '' }, retry: new Map(), warn: '', collapsed: new Set(), device: deviceId() });
  S.dirty = { cart: new Set(), stock: new Set() }; S.deleted = { cart: new Set(), stock: new Set() };
}
export const dirtyCount = () => S.dirty.cart.size + S.dirty.stock.size + S.deleted.cart.size + S.deleted.stock.size;

// ---------- 狀態燈 ----------
export function paintStatus() {
  const el = document.getElementById('invStatus');
  if (!el) return;
  const st = S.status;
  let text, cls;
  if (st.kind === 'saving') { text = '存檔中…'; cls = 'saving'; }
  else if (st.kind === 'fail') { text = '存檔失敗（按這裡重試）'; cls = 'fail'; }
  else if (dirtyCount() > 0) { text = '待存（停手 3 秒自動存）'; cls = 'wait'; }
  else if (st.kind === 'ok') { text = '已存 ' + st.hm; cls = 'ok'; }
  else { text = '已讀取最新資料'; cls = 'idle'; }
  el.className = 'inv-status ' + cls; el.textContent = text;
  el.title = st.kind === 'fail' ? st.msg : '';
  const w = document.getElementById('invWarn');
  if (w) { w.hidden = !S.warn; w.querySelector('span').textContent = S.warn; }
}
const setStatus = (kind, msg) => { S.status = { kind, hm: kind === 'ok' ? hm() : S.status.hm, msg: msg || '' }; paintStatus(); };

// ---------- 讀 ----------
export async function load() {
  const d = await api('POST', '/m/inventory/bootstrap', {});
  S.data = d.data; S.at = d.at; S.lastFinish = d.lastFinish; S.loaded = true; S.loadedAt = Date.now();
  S.data.cartCats = S.data.cartCats || []; S.data.stockCats = S.data.stockCats || [];
  return S.data;
}
export function reload() { S.loaded = false; S.dirty = { cart: new Set(), stock: new Set() }; S.deleted = { cart: new Set(), stock: new Set() }; S.warn = ''; return load(); }

// ---------- 盤點列的本機修改（只動記憶體＋標記待存）----------
export const zoneItems = zone => (zone === 'cart' ? S.data.cartItems : S.data.stockItems);
export const zoneCats = zone => (zone === 'cart' ? S.data.cartCats : S.data.stockCats);
export function findLine(zone, id) {
  const m = zoneItems(zone);
  for (const c of Object.keys(m)) { const l = (m[c] || []).find(x => x.id === id); if (l) return { line: l, cat: c }; }
  return null;
}
export function touch(zone, id) { S.dirty[zone].add(id); S.deleted[zone].delete(id); schedule(); paintStatus(); }
export function addLine(zone, cat, pid) {
  const p = (S.data.products ? Object.values(S.data.products).flat() : []).find(x => x.id === pid);
  if (!p) return null;
  const m = zoneItems(zone); if (!m[cat]) m[cat] = [];
  const line = { id: uid(), pid, name: p.name, spec: p.spec, qty: 0 };
  m[cat].push(line); touch(zone, line.id);
  return line;
}
export function delLine(zone, cat, id) {
  const m = zoneItems(zone); m[cat] = (m[cat] || []).filter(i => i.id !== id);
  S.dirty[zone].delete(id); S.deleted[zone].add(id); schedule(); paintStatus();
}
export function clearQty(zone) {
  let n = 0;
  Object.values(zoneItems(zone)).forEach(arr => (arr || []).forEach(i => { if (parseFloat(i.qty) > 0) n++; i.qty = 0; S.dirty[zone].add(i.id); }));
  schedule(); paintStatus();
  return n;
}
function schedule() { clearTimeout(S.timer); S.timer = setTimeout(() => { flushNow(); }, AUTOSAVE_MS); }

// ---------- 存檔 ----------
// 把還沒存的盤點列一次送出。同一時間只跑一趟；跑的時候又有新變更就接著再跑一趟。呼叫時若沒有在跑，會「同步」送出請求（登出前要搶在登出請求之前）。
export function flushNow() {
  clearTimeout(S.timer);
  if (S.inflight) return S.inflight.then(() => (dirtyCount() ? flushNow() : undefined));
  if (!dirtyCount() || !S.data) return Promise.resolve();
  const batch = { cart: { ids: [...S.dirty.cart], del: [...S.deleted.cart] }, stock: { ids: [...S.dirty.stock], del: [...S.deleted.stock] } };
  S.dirty = { cart: new Set(), stock: new Set() }; S.deleted = { cart: new Set(), stock: new Set() };
  S.saving++; setStatus('saving');
  const run = async () => {
    let failed = null;
    for (const zone of ['cart', 'stock']) {
      const b = batch[zone];
      if (!b.ids.length && !b.del.length) continue;
      const lines = [];
      for (const id of b.ids) { const f = findLine(zone, id); if (f) lines.push({ id, pid: f.line.pid, cat: f.cat, name: f.line.name, spec: f.line.spec, qty: parseFloat(f.line.qty) || 0 }); }
      try {
        const r = await api('POST', '/m/inventory/saveCounts', { zone, lines, deleted: b.del, base: S.at, device: S.device });
        S.at = r.at;
        if (r.overwrote) S.warn = '有人剛剛也改過同一筆盤點，已用你這次輸入的數字蓋過去。要看最新結果請按「重新讀取」。';
        if (r.dropped && r.dropped.length) S.warn = '有幾筆的商品或分類已經被別人刪掉，沒有存進去。請按「重新讀取」。';
      } catch (e) {
        failed = e;
        b.ids.forEach(id => S.dirty[zone].add(id)); b.del.forEach(id => S.deleted[zone].add(id));       // 沒存成功的放回待存
      }
    }
    S.saving--;
    if (failed) { setStatus('fail', failed.message); clearTimeout(S.timer); S.timer = setTimeout(() => { flushNow(); }, 10000); }
    else if (S.saving === 0) { setStatus('ok'); }
    paintStatus();
  };
  const p = run().then(() => { if (S.inflight === p) S.inflight = null; });
  S.inflight = p;
  return p;
}

// 商品、門檻、分類這類「改完就要存」的動作：包一層，狀態燈跟著動；失敗的存起來，按狀態燈重試
export async function track(key, fn) {
  S.saving++; setStatus('saving');
  try { const r = await fn(); S.retry.delete(key); S.saving--; if (S.saving === 0 && !S.retry.size && !dirtyCount()) setStatus('ok'); else paintStatus(); return r; }
  catch (e) { S.saving--; S.retry.set(key, fn); setStatus('fail', e.message); throw e; }
}
export async function retryAll() {
  const fns = [...S.retry.entries()];
  for (const [k, fn] of fns) { try { await track(k, fn); } catch (e) { /* 狀態燈已顯示失敗 */ } }
  if (dirtyCount()) await flushNow();
  else if (!S.retry.size && S.status.kind === 'fail') setStatus('ok');
}

// ---------- 離開前保護 ----------
let hooked = false;
export function hookPage() {
  if (hooked) return; hooked = true;
  window.addEventListener('beforeunload', e => { if (dirtyCount() > 0 || S.inflight || S.retry.size) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('hashchange', () => { if (dirtyCount() > 0) flushNow(); });                       // 切頁、換系統立即存
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirtyCount() > 0) flushNow(); });
  document.addEventListener('click', e => { if (e.target.closest && e.target.closest('#logoutBtn') && dirtyCount() > 0) flushNow(); }, true);   // 登出前先送出
}
