import { S, reset, refreshReqBadge } from './state.js';
import { renderApprove } from './approve.js';
import { renderDevice } from './device.js';
import { renderRoster } from './roster.js';
import { renderNotice } from './notice.js';
import { renderRequest } from './request.js';
import { api } from '../../js/api.js';
import { busy, setMsg } from '../../js/ui.js';

// 旗標：'1'＝已解鎖；'m'＝已用預設 0000 解鎖、但還沒改成自己的（只能看到改密碼表單）。登出時 clearSession 會一併清掉。
const KEY = 'dzystore_dutyok';
const flag = () => { try { return sessionStorage.getItem(KEY) || ''; } catch (e) { return ''; } };
const setFlag = v => { try { if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch (e) {} };

export default {
  id: 'duty',
  tabs: [{ id: 'approve', label: '核定工時' }, { id: 'request', label: '申請審核' }, { id: 'device', label: '裝置核准' }, { id: 'roster', label: '員工名冊' }, { id: 'notice', label: '公告' }],
  locked: () => flag() !== '1',
  renderGate(ctx) { flag() === 'm' ? changeForm(ctx) : unlockForm(ctx); },
  render(ctx) {
    const key = ctx.session.token || ctx.session.code;
    if (S.key !== key) reset(key);                      // 換了登入就重來，不留上一個人的資料
    S.rerender = ctx.rerender;
    ({ approve: renderApprove, request: renderRequest, device: renderDevice, roster: renderRoster, notice: renderNotice }[ctx.tab] || renderApprove)(ctx);
    if (ctx.tab !== 'request') refreshReqBadge();      // 申請審核分頁自己讀清單時會更新，不重複問
  },
};

function unlockForm(ctx) {
  ctx.el.innerHTML = `<div class="card" style="max-width:420px"><h2>值班核定</h2>
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
