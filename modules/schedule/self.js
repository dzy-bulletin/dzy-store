// 總部自填排班：「我的班表」（同仁每天自己選班、送出）與「部屬核准」（主管看部屬月曆、核准或退回）。
// 規格 docs/schedule-hq/spec.md §3、§5、§10.1。資料一律整包重讀（selfLoad 回來的就是最新的狀態、版本與檢查結果），畫面不自己拼。
import { esc, busy } from '../../js/ui.js';
import { timeText } from './hours.js';
import { call, calHtml, monthDates, resultsHtml, issueMap, cellOptions, cellOfValue, valueOfCell, mLabel, md, nextMonth, prevMonth, curMonth, defaultSelfMonth, STATUS_TEXT, WD } from './hq.js';
import { weekday } from './period.js';
import { canEdit } from './state.js';

export const H = { key: null, month: null, data: null, loading: null, who: null, emp: null, sel: null, msg: '', err: '' };
export function resetSelf(key) { Object.assign(H, { key, month: null, data: null, loading: null, who: null, emp: null, sel: null, msg: '', err: '' }); }

async function load() {
  if (!H.month) H.month = defaultSelfMonth();
  let d = await call('selfLoad', { month: H.month });
  const lo = d.mode_from ? d.mode_from.slice(0, 7) : null;
  if (lo && H.month < lo) { H.month = lo; d = await call('selfLoad', { month: H.month }); }       // 起用日以前的月份不在這套排班
  H.data = d;
  return d;
}
const say = (m, isErr) => { H.msg = isErr ? '' : m; H.err = isErr ? m : ''; };
const reload = async () => { H.data = null; await load(); };

/** 月份切換（兩個分頁共用）：最早起用月、最晚下個月 */
function head(D, title, extra) {
  const lo = D.mode_from ? D.mode_from.slice(0, 7) : prevMonth(H.month), hi = nextMonth(curMonth());
  return `<div class="card sc-head"><div class="sc-period"><button type="button" class="btn ghost sm" id="hqPrev" aria-label="上一個月" ${H.month <= lo ? 'disabled' : ''}>‹</button>
    <div><b id="hqMonth">${esc(mLabel(H.month))}</b><span class="sc-range">${esc(title)}</span></div>
    <button type="button" class="btn ghost sm" id="hqNext" aria-label="下一個月" ${H.month >= hi ? 'disabled' : ''}>›</button></div>${extra || ''}
    <div id="hqMsg" class="${H.err ? 'err' : 'okmsg'}" role="status">${esc(H.err || H.msg || '')}</div></div>`;
}
function bindMonth(ctx, el) {
  const go = (m) => { H.month = m; H.data = null; H.sel = null; H.who = null; say(''); ctx.rerender(); };
  const p = el.querySelector('#hqPrev'), n = el.querySelector('#hqNext');
  if (p) p.onclick = () => go(prevMonth(H.month));
  if (n) n.onclick = () => go(nextMonth(H.month));
}

/** 資料載入外殼：沒資料先讀；讀不到顯示白話＋重新讀取 */
function shell(ctx, draw) {
  if (H.data && H.data.month === H.month) return draw();
  ctx.el.innerHTML = '<div class="card"><p class="hint" style="margin:0">讀取中…</p></div>';
  if (!H.loading) H.loading = load().finally(() => { H.loading = null; });
  return H.loading.then(draw, (e) => {
    if (!ctx.el.isConnected) return;
    ctx.el.innerHTML = `<div class="card"><div class="err" id="hqLoadErr" role="alert">${esc(e.message)}</div><button class="btn mt" id="hqRetry" type="button">重新讀取</button></div>`;
    ctx.el.querySelector('#hqRetry').onclick = () => ctx.rerender();
  });
}

// ---------------------------------------------------------------- 我的班表
export function renderSelf(ctx) {
  const key = ctx.session.token || ctx.session.code;
  if (H.key !== key) resetSelf(key);
  return shell(ctx, () => { if (ctx.el.isConnected) drawSelf(ctx); });
}

