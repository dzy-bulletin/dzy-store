// 總部自填排班：「我的班表」（同仁每期自己選班，存了就生效）與「部屬班表」（主管唯讀看部屬每一期）。2026-11-03 起四週一期、不用核准。
// 規格 docs/schedule-hq/spec.md §3、§5、§10.1。資料一律整包重讀（selfLoad 回來的就是最新的狀態、版本與檢查結果），畫面不自己拼。
import { esc, busy } from '../../js/ui.js';
import { timeText, shiftCode } from './hours.js';
import { call, calHtml, resultsHtml, issueMap, cellOptions, cellOfValue, valueOfCell, md, defaultSelfPeriod, SELF_OPEN, WD } from './hq.js';
import { weekday, periodOf, periodNo, periodStart, periodEnd, periodDates, shiftPeriod, parseLabel, diffDays, todayTaipei } from './period.js';
import { canEdit } from './state.js';

export const H = { key: null, period: null, data: null, loading: null, who: null, emp: null, sel: null, shEdit: null, msg: '', err: '' };
export function resetSelf(key) { Object.assign(H, { key, period: null, data: null, loading: null, who: null, emp: null, sel: null, shEdit: null, msg: '', err: '' }); }

async function load() {
  if (!H.period) H.period = defaultSelfPeriod();
  let d = await call('selfLoad', { period: H.period });
  const lo = d.mode_from ? periodOf(d.mode_from) : null;
  if (lo && parseLabel(H.period) < parseLabel(lo)) { H.period = lo; d = await call('selfLoad', { period: H.period }); }       // 起用日以前的期別不在這套排班
  H.data = d;
  return d;
}
const say = (m, isErr) => { H.msg = isErr ? '' : m; H.err = isErr ? m : ''; };
const reload = async () => { H.data = null; await load(); };

/** 期別切換（兩個分頁共用；2026-11-03 起四週一期）：最早起用那期、最晚下一期 */
function head(D, title, extra) {
  const n = parseLabel(H.period), lo = D.mode_from ? parseLabel(periodOf(D.mode_from)) : Math.max(1, n - 1), hi = Math.max(1, periodNo(todayTaipei()) || 0) + 1;
  const start = periodStart(H.period), end = periodEnd(H.period);
  return `<div class="card sc-head"><div class="sc-period"><button type="button" class="btn ghost sm" id="hqPrev" aria-label="上一期" ${n <= lo ? 'disabled' : ''}>‹</button>
    <div><b id="hqMonth">${esc(H.period)}</b><span class="sc-range" id="hqRange">${md(start)}（日）– ${md(end)}（六）・${esc(title)}</span></div>
    <button type="button" class="btn ghost sm" id="hqNext" aria-label="下一期" ${n >= hi ? 'disabled' : ''}>›</button></div>${extra || ''}
    <div id="hqMsg" class="${H.err ? 'err' : 'okmsg'}" role="status">${esc(H.err || H.msg || '')}</div></div>`;
}
function bindMonth(ctx, el) {
  const go = (k) => { H.period = shiftPeriod(H.period, k); H.data = null; H.sel = null; H.who = null; say(''); ctx.rerender(); };
  const p = el.querySelector('#hqPrev'), n = el.querySelector('#hqNext');
  if (p) p.onclick = () => go(-1);
  if (n) n.onclick = () => go(1);
}

/** 資料載入外殼：沒資料先讀；讀不到顯示白話＋重新讀取 */
function shell(ctx, draw) {
  if (H.data && H.data.period === H.period) return draw();
  ctx.el.innerHTML = '<div class="card"><p class="hint" style="margin:0">讀取中…</p></div>';
  if (!H.loading) H.loading = load().finally(() => { H.loading = null; });
  return H.loading.then(draw, (e) => {
    if (!ctx.el.isConnected) return;
    ctx.el.innerHTML = `<div class="card"><div class="err" id="hqLoadErr" role="alert">${esc(e.message)}</div><button class="btn mt" id="hqRetry" type="button">重新讀取</button></div>`;
    ctx.el.querySelector('#hqRetry').onclick = () => ctx.rerender();
  });
}

