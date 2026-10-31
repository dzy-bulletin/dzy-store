// 庫存盤點（營運系統自有資料，取代只存在手機的舊版 eason0728.github.io/mala）。
// 六個分頁：攤車庫存／現場庫存／商品價格／列印與匯出／歷史／從舊版匯入。功能與計算照正本，存檔改成伺服器（停手 3 秒自動存）。
import { esc } from '../../js/ui.js';
import { api } from '../../js/api.js';
import { S, resetState, load, flushNow, paintStatus, retryAll, hookPage, dirtyCount } from './state.js';
import { renderZone } from './count.js';
import { renderPrice } from './price.js';
import { renderPrint } from './print.js';
import { renderHistory } from './history.js';
import { renderImport } from './import.js';

const STALE_MS = 120000;
const LOCK_TABS = ['cart', 'stock', 'price', 'import'];             // 鎖定時這幾頁整頁唯讀（列印與匯出、歷史照常）

const whenOf = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function lockBar() {
  if (!S.lock) return '';
  const who = [whenOf(S.lock.at), S.lock.by].filter(Boolean).join(' ');
  return `<div class="inv-lockbar" id="invLock" role="status"><span>🔒 盤點已鎖定${who ? '（' + esc(who) + ' 完成盤點）' : ''}。數量、價格、商品都不能改；列印、匯出、看歷史照常。</span>`
    + (S.canUnlock ? '<button class="btn ghost sm" type="button" id="invUnlockBtn">🔓 解鎖</button>' : '<span class="inv-lockhint">要修改請店長解鎖。</span>') + '</div>';
}
function lockView(el) {
  el.querySelectorAll('input, select, textarea, button').forEach(x => { if (!x.matches('[data-act="tog"]')) x.disabled = true; });   // 收合分類照常可按
  el.classList.add('inv-locked');
}
const VIEWS = { cart: c => renderZone(c, 'cart'), stock: c => renderZone(c, 'stock'), price: renderPrice, print: renderPrint, history: renderHistory, import: renderImport };

function ensureCss() {
  if (document.getElementById('invCss')) return;
  const l = document.createElement('link'); l.id = 'invCss'; l.rel = 'stylesheet'; l.href = new URL('../../css/inventory.css', import.meta.url).href;
  document.head.appendChild(l);
}

export default {
  id: 'inventory',
  tabs: [{ id: 'cart', label: '攤車庫存' }, { id: 'stock', label: '現場庫存' }, { id: 'price', label: '商品價格' }, { id: 'print', label: '列印與匯出' }, { id: 'history', label: '歷史' }, { id: 'import', label: '從舊版匯入' }],
  render(ctx) {
    ensureCss(); hookPage();
    const key = ctx.session.token || ctx.session.code;
    if (S.key !== key) resetState(key);                              // 換了登入就重來，不留上一家店的資料
    if (dirtyCount() > 0) flushNow();                                // 切頁立即存
    const draw = () => {
      if (!ctx.el.isConnected) return;
      ctx.el.innerHTML = `<div class="inv-top"><button type="button" id="invStatus" class="inv-status idle"></button></div><div id="invWarn" class="note warn" hidden role="alert"><span></span> <button class="btn ghost sm" type="button" id="invReload">重新讀取</button></div>${lockBar()}<div id="invView"></div>`;
      ctx.el.querySelector('#invStatus').onclick = () => { if (S.status.kind === 'fail') retryAll(); };
      ctx.el.querySelector('#invReload').onclick = async () => { try { await flushNow(); S.loaded = false; S.warn = ''; await load(); } catch (e) { /* 留著提示 */ } ctx.rerender(); };
      const ub = ctx.el.querySelector('#invUnlockBtn');
      if (ub) ub.onclick = async () => {
        ub.disabled = true;
        try { await api('POST', '/m/inventory/unlock', {}); S.lock = null; S.warn = ''; ctx.rerender(); }
        catch (e) { ub.disabled = false; S.warn = '解鎖失敗：' + e.message; paintStatus(); }
      };
      paintStatus();
      const view = { el: ctx.el.querySelector('#invView'), session: ctx.session, rerender: ctx.rerender, tab: ctx.tab };
      const tab = VIEWS[ctx.tab] ? ctx.tab : 'cart';
      Promise.resolve(VIEWS[tab](view)).then(() => { if (S.lock && LOCK_TABS.includes(tab) && view.el.isConnected) lockView(view.el); });
    };
    const fresh = S.loaded && (Date.now() - S.loadedAt < STALE_MS || dirtyCount() > 0 || S.inflight || S.retry.size);
    if (fresh) return draw();
    ctx.el.innerHTML = '<div class="card"><p class="hint" style="margin:0">讀取中…</p></div>';
    if (!S.loading) S.loading = load().finally(() => { S.loading = null; });
    return S.loading.then(draw, e => {
      if (!ctx.el.isConnected) return;
      ctx.el.innerHTML = `<div class="card"><div class="err" id="invLoadErr" role="alert">${esc(e.message)}</div><button class="btn mt" id="invRetry" type="button">重新讀取</button></div>`;
      ctx.el.querySelector('#invRetry').onclick = () => ctx.rerender();
    });
  },
};
