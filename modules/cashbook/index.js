// 收支登記（多店版）：門市記當天現金支出與收入。流程與規則照原系統 ~/mala-cashbook（Eason 拍板過的設計全部保留，見各檔註解），
// 外觀換成營運系統薪資風格；登入、通行碼、店別都由營運系統處理，這裡不碰。三個分頁：記帳／明細／月結。
import { esc } from '../../js/ui.js';
import { S, resetState, loadAll, monthOf, todayISO, msgOf } from './state.js';
import { renderEntry } from './entry.js';
import { renderList, readMsg } from './list.js';
import { renderClose } from './close.js';

const VIEWS = { entry: renderEntry, list: renderList, close: renderClose };

export default {
  id: 'cashbook',
  tabs: [{ id: 'entry', label: '記帳' }, { id: 'list', label: '明細' }, { id: 'close', label: '月結' }],
  render(ctx) {
    const key = ctx.session.token || ctx.session.code;
    if (S.key !== key) resetState(key);                  // 換了登入就重來，不留上一個人的帳
    const draw = () => { if (ctx.el.isConnected) (VIEWS[ctx.tab] || renderEntry)(ctx); };
    if (S.loaded) return draw();
    ctx.el.innerHTML = '<div class="card"><p class="hint" style="margin:0">讀取中…</p></div>';
    if (!S.loading) S.loading = loadAll(monthOf(todayISO())).finally(() => { S.loading = null; });
    return S.loading.then(draw, e => {
      if (!ctx.el.isConnected) return;
      ctx.el.innerHTML = `<div class="card"><div class="err" id="cbLoadErr" role="alert">${esc(readMsg(e))}</div><button class="btn mt" id="cbRetry" type="button">重新讀取</button></div>`;
      ctx.el.querySelector('#cbRetry').onclick = () => ctx.rerender();
    });
  },
};
