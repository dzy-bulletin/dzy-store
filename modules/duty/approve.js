// 核定工時：照原系統 ~/mala-clock-in/manager.html 搬。日期列（前一天／後一天／今天）、本月待核定提醒、員工卡（收合展開、時段、
// 核定時數即時算、休息、假別、出差、遲到分鐘）、送出核定。外觀換成營運系統風格，規則與文案不改。
import { confirmBox } from '../../js/ui.js';
import { S, call, brk, h, failBar } from './state.js';
import * as C from './calc.js';

export function renderApprove(ctx) {
  const el = ctx.el;
  el.innerHTML = `<div class="du-datebar"><button type="button" class="btn ghost du-nav" id="duPrev" aria-label="前一天">‹</button>
    <input type="date" id="duDate" aria-label="日期"><button type="button" class="btn ghost du-nav" id="duNext" aria-label="後一天">›</button>
    <button type="button" class="btn ghost" id="duToday">今天</button></div>
    <div id="duPend"></div><div id="duDayBox"></div>`;
  const dateIn = el.querySelector('#duDate'), pendEl = el.querySelector('#duPend'), box = el.querySelector('#duDayBox');
  const live = () => el.isConnected;

  // ---------- 本月待核定提醒（manager.html:1604–1745）：沒有待核定＝整塊不畫 ----------
  function loadPending() {
    call('mgr_pending_approvals').then(r => { if (!live()) return; S.pend = Array.isArray(r.items) ? r.items : []; drawPending(); },
      e => { if (live()) failBar(pendEl, '本月待核定提醒', e, loadPending); });
  }
  function drawPending() {
    pendEl.innerHTML = '';
    const items = S.pend || [];
    if (!items.length) return;
    const groups = [], by = {};
    items.forEach(it => { if (!by[it.date]) { by[it.date] = { date: it.date, names: [] }; groups.push(by[it.date]); } by[it.date].names.push(it); });
    const card = h('div', 'du-pa');
    card.append(h('div', 'du-pa-title', '本月還有 ' + groups.length + ' 天沒核定'), h('div', 'du-pa-sub', '點名字直接跳到那天核定'));
    (S.pendAll ? groups : groups.slice(0, 5)).forEach(g => {
      const row = h('div', 'du-pa-group'), names = h('div', 'du-pa-names');
      row.append(h('div', 'du-pa-date', C.weekdayLabel(g.date)));
      g.names.forEach(n => {
        const chip = h('button', 'du-chip', n.name, { type: 'button' });
        chip.dataset.date = g.date; chip.dataset.emp = String(n.emp_id);
        chip.onclick = () => { S.focusEmp = String(n.emp_id); loadDay(g.date); };
        names.append(chip);
      });
      row.append(names); card.append(row);
    });
    if (!S.pendAll && groups.length > 5) {
      const more = h('button', 'du-more', '再顯示 ' + (groups.length - 5) + ' 天', { type: 'button' });
      more.onclick = () => { S.pendAll = true; drawPending(); };
      card.append(more);
    }
    pendEl.append(card);
  }
  // 核定成功後即時從提醒移除（不必重打後端）
  box.addEventListener('emp-approved', e => {
    const d = e.detail; if (!d || !S.pend) return;
    const n = S.pend.length;
    S.pend = S.pend.filter(it => !(it.date === d.date && String(it.emp_id) === String(d.emp_id)));
    if (S.pend.length !== n) drawPending();
  });

  // ---------- 某天的名單（manager.html:1540–1590、1840–1930）----------
  const cacheable = d => !!d && d < C.taipeiToday();          // 嚴格早於今天（台北）才快取
  function prefetch(date) {                                   // 背景預抓前幾天，‹ 幾乎瞬間；循序一次一天（原頁抓 6 天，這裡經營運系統轉送，縮成 3 天）
    const targets = []; for (let i = 1; i <= 3; i++) targets.push(C.addDaysStr(date, -i));
    (function next() {
      const d = targets.shift(); if (!d) return;
      if (!cacheable(d) || S.dayCache[d]) return next();
      call('mgr_day', { date: d }).then(r => { if (r && r.date) S.dayCache[r.date] = r.employees; next(); }, () => next());
    })();
  }
  function loadDay(dateOverride) {
    const tok = ++S.dayTok;
    if (dateOverride && S.dayCache[dateOverride]) { drawDay(dateOverride, S.dayCache[dateOverride]); prefetch(dateOverride); return; }
    box.innerHTML = '<div class="card du-center" id="duLoading">載入中…</div>';
    const body = dateOverride ? { date: dateOverride } : {};
    call('mgr_day', body).then(r => {
      if (tok !== S.dayTok || !live()) return;
      if (cacheable(r.date)) S.dayCache[r.date] = r.employees;
      drawDay(r.date, r.employees); prefetch(r.date);
    }, e => {
      if (tok !== S.dayTok || !live()) return;
      box.innerHTML = ''; const c = h('div', 'card'); box.append(c);
      failBar(c, '這天的名單', e, () => loadDay(dateOverride));
    });
  }
  function drawDay(date, employees) {
    S.date = date; dateIn.value = date;
    renderEmployees(box, date, employees);
  }

  dateIn.onchange = () => { if (dateIn.value) loadDay(dateIn.value); };
  el.querySelector('#duPrev').onclick = () => { if (S.date) loadDay(C.addDaysStr(S.date, -1)); };
  el.querySelector('#duNext').onclick = () => { if (S.date) loadDay(C.addDaysStr(S.date, 1)); };
  el.querySelector('#duToday').onclick = () => loadDay(null);

  if (S.pend) drawPending();
  loadPending();
  loadDay(S.date);
}

