// 門市調撥（取代原系統 eason0728.github.io/mala-transfer 的「門市端」）：三個分頁——待辦／開單／查單；點單據進詳情（出貨、簽收、修改、刪除）。
// 登入、節點、pin 都由營運系統處理（門市代號→調撥節點在後台「門市對照」設定，pin 在伺服器 vault），這裡不碰。
// 會計專區（月報、差異原因維護、改 pin）與總部管理總覽不在本系統。
import { esc } from '../../js/ui.js';
import { S, resetState, loadBoot, msgOf } from './state.js';
import { renderTodo } from './todo.js';
import { renderForm } from './form.js';
import { renderQuery } from './query.js';
import { renderDoc } from './doc.js';

// 專屬樣式放自己的檔案（不動共用的 app.css）
if (!document.getElementById('xf-css')) {
  const l = document.createElement('link'); l.id = 'xf-css'; l.rel = 'stylesheet'; l.href = new URL('../../css/transfer.css', import.meta.url).href; document.head.appendChild(l);
}

const VIEWS = { todo: renderTodo, new: renderForm, query: renderQuery };

export default {
  id: 'transfer',
  tabs: [{ id: 'todo', label: '待辦' }, { id: 'new', label: '開單' }, { id: 'query', label: '查單' }],
  render(ctx) {
    const key = ctx.session.token || ctx.session.code;
    if (S.key !== key) resetState(key);                  // 換了登入就重來，不留上一個人的單
    if (S.tab !== ctx.tab) { S.tab = ctx.tab; S.docNo = ''; S.doc = null; S.mode = ''; }   // 換分頁就離開詳情
    if (ctx.tab !== 'new') S.editNo = '';
    const draw = () => {
      if (!ctx.el.isConnected) return;
      if (S.docNo && S.doc) return renderDoc(ctx);
      (VIEWS[ctx.tab] || renderTodo)(ctx);
    };
    // 在詳情畫面再點一次目前的分頁＝回到那個分頁（網址沒變、不會觸發換頁，所以自己處理）
    const tabs = document.querySelector('nav.tabs');
    if (tabs) tabs.onclick = e => { const a = e.target.closest && e.target.closest('a[data-tab]'); if (a && S.docNo && a.dataset.tab === S.tab) { S.docNo = ''; S.doc = null; S.mode = ''; ctx.rerender(); } };
    if (S.loaded) return draw();
    ctx.el.innerHTML = '<div class="card"><p class="hint" style="margin:0">讀取中…</p></div>';
    if (!S.loading) S.loading = loadBoot().finally(() => { S.loading = null; });
    return S.loading.then(draw, e => {
      if (!ctx.el.isConnected) return;
      ctx.el.innerHTML = `<div class="card"><div class="err" id="xfLoadErr" role="alert">${esc(msgOf(e))}</div><button class="btn mt" id="xfRetry" type="button">重新讀取</button></div>`;
      ctx.el.querySelector('#xfRetry').onclick = () => ctx.rerender();
    });
  },
};
