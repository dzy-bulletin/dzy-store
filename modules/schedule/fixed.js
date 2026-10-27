// 央廚固定排班：「央廚班表」（四週一期的總表，人×日；廠長可改格子、重新產生這一期）與「固定班別」（每人平日上哪個班）。
// 規格 docs/schedule-hq/spec.md §4、§5、§10.1：平日＝固定班別、週六休息日、週日例假、國定假日／補假（平日）＝國定假日假；手改的格子重新產生時不會被蓋掉；
// 廠長改格子立即生效，系統約 1 分鐘內合併重送 LINE。2026-10-27 Eason 改「央廚用 T01」：畫面跟門市排班一樣 ‹ T01 › 一期 28 天，跨月那欄標月份。
import { esc, busy } from '../../js/ui.js';
import { timeText } from './hours.js';
import { call, cellInfo, cellOptions, cellOfValue, valueOfCell, md, resultsHtml, WD } from './hq.js';
import { weekday, periodOf, periodNo, periodStart, periodEnd, periodDates, shiftPeriod, parseLabel, label, todayTaipei } from './period.js';
import { stHidden, setStHidden, stToggleHtml } from './stview.js';

export const F = { key: null, period: null, data: null, loading: null, sel: null, msg: '', err: '' };
// 設定頁（班別、站別）改了東西後，央廚班表／固定班別的快取要作廢，下次進去重讀（不然新站別、新班別要換期才看得到）
export function staleFixed() { F.data = null; }
export function resetFixed(key) { Object.assign(F, { key, period: null, data: null, loading: null, sel: null, msg: '', err: '' }); }

