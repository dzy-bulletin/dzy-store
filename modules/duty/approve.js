// 核定工時：照原系統 ~/mala-clock-in/manager.html 搬。日期列（前一天／後一天／今天）、本月待核定提醒、員工卡（收合展開、時段、
// 核定時數即時算、休息、假別、出差、遲到分鐘）、送出核定。外觀換成營運系統風格，規則與文案不改。
import { confirmBox } from '../../js/ui.js';
import { S, dutyManager, call, callAll, brk, h, failBar, failedStores, loadLeave, staleLeave, leaveFor, rowKey, canWriteRow, supportTag } from './state.js';
import * as C from './calc.js';
import { qrButton } from './qr.js';
import { api } from '../../js/api.js';
import { comparePlan } from '../schedule/compare.js';

export function renderApprove(ctx) {
  const el = ctx.el;
  el.innerHTML = `<div id="duQrSlot"></div><div class="du-datebar"><button type="button" class="btn ghost du-nav" id="duPrev" aria-label="前一天">‹</button>
    <input type="date" id="duDate" aria-label="日期"><button type="button" class="btn ghost du-nav" id="duNext" aria-label="後一天">›</button>
    <button type="button" class="btn ghost" id="duToday">今天</button></div>
    <div id="duPend"></div><div id="duDayBox"></div>`;
  const dateIn = el.querySelector('#duDate'), pendEl = el.querySelector('#duPend'), box = el.querySelector('#duDayBox');
  const live = () => el.isConnected;
  if (dutyManager(ctx.session) && !S.all) el.querySelector('#duQrSlot').append(qrButton(el));      // 打卡 QR（同仁定位抓不到時給他掃），日期列上方

  // ---------- 本月待核定提醒（manager.html:1604–1745）：沒有待核定＝整塊不畫 ----------
  function loadPending() {
    (S.all ? callAll('mgr_pending_approvals') : call('mgr_pending_approvals')).then(r => { if (!live()) return; S.pend = Array.isArray(r.items) ? r.items : []; S.pendFailed = S.all ? (r.failed || []) : []; drawPending(); },
      e => { if (live()) failBar(pendEl, '本月待核定提醒', e, loadPending); });
  }
  function drawPending() {
    pendEl.innerHTML = '';
    const items = S.pend || [];
    if (S.all) failedStores(pendEl, S.pendFailed, loadPending);
    if (!items.length) return;
    const groups = [], by = {};
    items.forEach(it => { if (!by[it.date]) { by[it.date] = { date: it.date, names: [] }; groups.push(by[it.date]); } by[it.date].names.push(it); });
    const card = h('div', 'du-pa');
    card.append(h('div', 'du-pa-title', '本月還有 ' + groups.length + ' 天沒核定'), h('div', 'du-pa-sub', '點名字直接跳到那天核定'));
    (S.pendAll ? groups : groups.slice(0, 5)).forEach(g => {
      const row = h('div', 'du-pa-group'), names = h('div', 'du-pa-names');
      row.append(h('div', 'du-pa-date', C.weekdayLabel(g.date)));
      g.names.forEach(n => {
        const chip = h('button', 'du-chip', n.name + (n.storeName ? '・' + n.storeName : ''), { type: 'button' });
        const sup = supportTag(n); if (sup) chip.append(sup);
        chip.dataset.date = g.date; chip.dataset.emp = String(n.emp_id); if (n.store) chip.dataset.store = n.store;
        chip.onclick = () => { S.focusEmp = rowKey(n); loadDay(g.date); };
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
    S.pend = S.pend.filter(it => !(it.date === d.date && String(it.emp_id) === String(d.emp_id) && (it.store || '') === (d.store || '')));
    if (S.pend.length !== n) drawPending();
  });

  // ---------- 某天的名單（manager.html:1540–1590、1840–1930）----------
  // 昨天以前才快取（昨天不快取）：跨夜班同仁午夜後才打下班卡，掛在昨天，快取會一直顯示舊的（2026-10-11 審查）
  const cacheable = d => !!d && d < C.addDaysStr(C.taipeiToday(), -1);
  function prefetch(date) {                                   // 背景預抓前幾天，‹ 幾乎瞬間；循序一次一天（原頁抓 6 天，這裡經營運系統轉送，縮成 3 天）
    const targets = []; for (let i = 1; i <= 3; i++) targets.push(C.addDaysStr(date, -i));
    (function next() {
      const d = targets.shift(); if (!d) return;
      if (!cacheable(d) || S.dayCache[d]) return next();
      dayRead(d).then(r => { if (r && r.date && !(r.failed && r.failed.length)) S.dayCache[r.date] = r.employees; next(); }, () => next());      // 全部門市有店讀不到的那天不快取（讀不到的店不能被當成「這天沒人」記住）
    })();
  }
  const dayRead = body => (S.all ? callAll('mgr_day', typeof body === 'string' ? { date: body } : body) : call('mgr_day', typeof body === 'string' ? { date: body } : body));
  function loadDay(dateOverride) {
    const tok = ++S.dayTok;
    // 假別額度被清掉（核定過請假）時先重抓，再畫名單：不然新卡片拿不到額度，額度與期限的硬擋整批失效（2026-10-12 Codex 審查）
    if (S.leaveStale) { S.leaveStale = false; const go = () => { if (tok === S.dayTok && live()) loadDayNow(dateOverride, tok); }; loadLeave().then(go, go); return; }
    loadDayNow(dateOverride, tok);
  }
  function loadDayNow(dateOverride, tok) {
    if (dateOverride && S.dayCache[dateOverride]) { drawDay(dateOverride, S.dayCache[dateOverride], []); prefetch(dateOverride); return; }
    box.innerHTML = '<div class="card du-center" id="duLoading">載入中…</div>';
    const body = dateOverride ? { date: dateOverride } : {};
    dayRead(body).then(r => {
      if (tok !== S.dayTok || !live()) return;
      const failed = S.all ? (r.failed || []) : [];
      if (cacheable(r.date) && !failed.length) S.dayCache[r.date] = r.employees;
      drawDay(r.date, r.employees, failed); prefetch(r.date);
    }, e => {
      if (tok !== S.dayTok || !live()) return;
      box.innerHTML = ''; const c = h('div', 'card'); box.append(c);
      failBar(c, '這天的名單', e, () => loadDay(dateOverride));
    });
  }
  function drawDay(date, employees, failed) {
    S.date = date; dateIn.value = date;
    renderEmployees(box, date, employees, failed, () => { loadPending(); loadDay(date); });
    applyDayRequests(date);
    applyDayPlan(date);
  }
  // 自動排班的班表（2026-10-11）：每人加一行「班表：早班 10:00–19:00」，打卡跟班表差超過 15 分鐘標橘色。只提示，不擋核定。
  // 這家店沒開自動排班、或讀不到，就安靜略過。
  function applyDayPlan(date) {
    if (S.all || !((ctx.session && ctx.session.features) || []).includes('schedule')) return;      // 全部門市：班表比對只在單一門市（各店班表要各自讀，暫不合併）
    const tok = S.dayTok;
    api('POST', '/m/schedule/dayPlan', S.asStore ? { date, store: S.asStore } : { date }).then(res => {   // 管理者代看：讀該店的班表
      if (tok !== S.dayTok || S.date !== date || !live() || !res || !res.plan) return;
      const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);   // 台北今天
      box.querySelectorAll('.du-card').forEach(card => {
        const r = comparePlan(res.plan[card.dataset.empId], card.__segments, { past: date <= today });
        if (!r || !card.__showPlan) return;
        card.__showPlan(r);
      });
    }, () => {});
  }
  // 那天已核准的加班請假／忘打卡申請 → 對應同仁卡片顯示並預填（不快取：主管剛核准完切過來要看得到）。失敗就安靜略過，不擋核定。
  function applyDayRequests(date) {
    const tok = S.dayTok;
    const put = (store, byEmp) => Object.keys(byEmp || {}).forEach(id => {
      const key = rowKey({ store, emp_id: id });
      const card = [].filter.call(box.querySelectorAll('.du-card'), c => c.dataset.empId === key)[0];
      if (card && card.__applyReq) card.__applyReq(byEmp[id]);
    });
    if (S.all) {          // 全部門市：by_store[店].by_emp，各店的 emp_id 分開對（同號員編不會對錯人）
      callAll('mgr_req_day', { date }).then(res => {
        if (tok !== S.dayTok || S.date !== date || !live() || !res || !res.by_store) return;
        Object.keys(res.by_store).forEach(st => put(st, res.by_store[st] && res.by_store[st].by_emp));
      }, () => {});
      return;
    }
    call('mgr_req_day', { date }).then(res => {
      if (tok !== S.dayTok || S.date !== date || !live() || !res || !res.by_emp) return;
      put('', res.by_emp);
    }, () => {});
  }

  dateIn.onchange = () => { if (dateIn.value) loadDay(dateIn.value); };
  el.querySelector('#duPrev').onclick = () => { if (S.date) loadDay(C.addDaysStr(S.date, -1)); };
  el.querySelector('#duNext').onclick = () => { if (S.date) loadDay(C.addDaysStr(S.date, 1)); };
  el.querySelector('#duToday').onclick = () => loadDay(null);

  if (S.pend) drawPending();
  loadPending();
  // 假別清單與額度要在畫員工卡之前到（原頁也是先 loadLeaveOptions 再 loadDay）；失敗不擋人，退回內建清單
  if (S.leave) loadDay(S.date);
  else { box.innerHTML = '<div class="card du-center" id="duLoading">載入中…</div>'; loadLeave().then(() => { if (live()) loadDay(S.date); }); }
}

function renderEmployees(box, date, employees, failed, retry) {
  box.innerHTML = '';
  if (S.all) failedStores(box, failed, retry);
  if (!employees || !employees.length) { box.append(h('div', 'card du-center', failed && failed.length ? '讀得到的門市這天沒有任何同仁打卡紀錄。' : '這天沒有任何同仁打卡紀錄。')); return; }
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
    const fid = String(S.focusEmp); S.focusEmp = null;
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
  const br = brk(emp.store);
  const readOnly = !canWriteRow('hours', emp.emp_id, emp.store);      // 不在核定工時名單（只看）：不出現送出核定，欄位不可改
  const card = h('div', 'du-card'); card.dataset.empId = rowKey(emp); if (emp.store) card.dataset.store = emp.store;
  card.__segments = emp.segments || [];
  const pv = C.planPrefill(emp, emp.plan, br);                        // 那天的班表優先，沒排班才用個人預設時間（2026-10-29 Eason 選 A）
  const offDay = pv.mode === 'off';

  // ---- 頭部（收合時看得到：姓名、班別、打卡摘要、精簡徽章）----
  const nameEl = h('div', 'du-name', emp.name);
  const sup = supportTag(emp); if (sup) nameEl.append(sup);      // 支援（原單位）：別單位來這家店支援的同仁
  if (emp.store) nameEl.append(h('span', 'du-where', '打卡地點：' + emp.storeName, { 'data-where': emp.store }));      // 全部門市：這個人在哪一家店打的卡（同一人同一天在多家打卡會依店分列）
  if (pv.text) nameEl.append(h('span', 'du-shift' + (pv.mode === 'off' ? ' off' : ''), pv.text, { 'data-mode': pv.mode }));
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
  card.__showPlan = (r) => {                                  // 自動排班比對（只提示）
    const old = hmain.querySelector('.du-plan'); if (old) old.remove();
    const line = h('div', 'du-plan', r.text);
    r.flags.forEach(f => line.append(h('span', 'du-planflag', f)));
    hmain.append(line);
  };
  const body = h('div', 'du-body'); body.hidden = true;
  card.append(head, body);

  // ---- 防呆：有打卡段還沒配對（有上班沒下班），現在核定會核不到那段（manager.html:1003–1012）----
  const hasOpenSeg = (emp.segments || []).some(s => s.in && !s.out);
  if (hasOpenSeg) body.append(h('div', 'du-openwarn', '⚠ 有打卡段還沒打下班卡（可能還在上班或跨夜還沒打完），現在核定會核不到這段、且之後補打卡也不會自動更新。請同仁立即打卡避免忘刷卡。'));

  // ---- 狀態徽章：核定成功後當場翻成「已核定」----
  const badge = h('div', 'du-badge');
  function setBadge(approved, leaves) {
    if (approved) {
      badge.className = 'du-badge ' + C.badgeClass(approved.status_text);
      badge.textContent = '已核定 ' + approved.approved_hours + ' 小時・' + approved.status_text + C.leavesSuffix(leaves) + '（' + approved.manager_name + '）';
      mini.className = 'du-mini ' + C.badgeClass(approved.status_text); mini.textContent = '✓ ' + approved.approved_hours + ' 小時';
    } else { badge.className = 'du-badge pending'; badge.textContent = '待核定'; mini.className = 'du-mini pending'; mini.textContent = '待核定'; }
    badge.hidden = !approved;                       // 未核定時頭部的精簡徽章已寫「待核定」，不必再重複一顆
  }
  body.append(badge);

  // ---- 時段預設值（manager.html:1031–1062）：已核定→帶既有；已核定但沒時段（整天請假／出差）→空白（不可再帶預設，重送會多算）；
  //      班表上班→帶班表（分段班照段）；班表休假→空白；沒排班→個人預設班別；碰到休息帶就預先拆成兩段，不做隱形扣除。刻意不從當天打卡時間推算。（C.planPrefill）
  const periodRows = h('div', 'du-periods');
  pv.initial.forEach(p => periodRows.append(periodRow(p, refresh)));
  const offHint = pv.offPunch ? h('div', 'du-offhint', C.OFF_PUNCH_HINT) : null;      // 排休卻有打卡、沒有已核准的加班申請（申請到了由 __applyReq 收掉）
  if (offHint) body.append(offHint);
  const totalBox = h('div', 'du-total'); const breakToggle = h('button', 'du-breaktoggle', '', { type: 'button' }); breakToggle.hidden = true;
  body.append(periodRows, totalBox, breakToggle);

  // ---- 請假註記／出差／遲到分鐘 ----
  // 一天多種假別（2026-10-29，照 manager.html 2026-10-26）：一種一列，「＋ 再加一種假別」最多 4 種；送出 leaves:[{type,hours}]。
  // 出差時數加進核定時數，其他假別只是註記。已經記過的假別即使現在額度用完也要能顯示、重送，否則重開頁會掉值。
  const LO = leaveFor(emp.store);                               // payroll_leave_options 的回應；null＝拿不到，用內建清單、沒有額度與期限檢查
  const initLeaves = C.leavesOf(emp);
  const prevHad = t => initLeaves.some(x => x.type === t);
  function fillLeaveOptions(sel) {
    [''].concat(C.leaveNames(LO)).forEach(t => {
      const o = h('option', null, t || '無'); o.value = t;
      if (t && LO) {                                  // 額度用完就反灰選不了（manager.html:1184–1207）
        const def = C.leaveDefOf(LO, t), v = C.leaveOptionView(t, def, def ? C.quotaOf(LO, String(emp.emp_id), def.code) : null);
        o.textContent = v.text; o.disabled = v.disabled && !prevHad(t);
      }
      sel.append(o);
    });
  }
  const leaveBox = h('div', 'du-leavebox');
  const leaveLines = [];
  const addLeaveBtn = h('button', 'btn sm ghost du-addleave', '＋ 再加一種假別', { type: 'button' });
  leaveBox.append(addLeaveBtn);
  const tripHint = h('div', 'du-triphint', '出差：時數填幾小時就核定幾小時，會與上方上班時段相加。出差那段不用再填進上班時段（填了會重複算）；整天出差可以不填上班時段。');
  function syncLeave() {                            // 時數只在有選假別時可填；出差換提示（manager.html:1376–1386）
    leaveLines.forEach(l => {
      const on = !!l.sel.value;
      l.hours.disabled = !on || readOnly; if (!on) l.hours.value = '';
      l.hours.placeholder = l.sel.value === '出差' ? '出差時數' : '時數';
    });
    tripHint.hidden = !leaveLines.some(l => l.sel.value === '出差');
    addLeaveBtn.hidden = readOnly || leaveLines.length >= C.MAX_LEAVE_LINES;
    refresh();
  }
  function addLeaveLine(type, hours) {
    const first = !leaveLines.length;
    const row = h('div', 'du-row du-leaverow');
    const sel = h('select', 'du-leave', null, { 'aria-label': first ? '請假註記' : '再一種假別' });
    fillLeaveOptions(sel);
    if (type && ![...sel.options].some(o => o.value === type)) { const o = h('option', null, type); o.value = type; sel.append(o); }   // 不在清單內的既有假別也要能顯示
    sel.value = type || '';
    const hrs = h('input', 'du-leave-hours', null, { type: 'number', step: '0.25', min: '0', placeholder: '時數', 'aria-label': '假別時數' });
    hrs.value = (hours === 0 || hours) ? hours : '';
    row.append(h('label', null, first ? '請假註記' : '再一種'), sel, hrs, h('span', 'du-unit', '小時'));
    const line = { row, sel, hours: hrs };
    if (!first) {
      const rm = h('button', 'btn sm ghost du-leaverm', '✕', { type: 'button', 'aria-label': '移除這種假別' });
      rm.onclick = () => { row.remove(); leaveLines.splice(leaveLines.indexOf(line), 1); syncLeave(); };
      row.append(rm);
    }
    sel.addEventListener('change', syncLeave); hrs.addEventListener('input', refresh);
    leaveLines.push(line);
    leaveBox.insertBefore(row, addLeaveBtn);
    return line;
  }
  function setLeaveLines(list) {                    // 整組換掉（申請預填用）；空清單＝留一列「無」
    leaveLines.forEach(l => l.row.remove()); leaveLines.length = 0;
    (list && list.length ? list : [{ type: '', hours: '' }]).forEach(x => addLeaveLine(x.type, x.hours));
    syncLeave();
  }
  const leaveList = () => leaveLines.filter(l => l.sel.value).map(l => ({ type: l.sel.value, hours: l.hours.value }));
  addLeaveBtn.onclick = () => { addLeaveLine('', '').sel.focus(); syncLeave(); };
  const lateIn = h('input', 'du-late', null, { type: 'number', step: '1', min: '0', placeholder: '自動', 'aria-label': '遲到分鐘' });
  lateIn.value = C.lateFromStatus(emp.approved && emp.approved.status_text);
  const lateRow = h('div', 'du-row'); lateRow.append(h('label', null, '遲到分鐘'), lateIn, h('span', 'du-unit', '分鐘'), h('span', 'du-hint', '留空＝自動判定　填 0＝認定不算遲到'));
  body.append(leaveBox, tripHint, lateRow);

  const tripH = () => C.tripHoursOfList(leaveList());
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
  setLeaveLines(initLeaves);

  // ---- 按鈕、結果 ----
  const addBtn = h('button', 'btn ghost du-add', '＋ 加一段', { type: 'button' });
  addBtn.onclick = () => { periodRows.append(periodRow(null, refresh)); refresh(); };
  const submit = h('button', 'btn du-submit', emp.approved ? '重新送出核定' : '送出核定', { type: 'button' });
  const actions = h('div', 'du-actions'); actions.append(addBtn, submit);
  if (readOnly) actions.hidden = true;
  const result = h('div', 'du-result'); result.hidden = true;
  body.append(actions, result);
  const say = (cls, text) => { result.className = 'du-result ' + cls; result.hidden = false; result.textContent = text; };

  submit.onclick = async () => {
    // 硬擋（Eason 2026-08-22「硬擋，不給送出」，manager.html:1296–1320）：額度用完、期限過了的假別不給送出。
    // 下拉的 disabled 只擋滑鼠，程式指定仍設得進去，所以送出前用同一份資料再判一次；原本就選著這個假別的既有紀錄放行，否則已超額的人連重送核定都做不了
    const lv = leaveList();
    const dupT = C.dupLeaveType(lv);
    if (dupT) return say('bad', '✕ 「' + dupT + '」選了兩次，同一種假別請合併成一列（時數加起來）。');
    for (const L of lv) {
      if (!LO || prevHad(L.type)) continue;
      const d0 = C.leaveDefOf(LO, L.type), q0 = d0 ? C.quotaOf(LO, String(emp.emp_id), d0.code) : null;
      if (d0) {
        const wc = C.windowCheck(d0, LO.events, String(emp.emp_id), date);
        if (!wc.ok) return say('bad', '✕ ' + wc.msg + '，無法送出。確有需要請聯絡 Eason。');
        if (wc.note && !await confirmBox(wc.note + '\n\n仍要送出嗎？', '送出')) return;
      }
      // 補休：時數不能超過餘額（同一天重送原本的補休紀錄放行，否則改不動；manager.html:1388–1395）
      if (q0 && q0.comp && (!q0.allowed || Number(L.hours || 0) > Number(q0.balance_h || 0)))
        return say('bad', '✕ ' + emp.name + (q0.allowed ? ' 的補休餘額只剩 ' + (q0.balance_h || 0) + ' 小時，不夠請 ' + (L.hours || 0) + ' 小時' : ' 是計時同仁，沒有補休') + '，無法送出。');
      if (q0 && q0.blocked && !q0.comp) return say('bad', '✕ ' + emp.name + ' 的「' + L.type + '」額度已用完（上限 ' + q0.cap_days + ' 日，已用 ' + (Math.round((q0.used_days || 0) * 10) / 10) + ' 日），無法送出。確有需要請聯絡 Eason 調整假別設定。');
    }
    const lvText = C.leavesText(lv), hasTripLv = lv.some(x => x.type === '出差');
    const periods = []; let half = false;
    periodRows.querySelectorAll('.du-prow').forEach(r => {
      const s = r.querySelector('.p-start').value, e = r.querySelector('.p-end').value;
      if (s && e) periods.push({ start: s, end: e }); else if (s || e) half = true;
    });
    if (half) return say('bad', '✕ 有一段只填了上班或下班時間，請補齊兩邊，或按該段的 － 移除。');
    if (lv.some(x => x.hours !== '' && Number(x.hours) < 0)) return say('bad', '✕ 請假時數不能是負數，請修正後再送出。');
    if (periods.length === 0) {                     // 沒填任何上班時段：有選假別＝整天請假（核定 0 小時）；否則就是漏填（manager.html:1340–1366）
      if (!lv.length) return say('bad', '✕ 請至少輸入一段上班時間；若是整天請假，請在「請假註記」選假別再送出。');
      if (hasTripLv) {               // 出差不是請假：整天出差核定＝出差時數，沒填就是 0 工時（正職月底會被不足倒扣）
        const t0 = tripH();
        if (!t0) return say('bad', '✕ 整天出差請在出差時數填幾小時（填幾小時就核定幾小時）。');
        if (!await confirmBox('整天出差：' + emp.name + '\n' + lvText + '\n核定時數 ' + t0 + ' 小時（只有出差時數算進核定）\n\n確定送出?', '送出')) return;
      } else if (!await confirmBox('整天請假：' + emp.name + '\n' + lvText + '\n核定時數 0 小時（整天沒上班）\n\n確定送出?', '送出')) return;
    } else {                                        // 送出前把總時數與提醒攤開給主管看過（manager.html:1367–1415）
      const { segs, totalH, warnings } = C.analyzePeriods(periods), t2 = tripH();
      if (hasOpenSeg) warnings.push('・這天有打卡段還沒打下班卡，現在核定可能會核不到那一段，且之後補打卡不會自動重算——請同仁立即打卡避免忘刷卡。');
      let msg = '即將核定 ' + emp.name + '：\n' + segs.map(s => s.start + '–' + s.end).join('、')
        + (t2 ? '\n上班 ' + totalH + ' 小時＋出差 ' + t2 + ' 小時\n核定時數共 ' + C.round2(totalH + t2) + ' 小時' : '\n核定時數共 ' + totalH + ' 小時');
      if (periodRows.querySelector('.du-break')) msg += '\n（休息 ' + br.start + '–' + br.end + ' 不計入）';
      const noted = lv.filter(x => !(x.type === '出差' && Number(x.hours) > 0));      // 沒算進核定的假別（出差以外、或沒填時數的出差）列出來給主管看
      if (noted.length) msg += '\n' + (noted.every(x => x.type === '出差') ? '註記' : '請假') + '：' + C.leavesText(noted);
      if (warnings.length) msg += '\n\n⚠ 請再確認：\n' + warnings.join('\n');
      if (!await confirmBox(msg + '\n\n確定送出?', '送出')) return;
    }
    submit.disabled = true; submit.textContent = '送出中…';
    const approveDate = date;                       // 送出當下鎖定日期，避免回呼時已切到別天
    try {
      const res = await call('mgr_approve', { store: emp.store, date: approveDate, emp_id: emp.emp_id, periods, late_min: lateIn.value, leaves: lv });
      delete S.dayCache[approveDate];
      if (lv.length || initLeaves.length) staleLeave();      // 有請假的核定會動到額度，下次進核定頁重抓
      say('ok', '✓ 已核定 ' + res.approved_hours + ' 小時・' + res.status_text + C.leavesSuffix(C.leavesOf(res)) + '（' + res.manager_name + '）');
      setBadge(res, C.leavesOf(res));
      card.__pending = false;
      card.dispatchEvent(new CustomEvent('emp-approved', { bubbles: true, detail: { emp_id: emp.emp_id, date: approveDate, store: emp.store } }));
    } catch (e) { say('bad', '✕ 核定失敗：' + e.message); }
    finally { submit.disabled = false; submit.textContent = '重新送出核定'; }
  };

  function setExpanded(on) { body.hidden = !on; card.classList.toggle('open', on); head.setAttribute('aria-expanded', on ? 'true' : 'false'); }
  setBadge(emp.approved, initLeaves);
  setExpanded(false);
  card.__pending = !emp.approved;
  card.__hasPunch = !!(emp.segments && emp.segments.length) || emp.attempts > 0;
  card.__setExpanded = setExpanded;

  // ---- 已核准的申請（2026-10-09，照 manager.html __applyReq）：還沒核定就幫主管預填；已核定過不覆蓋，改給一顆「依申請重新填」。
  //      預填只是畫面上的值，主管按送出核定才算數（核准申請本身不寫入核定）。加班在上班日只顯示、不預填；
  //      班表排休那天（2026-10-29）加班申請的時段就是當天工時 → 依加班申請預填、標「來自加班申請」，並收掉補申請提示。
  card.__applyReq = reqs => {
    if (!reqs || !reqs.length || card.__reqApplied) return;
    card.__reqApplied = true;
    // 同一天多張申請（2026-10-29，照 manager.html 2026-10-26；spec §1.1）：不同假別（出差＋天災假）一起填、各成一列；
    // 同一種假別兩張（多半一張是舊單）或兩張忘打卡，自動填會互蓋——不自動填，逐張列出給主管選，舊單可作廢。
    const plan = C.reqPlan(reqs), fillables = plan.fillables, multi = plan.multi;
    const otP = offDay ? C.otPeriods(reqs) : [];
    if (offDay && offHint && otP.length) offHint.remove();      // 加班申請沒填時段＝帶不進來，提示留著（2026-10-29 Fable 審查）
    const rbox = h('div', 'du-reqbox' + (emp.approved || multi ? ' warn' : ''));
    if (multi) rbox.append(h('div', 'du-reqlead', '⚠ 這天有 ' + fillables.length + ' 張已核准的申請，其中有同一種的（多半一張是舊單），系統不自動填：請把舊的或重複的按「作廢」，剩下的會自動填好；或按「依這張填」只填那一張。'));
    const note = h('div', 'du-reqnote'); note.hidden = true;
    const setNote = t => { note.textContent = t; note.hidden = !t; };
    let tag = null;
    const canVoid = !readOnly || canWriteRow('req', emp.emp_id, emp.store);     // 能核他工時、或能審他申請的人（Eason 2026-10-29 選 2A；伺服器再驗一次）
    reqs.forEach(r => {
      const row = h('div', 'du-reqrow');
      row.append(h('div', null, '✓ 已核准的申請：' + r.summary + '（' + r.decided_by + ' 核准）'));
      if (r.kind !== 'ot' && plan.older(r)) row.append(h('div', 'du-reqold', '同類還有一張較晚送出的申請，這張可能是舊單'));
      const acts = h('div', 'du-reqacts');
      if (multi && r.kind !== 'ot' && !readOnly) {
        const fb = h('button', 'btn sm ghost du-reqpick', '依這張填', { type: 'button' });
        fb.onclick = () => { fill([r]); setNote('已依「' + r.summary + '」填好，其他申請沒有填進去，確認後按送出核定。'); };
        acts.append(fb);
      }
      if (r.attach_id) acts.append(proofButton(r, row));
      else if (r.has_attach) row.append(h('div', 'du-reqproof', '📎 有附證明（打卡系統還沒更新，暫時打不開）'));
      if (canVoid) {
        const vb = h('button', 'btn sm ghost du-reqvoid', '作廢', { type: 'button' });
        // 伺服器有給 void_ok（個人登入）就照它；沒有（門市登入、舊伺服器）就保守：值班主管本人與自己的單停用（2026-10-29 Fable 審查第 1 條）
        if (r.void_ok === false || (r.void_ok === undefined && (r.upper === true || r.self === true))) { vb.disabled = true; vb.textContent = '送上層處理'; vb.title = '值班主管本人的申請，由上層主管在申請審核處理'; }
        else vb.onclick = () => askVoid(r, vb, row);
        acts.append(vb);
      }
      if (acts.childNodes.length) row.append(acts);
      rbox.append(row);
    });
    rbox.append(note);
    if (reqs.some(r => r.attach_id || r.has_attach) && !nameEl.querySelector('.du-proofmark')) nameEl.append(h('span', 'du-proofmark', '📎', { title: '這天有附證明的申請', 'aria-label': '有附證明' }));
    // 看證明（2026-10-30）：帶 date，營運系統與打卡端都用那天已核准的申請核對（不是待審清單）
    function proofButton(r, row) {
      const b = h('button', 'btn sm ghost du-reqatt', '📎 看證明', { type: 'button' });
      b.onclick = async () => {
        b.disabled = true; b.textContent = '載入中…';
        try {
          const res = await call('line_hub_attach_get', { attach_id: r.attach_id, date, store: emp.store });
          const mime = String(res.mime || ''), data = String(res.data || '');
          if (!data) throw new Error('empty');
          b.remove();
          if (/^image\/(png|jpe?g|gif|webp|heic|heif)$/i.test(mime)) {
            const img = h('img', 'du-rq-img', null, { alt: (emp.name || '') + ' 的申請證明' }); img.src = 'data:' + mime + ';base64,' + data; row.append(img);
          } else {
            const KNOWN = { 'application/pdf': ['pdf', 'PDF'] };
            const k = KNOWN[mime.toLowerCase()];
            const a = h('a', 'du-rq-file', k ? `下載證明（${k[1]}）` : '下載證明（格式無法預覽，下載後用對應的程式開）', { download: 'attachment.' + (k ? k[0] : 'bin') });
            a.href = 'data:' + (k ? mime : 'application/octet-stream') + ';base64,' + data; row.append(a);
          }
        } catch (e) { b.disabled = false; b.textContent = '證明讀不到，再試一次'; }
      };
      return b;
    }
    function askVoid(r, vb, row) {                  // 作廢理由（必填，同仁在 LINE「我的申請」看得到）：就地開輸入框，不用 prompt（嵌入頁的 prompt 不一定能跳）
      if (row.querySelector('.du-voidreason')) return;
      const inp = h('input', 'du-voidreason', null, { type: 'text', maxlength: '100', placeholder: '作廢理由（必填，同仁在 LINE 看得到）', 'aria-label': '作廢理由' });
      const go = h('button', 'btn sm du-voidgo', '確定作廢', { type: 'button' });
      const box2 = h('div', 'du-voidbox'); box2.append(inp, go); row.append(box2); inp.focus();
      go.onclick = async () => {
        const why = inp.value.trim();
        if (!why) return setNote('✕ 作廢要寫理由');
        go.disabled = vb.disabled = true; setNote('作廢中…');
        try {
          await call('mgr_req_void', { id: r.id, reason: why, date, store: emp.store });
          const rest = reqs.filter(q => q.id !== r.id);
          const wasFilled = (card.__lastFilled || []).includes(r.id);      // 作廢的這張剛才有填進畫面
          rbox.remove(); if (tag) { tag.remove(); tag = null; }
          card.__reqApplied = false; card.__lastFilled = [];
          card.__applyReq(rest);
          const stale = wasFilled && !card.__lastFilled.length;           // 剩下的沒有重新填 → 畫面還是作廢那張的內容（2026-10-29 Fable 審查第 5、6 條）
          const done = h('div', 'du-reqbox warn du-voided', '已作廢：' + r.summary + (stale ? '。畫面上已經預填的內容沒有清掉，請確認後再送出核定。' : ''));
          periodRows.parentNode.insertBefore(done, periodRows);
          delete S.dayCache[date];
        } catch (e) { go.disabled = vb.disabled = false; setNote('✕ ' + ((e && e.message) || '沒有成功，請再試一次')); }
      };
    }
    function fill(list) {
      const isOff = offDay && list === fillables;
      card.__lastFilled = list.map(r => r.id).concat(isOff && otP.length ? reqs.filter(r => r.kind === 'ot').map(r => r.id) : []);
      if (isOff && otP.length) {
        periodRows.textContent = '';
        otP.forEach(p => periodRows.append(periodRow(p, refresh)));
        if (!tag) { tag = h('span', 'du-fromreq', '來自加班申請'); periodRows.parentNode.insertBefore(tag, periodRows); }
      }
      const lvFill = C.reqLeaveLines(list);
      list.forEach(r => {
        if (r.kind === 'leave') {
          if (!r.start) { periodRows.textContent = ''; periodRows.append(periodRow(null, refresh)); }
        } else if (r.kind === 'trip') {
          // 整天出差（申請沒填時段、那天也沒打卡）：預設班別清掉，否則班別 8 小時＋出差 8 小時＝16 小時（2026-10-10 Codex 審查，manager.html 同步）
          if (!r.start && !(emp.segments || []).length) { periodRows.textContent = ''; periodRows.append(periodRow(null, refresh)); }
        } else if (r.kind === 'miss') {
          const full = C.missPeriods(emp.segments, r);
          if (full.length) {
            periodRows.textContent = '';
            full.forEach(p => periodRows.append(periodRow(p, refresh)));
            if (!tag) { tag = h('span', 'du-fromreq', '來自申請'); periodRows.parentNode.insertBefore(tag, periodRows); }
          }
        }
      });
      if (lvFill.length) setLeaveLines(lvFill);
      refresh();
      if (readOnly) lockBody();
    }
    const fillable = otP.length > 0 || fillables.length > 0;
    if (!multi && fillable && emp.approved) {
      const b = h('button', 'du-reqfill', '這天已核定過，依申請重新填', { type: 'button' });
      if (readOnly) b.hidden = true;
      b.onclick = () => { fill(fillables); b.remove(); setNote('已依申請填好，確認後按送出核定。'); };
      rbox.insertBefore(b, note);
    } else if (!multi && fillable) fill(fillables);
    periodRows.parentNode.insertBefore(rbox, tag || periodRows);    // 順序：申請說明 → 來自申請 → 時段
  };
  const lockBody = () => body.querySelectorAll('input,select,button').forEach(x => { if (!x.closest('.du-reqbox')) x.disabled = true; });
  if (readOnly) {                                                // 只看：姓名旁「唯讀」小字，內文所有欄位與按鈕鎖住（申請說明框裡的「作廢」另外判斷：能審他申請的人可以作廢）
    nameEl.append(h('span', 'du-ro', '唯讀'));
    lockBody();
  }
  head.onclick = () => setExpanded(body.hidden);
  head.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(body.hidden); } };
  return card;
}
