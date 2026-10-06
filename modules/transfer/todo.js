// 待辦：等你簽收（對方已出貨給我）／你的草稿（待出貨）／在路上的貨（我已出貨、對方還沒簽收）。逾期的排最前（照原系統）。
import { esc } from '../../js/ui.js';
import { S, call, msgOf } from './state.js';
import { paintCards, daysOverdue, openDoc } from './list.js';

const SECTIONS = [
  ['recv', '等你簽收', { side: 'in', '狀態': '已出貨' }, '目前沒有等你簽收的貨', true],
  ['draft', '你的草稿（待出貨）', { side: 'out', '狀態': '草稿' }, '目前沒有草稿', false],
  ['ship', '在路上的貨', { side: 'out', '狀態': '已出貨' }, '目前沒有在路上的貨', true],
];

export function renderTodo(ctx) {
  const el = ctx.el;
  el.innerHTML = `<div class="xf-me hint">${esc(S.me ? S.me.name : '')}</div><div id="xfTodoMsg" class="err" role="alert"></div>` + SECTIONS.map(([k, t]) =>
    `<section class="card xf-sec" id="xfSec-${k}"><h2>${esc(t)}　<span class="xf-count" id="xfCount-${k}">…</span></h2><div class="xf-list" id="xfList-${k}"><div class="hint">讀取中…</div></div></section>`).join('');
  const open = no => openDoc(ctx, no, 'todo').catch(e => { if (el.isConnected) el.querySelector('#xfTodoMsg').textContent = msgOf(e); });
  Promise.allSettled(SECTIONS.map(([, , body]) => call('listDocs', { ...body, limit: 50 }))).then(rs => {
    if (!el.isConnected) return;
    let failed = '';
    SECTIONS.forEach(([k, , , empty, od], i) => {
      const r = rs[i];
      if (r.status === 'rejected') { failed = msgOf(r.reason); el.querySelector('#xfCount-' + k).textContent = '—'; el.querySelector('#xfList-' + k).innerHTML = '<div class="xf-none">暫時讀不到</div>'; return; }
      const rows = (r.value.rows || []).slice();
      if (od) rows.sort((a, b) => daysOverdue(b) - daysOverdue(a));      // 逾期久的排最前
      el.querySelector('#xfCount-' + k).textContent = r.value.total;
      paintCards(el.querySelector('#xfList-' + k), rows, empty, od, open);
    });
    if (failed) el.querySelector('#xfTodoMsg').textContent = failed;
  });
}
