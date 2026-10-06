// 耗損登記：登記／統計／成本設定三個分頁。功能與規則照原系統 eason0728.github.io/mzt-loss（墨竹亭四店共用；小辛辣等其他店資料存營運系統自己的資料庫），
// 外觀換成營運系統薪資風格；登入、店別都由營運系統處理，這裡不碰（店別由伺服器依門市對照決定）。
import { esc } from '../../js/ui.js';
import { S, resetState, loadAll, msgOf } from './state.js';
import { renderAdd } from './add.js';
import { renderStat } from './stat.js';
import { renderItems } from './items.js';

const VIEWS = { add: renderAdd, stat: renderStat, items: renderItems };
if (!document.getElementById('lossCss')) {
  const l = document.createElement('link');
  l.id = 'lossCss'; l.rel = 'stylesheet'; l.href = new URL('./loss.css', import.meta.url).href;
  document.head.appendChild(l);
}

export default {
  id: 'loss',
  tabs: [{ id: 'add', label: '登記' }, { id: 'stat', label: '統計' }, { id: 'items', label: '成本設定' }],
  render(ctx) {
    const key = ctx.session.token || ctx.session.code;
    if (S.key !== key) resetState(key);                  // 換了登入就重來，不留上一個人的資料
    const draw = () => { if (ctx.el.isConnected) (VIEWS[ctx.tab] || renderAdd)(ctx); };
    if (S.loaded) return draw();
    ctx.el.innerHTML = '<div class="card"><p class="hint" style="margin:0">讀取中…</p></div>';
    if (!S.loading) S.loading = loadAll().finally(() => { S.loading = null; });
    return S.loading.then(draw, e => {
      if (!ctx.el.isConnected) return;
      ctx.el.innerHTML = `<div class="card"><div class="err" id="lsLoadErr" role="alert">${esc(msgOf(e))}</div><button class="btn mt" id="lsRetry" type="button">重新讀取</button></div>`;
      ctx.el.querySelector('#lsRetry').onclick = () => ctx.rerender();
    });
  },
};
