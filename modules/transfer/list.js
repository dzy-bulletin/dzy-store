// 單據卡片列表（待辦與查單共用）
import { esc } from '../../js/ui.js';
import { S, STIDX, shortOf, call, msgOf } from './state.js';
import { money } from './calc.js';

// 逾期：預計到貨日 < 今天才算，當天到期不算（Code.gs 第 815 行 overdueDays_ 同一條規則）
export function daysOverdue(d) {
  const eta = String(d['預計到貨日'] || '').slice(0, 10);
  if (!eta || eta >= S.today) return 0;
  return Math.max(1, Math.round((new Date(S.today) - new Date(eta)) / 86400000));
}

export function docCard(d, overdue) {
  const gap = Number(d['差異總額']);
  const od = overdue ? `<span class="xf-od">逾期 ${overdue} 天</span> ` : '';
  return `<button class="xf-dc" type="button" data-no="${esc(d['單號'])}" data-status="${esc(d['狀態'])}">
    <div class="r1"><b>${od}${esc(shortOf(d['調出方']))} → ${esc(shortOf(d['調入方']))}</b><span class="xf-pill s${STIDX[d['狀態']] || 0}">${esc(d['狀態'])}</span></div>
    <div class="r2">${esc(String(d['調撥日期']).slice(5))}　·　${esc(d['品項數'])} 項　·　<b>${money(Number(d['應撥總額']) || 0)}</b>${gap ? `<span class="xf-gap">差異 ${money(gap)}</span>` : ''}</div>
    <div class="r3">${esc(d['單號'])}</div></button>`;
}

export function paintCards(el, rows, emptyText, markOverdue, onOpen) {
  el.innerHTML = rows.length ? rows.map(d => docCard(d, markOverdue ? daysOverdue(d) : 0)).join('') : `<div class="xf-none">${esc(emptyText)}</div>`;
  el.querySelectorAll('.xf-dc').forEach(b => { b.onclick = () => onOpen(b.dataset.no); });
}

export async function openDoc(ctx, no, from) {
  const d = await call('getDoc', { '單號': no });
  S.doc = d; S.docNo = no; S.mode = ''; S.from = from || S.tab;
  ctx.rerender();
}
export { msgOf };