// ---------------------------------------------------------------- 總部班別卡（新增、修改）
// 誰能用：能排整個總部的人（canEdit＝人資主管、管理員，放在「部屬核准」）＋總部總監 shiftAdmin（2026-10-30 Eason：hm、odir 都能新增、修改，放在「我的班表」；沒有我的班表才放部屬核准）。
// 總部班別是共用的一份清單；刪除只在門市排班的「班別與設定」頁（用過就不能刪），這裡不提供。伺服器 schedule.js mod() 對 shiftAdmin 只放行 saveShift。
const shiftAdminOf = (ses) => !!(ses && ses.person && ses.shiftAdmin);
const shiftsInApprove = (ses) => canEdit(ses) || (shiftAdminOf(ses) && !ses.schedSelfOn);
const shiftsInSelf = (ses) => shiftAdminOf(ses) && !canEdit(ses) && !!ses.schedSelfOn;
function shiftCardHtml(D) {
  const ed = H.shEdit ? D.shifts.find((s) => s.id === H.shEdit) : null;
  if (H.shEdit && !ed) H.shEdit = null;
  const desc = (s) => `${esc(shiftCode(s.name))} ${esc(timeText(s))}（${s.segs ? '分段班' : `休息 ${s.break_min} 分`}）`;
  const list = D.shifts.length ? `<div class="sc-dlist" id="hqShList">${D.shifts.map((s) => `<div class="row hq-shrow"><span class="grow">${desc(s)}</span><button type="button" class="hq-shEdit btn sm ghost" data-id="${esc(s.id)}">修改</button></div>`).join('')}</div>`
    : '<p class="hint">還沒有班別，同仁沒有班可以選。</p>';
  // 中間休息不打卡（2026-11-02 Eason：財務 09–18、14–15 吃飯不打卡）＝填「中間休息」就存成兩段（09:00–14:00＋15:00–18:00），核定頁才會預填兩段、空檔不算工時。
  // 兩段、各段沒有另外的休息＝這裡改得到；三段或段內另有休息的分段班仍只能改名稱（在門市排班「班別與設定」頁改時段）
  const gapOf = (s) => (s && s.segs && s.segs.length === 2 && s.segs.every((x) => !Number(x.break_min)) ? { start: s.segs[0].start, end: s.segs[1].end, gs: s.segs[0].end, ge: s.segs[1].start } : null);
  const g = gapOf(ed);
  const v = g ? Object.assign({}, ed, { start: g.start, end: g.end, break_min: 0 }) : ed || { name: '', start: '09:00', end: '18:00', break_min: 60 };
  const segLock = ed && ed.segs && !g ? ' disabled' : '';
  return `<div class="card" id="hqShifts"><h2>總部班別</h2>${list}
      ${ed ? `<p class="hint mt" id="hqShEditing">修改「${esc(ed.name)}」${segLock ? '（分段班：這裡只能改名稱）' : ''}；已經用在已鎖定班表的班別不能改時間，請新增一個班別。</p>` : '<p class="hint mt">總部班別是大家共用的一份清單，新增、修改都會留紀錄。</p>'}
      <div class="row"><input id="hqShName" placeholder="班別名稱" maxlength="12" aria-label="班別名稱" style="width:110px" value="${esc(v.name)}"><input id="hqShStart" type="time" value="${esc(v.start)}" aria-label="上班時間"${segLock}><input id="hqShEnd" type="time" value="${esc(v.end)}" aria-label="下班時間"${segLock}>
      <input id="hqShBrk" type="number" min="0" max="600" value="${Number(v.break_min) || 0}" aria-label="休息分鐘" style="width:70px"${segLock || (g ? ' disabled' : '')}>${ed ? '<button type="button" class="btn sm" id="hqShSave">儲存修改</button><button type="button" class="btn sm ghost" id="hqShCancel">取消</button>' : '<button type="button" class="btn sm" id="hqShAdd">新增班別</button>'}</div>
      ${segLock ? '' : `<div class="row mt"><span>中間休息不打卡（選填）</span><input id="hqShGapS" type="time" value="${esc(g ? g.gs : '')}" aria-label="中間休息開始"><span>到</span><input id="hqShGapE" type="time" value="${esc(g ? g.ge : '')}" aria-label="中間休息結束"></div>
      <p class="hint">填了＝存成兩段（例：09:00–14:00＋15:00–18:00），核定頁預填兩段、中間不算工時，休息分鐘不用填。</p>`}</div>`;
}
function bindShiftCard(ctx, el, D) {
  const q = (s) => el.querySelector(s);
  if (!q('#hqShifts')) return;
  const done = async (okMsg) => { H.shEdit = null; try { await reload(); say(okMsg); } catch (e) { say(e.message, true); } ctx.rerender(); };
  const form = () => {
    const f = { name: q('#hqShName').value.trim(), start: q('#hqShStart').value, end: q('#hqShEnd').value, break_min: Number(q('#hqShBrk').value) || 0 };
    const gs = q('#hqShGapS') ? q('#hqShGapS').value : '', ge = q('#hqShGapE') ? q('#hqShGapE').value : '';
    if (!gs && !ge) return f;
    if (!gs || !ge) throw new Error('中間休息的開始、結束都要填（不分兩段就兩格都清空）');
    return Object.assign(f, { break_min: 0, segs: [{ start: f.start, end: gs, break_min: 0 }, { start: ge, end: f.end, break_min: 0 }] });
  };
  const syncBrk = () => { if (q('#hqShGapS') && !q('#hqShStart').disabled) q('#hqShBrk').disabled = !!(q('#hqShGapS').value || q('#hqShGapE').value); };
  ['#hqShGapS', '#hqShGapE'].forEach((id) => { if (q(id)) q(id).oninput = syncBrk; });
  el.querySelectorAll('button.hq-shEdit').forEach((b) => { b.onclick = () => { H.shEdit = b.dataset.id; say(''); ctx.rerender(); }; });
  if (q('#hqShCancel')) q('#hqShCancel').onclick = () => { H.shEdit = null; say(''); ctx.rerender(); };
  if (q('#hqShAdd')) q('#hqShAdd').onclick = () => busy(q('#hqShAdd'), async () => {
    try { await call('saveShift', { shift: form() }); await done('已新增班別'); } catch (e) { say(e.message, true); ctx.rerender(); }
  });
  if (q('#hqShSave')) q('#hqShSave').onclick = () => busy(q('#hqShSave'), async () => {
    const cur = D.shifts.find((s) => s.id === H.shEdit);
    if (!cur) { H.shEdit = null; return ctx.rerender(); }
    // 只送畫面上改得到的欄位，顏色、排序原樣送回（不送會被清成預設）；只能改名稱的分段班照原本的分段（伺服器由分段推算上下班）
    try {
      const f = form();
      const shift = Object.assign({ id: cur.id, color: cur.color || '', sort: cur.sort || 0, active: true }, q('#hqShStart').disabled ? { name: f.name, start: cur.start, end: cur.end, break_min: cur.break_min, segs: cur.segs } : f);
      await call('saveShift', { shift }); await done(`已修改班別「${f.name}」`);
    } catch (e) { say(e.message, true); ctx.rerender(); }
  });
}