function renderEmployees(box, date, employees) {
  box.innerHTML = '';
  if (!employees || !employees.length) { box.append(h('div', 'card du-center', '這天沒有任何同仁打卡紀錄。')); return; }
  const pendingCount = employees.filter(e => !e.approved).length;
  const bar = h('div', 'du-listbar');
  const count = h('span', 'du-count'); count.innerHTML = '共 ' + employees.length + ' 人・待核定 <b>' + pendingCount + '</b> 人';
  const toggleAll = h('button', 'btn sm ghost', '全部展開', { type: 'button', id: 'duToggleAll' });
  let allOpen = false;
  toggleAll.onclick = () => { allOpen = !allOpen; toggleAll.textContent = allOpen ? '全部收合' : '全部展開'; list.querySelectorAll('.du-card').forEach(c => c.__setExpanded(allOpen)); };
  bar.append(count, toggleAll);
  const list = h('div', 'du-list');
  box.append(bar, list);
  employees.forEach(emp => list.append(buildCard(emp, date)));

  // 一次只展開一位：開著「下一位要核定的人」，核完自動收起來翻到下一位（manager.html:1520–1560）
  const nextPending = () => [].filter.call(list.querySelectorAll('.du-card'), c => c.__pending && c.__hasPunch)[0];
  const openNext = () => { const c = nextPending(); if (c) c.__setExpanded(true); return c; };
  if (S.focusEmp) {                                           // 待核定提醒點姓名跳過來：改開那張並捲過去，消費一次就清掉
    const fid = S.focusEmp; S.focusEmp = null;
    const fc = [].filter.call(list.querySelectorAll('.du-card'), c => c.dataset.empId === fid)[0];
    if (fc) { fc.__setExpanded(true); if (fc.scrollIntoView) fc.scrollIntoView({ block: 'center' }); } else openNext();
  } else openNext();
  list.addEventListener('emp-approved', e => {
    if (e.target && e.target.__setExpanded) e.target.__setExpanded(false);
    const nx = openNext();
    if (nx && nx.scrollIntoView) nx.scrollIntoView({ block: 'center' });
    const left = [].filter.call(list.querySelectorAll('.du-card'), c => c.__pending).length;
    count.innerHTML = '共 ' + employees.length + ' 人・待核定 <b>' + left + '</b> 人';
  });
}

