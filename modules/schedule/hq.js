// 總部自填排班／央廚固定排班畫面共用的小工具（self.js、fixed.js）：呼叫、月份換算、月曆、檢查結果清單。
// 規格：docs/schedule-hq/spec.md §5、§10.1。月份是畫面單位；格子 {t:'W'|'R'|'H'|'L', s?:班別, l?:假別}。
import { esc } from '../../js/ui.js';
import { timeText, shiftCode } from './hours.js';
import { api } from '../../js/api.js';
import { addDays, weekday, todayTaipei, periodNo, periodStart, label, diffDays } from './period.js';

export const call = (action, body) => api('POST', '/m/schedule/' + action, body || {});
export const WD = ['日', '一', '二', '三', '四', '五', '六'];
export const monthDates = (m) => { const out = []; for (let d = m + '-01'; d.slice(0, 7) === m; d = addDays(d, 1)) out.push(d); return out; };
export const nextMonth = (m) => addDays(m + '-01', 32).slice(0, 7);
export const prevMonth = (m) => addDays(m + '-01', -1).slice(0, 7);
export const mLabel = (m) => `${m.slice(0, 4)} 年 ${+m.slice(5)} 月`;
export const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
export const curMonth = () => todayTaipei().slice(0, 7);
/** 總部自填的預設期別（2026-11-03 起四週一期）：下一期開放填寫（開始前 SELF_OPEN 天）起看下一期，之前看本期 */
export const SELF_OPEN = 14;
export function defaultSelfPeriod() {
  const t = todayTaipei(), n = Math.max(1, periodNo(t) || 0);
  return label(diffDays(t, periodStart(label(n + 1))) <= SELF_OPEN ? n + 1 : n);
}

export const STATUS_TEXT = { draft: '草稿（還沒送出）', submitted: '已送出，等主管核准', approved: '已核准', rejected: '已退回，請修改後再送出' };
const LEAVE = { '特': '特休', '補': '補休', '國': '國定' };

