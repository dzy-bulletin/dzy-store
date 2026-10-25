// 總部自填排班／央廚固定排班畫面共用的小工具（self.js、fixed.js）：呼叫、月份換算、月曆、檢查結果清單。
// 規格：docs/schedule-hq/spec.md §5、§10.1。月份是畫面單位；格子 {t:'W'|'R'|'H'|'L', s?:班別, l?:假別}。
import { esc } from '../../js/ui.js';
import { api } from '../../js/api.js';
import { addDays, weekday, todayTaipei } from './period.js';

export const call = (action, body) => api('POST', '/m/schedule/' + action, body || {});
export const WD = ['日', '一', '二', '三', '四', '五', '六'];
export const monthDates = (m) => { const out = []; for (let d = m + '-01'; d.slice(0, 7) === m; d = addDays(d, 1)) out.push(d); return out; };
export const nextMonth = (m) => addDays(m + '-01', 32).slice(0, 7);
export const prevMonth = (m) => addDays(m + '-01', -1).slice(0, 7);
export const mLabel = (m) => `${m.slice(0, 4)} 年 ${+m.slice(5)} 月`;
export const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
export const curMonth = () => todayTaipei().slice(0, 7);
/** 總部自填的預設月份：20 號起看下個月，之前看當月（至少到起用月） */
export function defaultSelfMonth() {
  const t = todayTaipei();
  return Number(t.slice(8, 10)) >= 20 ? nextMonth(t.slice(0, 7)) : t.slice(0, 7);
}

export const STATUS_TEXT = { draft: '草稿（還沒送出）', submitted: '已送出，等主管核准', approved: '已核准', rejected: '已退回，請修改後再送出' };
const LEAVE = { '特': '特休', '補': '補休', '國': '國定' };

/** 格子的顯示文字與樣式 */
export function cellInfo(c, shiftMap) {
  if (!c || !c.t) return { t: '', cls: 'empty' };
  if (c.t === 'W') { const sh = shiftMap[c.s]; return { t: sh ? sh.name : (c.s || '班'), cls: 'work' }; }
  if (c.t === 'H') { if (c.s) { const sh = shiftMap[c.s]; return { t: (sh ? sh.name : '班') + '(休息日)', cls: 'work ot' }; } return { t: '休', cls: 'off' }; }
  if (c.t === 'R') return { t: '例', cls: 'rest' };
  if (c.t === 'L') return { t: LEAVE[c.l] || '假', cls: 'leave' };
  return { t: '', cls: 'empty' };
}
/** 選單值 → 格子（'S:<班別>'、'R'、'H'、'L:特'…、'CLEAR'） */
export function cellOfValue(v) {
  if (v === 'CLEAR') return { t: '' };
  if (v.startsWith('S:')) return { t: 'W', s: v.slice(2) };
  if (v.startsWith('L:')) return { t: 'L', l: v.slice(2) };
  return { t: v };
}
export function valueOfCell(c) {
  if (!c || !c.t) return '';
  if (c.t === 'W') return 'S:' + c.s;
  if (c.t === 'L') return 'L:' + c.l;
  return c.t;
}
/** 格子可選的內容（班別、休息日、例假、特休、補休、國定假日假） */
export function cellOptions(shifts, cur, withClear) {
  const o = shifts.map((s) => `<option value="S:${esc(s.id)}">${esc(s.name)} ${esc(s.start)}–${esc(s.end)}</option>`).join('')
    + '<option value="H">休息日</option><option value="R">例假</option><option value="L:特">特休</option><option value="L:補">補休</option><option value="L:國">國定假日假</option>'
    + (withClear ? '<option value="CLEAR">清空</option>' : '');
  return cur ? o.replace(`value="${esc(cur)}"`, `value="${esc(cur)}" selected`) : o;
}

/** 月曆（日～六）；editable＝每格是可點的按鈕。cells: {date: {t,s?,l?,pending?}}；issue: {date: 'block'|'warn'} */
export function calHtml(month, cells, shiftMap, holidays, opt) {
  opt = opt || {};
  const dates = monthDates(month);
  const lead = weekday(dates[0]);
  const all = Array(lead).fill(null).concat(dates);
  while (all.length % 7) all.push(null);
  const head = WD.map((w, i) => `<th class="${i === 0 || i === 6 ? 'we' : ''}">${w}</th>`).join('');
  let body = '';
  for (let r = 0; r < all.length; r += 7) {
    body += '<tr>' + all.slice(r, r + 7).map((d) => {
      if (!d) return '<td class="hq-na"></td>';
      const c = (cells || {})[d], x = cellInfo(c, shiftMap), hol = (holidays || {})[d];
      const p = c && c.pending ? cellInfo(c.pending, shiftMap) : null;
      const iss = (opt.issue || {})[d];
      const cls = `hq-day ${x.cls}${hol ? ' hol' : ''}${p ? ' pend' : ''}${iss ? ' i-' + iss : ''}${opt.sel === d ? ' sel' : ''}${c && c.src === 'manual' ? ' man' : ''}`;
      const inner = `<b>${+d.slice(8)}</b><span class="hq-v">${esc(x.t)}</span>${hol ? `<small>${esc(hol)}</small>` : ''}${p ? `<i class="hq-pend">待核准：${esc(p.t)}</i>` : ''}`;
      const label = `${md(d)} ${x.t || '還沒選'}${p ? '，待核准改成 ' + p.t : ''}`;
      return `<td>${opt.editable ? `<button type="button" class="${cls}" data-date="${d}" aria-label="${esc(label)}">${inner}</button>` : `<div class="${cls}" aria-label="${esc(label)}">${inner}</div>`}</td>`;
    }).join('') + '</tr>';
  }
  return `<table class="hq-cal"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** 檢查結果（可只列某個人的）；不收合，直接列出（最多 12 條） */
export function resultsHtml(results, empId) {
  const list = (results || []).filter((r) => !empId || r.emp_id === empId || !r.emp_id);
  const order = { block: 0, warn: 1, info: 2 };
  const nb = list.filter((r) => r.level === 'block').length, nw = list.filter((r) => r.level === 'warn').length;
  if (!list.length) return '<div class="card sc-sum" id="hqSum"><span class="lv ok">沒有違反規定</span></div>';
  const sorted = list.slice().sort((a, b) => order[a.level] - order[b.level]);
  return `<div class="card sc-sum" id="hqSum"><div><span class="sc-sumlabel">提醒</span>
    ${nb ? `<span class="lv block">${nb} 個要修正</span>` : '<span class="lv ok">沒有違反規定</span>'}${nw ? `<span class="lv warn">${nw} 個提醒</span>` : ''}</div>
    <ul class="sc-list">${sorted.slice(0, 12).map((r) => `<li class="lv-${r.level}">${esc(r.msg)}</li>`).join('')}${sorted.length > 12 ? `<li class="lv-info">還有 ${sorted.length - 12} 項…</li>` : ''}</ul></div>`;
}
export function issueMap(results, empId) {
  const out = {};
  for (const r of results || []) {
    if (!r.date || (empId && r.emp_id && r.emp_id !== empId)) continue;
    if (r.level === 'block' || (r.level === 'warn' && out[r.date] !== 'block')) out[r.date] = r.level;
  }
  return out;
}