// 今天所在的期（最早 T01）；往後最多看到再兩期（還沒產生＝空白），同原本「當月＋兩個月」
const curPeriod = () => label(Math.max(1, periodNo(todayTaipei()) || 0));
const ymd = (d) => `${d.slice(0, 4)}/${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
async function load() {
  if (!F.period) F.period = curPeriod();
  let d = await call('fixedLoad', { period: F.period });
  const lo = d.mode_from ? periodOf(d.mode_from) : null;
  if (lo && parseLabel(F.period) < parseLabel(lo)) { F.period = lo; d = await call('fixedLoad', { period: F.period }); }
  F.data = d;
  return d;
}
const say = (m, isErr) => { F.msg = isErr ? '' : m; F.err = isErr ? m : ''; };
const reload = async () => { F.data = null; await load(); };

// nav＝false：固定班別頁不分期，不畫換期鈕
function head(D, title, extra, nav) {
  const lo = D.mode_from ? parseLabel(periodOf(D.mode_from)) : 1, hi = parseLabel(curPeriod()) + 2, n = parseLabel(F.period);
  const start = periodStart(F.period), end = periodEnd(F.period);
  const bar = nav === false ? `<div class="sc-period"><div><b>${esc(title)}</b></div></div>`
    : `<div class="sc-printtitle" id="fxPrintTitle">央廚班表　${esc(F.period)}　${ymd(start)}–${+end.slice(5, 7)}/${+end.slice(8, 10)}　<small>列印日期 ${ymd(todayTaipei())}</small></div>
    <div class="sc-period"><button type="button" class="btn ghost sm" id="fxPrev" aria-label="上一期" ${n <= lo ? 'disabled' : ''}>‹</button>
    <div><b id="fxPeriod">${esc(F.period)}</b><span class="sc-range" id="fxRange">${md(start)}（日）– ${md(end)}（六）・${esc(title)}</span></div>
    <button type="button" class="btn ghost sm" id="fxNext" aria-label="下一期" ${n >= hi ? 'disabled' : ''}>›</button></div>`;
  return `<div class="card sc-head">${bar}${extra || ''}
    <div id="fxMsg" class="${F.err ? 'err' : 'okmsg'}" role="status">${esc(F.err || F.msg || '')}</div></div>`;
}
function bindPeriod(ctx, el) {
  const go = (k) => { F.period = shiftPeriod(F.period, k); F.data = null; F.sel = null; say(''); ctx.rerender(); };
  const p = el.querySelector('#fxPrev'), n = el.querySelector('#fxNext');
  if (p) p.onclick = () => go(-1);
  if (n) n.onclick = () => go(1);
}
function shell(ctx, draw) {
  const key = ctx.session.token || ctx.session.code;
  if (F.key !== key) resetFixed(key);
  if (F.data && F.period && F.data.period === F.period) return draw();
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
  const dates = periodDates(F.period);
  // 換月：每月 1 號（不是這期第一天）那欄左邊粗線、日期上標「12月」（Eason 2026-10-27 選 3A）
  const mb = (d, i) => (i > 0 && d.slice(8) === '01' ? ' mb' : '');
  // 工作站別（station-spec §7）：店裡沒有任何站別就完全不畫站別相關的東西。stMap 含停用的站（舊格子照樣顯示）。
  const stList = D.stations || [], stMap = Object.fromEntries(stList.map((x) => [x.id, x]));
  const stActive = stList.filter((x) => x.active);
  const hideSt = stHidden();   // 「隱藏工作站」：只藏格子小標與各站人數列，改站別的面板照常
  const stTag = (c) => {
    if (hideSt || !c || c.t === 'L' || !c.s) return '';
    const x = c.w && stMap[c.w];
    if (x) return `<small class="sc-sn${x.active ? '' : ' off'}" data-station="${esc(x.id)}"${x.color ? ` style="color:${esc(x.color)}"` : ''}>${esc(x.name)}</small>`;
    return stActive.length ? '<small class="sc-sn none">未選站</small>' : '';
  };
  const stCount = (d, id) => D.staff.filter((st) => { const c = (D.cells[st.emp_id] || {})[d]; return c && c.s && c.w === id; }).length;
  const byCell = {};
  for (const r of D.results) if (r.emp_id && r.date) byCell[r.emp_id + '|' + r.date] = r.level;
  const th = dates.map((d, i) => `<th class="${[0, 6].includes(weekday(d)) || D.holidays[d] ? 'we' : ''}${D.holidays[d] ? ' hol' : ''}${mb(d, i)}" title="${esc(D.holidays[d] || '')}">${mb(d, i) ? `<span class="sc-mlab">${+d.slice(5, 7)}月</span>` : ''}${md(d)}<small>${WD[weekday(d)]}${D.holidays[d] ? '・休' : ''}</small></th>`).join('');
  const rows = D.staff.map((st) => {
    const tds = dates.map((d, i) => {
      const c = (D.cells[st.emp_id] || {})[d], x = cellInfo(c, shiftMap), lv = byCell[st.emp_id + '|' + d];
      const sel = F.sel && F.sel.emp === st.emp_id && F.sel.date === d;
      const cls = `sc-c ${x.cls}${[0, 6].includes(weekday(d)) || D.holidays[d] ? ' we' : ''}${lv ? ' i-' + lv : ''}${sel ? ' sel' : ''}${c && c.src === 'manual' ? ' man' : ''}${mb(d, i)}`;
      return `<td class="${cls}" data-emp="${esc(st.emp_id)}" data-date="${d}">${esc(x.t)}${stTag(c)}</td>`;
    }).join('');
    return `<tr><th class="sc-name" scope="row">${esc(st.name)}${st.fixed_shift ? `<small class="sc-al">${esc((shiftMap[st.fixed_shift] || {}).name || st.fixed_shift)}</small>` : '<small class="sc-al">未設固定班別</small>'}</th>${tds}</tr>`;
  }).join('');
  // 各站人數：每個使用中的站一列（有設最少人數才顯示「1/2」，不足紅字）
  const stRows = (hideSt ? [] : stActive).map((x) => `<tr class="sc-stcnt" data-station="${esc(x.id)}"><th scope="row">${esc(x.name)}</th>${dates.map((d, i) => {
    const n = stCount(d, x.id), need = ((D.stationNeed || {})[d] || {})[x.id] || 0;
    return `<td class="${need && n < need ? 'short' : ''}${[0, 6].includes(weekday(d)) || D.holidays[d] ? ' we' : ''}${mb(d, i)}" title="${esc(x.name)}${need ? `至少要 ${need} 人` : '沒有設人數'}">${n}${need ? '/' + need : ''}</td>`;
  }).join('')}</tr>`).join('');
  const tog = stList.length ? stToggleHtml('fxStToggle') : '';
  const acts = (D.canEdit ? `<div class="row sc-acts mt"><button type="button" class="btn" id="fxGen">重新產生這一期（手改的不會被蓋掉）</button>${tog}</div>`
    : `<p class="hint mt">你只能查看央廚班表，修改請找廠長。</p>${tog ? `<div class="row sc-acts mt">${tog}</div>` : ''}`);
  el.innerHTML = head(D, `央廚 ${D.staff.length} 位同仁`, `<p class="hint mt fx-hint">平日＝固定班別、週六休息日、週日例假、國定假日／補假＝國定假日假。每期開始前 10 天自動排好下一期。廠長改格子立即生效，系統約 1 分鐘內合併送到 LINE。有「・」的是手改過的格子。</p>${acts}`)
    + resultsHtml(D.results)
    + `<div class="card sc-gridcard"><div class="scroll"><table class="sc-grid fx-grid"><thead><tr><th class="sc-name">同仁</th>${th}</tr></thead><tbody>${rows}${stRows}</tbody></table></div></div>`;
  if (F.sel && D.canEdit) {
    const st = D.staff.find((x) => x.emp_id === F.sel.emp), c = (D.cells[F.sel.emp] || {})[F.sel.date];
    el.insertAdjacentHTML('beforeend', `<div class="card sc-editor" id="fxEditor"><b>${esc(st ? st.name : '')}　${md(F.sel.date)}（${WD[weekday(F.sel.date)]}）</b>
      <div class="row mt"><select id="fxCellSel" aria-label="這一格要排什麼">${cellOptions(D.shifts, valueOfCell(c), true)}</select>
      <button type="button" class="btn" id="fxCellOk">套用</button><button type="button" class="btn ghost" id="fxCellX">取消</button></div>
      ${c && c.s && (stActive.length || c.w) ? `<div class="row mt"><label for="fxStationSel">工作站</label><select id="fxStationSel" aria-label="這一格的工作站"><option value="">不選</option>${
        stList.filter((x) => x.active || x.id === c.w).map((x) => `<option value="${esc(x.id)}"${x.id === c.w ? ' selected' : ''}>${esc(x.name)}${x.active ? '' : '（已停用）'}</option>`).join('')}</select>
        <button type="button" class="btn" id="fxStationOk">儲存站別</button></div>` : ''}</div>`);
  }
  const q = (s) => el.querySelector(s);
  bindPeriod(ctx, el);
  const after = async (okMsg) => { try { await reload(); say(okMsg); } catch (e) { say(e.message, true); } ctx.rerender(); };
  if (D.canEdit) el.querySelectorAll('td.sc-c[data-emp]').forEach((td) => { td.onclick = () => { F.sel = { emp: td.dataset.emp, date: td.dataset.date }; say(''); ctx.rerender(); }; });
  if (q('#fxCellX')) q('#fxCellX').onclick = () => { F.sel = null; ctx.rerender(); };
  if (q('#fxCellOk')) q('#fxCellOk').onclick = () => busy(q('#fxCellOk'), async () => {
    const { emp, date } = F.sel;
    try { await call('fixedSave', { period: F.period, version: D.version, cells: { [emp]: { [date]: cellOfValue(q('#fxCellSel').value) } } }); F.sel = null; await after('已存，立即生效，約 1 分鐘內送到 LINE'); }
    catch (e) { say(e.message, true); if (e.code === 'CONFLICT') { try { await reload(); } catch (e2) { /* 留原畫面 */ } } ctx.rerender(); }
  });
  if (q('#fxStationOk')) q('#fxStationOk').onclick = () => busy(q('#fxStationOk'), async () => {
    const { emp, date } = F.sel;
    try { await call('fixedStation', { period: F.period, version: D.version, cells: [{ emp_id: emp, date, station_id: q('#fxStationSel').value || null }] }); F.sel = null; await after('已存站別，立即生效，約 1 分鐘內送到 LINE'); }
    catch (e) { say(e.message, true); if (e.code === 'CONFLICT') { try { await reload(); } catch (e2) { /* 留原畫面 */ } } ctx.rerender(); }
  });
  if (q('#fxStToggle')) q('#fxStToggle').onclick = () => { setStHidden(!stHidden()); ctx.rerender(); };
  if (q('#fxGen')) q('#fxGen').onclick = () => busy(q('#fxGen'), async () => {
    try { const r = await call('fixedGenerate', { period: F.period }); await after(`產生了 ${r.generated} 格，保留 ${r.kept} 格${r.generated ? '，正在送到 LINE' : '（沒有需要改的）'}`); }
    catch (e) { say(e.message, true); ctx.rerender(); }
  });
}

// ---------------------------------------------------------------- 固定班別
export function renderFixedStaff(ctx) {
  return shell(ctx, () => { if (ctx.el.isConnected) drawFixedStaff(ctx); });
}

function drawFixedStaff(ctx) {
  const el = ctx.el, D = F.data;
  const stList = D.stations || [];
  const showSt = stList.some((x) => x.active) || D.staff.some((st) => st.default_station);
  const stSel = (st) => `<select class="fx-station" data-emp="${esc(st.emp_id)}" aria-label="${esc(st.name)} 預設站別" ${D.canEdit ? '' : 'disabled'}><option value="">預設站別：不設</option>${
    stList.filter((x) => x.active || x.id === st.default_station).map((x) => `<option value="${esc(x.id)}" ${st.default_station === x.id ? 'selected' : ''}>${esc(x.name)}${x.active ? '' : '（已停用）'}</option>`).join('')}</select>`;
  const rows = D.staff.map((st) => `<div class="sc-drow fx-row"><span class="sc-dn">${esc(st.name)}<small class="sc-al">${esc(st.emp_id)}</small></span>
      <span class="sc-dv"><select class="fx-shift" data-emp="${esc(st.emp_id)}" aria-label="${esc(st.name)} 平日上哪個班" ${D.canEdit ? '' : 'disabled'}>
        <option value="">未設定（平日不排班）</option>${D.shifts.map((s) => `<option value="${esc(s.id)}" ${st.fixed_shift === s.id ? 'selected' : ''}>${esc(s.name)} ${esc(timeText(s))}</option>`).join('')}</select>${showSt ? ' ' + stSel(st) : ''}</span></div>`).join('');
  const lack = D.staff.filter((st) => !st.fixed_shift).length;
  const warn = lack ? `<p class="hint mt err" id="fxLack">${lack} 位同仁還沒設固定班別，他們的平日班表是空白的</p>` : '';
  el.innerHTML = head(D, '固定班別', `${warn}<p class="hint mt">每個人平日上的班。設定或更改後，系統會自動重產他從明天起的平日班表（手改的格子與請假不會被蓋掉），並送到 LINE。</p>`, false)
    + `<div class="card"><div class="sc-dlist" id="fxStaff">${rows || '<p class="hint" style="margin:0">還沒有同仁。</p>'}</div>${D.canEdit ? '' : '<p class="hint mt">只有廠長可以設定固定班別。</p>'}</div>`;
  el.querySelectorAll('select.fx-station').forEach((sel) => {
    sel.onchange = async () => {
      sel.disabled = true;
      try { await call('fixedDefaultStation', { emp_id: sel.dataset.emp, station_id: sel.value || null }); await reload(); say('已設定預設站別，之後新產生的上班格會帶入；已經排好的格子不變'); }
      catch (e) { say(e.message, true); }
      ctx.rerender();
    };
  });
  el.querySelectorAll('select.fx-shift').forEach((sel) => {
    sel.onchange = async () => {
      sel.disabled = true;
      try { await call('fixedShift', { emp_id: sel.dataset.emp, shift_id: sel.value || null }); await reload(); say('已設定，他從明天起的平日班表已更新'); }
      catch (e) { say(e.message, true); }
      ctx.rerender();
    };
  });
}