// ---------------------------------------------------------------- 我的班表
// 2026-11-03 Eason：總部改四週一期、存檔就生效（跟央廚一樣不用主管核准）；違反規定照存，上方提醒清單紅字
export function renderSelf(ctx) {
  const key = ctx.session.token || ctx.session.code;
  if (H.key !== key) resetSelf(key);
  return shell(ctx, () => { if (ctx.el.isConnected) drawSelf(ctx); });
}

/** 固定規則的一格：週六休息日、週日例假、平日國定假日（含補假）國定假日假、其他平日上 sid */
const patternCell = (d, sid) => { const w = weekday(d); return w === 6 ? { t: 'H' } : w === 0 ? { t: 'R' } : (H.data.holidays || {})[d] ? { t: 'L', l: '國' } : { t: 'W', s: sid }; };

/** 這一期能不能改：本期（起用期以後）；下一期要開始前 SELF_OPEN 天起（同伺服器 selfWindow） */
function canFill(D) {
  const n = parseLabel(H.period), cur = parseLabel(D.curPeriod || 'T01');
  const lo = Math.max(cur, D.mode_from ? parseLabel(periodOf(D.mode_from)) : 1);
  if (n < lo || n > cur + 1) return false;
  return n === cur || diffDays(todayTaipei(), periodStart(H.period)) <= SELF_OPEN;
}

