// 自動排班「班表」分頁：整期格子（桌機）／單日清單（手機）、營業額與工時比、每班人數、檢查結果、自動排班、鎖定與發布。
import { esc, busy, confirmBox } from '../../js/ui.js';
import { api } from '../../js/api.js';
import { S, load, mutate, movePeriod, setDutyFlag, WD, md, hm, DAY_LABEL, LEAVE_LABEL, call } from './state.js';
import { weekday, periodEnd } from './period.js';
import { ratios } from './calc.js';

const PUB_TEXT = { pending: '等待送到 LINE', sent: '已發布到 LINE', failed: '送 LINE 失敗', stale: '已被較新版本取代' };

function cellText(c, shifts) {
  if (!c) return { t: '', cls: 'empty' };
  if (c.shift_id) { const s = shifts[c.shift_id]; return { t: s ? s.name : c.shift_id, cls: 'work' + (c.day_type === 'H' ? ' ot' : ''), color: s && s.color }; }
  if (c.day_type === 'L') return { t: LEAVE_LABEL[c.leave] || '假', cls: 'leave' };
  if (c.day_type === 'W') return { t: '?', cls: 'empty' };
  return { t: DAY_LABEL[c.day_type] || '', cls: c.day_type === 'R' ? 'rest' : 'off' };
}
const LV_RANK = { block: 0, warn: 1, info: 2 };

