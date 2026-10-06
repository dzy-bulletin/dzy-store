// 月結分頁：看這個月的合計、鎖定／解除鎖定。鎖定後這個月（這家店）不能再新增、修改或作廢，別家店不受影響。
// 匯出 Excel 是會計的事，在原系統的會計端（管理通行碼），不在門市這邊。
import { esc } from '../../js/ui.js';
import { summarize, money } from './calc.js';
import { S, call, isLocked, loadMonth } from './state.js';
import { runBusy } from './busy.js';
import { confirmBox } from '../../js/ui.js';
import { readMsg } from './list.js';

export function renderClose(ctx) {
  const el = ctx.el;
  el.innerHTML = `<div class="card cb-card"><h2>月結</h2>
    <div class="fld"><label for="cbCloseMonth">月份</label><input id="cbCloseMonth" type="month"></div>
    <div id="cbCloseInfo" class="cb-closeinfo"></div><div id="cbLockState" class="mt"></div>
    <button class="btn wide mt" id="cbLockBtn" type="button" data-busy="處理中"></button>
    <div id="cbCloseErr" class="err" role="alert"></div>
    <p class="hint mt">鎖定後這個月不能再新增、修改或作廢。月底匯出 Excel 是會計在原系統做的，這裡不用處理。</p></div>`;
  const $ = id => el.querySelector('#' + id);
  $('cbCloseMonth').value = S.month;
  const err = t => { const e = $('cbCloseErr'); if (e) e.textContent = t || ''; };

  function draw() {
    const s = summarize(S.rows), locked = isLocked(S.month);
    $('cbCloseInfo').innerHTML = `${esc(S.month)}　共 ${s.count} 筆（作廢的不計）<br>支出 ${money(s.expense)}　收入 ${money(s.income)}　淨額 ${money(s.net)}`;
    $('cbLockState').innerHTML = locked ? `<span class="tag bad" id="cbLockTag">${esc(S.month)} 已鎖定</span>` : `<span class="hint" id="cbLockTag">${esc(S.month)} 目前可以編輯</span>`;
    $('cbLockBtn').textContent = locked ? '解除鎖定' : '鎖定這個月';
  }
  draw();

  $('cbCloseMonth').onchange = async () => {
    const m = $('cbCloseMonth').value;
    if (!/^\d{4}-\d{2}$/.test(m)) return;
    err('');
    try { await loadMonth(m); } catch (e) { if (el.isConnected) { err(readMsg(e)); $('cbCloseMonth').value = S.month; } return; }
    if (el.isConnected) draw();
  };

  $('cbLockBtn').onclick = async () => {
    const btn = $('cbLockBtn'); if (btn.disabled) return;
    const month = S.month, locked = isLocked(month);
    if (!locked && !(await confirmBox(`鎖定 ${month}？\n\n鎖定後這個月不能再新增、修改或作廢。`, '鎖定'))) return;
    err('');
    await runBusy(btn, async () => {
      const res = await call(locked ? 'unlock' : 'lock', { month });
      S.lockedMonths = res.lockedMonths || [];
      if (el.isConnected) draw();
    }, { label: '處理中', doneText: locked ? '已解鎖 ✓' : '已鎖定 ✓', onError: m => { if (el.isConnected) err(m); } });
    if (el.isConnected) setTimeout(() => { if (el.isConnected) draw(); }, 1300);   // 等「已鎖定 ✓」那一下過去，按鈕字樣改回對的
  };
}
