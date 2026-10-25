// 自動排班（docs/autoschedule/spec.md 第 9 節）。四個分頁：班表／指定與需求／同仁／班別與設定。
// 計算與檢查規則跟伺服器共用同一份（rules.js、auto.js、calc.js）；畫面只負責顯示與送出。
import { esc } from '../../js/ui.js';
import { S, reset, load, canEdit } from './state.js';
import { getSession } from '../../js/auth.js';
import { renderBoard } from './board.js';
import { renderNeeds } from './needs.js';
import { renderStaff } from './staff.js';
import { renderShifts } from './shifts.js';
import { renderSelf, renderApprove } from './self.js';
import { renderFixed, renderFixedStaff } from './fixed.js';
import { ssoSwitch, setSession, toSession, pickSchedStore } from '../../js/auth.js';

const VIEWS = { board: renderBoard, needs: renderNeeds, staff: renderStaff, shifts: renderShifts };

// 唯讀（看得到排班管理、但不是本店店長同等職／人資主管／管理員，hr-move-spec §3）：畫完之後把會改資料的欄位與按鈕關掉、按鈕藏起來；
// 只留切換期別、檢視方式、日期與同仁選單、匯出 PDF 這些「換著看」的控制
const VIEW_ONLY = new Set(['scPrev', 'scNext', 'scViewGrid', 'scViewDay', 'scPdf', 'ndDay', 'pnEmp']);
function lockDown(el, ses) {
  el.querySelectorAll('input, select, textarea, button').forEach((x) => {
    if (VIEW_ONLY.has(x.id) || x.classList.contains('sc-daychip') || x.closest('.sc-seg')) return;
    x.disabled = true;
    if (x.tagName === 'BUTTON' && x.classList.contains('btn')) x.hidden = true;
  });
  const hire = el.querySelector('#hiCard'); if (hire) hire.hidden = true;     // 「新增同仁」整張卡（含到管理系統新增的連結與備案表單）只給能排班的人
  if (!el.querySelector('#scRo')) el.insertAdjacentHTML('afterbegin', `<div class="note" id="scRo" role="note">${ses && ses.person ? '只能查看：排班、鎖定只有本店店長、人資主管或管理員可以做。' : '排班請用管理系統個人帳號：人資部門 → 排班管理'}</div>`);
}

function ensureCss() {
  if (document.getElementById('scCss')) return;
  const l = document.createElement('link'); l.id = 'scCss'; l.rel = 'stylesheet'; l.href = new URL('../../css/schedule.css', import.meta.url).href;
  document.head.appendChild(l);
}

// 頁頂分頁（docs/schedule-hq/spec.md §5）：依「目前所在的店」的排班方式送不同的分頁；跨入口分頁 go-store／go-hq／go-cf 點了就換店（整頁重載）
const STORE_TABS = [{ id: 'board', label: '班表' }, { id: 'needs', label: '指定與需求' }, { id: 'staff', label: '同仁' }, { id: 'shifts', label: '班別與設定' }];
const GO = { 'go-store': ['store', '門市排班'], 'go-hq': ['self', '總部排班'], 'go-cf': ['fixed', '央廚排班'] };
export function tabsFor(s) {
  const mode = (s && s.schedMode) || 'store';
  const cross = Object.keys(GO).filter((id) => GO[id][0] !== mode && !!pickSchedStore(s, GO[id][0])).map((id) => ({ id, label: GO[id][1] }));
  let own;
  if (mode === 'self') own = [].concat(s.schedSelfOn ? [{ id: 'self', label: '我的班表' }] : [], s.schedApproveOn ? [{ id: 'approve', label: '部屬核准' }] : []);
  else if (mode === 'fixed') own = [{ id: 'fixed', label: '央廚班表' }].concat(s.scheduleAdmin ? [{ id: 'fixedstaff', label: '固定班別' }] : []);
  else own = STORE_TABS;
  const all = own.concat(cross);
  return all.length ? all : STORE_TABS;
}
// 點跨入口分頁：換到那種排班的店（沿用個人登入的換店流程），整頁重載後停在該入口第一個分頁
function goCross(ctx) {
  const target = pickSchedStore(ctx.session, GO[ctx.tab][0]);
  if (!target) { ctx.el.innerHTML = '<div class="card"><p class="hint" style="margin:0" id="goNo">你沒有那邊的排班權限。</p></div>'; return; }
  ctx.el.innerHTML = '<div class="card"><p class="hint" style="margin:0" id="goWait">切換中…</p></div>';
  ssoSwitch(target.code).then((d) => { setSession(toSession(d)); location.hash = '#/schedule/'; location.reload(); },
    (e) => { if (ctx.el.isConnected) ctx.el.innerHTML = `<div class="card"><div class="err" id="goErr" role="alert">${esc(e.message)}</div></div>`; });
}

export default {
  id: 'schedule',
  tabs: STORE_TABS,
  tabsFor,
  render(ctx) {
    ensureCss();
    if (GO[ctx.tab]) return goCross(ctx);
    if (ctx.tab === 'self') return renderSelf(ctx);
    if (ctx.tab === 'approve') return renderApprove(ctx);
    if (ctx.tab === 'fixed') return renderFixed(ctx);
    if (ctx.tab === 'fixedstaff') return renderFixedStaff(ctx);
    const key = ctx.session.token || ctx.session.code;
    if (S.key !== key) reset(key);                                   // 換了登入就重來，不留上一家店的資料
    const draw = () => {
      if (!ctx.el.isConnected) return;
      (VIEWS[ctx.tab] || renderBoard)({ el: ctx.el, rerender: ctx.rerender, session: ctx.session });
      const ses = ctx.session || getSession();
      if (!canEdit(ses)) lockDown(ctx.el, ses);
    };
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