function drawSelf(ctx) {
  const el = ctx.el, D = H.data;
  const emp = H.emp && D.me.includes(H.emp) ? H.emp : D.me[0];      // 一人有多個總部員編：上方可切換（H.emp）
  const row = D.staff.find((s) => s.emp_id === emp);
  if (!row) {
    el.innerHTML = '<div class="card"><p class="hint" style="margin:0" id="hqNoMe">你在這家店還沒有打卡員編，請洽總部。</p></div>'
      + (shiftsInSelf(ctx.session) ? `<div class="card"><div id="hqMsg" class="${H.err ? 'err' : 'okmsg'}" role="status">${esc(H.err || H.msg || '')}</div></div>` + shiftCardHtml(D) : '');
    bindShiftCard(ctx, el, D);
    return;
  }
  const shifts = D.shifts, shiftMap = Object.fromEntries(shifts.concat(D.extShifts || []).map((s) => [s.id, s]));
  const cells = D.cells[emp] || {};
  const editable = canFill(D);
  // 能改的日子：在職（到職日～離職日）、起用日以後、在別家打卡的人切換日以後
  const off = (d) => (row.hire_date && d < row.hire_date) || (row.leave_date && d > row.leave_date) || (D.mode_from && d < D.mode_from);
  const openDay = (d) => !off(d) && !(row.lockBefore && d < row.lockBefore);
  const fillTag = `<span class="tag ${row.filled >= row.days ? 'on' : ''}" id="hqStatus">${row.filled >= row.days ? '這一期填完了' : `已填 ${row.filled}／${row.days} 天`}</span>`;
  const acts = editable && shifts.length ? `<div class="row sc-acts"><label class="sc-chk" for="hqFillShift">平日上</label><select id="hqFillShift" aria-label="平日上哪個班">${shifts.map((s) => `<option value="${esc(s.id)}">${esc(shiftCode(s.name))} ${esc(timeText(s))}</option>`).join('')}</select><button type="button" class="btn ghost" id="hqFill">填入空白的天</button><button type="button" class="btn ghost" id="hqRedo">重新排這一期</button></div><p class="hint">週六休息日、週日例假、平日國定假日放假；「重新排」會把這一期整個蓋掉重填（請假保留）。</p>` : '';
  const hint = editable
    ? '<p class="hint mt">點日期選班別或休假，存了就生效，約 1 分鐘內送到 LINE。四週變形：這一期（28 天）要有 4 天例假、4 天休息日，每兩週至少 2 天例假、最多連上 12 天；不合規定的地方會在上面紅字提醒。</p>'
    : `<p class="hint mt" id="hqLocked">${parseLabel(H.period) < parseLabel(D.curPeriod || 'T01') ? '這一期已經過了，只能看不能改。' : `下一期開始前 ${SELF_OPEN} 天起才能填。`}</p>`;
  const empPick = D.me.length > 1 ? `<div class="row mt"><label class="sc-chk" for="hqEmpSel">員編</label><select id="hqEmpSel" aria-label="要看哪個員編的班表">${D.me.map((x) => `<option value="${esc(x)}" ${x === emp ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>` : '';
  const lockNote = row.lockBefore && periodDates(H.period)[0] < row.lockBefore ? `<p class="hint" id="hqLockNote">${md(row.lockBefore)} 以前的班在${esc(row.lockStore || '打卡的店')}，這裡只能看。</p>` : '';
  el.innerHTML = head(D, `${row.name}・${emp}`, `${empPick}<div class="sc-state mt">${fillTag}</div>${acts}${hint}${lockNote}`)
    + resultsHtml(D.results, emp)
    + `<div class="card hq-calcard">${calHtml(periodDates(H.period), cells, shiftMap, D.holidays, { editable, sel: H.sel, issue: issueMap(D.results, emp), off: (d) => !openDay(d) })}</div>`
    + (shiftsInSelf(ctx.session) ? shiftCardHtml(D) : '');

  if (H.sel && editable) {
    el.insertAdjacentHTML('beforeend', `<div class="card sc-editor" id="hqEditor"><b>${md(H.sel)}（${WD[weekday(H.sel)]}）${D.holidays[H.sel] ? esc(D.holidays[H.sel]) : ''}</b>
      <div class="row mt"><select id="hqCellSel" aria-label="這一天要選什麼">${cellOptions(shifts, valueOfCell(cells[H.sel] || {}), true)}</select>
      <button type="button" class="btn" id="hqCellOk">套用</button><button type="button" class="btn ghost" id="hqCellX">取消</button></div></div>`);
  }
  const q = (s) => el.querySelector(s);
  bindMonth(ctx, el);
  bindShiftCard(ctx, el, D);
  if (q('#hqEmpSel')) q('#hqEmpSel').onchange = () => { H.emp = q('#hqEmpSel').value; H.sel = null; say(''); ctx.rerender(); };
  const refresh = async (okMsg) => { try { await reload(); if (okMsg) say(okMsg); } catch (e) { say(e.message, true); } ctx.rerender(); };
  const save = async (cellsIn, okMsg) => {
    try { await call('selfSave', { period: H.period, emp_id: emp, version: row.version, cells: cellsIn }); H.sel = null; await refresh(okMsg); }
    catch (e) { say(e.message, true); if (e.code === 'CONFLICT') { try { await reload(); } catch (e2) { /* 留原畫面 */ } } ctx.rerender(); }
  };
  el.querySelectorAll('button.hq-day').forEach((b) => { b.onclick = () => { H.sel = b.dataset.date; say(''); ctx.rerender(); }; });
  if (q('#hqCellX')) q('#hqCellX').onclick = () => { H.sel = null; ctx.rerender(); };
  if (q('#hqCellOk')) q('#hqCellOk').onclick = () => busy(q('#hqCellOk'), () => save({ [H.sel]: cellOfValue(q('#hqCellSel').value) }, '已存，約 1 分鐘內送到 LINE'));
  if (q('#hqFill')) q('#hqFill').onclick = () => busy(q('#hqFill'), async () => {
    const sid = q('#hqFillShift').value, out = {};
    if (!sid) { say('還沒有總部班別，請先請主管新增班別', true); return ctx.rerender(); }
    for (const d of periodDates(H.period)) {
      if (!openDay(d)) continue;
      const c = cells[d] || {};
      if (c.t && !(c.t === 'W' && !c.s)) continue;      // 上班但沒選班別（2026-11-02 張淳：總部還沒建班別時按填入，平日全是沒班別的「班」）也當空白補上
      out[d] = patternCell(d, sid);
    }
    if (!Object.keys(out).length) { say('沒有空白的天'); return ctx.rerender(); }
    await save(out, '已填入空白的天，約 1 分鐘內送到 LINE；檢查一下上面的提醒');
  });
  // 重新排這一期（2026-11-03 Eason）：整期照固定規則蓋掉重填，請假（國定假日假以外的 L）保留
  if (q('#hqRedo')) q('#hqRedo').onclick = () => busy(q('#hqRedo'), async () => {
    const sid = q('#hqFillShift').value, out = {};
    if (!sid) { say('還沒有總部班別，請先請主管新增班別', true); return ctx.rerender(); }
    if (!window.confirm(`把 ${H.period} 整期重新排成「平日 ${(shiftMap[sid] || {}).name || ''}、週六休息日、週日例假」？已排的請假會保留。`)) return;
    for (const d of periodDates(H.period)) {
      if (!openDay(d)) continue;
      const c = cells[d] || {};
      if (c.t === 'L' && c.l !== '國') continue;
      out[d] = patternCell(d, sid);
    }
    if (!Object.keys(out).length) { say('這一期沒有可以重排的天'); return ctx.rerender(); }
    await save(out, '已重新排這一期，約 1 分鐘內送到 LINE；檢查一下上面的提醒');
  });
}

// ---------------------------------------------------------------- 部屬班表（唯讀）
// 2026-11-03 起不用核准：主管（考勤核定他工時的人）、人資主管、管理員看部屬每一期填了多少、哪裡不合規定
export function renderApprove(ctx) {
  const key = ctx.session.token || ctx.session.code;
  if (H.key !== key) resetSelf(key);
  return shell(ctx, () => { if (ctx.el.isConnected) drawApprove(ctx); });
}

function drawApprove(ctx) {
  const el = ctx.el, D = H.data;
  const subs = D.staff.filter((s) => !D.me.includes(s.emp_id));
  const shiftMap = Object.fromEntries(D.shifts.map((s) => [s.id, s]));
  const bad = (e) => D.results.filter((r) => r.emp_id === e && r.level === 'block').length;
  const notDone = subs.filter((s) => s.filled < s.days).length;
  const list = subs.length ? subs.map((s) => {
    const n = bad(s.emp_id);
    const tag = s.filled < s.days ? `<span class="tag">已填 ${s.filled}／${s.days} 天</span>` : '<span class="tag on">填完了</span>';
    return `<button type="button" class="sc-drow hq-emp${H.who === s.emp_id ? ' sel' : ''}" data-emp="${esc(s.emp_id)}"><span class="sc-dn">${esc(s.name)}</span><span class="sc-dv">${tag}${n ? `<small class="err">${n} 處不合規定</small>` : ''}</span></button>`;
  }).join('') : '<p class="hint" style="margin:0" id="hqNoSubs">沒有部屬。</p>';
  const ses = ctx.session;
  const shiftCard = shiftsInApprove(ses) ? shiftCardHtml(D) : '';
  el.innerHTML = head(D, `${subs.length} 位部屬・${notDone} 位還沒填完`, '<p class="hint mt">同仁存了就生效、送到 LINE，不用核准；這裡只能看。</p>')
    + `<div class="card"><h2>部屬</h2><div class="sc-dlist" id="hqSubs">${list}</div></div>` + shiftCard;

  const who = subs.find((s) => s.emp_id === H.who);
  if (who) {
    el.insertAdjacentHTML('beforeend', `<div class="card" id="hqDetail"><h2>${esc(who.name)}　已填 ${who.filled}／${who.days} 天</h2>
      ${resultsHtml(D.results, who.emp_id).replace('class="card sc-sum" id="hqSum"', 'class="sc-sum" id="hqSum"')}
      <div class="hq-calcard mt">${calHtml(periodDates(H.period), D.cells[who.emp_id] || {}, shiftMap, D.holidays, { editable: false, issue: issueMap(D.results, who.emp_id) })}</div></div>`);
  }
  bindMonth(ctx, el);
  el.querySelectorAll('button.hq-emp').forEach((b) => { b.onclick = () => { H.who = b.dataset.emp; say(''); ctx.rerender(); }; });
  bindShiftCard(ctx, el, D);
}