function periodRow(p, onChange) {
  const row = h('div', 'du-prow');
  const s = h('input', 'p-start', null, { type: 'time', 'aria-label': '上班時間' }); s.value = (p && p.start) || '';
  const e = h('input', 'p-end', null, { type: 'time', 'aria-label': '下班時間' }); e.value = (p && p.end) || '';
  const rm = h('button', 'btn sm ghost remove-btn', '－', { type: 'button', 'aria-label': '移除這一段' });
  rm.onclick = () => { row.remove(); onChange(); };
  ['input', 'change'].forEach(ev => { s.addEventListener(ev, onChange); e.addEventListener(ev, onChange); });
  row.append(s, h('span', 'du-dash', '–'), e, rm);
  return row;
}

function buildCard(emp, date) {
  const br = brk();
  const card = h('div', 'du-card'); card.dataset.empId = String(emp.emp_id);

  // ---- 頭部（收合時看得到：姓名、班別、打卡摘要、精簡徽章）----
  const nameEl = h('div', 'du-name', emp.name);
  if (emp.shift_in && emp.shift_out)
    nameEl.append(h('span', 'du-shift', emp.shift_in + '–' + emp.shift_out + (C.shiftCoversBreak(br, emp.shift_in, emp.shift_out) ? '・休' + C.breakHoursText(br) + 'h' : '')));
  const punchEl = h('div', 'du-punch');
  if (emp.segments && emp.segments.length) {
    const ref = (emp.reference === null || emp.reference === undefined) ? '參考 —' : '參考 ' + emp.reference + ' 小時';   // 忘刷卡整天 reference=null，不可印成 "null"
    punchEl.textContent = '打卡：' + emp.segments.map(C.segmentText).join('、') + '　' + ref;
  } else if (emp.attempts > 0) punchEl.textContent = '今天沒有入帳的打卡（有 ' + emp.attempts + ' 筆未入帳嘗試）';
  else punchEl.textContent = '今天沒有打卡紀錄';
  const mini = h('span', 'du-mini'), chev = h('span', 'du-chev', '▼');
  const head = h('div', 'du-head', null, { role: 'button', tabindex: '0', 'aria-expanded': 'false' });
  const hmain = h('div', 'du-hmain'); hmain.append(nameEl, punchEl);
  head.append(hmain, mini, chev);
  const body = h('div', 'du-body'); body.hidden = true;
  card.append(head, body);

  // ---- 防呆：有打卡段還沒配對（有上班沒下班），現在核定會核不到那段（manager.html:1003–1012）----
  const hasOpenSeg = (emp.segments || []).some(s => s.in && !s.out);
  if (hasOpenSeg) body.append(h('div', 'du-openwarn', '⚠ 有打卡段還沒打下班卡（可能還在上班或跨夜還沒打完），現在核定會核不到這段、且之後補打卡也不會自動更新。請同仁立即打卡避免忘刷卡。'));

  // ---- 狀態徽章：核定成功後當場翻成「已核定」----
  const badge = h('div', 'du-badge');
  function setBadge(approved, leaveType, leaveHours) {
    if (approved) {
      badge.className = 'du-badge ' + C.badgeClass(approved.status_text);
      badge.textContent = '已核定 ' + approved.approved_hours + ' 小時・' + approved.status_text + C.leaveSuffix(leaveType, leaveHours) + '（' + approved.manager_name + '）';
      mini.className = 'du-mini ' + C.badgeClass(approved.status_text); mini.textContent = '✓ ' + approved.approved_hours + ' 小時';
    } else { badge.className = 'du-badge pending'; badge.textContent = '待核定'; mini.className = 'du-mini pending'; mini.textContent = '待核定'; }
    badge.hidden = !approved;                       // 未核定時頭部的精簡徽章已寫「待核定」，不必再重複一顆
  }
  body.append(badge);

  // ---- 時段預設值（manager.html:1031–1062）：已核定→帶既有；已核定但沒時段（整天請假／出差）→空白（不可再帶預設，重送會多算）；
  //      有預設班別→帶入（碰到休息帶就預先拆成兩段，不做隱形扣除）；都沒有→空白。刻意不從當天打卡時間推算。
  let initial;
  if (emp.approved && emp.approved.periods && emp.approved.periods.length) initial = emp.approved.periods;
  else if (emp.approved) initial = [null];
  else if (emp.shift_in && emp.shift_out)
    initial = C.shiftCoversBreak(br, emp.shift_in, emp.shift_out)
      ? [{ start: emp.shift_in, end: br.start }, { start: br.end, end: emp.shift_out }] : [{ start: emp.shift_in, end: emp.shift_out }];
  else initial = [null];
  const periodRows = h('div', 'du-periods');
  initial.forEach(p => periodRows.append(periodRow(p, refresh)));
  const totalBox = h('div', 'du-total'); const breakToggle = h('button', 'du-breaktoggle', '', { type: 'button' }); breakToggle.hidden = true;
  body.append(periodRows, totalBox, breakToggle);

  // ---- 請假註記／出差／遲到分鐘 ----
  const leaveSel = h('select', 'du-leave', null, { 'aria-label': '請假註記' });
  ['無'].concat(C.LEAVE_TYPES).forEach(t => { const o = h('option', null, t); o.value = t === '無' ? '' : t; leaveSel.append(o); });
  if (emp.leave_type && ![...leaveSel.options].some(o => o.value === emp.leave_type)) { const o = h('option', null, emp.leave_type); o.value = emp.leave_type; leaveSel.append(o); }   // 既有紀錄的假別不在清單內也要能顯示，否則重開頁掉值
  leaveSel.value = emp.leave_type || '';
  const leaveHours = h('input', 'du-leave-hours', null, { type: 'number', step: '0.25', min: '0', placeholder: '時數', 'aria-label': '假別時數' });
  leaveHours.value = (emp.leave_hours === 0 || emp.leave_hours) ? emp.leave_hours : '';
  const leaveRow = h('div', 'du-row'); leaveRow.append(h('label', null, '請假註記'), leaveSel, leaveHours, h('span', 'du-unit', '小時'));
  const tripHint = h('div', 'du-triphint', '出差：時數填幾小時就核定幾小時，會與上方上班時段相加。出差那段不用再填進上班時段（填了會重複算）；整天出差可以不填上班時段。');
  const lateIn = h('input', 'du-late', null, { type: 'number', step: '1', min: '0', placeholder: '自動', 'aria-label': '遲到分鐘' });
  lateIn.value = C.lateFromStatus(emp.approved && emp.approved.status_text);
  const lateRow = h('div', 'du-row'); lateRow.append(h('label', null, '遲到分鐘'), lateIn, h('span', 'du-unit', '分鐘'), h('span', 'du-hint', '留空＝自動判定　填 0＝認定不算遲到'));
  body.append(leaveRow, tripHint, lateRow);

  const tripH = () => C.tripHoursOf(leaveSel.value, leaveHours.value);
  const readRows = () => [...periodRows.querySelectorAll('.du-prow')].map(r => ({ row: r, start: r.querySelector('.p-start').value, end: r.querySelector('.p-end').value }));

  // 每次時段有變動就整個重算（manager.html:1099–1141）。刻意不記「主管有沒有動過」——休息列純粹依「相鄰兩段之間的空檔是不是剛好等於休息帶」決定
  function refresh() {
    const rows = readRows();
    periodRows.querySelectorAll('.du-break').forEach(n => n.remove());
    for (let i = 1; i < rows.length; i++) if (C.gapIsBreak(br, rows[i - 1].end, rows[i].start))
      periodRows.insertBefore(h('div', 'du-break', '休息 ' + br.start + '–' + br.end + '（不打卡・不計入時數）'), rows[i].row);
    const { total, filled } = C.sumPeriods(rows), th = tripH();
    totalBox.textContent = ''; totalBox.hidden = !filled && !th;
    if (filled || th) {
      const val = h('span', 'du-total-val', String(C.round2(total + th)));
      totalBox.append(h('span', 'du-total-lb', '核定時數'), val, h('span', 'du-total-unit', th ? '小時（上班 ' + C.round2(total) + '＋出差 ' + th + '）' : '小時'));
    }
    breakToggle.hidden = true;                      // 一顆鈕在「併成一段」與「插入休息」之間切換，兩個方向都回得去
    if (C.hasBreak(br)) {
      if (rows.length === 2 && C.gapIsBreak(br, rows[0].end, rows[1].start)) { breakToggle.hidden = false; breakToggle.dataset.mode = 'merge'; breakToggle.textContent = '今天沒休息 → 併成一段'; }
      else if (rows.length === 1 && C.shiftCoversBreak(br, rows[0].start, rows[0].end)) { breakToggle.hidden = false; breakToggle.dataset.mode = 'split'; breakToggle.textContent = '插入休息 ' + br.start + '–' + br.end; }
    }
  }
  breakToggle.onclick = () => {
    const rows = readRows();
    if (breakToggle.dataset.mode === 'merge' && rows.length === 2) { rows[0].row.querySelector('.p-end').value = rows[1].end; rows[1].row.remove(); }
    else if (breakToggle.dataset.mode === 'split' && rows.length === 1) {
      const tail = rows[0].end; rows[0].row.querySelector('.p-end').value = br.start;
      periodRows.append(periodRow({ start: br.end, end: tail }, refresh));
    }
    refresh();
  };
  function syncLeave() {                            // 時數只在有選假別時可填；出差換提示（manager.html:1225–1233）
    const on = !!leaveSel.value;
    leaveHours.disabled = !on; if (!on) leaveHours.value = '';
    const trip = leaveSel.value === '出差';
    leaveHours.placeholder = trip ? '出差時數' : '時數'; tripHint.hidden = !trip;
    refresh();
  }
  leaveSel.addEventListener('change', syncLeave); leaveHours.addEventListener('input', refresh);
  syncLeave();

  // ---- 按鈕、結果 ----
  const addBtn = h('button', 'btn ghost du-add', '＋ 加一段', { type: 'button' });
  addBtn.onclick = () => { periodRows.append(periodRow(null, refresh)); refresh(); };
  const submit = h('button', 'btn du-submit', emp.approved ? '重新送出核定' : '送出核定', { type: 'button' });
  const actions = h('div', 'du-actions'); actions.append(addBtn, submit);
  const result = h('div', 'du-result'); result.hidden = true;
  body.append(actions, result);
  const say = (cls, text) => { result.className = 'du-result ' + cls; result.hidden = false; result.textContent = text; };

  submit.onclick = async () => {
    const periods = []; let half = false;
    periodRows.querySelectorAll('.du-prow').forEach(r => {
      const s = r.querySelector('.p-start').value, e = r.querySelector('.p-end').value;
      if (s && e) periods.push({ start: s, end: e }); else if (s || e) half = true;
    });
    if (half) return say('bad', '✕ 有一段只填了上班或下班時間，請補齊兩邊，或按該段的 － 移除。');
    if (leaveHours.value !== '' && Number(leaveHours.value) < 0) return say('bad', '✕ 請假時數不能是負數，請修正後再送出。');
    if (periods.length === 0) {                     // 沒填任何上班時段：有選假別＝整天請假（核定 0 小時）；否則就是漏填（manager.html:1340–1366）
      if (!leaveSel.value) return say('bad', '✕ 請至少輸入一段上班時間；若是整天請假，請在「請假註記」選假別再送出。');
      if (leaveSel.value === '出差') {               // 出差不是請假：整天出差核定＝出差時數，沒填就是 0 工時（正職月底會被不足倒扣）
        const t0 = tripH();
        if (!t0) return say('bad', '✕ 整天出差請在出差時數填幾小時（填幾小時就核定幾小時）。');
        if (!await confirmBox('整天出差：' + emp.name + '\n出差 ' + t0 + ' 小時\n核定時數 ' + t0 + ' 小時\n\n確定送出?', '送出')) return;
      } else if (!await confirmBox('整天請假：' + emp.name + '\n' + leaveSel.value + (leaveHours.value ? '　' + leaveHours.value + ' 小時' : '') + '\n核定時數 0 小時（整天沒上班）\n\n確定送出?', '送出')) return;
    } else {                                        // 送出前把總時數與提醒攤開給主管看過（manager.html:1367–1415）
      const { segs, totalH, warnings } = C.analyzePeriods(periods), t2 = tripH();
      if (hasOpenSeg) warnings.push('・這天有打卡段還沒打下班卡，現在核定可能會核不到那一段，且之後補打卡不會自動重算——請同仁立即打卡避免忘刷卡。');
      let msg = '即將核定 ' + emp.name + '：\n' + segs.map(s => s.start + '–' + s.end).join('、')
        + (t2 ? '\n上班 ' + totalH + ' 小時＋出差 ' + t2 + ' 小時\n核定時數共 ' + C.round2(totalH + t2) + ' 小時' : '\n核定時數共 ' + totalH + ' 小時');
      if (periodRows.querySelector('.du-break')) msg += '\n（休息 ' + br.start + '–' + br.end + ' 不計入）';
      if (leaveSel.value && !t2) msg += '\n' + (leaveSel.value === '出差' ? '註記' : '請假') + '：' + leaveSel.value + (leaveHours.value ? ' ' + leaveHours.value + ' 小時' : '');
      if (warnings.length) msg += '\n\n⚠ 請再確認：\n' + warnings.join('\n');
      if (!await confirmBox(msg + '\n\n確定送出?', '送出')) return;
    }
    submit.disabled = true; submit.textContent = '送出中…';
    const approveDate = date;                       // 送出當下鎖定日期，避免回呼時已切到別天
    try {
      const res = await call('mgr_approve', { date: approveDate, emp_id: emp.emp_id, periods, late_min: lateIn.value, leave_type: leaveSel.value, leave_hours: leaveSel.value ? leaveHours.value : '' });
      delete S.dayCache[approveDate];
      say('ok', '✓ 已核定 ' + res.approved_hours + ' 小時・' + res.status_text + C.leaveSuffix(res.leave_type, res.leave_hours) + '（' + res.manager_name + '）');
      setBadge(res, res.leave_type, res.leave_hours);
      card.__pending = false;
      card.dispatchEvent(new CustomEvent('emp-approved', { bubbles: true, detail: { emp_id: emp.emp_id, date: approveDate } }));
    } catch (e) { say('bad', '✕ 核定失敗：' + e.message); }
    finally { submit.disabled = false; submit.textContent = '重新送出核定'; }
  };

  function setExpanded(on) { body.hidden = !on; card.classList.toggle('open', on); head.setAttribute('aria-expanded', on ? 'true' : 'false'); }
  setBadge(emp.approved, emp.leave_type, emp.leave_hours);
  setExpanded(false);
  card.__pending = !emp.approved;
  card.__hasPunch = !!(emp.segments && emp.segments.length) || emp.attempts > 0;
  card.__setExpanded = setExpanded;
  head.onclick = () => setExpanded(body.hidden);
  head.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(body.hidden); } };
  return card;
}
