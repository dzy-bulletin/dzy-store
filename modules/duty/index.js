import { S, reset, refreshReqBadge, dutyManager, dutyHours, multiStores, allModeOf, setAll } from './state.js';
import { renderOverview, storeBar, personStoreBar } from './overview.js';
import { renderApprove } from './approve.js';
import { renderDevice } from './device.js';
import { renderRoster } from './roster.js';
import { renderNotice } from './notice.js';
import { renderRequest } from './request.js';
import { api } from '../../js/api.js';
import { busy, setMsg } from '../../js/ui.js';
import { getSession } from '../../js/auth.js';

// 旗標：'1'＝已解鎖；'m'＝已用預設 0000 解鎖、但還沒改成自己的（只能看到改密碼表單）。登出時 clearSession 會一併清掉。
const KEY = 'dzystore_dutyok';
const flag = () => { try { return sessionStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
const setFlag = v => { try { if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch (e) {} };

const TABS = [{ id: 'approve', label: '核定工時' }, { id: 'request', label: '申請審核' }, { id: 'device', label: '裝置核准' }, { id: 'roster', label: '員工名冊' }, { id: 'notice', label: '公告' }];

export default {
  id: 'duty',
  tabs: TABS,
  // 管理者多一個「各店總覽」放第一格（2026-10-11 Eason）；其餘分頁要先選門市，畫面上方有門市切換
  // 個人登入的「全部門市」：整店功能（裝置核准、員工名冊、公告）不顯示，只剩核定工時與申請審核
  // 只有申請審核權的人（dutyHours=false）不顯示「核定工時」，第一格就是申請審核（嵌入管理系統時頁頂選單也跟著少一格）
  tabsFor: s => { let t = dutyManager(s) ? TABS : TABS.filter(x => x.id !== 'notice'); if (!dutyHours(s)) t = t.filter(x => x.id !== 'approve'); if (allModeOf(s)) t = t.filter(x => x.id === 'approve' || x.id === 'request'); return s && s.role === 'admin' ? [{ id: 'overview', label: '各店總覽' }, ...t] : t; },
  // 個人登入（管理系統帳號）：有出勤核定入口就已解鎖，不問核定密碼、也沒有「改核定密碼」
  locked: () => { const s = getSession(); return !(s && s.person && s.dutyUnlocked) && flag() !== '1'; },
  renderGate(ctx) { flag() === 'm' ? changeForm(ctx) : unlockForm(ctx); },
  render(ctx) {
    const key = ctx.session.token || ctx.session.code;
    if (S.key !== key) reset(key);                      // 換了登入就重來，不留上一個人的資料
    S.rerender = ctx.rerender;
    S.admin = ctx.session.role === 'admin';
    if (S.admin) {
      if (ctx.tab === 'overview') return renderOverview(ctx);
      const body = storeBar(ctx);                       // 還沒選門市：只畫選單與說明
      if (!body) return;
      ctx = Object.assign({}, ctx, { el: body });
    }
    const multi = !S.admin && multiStores(ctx.session).length > 0;
    setAll(multi && allModeOf(ctx.session));            // 換模式就整包重來
    if (multi) ctx = Object.assign({}, ctx, { el: personStoreBar(ctx) });
    if (ctx.tab === 'notice' && !dutyManager(ctx.session)) ctx = Object.assign({}, ctx, { tab: 'approve' });
    ({ approve: renderApprove, request: renderRequest, device: renderDevice, roster: renderRoster, notice: renderNotice }[ctx.tab] || renderApprove)(ctx);
    if (ctx.tab !== 'request') refreshReqBadge();      // 申請審核分頁自己讀清單時會更新，不重複問
  },
};

function unlockForm(ctx) {
  ctx.el.innerHTML = `<div class="card" style="max-width:420px"><h2>出勤核定</h2>
    <p class="hint">請輸入這家店的核定密碼。本次登入期間只需輸入一次。第一次使用的核定密碼是 0000。</p>
    <form id="dutyForm"><div class="fld"><label for="dutyPw">核定密碼</label><input id="dutyPw" type="password" autocomplete="off"></div>
    <div class="row mt"><button class="btn" id="dutyBtn" type="submit">進入</button></div><div id="dutyErr" class="err" role="alert"></div></form></div>`;
  const form = ctx.el.querySelector('#dutyForm');
  form.onsubmit = e => {
    e.preventDefault();
    busy(form.querySelector('#dutyBtn'), async () => {
      try {
        const r = await api('POST', '/duty/unlock', { password: form.querySelector('#dutyPw').value });
        setFlag(r && r.mustChange ? 'm' : '1');
        ctx.rerender();
      } catch (er) { setMsg(form.querySelector('#dutyErr'), er.message); }
    });
  };
}

function changeForm(ctx) {
  ctx.el.innerHTML = `<div class="card" style="max-width:420px"><h2>請先設定自己的核定密碼</h2>
    <p class="hint">你現在用的是預設的 0000。請改成只有主管知道的新密碼（至少 4 碼，不可以是 0000）。</p>
    <form id="dutyNewForm"><div class="fld"><label for="dutyNew">新的核定密碼（4 碼以上）</label><input id="dutyNew" type="password" autocomplete="new-password"></div>
    <div class="fld mt"><label for="dutyNew2">再輸入一次</label><input id="dutyNew2" type="password" autocomplete="new-password"></div>
    <div class="row mt"><button class="btn" id="dutyNewBtn" type="submit">儲存並進入</button></div><div id="dutyNewErr" class="err" role="alert"></div></form></div>`;
  const form = ctx.el.querySelector('#dutyNewForm'), err = form.querySelector('#dutyNewErr');
  form.onsubmit = e => {
    e.preventDefault();
    const a = form.querySelector('#dutyNew').value, b = form.querySelector('#dutyNew2').value;
    if (a === '0000') return setMsg(err, '新的核定密碼不可以是預設的 0000');
    if (a.length < 4) return setMsg(err, '新的核定密碼至少要 4 碼');
    if (a !== b) return setMsg(err, '兩次輸入的不一樣');
    busy(form.querySelector('#dutyNewBtn'), async () => {
      try { await api('POST', '/duty/password', { newPassword: a }); setFlag('1'); ctx.rerender(); }
      catch (er) { setMsg(err, er.message); }
    });
  };
}
