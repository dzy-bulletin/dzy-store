// 自動排班（docs/autoschedule/spec.md 第 9 節）。四個分頁：班表／指定與需求／同仁／班別與設定。
// 計算與檢查規則跟伺服器共用同一份（rules.js、auto.js、calc.js）；畫面只負責顯示與送出。
import { esc } from '../../js/ui.js';
import { S, reset, load } from './state.js';
import { renderBoard } from './board.js';
import { renderNeeds } from './needs.js';
import { renderStaff } from './staff.js';
import { renderShifts } from './shifts.js';

const VIEWS = { board: renderBoard, needs: renderNeeds, staff: renderStaff, shifts: renderShifts };

function ensureCss() {
  if (document.getElementById('scCss')) return;
  const l = document.createElement('link'); l.id = 'scCss'; l.rel = 'stylesheet'; l.href = new URL('../../css/schedule.css', import.meta.url).href;
  document.head.appendChild(l);
}

export default {
  id: 'schedule',
  tabs: [{ id: 'board', label: '班表' }, { id: 'needs', label: '指定與需求' }, { id: 'staff', label: '同仁' }, { id: 'shifts', label: '班別與設定' }],
  render(ctx) {
    ensureCss();
    const key = ctx.session.token || ctx.session.code;
    if (S.key !== key) reset(key);                                   // 換了登入就重來，不留上一家店的資料
    const draw = () => { if (ctx.el.isConnected) (VIEWS[ctx.tab] || renderBoard)({ el: ctx.el, rerender: ctx.rerender, session: ctx.session }); };
    if (S.data && S.data.period === S.period) return draw();
    ctx.el.innerHTML = '<div class="card"><p class="hint" style="margin:0">讀取中…</p></div>';
    if (!S.loading) S.loading = load().finally(() => { S.loading = null; });
    return S.loading.then(draw, (e) => {
      if (!ctx.el.isConnected) return;
      ctx.el.innerHTML = `<div class="card"><div class="err" id="scLoadErr" role="alert">${esc(e.message)}</div><button class="btn mt" id="scRetry" type="button">重新讀取</button></div>`;
      ctx.el.querySelector('#scRetry').onclick = () => ctx.rerender();
    });
  },
};
