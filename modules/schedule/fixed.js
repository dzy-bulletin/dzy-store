// 央廚固定排班：「央廚班表」（月曆總表，人×日；廠長可改格子、重新產生）與「固定班別」（每人平日上哪個班）。
// 規格 docs/schedule-hq/spec.md §4、§5、§10.1：平日＝固定班別、週六休息日、週日例假、國定假日／補假（平日）＝國定假日假；手改的格子重新產生時不會被蓋掉；
// 廠長改格子立即生效，系統約 1 分鐘內合併重送 LINE。
import { esc, busy } from '../../js/ui.js';
import { call, cellInfo, cellOptions, cellOfValue, valueOfCell, mLabel, md, monthDates, nextMonth, prevMonth, curMonth, resultsHtml, WD } from './hq.js';
import { weekday } from './period.js';

export const F = { key: null, month: null, data: null, loading: null, sel: null, msg: '', err: '' };
export function resetFixed(key) { Object.assign(F, { key, month: null, data: null, loading: null, sel: null, msg: '', err: '' }); }

async function load() {
  if (!F.month) F.month = curMonth();
  let d = await call('fixedLoad', { month: F.month });
  const lo = d.mode_from ? d.mode_from.slice(0, 7) : null;
  if (lo && F.month < lo) { F.month = lo; d = await call('fixedLoad', { month: F.month }); }
  F.data = d;
  return d;
}
const say = (m, isErr) => { F.msg = isErr ? '' : m; F.err = isErr ? m : ''; };
const reload = async () => { F.data = null; await load(); };

function head(D, title, extra) {
  const lo = D.mode_from ? D.mode_from.slice(0, 7) : prevMonth(F.month), hi = nextMonth(nextMonth(curMonth()));
  return `<div class="card sc-head"><div class="sc-period"><button type="button" class="btn ghost sm" id="fxPrev" aria-label="上一個月" ${F.month <= lo ? 'disabled' : ''}>‹</button>
    <div><b id="fxMonth">${esc(mLabel(F.month))}</b><span class="sc-range">${esc(title)}</span></div>
    <button type="button" class="btn ghost sm" id="fxNext" aria-label="下一個月" ${F.month >= hi ? 'disabled' : ''}>›</button></div>${extra || ''}
    <div id="fxMsg" class="${F.err ? 'err' : 'okmsg'}" role="status">${esc(F.err || F.msg || '')}</div></div>`;
}
function bindMonth(ctx, el) {
  const go = (m) => { F.month = m; F.data = null; F.sel = null; say(''); ctx.rerender(); };
  const p = el.querySelector('#fxPrev'), n = el.querySelector('#fxNext');
  if (p) p.onclick = () => go(prevMonth(F.month));
  if (n) n.onclick = () => go(nextMonth(F.month));
}
function shell(ctx, draw) {
  const key = ctx.session.token || ctx.session.code;
  if (F.key !== key) resetFixed(key);
  if (F.data && F.data.month === F.month) return draw();
  ctx.el.innerHTML = '<div class="card"><p class="hint" style="margin:0">讀取中…</p></div>';
  if (!F.loading) F.loading = load().finally(() => { F.loading = null; });
  return F.loading.then(draw, (e) => {
    if (!ctx.el.isConnected) return;
    ctx.el.innerHTML = `<div class="card"><div class="err" id="fxLoadErr" role="alert">${esc(e.message)}</div><button class="btn mt" id="fxRetry" type="button">重新讀取</button></div>`;
    ctx.el.querySelector('#fxRetry').onclick = () => ctx.rerender();
  });
}

// ---------------------------------------------------------------- 央廚班表
export function renderFixed(ctx) {
  return shell(ctx, () => { if (ctx.el.isConnected) drawFixed(ctx); });
}