/** 格子的顯示文字與樣式 */
const shColor = (sh) => (sh && /^#[0-9A-Fa-f]{6}$/.test(sh.color || '') ? sh.color : '');      // 班別顏色（2026-11-03 Eason：三個班表都依班別上色，取代 10/12「班別不分顏色」）
export function cellInfo(c, shiftMap) {
  if (!c || !c.t) return { t: '', cls: 'empty' };
  // 門市班顯示「光復 C」（門市簡稱去掉「店」＋班別代碼）；出差顯示「出差A」（總部出差＋門市班，2026-11-07）
  const nm0 = (id) => { const sh = shiftMap[id]; if (!sh) return id; if (!isExt(id)) return shiftCode(sh.name); const t = sh.name.split(' '); return t[0].replace(/店$/, '').replace(/^(新竹|台中|員林|台北)/, '') + ' ' + shiftCode(t.slice(1).join(' ')); };
  const nm = (id) => (id === c.s && c.tr ? '出差' : id === c.s2 && c.tr2 ? '出差' : '') + nm0(id);
  const two = c.s && c.s2 ? '＋' + nm(c.s2) : '';      // 一天兩班顯示「A＋C」（2026-11-07）
  if (c.t === 'W') { const sh = shiftMap[c.s]; return { t: (c.s ? nm(c.s) : '班') + two, cls: 'work' + (two ? ' two' : ''), color: shColor(sh) }; }
  if (c.t === 'H') { if (c.s) { const sh = shiftMap[c.s]; return { t: nm(c.s) + two, cls: 'work ot' + (two ? ' two' : ''), ot: true, color: shColor(sh) }; } return { t: '休', cls: 'off' }; }      // 休息日加班：班別＋橘色「休加」（otTag，同門市班表）
  if (c.t === 'R') return { t: '例', cls: 'rest' };
  if (c.t === 'L') return { t: LEAVE[c.l] || '假', cls: 'leave' };
  return { t: '', cls: 'empty' };
}
export const otTag = (x) => (x.ot ? '<i class="sc-ot">休加</i>' : '');
/** 選單值 → 格子（'S:<班別>'、'O:<班別>'＝休息日加班、'R'、'H'、'L:特'…、'CLEAR'） */
export function cellOfValue(v, v2, more) {
  if (v === 'CLEAR') return { t: '' };
  const two = Object.assign(v2 ? { s2: v2 } : {}, more || {});      // 第二班（一天兩班，2026-11-07）：只跟著班別、休息日加班；more＝出差 tr／tr2、門市站 w／w2
  if (v.startsWith('S:')) return Object.assign({ t: 'W', s: v.slice(2) }, two);
  if (v.startsWith('O:')) return Object.assign({ t: 'H', s: v.slice(2) }, two);
  if (v.startsWith('L:')) return { t: 'L', l: v.slice(2) };
  return { t: v };
}
export function valueOfCell(c) {
  if (!c || !c.t) return '';
  if (c.t === 'W') return 'S:' + c.s;
  if (c.t === 'H' && c.s) return 'O:' + c.s;
  if (c.t === 'L') return 'L:' + c.l;
  return c.t;
}
/** 第二班選單（一天兩班，2026-11-07）：第一格選了班別才能選；只列使用中的班（原本選的停用班照列） */
export function secondHtml(shifts, cur, firstVal, id, stores) {
  const on = /^[SO]:/.test(firstVal || '');
  const o = `<option value="">不加</option>${shifts.filter((s) => s.active !== 0 && s.active !== false || s.id === cur).map((s) => `<option value="${esc(s.id)}">${esc(shiftCode(s.name))} ${esc(timeText(s))}</option>`).join('')}${storeGroups(stores, '')}`;
  return `<label class="sc-two" for="${id}">＋第二班</label><select id="${id}" aria-label="第二個班別"${on ? '' : ' disabled'}>${cur ? o.replace(`value="${esc(cur)}"`, `value="${esc(cur)}" selected`) : o}</select>`;
}
/** 格子可選的內容（班別、休息日、休息日加班（班別，2026-11-03 Eason：總部、央廚都照門市正職）、例假、特休、補休、國定假日假） */
// 門市班（總部出差＋門市班，2026-11-07）：每家門市一組 optgroup，值「S:門市代號.班別」
export const storeGroups = (stores, prefix) => (stores || []).map((x) => `<optgroup label="${esc(x.name)}（門市）">${x.shifts.map((s) => `<option value="${prefix}${esc(s.id)}">${esc(x.name)} ${esc(shiftCode(s.name))} ${esc(timeText(s))}</option>`).join('')}</optgroup>`).join('');
export const isExt = (id) => typeof id === 'string' && id.indexOf('.') > 0;
export function cellOptions(shifts, cur, withClear, stores) {
  const o = shifts.map((s) => `<option value="S:${esc(s.id)}">${esc(shiftCode(s.name))} ${esc(timeText(s))}</option>`).join('')
    + storeGroups(stores, 'S:')
    + '<option value="H">休息日</option>'
    + shifts.map((s) => `<option value="O:${esc(s.id)}">${esc(shiftCode(s.name))} ${esc(timeText(s))}（休息日加班）</option>`).join('')
    + '<option value="R">例假</option><option value="L:特">特休</option><option value="L:補">補休</option><option value="L:國">國定假日假</option>'
    + (withClear ? '<option value="CLEAR">清空</option>' : '');
  return cur ? o.replace(`value="${esc(cur)}"`, `value="${esc(cur)}" selected`) : o;
}

/** 月曆（日～六）；editable＝每格是可點的按鈕。cells: {date: {t,s?,l?,pending?}}；issue: {date: 'block'|'warn'} */
export function calHtml(month, cells, shiftMap, holidays, opt) {
  opt = opt || {};
  const dates = Array.isArray(month) ? month : monthDates(month);      // 總部自填傳一期的日期清單（四週一期）
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
      const xt = x.t + (x.ot ? '（休息日加班）' : ''), pt = p ? p.t + (p.ot ? '（休息日加班）' : '') : '';
      const iss = (opt.issue || {})[d];
      const cls = `hq-day ${x.cls}${x.color ? ' shc' : ''}${hol ? ' hol' : ''}${p ? ' pend' : ''}${iss ? ' i-' + iss : ''}${opt.sel === d ? ' sel' : ''}${c && c.src === 'manual' ? ' man' : ''}`;
      const inner = `<b>${+d.slice(8)}</b><span class="hq-v">${esc(x.t)}</span>${otTag(x)}${hol ? `<small>${esc(hol)}</small>` : ''}${p ? `<i class="hq-pend">待核准：${esc(pt)}</i>` : ''}`;
      const label = `${md(d)} ${xt || '還沒選'}${p ? '，待核准改成 ' + pt : ''}`;
      const canClick = opt.editable && !(opt.lockBefore && d < opt.lockBefore) && !(opt.off && opt.off(d));      // 鎖住的日子（在別家打卡的人切換日以前、不在職）只顯示
      const sty = x.color ? ` style="--shc:${x.color}"` : '';
      return `<td>${canClick ? `<button type="button" class="${cls}"${sty} data-date="${d}" aria-label="${esc(label)}">${inner}</button>` : `<div class="${cls}"${sty} aria-label="${esc(label)}">${inner}</div>`}</td>`;
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