export function renderBoard(ctx) {
  const el = ctx.el, D = S.data;
  const shifts = Object.fromEntries(D.shifts.map((s) => [s.id, s]));
  const activeShifts = D.shifts.filter((s) => s.active);
  const staff = D.staff.filter((st) => D.dates.some((d) => (!st.hire_date || st.hire_date <= d) && (!st.leave_date || d <= st.leave_date)));
  const locked = D.meta.locked;
  const byCell = {}, byDay = {};
  for (const r of D.results) {
    if (r.emp_id && r.date) (byCell[r.emp_id + '|' + r.date] = byCell[r.emp_id + '|' + r.date] || []).push(r);
    else if (r.date && !r.emp_id) (byDay[r.date] = byDay[r.date] || []).push(r);
  }
  const counts = { block: 0, warn: 0, info: 0 };
  D.results.forEach((r) => { counts[r.level]++; });
  const rat = ratios({ staff: D.staff, days: D.days, shifts }, D.dates, D.revenue);
  const target = D.cfg && D.cfg.ratio_target;
  const narrow = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
  const view = S.view || (narrow ? 'day' : 'grid');
  if (!S.day || !D.dates.includes(S.day)) S.day = D.dates.includes(D.today) ? D.today : D.dates[0];
  const pub = D.meta.publication;
  const bday = (st, d) => st.birthday && st.birthday.slice(5) === d.slice(5);

  const head = `<div class="card sc-head">
    <div class="sc-period"><button type="button" class="btn ghost sm" id="scPrev" aria-label="上一期">‹</button>
      <div><b>${esc(D.period)}</b><span class="sc-range">${md(D.dates[0])}（日）– ${md(periodEnd(D.period))}（六）</span></div>
      <button type="button" class="btn ghost sm" id="scNext" aria-label="下一期">›</button></div>
    <div class="sc-state">
      <span class="tag ${locked ? 'on' : ''}" id="scLockTag">${locked ? '已鎖定' : '排班中'}</span>
      ${D.period === 'T00' ? '<span class="tag">試排期，不送 LINE</span>' : ''}
      ${pub ? `<span class="tag ${pub.status === 'sent' ? 'on' : pub.status === 'failed' ? 'bad' : ''}" id="scPubTag" title="${esc(pub.last_error || '')}">${PUB_TEXT[pub.status] || ''}${pub.kind === 'unpublish' && pub.status === 'sent' ? '（已撤下）' : ''}</span>` : ''}
      ${D.meta.clockAlias === null && D.period !== 'T00' ? '<span class="tag">這家店沒有 LINE 打卡，鎖定不送 LINE</span>' : ''}
    </div>
    <div class="row sc-acts">
      ${locked ? '' : `<button type="button" class="btn" id="scAuto">自動排班</button><label class="sc-chk"><input type="checkbox" id="scAll"> 連手動改過的也重排</label>`}
      <button type="button" class="btn ${locked ? 'ghost' : ''}" id="scLock">${locked ? '解除鎖定' : '鎖定並發布'}</button>
      ${pub && (pub.status === 'failed' || pub.status === 'pending') ? '<button type="button" class="btn ghost" id="scResend">立即重送</button>' : ''}
      <span class="grow"></span>
      <div class="sc-seg" role="group" aria-label="檢視方式"><button type="button" id="scViewGrid" class="${view === 'grid' ? 'on' : ''}">整期</button><button type="button" id="scViewDay" class="${view === 'day' ? 'on' : ''}">單日</button></div>
    </div>
    <div id="scPw" hidden class="row mt"><input type="password" id="scPwIn" autocomplete="off" placeholder="出勤核定密碼" aria-label="出勤核定密碼"><button type="button" class="btn" id="scPwBtn">確認</button></div>
    ${D.meta.needs_recheck ? '<div class="note warn mt" role="alert">這一期已發布，但上一期改過之後，跨期的換班間隔或連續上班天數不合規定了。請解除鎖定、修正後再鎖定。</div>' : ''}
    <div id="scMsg" class="${S.err ? 'err' : 'okmsg'}" role="status">${esc(S.err || S.msg || '')}</div>
  </div>`;

  const sum = D.results.length ? `<details class="card sc-sum" ${counts.block ? 'open' : ''}><summary class="sc-sumtoggle">
      ${counts.block ? `<span class="lv block">${counts.block} 個要修正</span>` : '<span class="lv ok">沒有違反規定</span>'}
      ${counts.warn ? `<span class="lv warn">${counts.warn} 個警告</span>` : ''}${counts.info ? `<span class="lv info">${counts.info} 個提醒</span>` : ''}</summary>
      <ul class="sc-list">${D.results.slice().sort((a, b) => LV_RANK[a.level] - LV_RANK[b.level]).slice(0, 80).map((r) => `<li class="lv-${r.level}">${esc(r.msg)}</li>`).join('')}</ul></details>` : '';

  const ratioCls = (r) => (r == null || !target ? '' : r < target ? ' low' : ' good');
  let body;
  if (view === 'grid') {
    const th = D.dates.map((d) => { const w = weekday(d), hol = D.holidays.days[d]; return `<th class="${w === 0 || w === 6 ? 'we' : ''}${hol ? ' hol' : ''}" title="${esc(hol || '')}">${md(d)}<small>${WD[w]}${hol ? '・國' : ''}</small></th>`; }).join('');
    const rev = D.dates.map((d) => `<td><input type="number" inputmode="numeric" min="0" class="sc-rev" data-date="${d}" value="${D.revenue[d] == null ? '' : D.revenue[d]}" aria-label="${md(d)} 預估營業額"></td>`).join('');
    const ratioRow = D.dates.map((d) => { const r = rat.daily[d]; return `<td class="sc-ratio${ratioCls(r.ratio)}">${r.ratio == null ? '—' : r.ratio.toLocaleString()}</td>`; }).join('');
    const rows = staff.map((st) => {
      const tds = D.dates.map((d) => {
        const c = (D.days[st.emp_id] || {})[d];
        const inJob = (!st.hire_date || st.hire_date <= d) && (!st.leave_date || d <= st.leave_date);
        if (!inJob) return '<td class="sc-c na"></td>';
        const x = cellText(c, shifts), iss = byCell[st.emp_id + '|' + d] || [];
        const lv = iss.length ? iss.sort((a, b) => LV_RANK[a.level] - LV_RANK[b.level])[0].level : '';
        const pin = (D.pins[st.emp_id] || {})[d];
        const sel = S.sel && S.sel.emp === st.emp_id && S.sel.date === d;
        return `<td class="sc-c ${x.cls}${lv ? ' i-' + lv : ''}${sel ? ' sel' : ''}${pin ? ' pin' : ''}" data-emp="${esc(st.emp_id)}" data-date="${d}" title="${esc(iss.map((r) => r.msg).join('\n'))}" ${x.color ? `style="--sc-shift:${esc(x.color)}"` : ''}>${esc(x.t)}${bday(st, d) ? '<i class="sc-bd" title="生日">生日</i>' : ''}</td>`;
      }).join('');
      return `<tr><th class="sc-name" scope="row">${esc(st.name)}</th>${tds}</tr>`;
    }).join('');
    const cnt = activeShifts.map((s) => `<tr class="sc-cnt"><th scope="row">${esc(s.name)}人數</th>${D.dates.map((d) => {
      const n = staff.filter((st) => ((D.days[st.emp_id] || {})[d] || {}).shift_id === s.id).length, need = (D.demand[d] || {})[s.id];
      const short = need && n < need.min;
      return `<td class="${short ? 'short' : ''}" title="${need ? `最少 ${need.min}${need.max != null ? '、最多 ' + need.max : ''}` : '沒有設人數'}">${n}${need ? '/' + need.min : ''}</td>`;
    }).join('')}</tr>`).join('');
    body = `<div class="card sc-gridcard"><div class="scroll"><table class="sc-grid">
      <thead><tr><th class="sc-name">同仁</th>${th}</tr></thead>
      <tbody><tr class="sc-revrow"><th scope="row">預估營業額</th>${rev}</tr><tr class="sc-ratiorow"><th scope="row">每工時營業額</th>${ratioRow}</tr>${rows}${cnt}</tbody></table></div>
      <p class="hint sc-total">整期每工時營業額：<b class="${ratioCls(rat.period.ratio)}">${rat.period.ratio == null ? '—' : rat.period.ratio.toLocaleString() + ' 元'}</b>（營業額 ${rat.period.revenue.toLocaleString()} 元 ÷ ${hm(rat.period.minutes)} 小時）${target ? `，目標 ${target.toLocaleString()} 元` : ''}</p></div>`;
  } else {
    const d = S.day, r = rat.daily[d], hol = D.holidays.days[d];
    const chips = D.dates.map((x) => `<button type="button" class="sc-daychip${x === d ? ' on' : ''}${(byDay[x] || []).length ? ' warn' : ''}" data-day="${x}">${md(x)}<small>${WD[weekday(x)]}</small></button>`).join('');
    const list = staff.filter((st) => (!st.hire_date || st.hire_date <= d) && (!st.leave_date || d <= st.leave_date)).map((st) => {
      const c = (D.days[st.emp_id] || {})[d], x = cellText(c, shifts), iss = byCell[st.emp_id + '|' + d] || [];
      const s = c && c.shift_id ? shifts[c.shift_id] : null;
      return `<button type="button" class="sc-drow ${x.cls}${iss.length ? ' i-' + iss.sort((a, b) => LV_RANK[a.level] - LV_RANK[b.level])[0].level : ''}" data-emp="${esc(st.emp_id)}" data-date="${d}">
        <span class="sc-dn">${esc(st.name)}${bday(st, d) ? ' <i class="sc-bd">生日</i>' : ''}</span><span class="sc-dv">${esc(x.t)}${s ? `<small>${esc(s.start)}–${esc(s.end)}</small>` : ''}</span>
        ${iss.length ? `<span class="sc-dmsg">${esc(iss.map((i) => i.msg).join('；'))}</span>` : ''}</button>`;
    }).join('');
    const need = D.demand[d] || {};
    const cnt = activeShifts.map((s) => { const n = staff.filter((st) => ((D.days[st.emp_id] || {})[d] || {}).shift_id === s.id).length, nd = need[s.id]; return `<span class="tag ${nd && n < nd.min ? 'bad' : ''}">${esc(s.name)} ${n}${nd ? '/' + nd.min : ''} 人</span>`; }).join(' ');
    body = `<div class="card"><div class="sc-days">${chips}</div>
      <h2 class="mt">${md(d)}（${WD[weekday(d)]}）${hol ? `<span class="tag">${esc(hol)}</span>` : ''}</h2>
      <div class="row"><label for="scDayRev">預估營業額</label><input type="number" inputmode="numeric" min="0" id="scDayRev" class="sc-rev" data-date="${d}" value="${D.revenue[d] == null ? '' : D.revenue[d]}">
        <span class="hint">每工時營業額：<b>${r.ratio == null ? '—' : r.ratio.toLocaleString() + ' 元'}</b></span></div>
      <div class="row mt">${cnt}</div>
      ${(byDay[d] || []).map((x) => `<div class="note warn mt">${esc(x.msg)}</div>`).join('')}
      <div class="sc-dlist mt">${list}</div></div>`;
  }

  // 編輯列：選了一格才出現
  let editor = '';
  if (S.sel && !locked) {
    const st = D.staff.find((x) => x.emp_id === S.sel.emp);
    const c = (D.days[S.sel.emp] || {})[S.sel.date] || {};
    const cur = c.shift_id ? 'S:' + c.shift_id + (c.day_type === 'H' ? ':H' : '') : c.day_type === 'L' ? 'L:' + c.leave : c.day_type || '';
    const opts = activeShifts.map((s) => `<option value="S:${esc(s.id)}">${esc(s.name)} ${esc(s.start)}–${esc(s.end)}</option>`).join('')
      + activeShifts.map((s) => `<option value="S:${esc(s.id)}:H">${esc(s.name)}（休息日出勤）</option>`).join('')
      + '<option value="R">例假</option><option value="H">休息日</option><option value="L:特">特休</option><option value="L:補">補休</option>'
      + (D.holidays.days[S.sel.date] ? '<option value="L:國">國定假日放假</option>' : '') + '<option value="CLEAR">清空</option>';
    const iss = byCell[S.sel.emp + '|' + S.sel.date] || [];
    editor = `<div class="card sc-editor" id="scEditor"><b>${esc(st ? st.name : '')}　${md(S.sel.date)}（${WD[weekday(S.sel.date)]}）</b>
      <div class="row mt"><select id="scCellSel" aria-label="這一格要排什麼">${opts.replace(`value="${cur}"`, `value="${cur}" selected`)}</select>
      <button type="button" class="btn" id="scCellOk">套用</button><button type="button" class="btn ghost" id="scCellX">取消</button></div>
      ${iss.length ? `<ul class="sc-list">${iss.map((r) => `<li class="lv-${r.level}">${esc(r.msg)}</li>`).join('')}</ul>` : ''}</div>`;
  }

  el.innerHTML = head + sum + body + editor;
  const q = (s) => el.querySelector(s);
  const rerender = () => ctx.rerender();
  const say = (m, isErr) => { S.msg = isErr ? '' : m; S.err = isErr ? m : ''; };

  const onChip = el.querySelector('.sc-daychip.on'); if (onChip && onChip.scrollIntoView) onChip.scrollIntoView({ block: 'nearest', inline: 'center' });
  q('#scPrev').onclick = () => { movePeriod(-1); say(''); rerender(); };
  q('#scNext').onclick = () => { movePeriod(1); say(''); rerender(); };
  q('#scViewGrid').onclick = () => { S.view = 'grid'; rerender(); };
  q('#scViewDay').onclick = () => { S.view = 'day'; rerender(); };
  el.querySelectorAll('.sc-daychip').forEach((b) => { b.onclick = () => { S.day = b.dataset.day; rerender(); }; });
  el.querySelectorAll('.sc-c[data-emp], .sc-drow').forEach((td) => {
    td.onclick = () => { if (locked) { say('這一期已鎖定，要先解除鎖定才能修改', true); return rerender(); } S.sel = { emp: td.dataset.emp, date: td.dataset.date }; rerender(); };
  });
  el.querySelectorAll('.sc-rev').forEach((inp) => {
    inp.onchange = async () => {
      try { await mutate('saveRevenue', { values: { [inp.dataset.date]: inp.value === '' ? null : Number(inp.value) } }); say('已存營業額'); }
      catch (e) { say(e.message, true); }
      rerender();
    };
  });
  if (q('#scCellX')) q('#scCellX').onclick = () => { S.sel = null; rerender(); };
  if (q('#scCellOk')) q('#scCellOk').onclick = () => busy(q('#scCellOk'), async () => {
    const v = q('#scCellSel').value, cell = { emp_id: S.sel.emp, date: S.sel.date };
    if (v === 'CLEAR') cell.clear = true;
    else if (v.startsWith('S:')) { const [, id, h] = v.split(':'); Object.assign(cell, { day_type: h ? 'H' : 'W', shift_id: id }); }
    else if (v.startsWith('L:')) Object.assign(cell, { day_type: 'L', leave: v.slice(2) });
    else Object.assign(cell, { day_type: v });
    try { await mutate('saveDays', { cells: [cell] }); S.sel = null; say('已存'); } catch (e) { say(e.message, true); }
    rerender();
  });
  if (q('#scAuto')) q('#scAuto').onclick = () => busy(q('#scAuto'), async () => {
    const all = q('#scAll').checked;
    if (all && !(await confirmBox('手動改過的格子也會被重新排，確定嗎？', '全部重排'))) return;
    try {
      const r = await mutate('auto', { keepManual: !all });
      if (r.ok) say(r.problems && r.problems.length ? '排好了，有幾個地方要注意：' + r.problems.join('；') : '排好了');
      else say('排不出來：' + r.problems.slice(0, 5).join('；'), true);
    } catch (e) { say(e.message, true); }
    rerender();
  });

  // 鎖定／解鎖：要出勤核定密碼（同一次登入只問一次）
  const pwBox = q('#scPw');
  let pending = null;
  const doLock = async () => {
    try {
      if (locked) { await mutate('unlock'); say(pub && pub.kind === 'publish' ? '已解除鎖定，LINE 上的這一期班表會撤下' : '已解除鎖定'); }
      else { const r = await mutate('lock'); say(r.publish ? '已鎖定，正在送到 LINE' : '已鎖定'); }
    } catch (e) {
      if (e.code === 'FORBIDDEN' && /核定/.test(e.message)) { setDutyFlag(''); pending = doLock; pwBox.hidden = false; q('#scPwIn').focus(); say('請輸入出勤核定密碼', true); paintMsg(); return; }
      if (e.code === 'DUTY_MUST_CHANGE') { say('出勤核定密碼還是預設的 0000，請先到「出勤核定」改成自己的密碼', true); }
      else say(e.message, true);
    }
    rerender();
  };
  const paintMsg = () => { const m = q('#scMsg'); m.className = S.err ? 'err' : 'okmsg'; m.textContent = S.err || S.msg || ''; };
  q('#scLock').onclick = () => busy(q('#scLock'), async () => {
    if (!locked && counts.block) { say(`還有 ${counts.block} 個地方不合規定，修正後才能鎖定`, true); return rerender(); }
    if (locked && !(await confirmBox('解除鎖定後，同仁在 LINE 上會暫時看不到這一期的班表，改好要再鎖定。確定嗎？', '解除鎖定'))) return;
    await doLock();
  });
  q('#scPwBtn').onclick = () => busy(q('#scPwBtn'), async () => {
    try {
      const r = await api('POST', '/duty/unlock', { password: q('#scPwIn').value });
      if (r && r.mustChange) { setDutyFlag('m'); say('出勤核定密碼還是預設的 0000，請先到「出勤核定」改成自己的密碼', true); pwBox.hidden = true; paintMsg(); return; }
      setDutyFlag('1'); pwBox.hidden = true;
      if (pending) await pending();
    } catch (e) { say(e.message, true); paintMsg(); }
  });
  if (q('#scResend')) q('#scResend').onclick = () => busy(q('#scResend'), async () => {
    try { const r = await call('resend', { period: S.period }); await load(); say(r.publication && r.publication.status === 'sent' ? '已送到 LINE' : '還是送不出去，系統會每 5 分鐘自動再試'); }
    catch (e) {
      if (e.code === 'FORBIDDEN' && /核定/.test(e.message)) { pending = async () => { try { await call('resend', { period: S.period }); await load(); say('已重送'); } catch (e2) { say(e2.message, true); } rerender(); }; pwBox.hidden = false; say('請輸入出勤核定密碼', true); paintMsg(); return; }
      say(e.message, true);
    }
    rerender();
  });
}