function drawSelf(ctx) {
  const el = ctx.el, D = H.data;
  const emp = H.emp && D.me.includes(H.emp) ? H.emp : D.me[0];      // 一人有多個總部員編：上方可切換（H.emp）
  const row = D.staff.find((s) => s.emp_id === emp);
  if (!row) { el.innerHTML = '<div class="card"><p class="hint" style="margin:0" id="hqNoMe">你在這家店還沒有打卡員編，請洽總部。</p></div>'; return; }
  const shifts = D.shifts, shiftMap = Object.fromEntries(shifts.map((s) => [s.id, s]));
  const cells = D.cells[emp] || {};
  const st = row.status;
  const editable = st === 'draft' || st === 'rejected' || st === 'approved';
  const blocks = D.results.filter((r) => r.emp_id === emp && r.level === 'block').length;
  const stTag = `<span class="tag ${st === 'approved' ? 'on' : st === 'rejected' ? 'bad' : ''}" id="hqStatus">${esc(STATUS_TEXT[st])}</span>`;
  const pend = row.pendingDays ? `<span class="tag" id="hqPend">有 ${row.pendingDays} 天變更等核准</span>` : '';
  const why = st === 'rejected' && row.reject_reason ? `<div class="note warn mt" id="hqWhy" role="alert">主管退回的原因：${esc(row.reject_reason)}</div>` : (st === 'approved' && row.reject_reason ? `<div class="note warn mt" id="hqWhy" role="alert">主管退回了你的變更：${esc(row.reject_reason)}</div>` : '');
  const acts = `<div class="row sc-acts">
    ${st === 'draft' || st === 'rejected' ? '<button type="button" class="btn" id="hqSubmit">送出給主管核准</button>' : ''}
    ${st === 'submitted' ? '<button type="button" class="btn ghost" id="hqWithdraw">撤回（改完再送）</button>' : ''}
    ${st === 'draft' || st === 'rejected' ? `<span class="grow"></span><label class="sc-chk" for="hqFillShift">快速填入空白的天：平日</label><select id="hqFillShift" aria-label="平日上哪個班">${shifts.map((s) => `<option value="${esc(s.id)}">${esc(s.name)} ${esc(timeText(s))}</option>`).join('')}</select><button type="button" class="btn ghost" id="hqFill">填入（週六休息日、週日例假）</button>` : ''}
  </div>`;
  const hint = st === 'submitted' ? '<p class="hint mt">已送出，主管核准前不能修改；要改請先撤回。</p>' : st === 'approved' ? '<p class="hint mt">已核准。之後再改的日子會標「待核准」，主管核准後才生效。</p>' : '<p class="hint mt">點日期選班別或休假；每週至少 1 天例假＋1 天休息日，填完整個月才能送出。</p>';
  const empPick = D.me.length > 1 ? `<div class="row mt"><label class="sc-chk" for="hqEmpSel">員編</label><select id="hqEmpSel" aria-label="要看哪個員編的班表">${D.me.map((x) => `<option value="${esc(x)}" ${x === emp ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>` : '';
  el.innerHTML = head(D, `${row.name}・${emp}`, `${empPick}<div class="sc-state mt">${stTag}${pend}</div>${acts}${hint}${why}`)
    + resultsHtml(D.results, emp)
    + `<div class="card hq-calcard">${calHtml(H.month, cells, shiftMap, D.holidays, { editable, sel: H.sel, issue: issueMap(D.results, emp) })}</div>`;

  let editor = '';
  if (H.sel && editable) {
    const c = cells[H.sel] || {};
    const base = c.pending || c;
    editor = `<div class="card sc-editor" id="hqEditor"><b>${md(H.sel)}（${WD[weekday(H.sel)]}）${D.holidays[H.sel] ? esc(D.holidays[H.sel]) : ''}</b>
      <div class="row mt"><select id="hqCellSel" aria-label="這一天要選什麼">${cellOptions(shifts, valueOfCell(base), st !== 'approved')}</select>
      <button type="button" class="btn" id="hqCellOk">套用</button><button type="button" class="btn ghost" id="hqCellX">取消</button></div></div>`;
    el.insertAdjacentHTML('beforeend', editor);
  }
  const q = (s) => el.querySelector(s);
  bindMonth(ctx, el);
  if (q('#hqEmpSel')) q('#hqEmpSel').onchange = () => { H.emp = q('#hqEmpSel').value; H.sel = null; say(''); ctx.rerender(); };
  const refresh = async (okMsg) => { try { await reload(); if (okMsg) say(okMsg); } catch (e) { say(e.message, true); } ctx.rerender(); };
  const save = async (cellsIn, okMsg) => {
    try { await call('selfSave', { month: H.month, emp_id: emp, version: row.version, cells: cellsIn }); H.sel = null; await refresh(okMsg); }
    catch (e) { say(e.message, true); if (e.code === 'CONFLICT') { try { await reload(); } catch (e2) { /* 留原畫面 */ } } ctx.rerender(); }
  };
  el.querySelectorAll('button.hq-day').forEach((b) => { b.onclick = () => { H.sel = b.dataset.date; say(''); ctx.rerender(); }; });
  if (q('#hqCellX')) q('#hqCellX').onclick = () => { H.sel = null; ctx.rerender(); };
  if (q('#hqCellOk')) q('#hqCellOk').onclick = () => busy(q('#hqCellOk'), () => save({ [H.sel]: cellOfValue(q('#hqCellSel').value) }, st === 'approved' ? '已記下，等主管核准後生效' : '已存'));
  if (q('#hqFill')) q('#hqFill').onclick = () => busy(q('#hqFill'), async () => {
    const sid = q('#hqFillShift').value, out = {};
    for (const d of monthDates(H.month)) {
      if ((cells[d] || {}).t) continue;
      const w = weekday(d);
      out[d] = w === 6 ? { t: 'H' } : w === 0 ? { t: 'R' } : { t: 'W', s: sid };
    }
    if (!Object.keys(out).length) { say('沒有空白的天'); return ctx.rerender(); }
    await save(out, '已填入空白的天，檢查一下再送出');
  });
  if (q('#hqSubmit')) q('#hqSubmit').onclick = () => busy(q('#hqSubmit'), async () => {
    if (blocks) { say(`還有 ${blocks} 個地方不合規定，修正後才能送出`, true); return ctx.rerender(); }
    try { const r = await call('selfSubmit', { month: H.month, emp_id: emp, version: row.version }); await refresh(r.status === 'approved' ? '已送出，這個月直接生效（不需要核准）' : '已送出，等主管核准'); }
    catch (e) { say(e.message, true); ctx.rerender(); }
  });
  if (q('#hqWithdraw')) q('#hqWithdraw').onclick = () => busy(q('#hqWithdraw'), async () => {
    try { await call('selfWithdraw', { month: H.month, emp_id: emp, version: row.version }); await refresh('已撤回，可以修改'); }
    catch (e) { say(e.message, true); ctx.rerender(); }
  });
}

// ---------------------------------------------------------------- 部屬核准
export function renderApprove(ctx) {
  const key = ctx.session.token || ctx.session.code;
  if (H.key !== key) resetSelf(key);
  return shell(ctx, () => { if (ctx.el.isConnected) drawApprove(ctx); });
}

function drawApprove(ctx) {
  const el = ctx.el, D = H.data;
  const subs = D.staff.filter((s) => !D.me.includes(s.emp_id));
  const shiftMap = Object.fromEntries(D.shifts.map((s) => [s.id, s]));
  const waiting = subs.filter((s) => s.status === 'submitted' || s.pendingDays > 0).length;
  const list = subs.length ? subs.map((s) => {
    const tag = s.status === 'submitted' ? '<span class="tag">等核准</span>' : s.status === 'approved' ? '<span class="tag on">已核准</span>' : s.status === 'rejected' ? '<span class="tag bad">已退回</span>' : '<span class="tag">還沒送出</span>';
    return `<button type="button" class="sc-drow hq-emp${H.who === s.emp_id ? ' sel' : ''}" data-emp="${esc(s.emp_id)}"><span class="sc-dn">${esc(s.name)}</span><span class="sc-dv">${tag}${s.pendingDays ? `<small>${s.pendingDays} 天變更等核准</small>` : ''}</span></button>`;
  }).join('') : '<p class="hint" style="margin:0" id="hqNoSubs">沒有需要你核准的部屬。</p>';
  const ses = ctx.session;
  const shiftCard = canEdit(ses) ? `<div class="card" id="hqShifts"><h2>總部班別</h2>
      <p class="hint">${D.shifts.length ? D.shifts.map((s) => `${esc(s.name)} ${esc(timeText(s))}（${s.segs ? '分段班' : `休息 ${s.break_min} 分`}）`).join('；') : '還沒有班別，同仁沒有班可以選。'}</p>
      <div class="row"><input id="hqShName" placeholder="班別名稱" maxlength="12" aria-label="班別名稱" style="width:110px"><input id="hqShStart" type="time" value="09:00" aria-label="上班時間"><input id="hqShEnd" type="time" value="18:00" aria-label="下班時間">
      <input id="hqShBrk" type="number" min="0" max="600" value="60" aria-label="休息分鐘" style="width:70px"><button type="button" class="btn sm" id="hqShAdd">新增班別</button></div></div>` : '';
  el.innerHTML = head(D, `${subs.length} 位部屬・${waiting} 位等你核准`, '')
    + `<div class="card"><h2>部屬</h2><div class="sc-dlist" id="hqSubs">${list}</div></div>` + shiftCard;

  const who = subs.find((s) => s.emp_id === H.who);
  if (who) {
    const cells = D.cells[who.emp_id] || {};
    const can = who.status === 'submitted' || who.pendingDays > 0;
    el.insertAdjacentHTML('beforeend', `<div class="card" id="hqDetail"><h2>${esc(who.name)}　${esc(STATUS_TEXT[who.status])}${who.pendingDays ? `（${who.pendingDays} 天變更等核准）` : ''}</h2>
      ${who.reject_reason ? `<p class="hint">上次退回原因：${esc(who.reject_reason)}</p>` : ''}
      ${resultsHtml(D.results, who.emp_id).replace('class="card sc-sum" id="hqSum"', 'class="sc-sum" id="hqSum"')}
      <div class="hq-calcard mt">${calHtml(H.month, cells, shiftMap, D.holidays, { editable: false, issue: issueMap(D.results, who.emp_id) })}</div>
      ${can ? `<div class="fld mt"><label for="hqReason">退回原因（退回才需要填）</label><input id="hqReason" maxlength="200" placeholder="例如：11/15 那週請補休息日"></div>
      <div class="row mt"><button type="button" class="btn" id="hqApprove">核准</button><button type="button" class="btn ghost" id="hqReject">退回</button></div>` : '<p class="hint mt">目前沒有等你核准的內容。</p>'}</div>`);
  }
  const q = (s) => el.querySelector(s);
  bindMonth(ctx, el);
  const refresh = async (okMsg) => { try { await reload(); say(okMsg); } catch (e) { say(e.message, true); } ctx.rerender(); };
  el.querySelectorAll('button.hq-emp').forEach((b) => { b.onclick = () => { H.who = b.dataset.emp; say(''); ctx.rerender(); }; });
  if (q('#hqApprove')) q('#hqApprove').onclick = () => busy(q('#hqApprove'), async () => {
    try { await call('selfApprove', { month: H.month, emp_id: who.emp_id, version: who.version }); await refresh(`已核准 ${who.name} 的 ${+H.month.slice(5)} 月班表，正在送到 LINE`); }
    catch (e) { say(e.message, true); if (e.code === 'CONFLICT') { try { await reload(); } catch (e2) { /* 留原畫面 */ } } ctx.rerender(); }
  });
  if (q('#hqReject')) q('#hqReject').onclick = () => busy(q('#hqReject'), async () => {
    const reason = q('#hqReason').value.trim();
    if (!reason) { say('退回要寫原因', true); return ctx.rerender(); }
    try { await call('selfReject', { month: H.month, emp_id: who.emp_id, version: who.version, reason }); await refresh(`已退回 ${who.name} 的班表`); }
    catch (e) { say(e.message, true); if (e.code === 'CONFLICT') { try { await reload(); } catch (e2) { /* 留原畫面 */ } } ctx.rerender(); }
  });
  if (q('#hqShAdd')) q('#hqShAdd').onclick = () => busy(q('#hqShAdd'), async () => {
    try {
      await call('saveShift', { shift: { name: q('#hqShName').value.trim(), start: q('#hqShStart').value, end: q('#hqShEnd').value, break_min: Number(q('#hqShBrk').value) || 0 } });
      await refresh('已新增班別');
    } catch (e) { say(e.message, true); ctx.rerender(); }
  });
}