function drawFixed(ctx) {
  const el = ctx.el, D = F.data;
  const shiftMap = Object.fromEntries(D.shifts.map((s) => [s.id, s]));
  const dates = monthDates(F.month);
  const byCell = {};
  for (const r of D.results) if (r.emp_id && r.date) byCell[r.emp_id + '|' + r.date] = r.level;
  const th = dates.map((d) => `<th class="${[0, 6].includes(weekday(d)) || D.holidays[d] ? 'we' : ''}${D.holidays[d] ? ' hol' : ''}" title="${esc(D.holidays[d] || '')}">${md(d)}<small>${WD[weekday(d)]}${D.holidays[d] ? '・休' : ''}</small></th>`).join('');
  const rows = D.staff.map((st) => {
    const tds = dates.map((d) => {
      const c = (D.cells[st.emp_id] || {})[d], x = cellInfo(c, shiftMap), lv = byCell[st.emp_id + '|' + d];
      const sel = F.sel && F.sel.emp === st.emp_id && F.sel.date === d;
      const cls = `sc-c ${x.cls}${[0, 6].includes(weekday(d)) || D.holidays[d] ? ' we' : ''}${lv ? ' i-' + lv : ''}${sel ? ' sel' : ''}${c && c.src === 'manual' ? ' man' : ''}`;
      return `<td class="${cls}" data-emp="${esc(st.emp_id)}" data-date="${d}">${esc(x.t)}</td>`;
    }).join('');
    return `<tr><th class="sc-name" scope="row">${esc(st.name)}${st.fixed_shift ? `<small class="sc-al">${esc((shiftMap[st.fixed_shift] || {}).name || st.fixed_shift)}</small>` : '<small class="sc-al">未設固定班別</small>'}</th>${tds}</tr>`;
  }).join('');
  const acts = D.canEdit ? `<div class="row sc-acts mt"><button type="button" class="btn" id="fxGen">重新產生這個月（手改的不會被蓋掉）</button></div>` : '<p class="hint mt">你只能查看央廚班表，修改請找廠長。</p>';
  el.innerHTML = head(D, `央廚 ${D.staff.length} 位同仁`, `<p class="hint mt">平日＝固定班別、週六休息日、週日例假、國定假日／補假＝國定假日假。廠長改格子立即生效，系統約 1 分鐘內合併送到 LINE。有「・」的是手改過的格子。</p>${acts}`)
    + resultsHtml(D.results)
    + `<div class="card sc-gridcard"><div class="scroll"><table class="sc-grid fx-grid"><thead><tr><th class="sc-name">同仁</th>${th}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
  if (F.sel && D.canEdit) {
    const st = D.staff.find((x) => x.emp_id === F.sel.emp), c = (D.cells[F.sel.emp] || {})[F.sel.date];
    el.insertAdjacentHTML('beforeend', `<div class="card sc-editor" id="fxEditor"><b>${esc(st ? st.name : '')}　${md(F.sel.date)}（${WD[weekday(F.sel.date)]}）</b>
      <div class="row mt"><select id="fxCellSel" aria-label="這一格要排什麼">${cellOptions(D.shifts, valueOfCell(c), true)}</select>
      <button type="button" class="btn" id="fxCellOk">套用</button><button type="button" class="btn ghost" id="fxCellX">取消</button></div></div>`);
  }
  const q = (s) => el.querySelector(s);
  bindMonth(ctx, el);
  const after = async (okMsg) => { try { await reload(); say(okMsg); } catch (e) { say(e.message, true); } ctx.rerender(); };
  if (D.canEdit) el.querySelectorAll('td.sc-c[data-emp]').forEach((td) => { td.onclick = () => { F.sel = { emp: td.dataset.emp, date: td.dataset.date }; say(''); ctx.rerender(); }; });
  if (q('#fxCellX')) q('#fxCellX').onclick = () => { F.sel = null; ctx.rerender(); };
  if (q('#fxCellOk')) q('#fxCellOk').onclick = () => busy(q('#fxCellOk'), async () => {
    const { emp, date } = F.sel;
    try { await call('fixedSave', { month: F.month, version: D.version, cells: { [emp]: { [date]: cellOfValue(q('#fxCellSel').value) } } }); F.sel = null; await after('已存，立即生效，約 1 分鐘內送到 LINE'); }
    catch (e) { say(e.message, true); if (e.code === 'CONFLICT') { try { await reload(); } catch (e2) { /* 留原畫面 */ } } ctx.rerender(); }
  });
  if (q('#fxGen')) q('#fxGen').onclick = () => busy(q('#fxGen'), async () => {
    try { const r = await call('fixedGenerate', { month: F.month }); await after(`產生了 ${r.generated} 格，保留 ${r.kept} 格${r.generated ? '，正在送到 LINE' : '（沒有需要改的）'}`); }
    catch (e) { say(e.message, true); ctx.rerender(); }
  });
}

// ---------------------------------------------------------------- 固定班別
export function renderFixedStaff(ctx) {
  return shell(ctx, () => { if (ctx.el.isConnected) drawFixedStaff(ctx); });
}

function drawFixedStaff(ctx) {
  const el = ctx.el, D = F.data;
  const rows = D.staff.map((st) => `<div class="sc-drow fx-row"><span class="sc-dn">${esc(st.name)}<small class="sc-al">${esc(st.emp_id)}</small></span>
      <span class="sc-dv"><select class="fx-shift" data-emp="${esc(st.emp_id)}" aria-label="${esc(st.name)} 平日上哪個班" ${D.canEdit ? '' : 'disabled'}>
        <option value="">未設定（平日不排班）</option>${D.shifts.map((s) => `<option value="${esc(s.id)}" ${st.fixed_shift === s.id ? 'selected' : ''}>${esc(s.name)} ${esc(s.start)}–${esc(s.end)}</option>`).join('')}</select></span></div>`).join('');
  const lack = D.staff.filter((st) => !st.fixed_shift).length;
  const warn = lack ? `<p class="hint mt err" id="fxLack">${lack} 位同仁還沒設固定班別，他們的平日班表是空白的</p>` : '';
  el.innerHTML = head(D, '固定班別', `${warn}<p class="hint mt">每個人平日上的班。設定或更改後，系統會自動重產他從明天起的平日班表（手改的格子與請假不會被蓋掉），並送到 LINE。</p>`)
    + `<div class="card"><div class="sc-dlist" id="fxStaff">${rows || '<p class="hint" style="margin:0">還沒有同仁。</p>'}</div>${D.canEdit ? '' : '<p class="hint mt">只有廠長可以設定固定班別。</p>'}</div>`;
  bindMonth(ctx, el);
  el.querySelectorAll('select.fx-shift').forEach((sel) => {
    sel.onchange = async () => {
      sel.disabled = true;
      try { await call('fixedShift', { emp_id: sel.dataset.emp, shift_id: sel.value || null }); await reload(); say('已設定，他從明天起的平日班表已更新'); }
      catch (e) { say(e.message, true); }
      ctx.rerender();
    };
  });
}
