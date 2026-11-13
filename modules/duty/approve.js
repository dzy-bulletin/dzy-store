// 核定工時：照原系統 ~/mala-clock-in/manager.html 搬。日期列（前一天／後一天／今天）、本月待核定提醒、員工卡（收合展開、時段、
// 核定時數即時算、休息、假別、出差、遲到分鐘）、送出核定。外觀換成營運系統風格，規則與文案不改。
import { confirmBox } from '../../js/ui.js';
import { S, dutyManager, call, callAll, brk, h, failBar, failedStores, loadLeave, staleLeave, leaveFor, rowKey, canWriteRow, canVoidRow, supportTag, rememberOne, snapLabel } from './state.js';
import * as C from './calc.js';
import { qrButton } from './qr.js';
import { api } from '../../js/api.js';
import { comparePlan } from '../schedule/compare.js';
import { ssoSwitch, setSession, toSession } from '../../js/auth.js';
import { quickWanted, quickAvailable, renderQuick, backBar } from './quick.js';
import { canBg, watchJob, refreshJobs, rejectBar } from './bg.js';

export function renderApprove(ctx) {
  if (quickWanted(ctx)) return renderQuick(ctx);      // 手機寬度：預設用「一頁核定」（quick.js）；完整頁是退路
  const el = ctx.el;
  el.innerHTML = `<div id="duQrSlot"></div><div class="du-datebar"><button type="button" class="btn ghost du-nav" id="duPrev" aria-label="前一天">‹</button>
    <input type="date" id="duDate" aria-label="日期"><button type="button" class="btn ghost du-nav" id="duNext" aria-label="後一天">›</button>
    <button type="button" class="btn ghost" id="duToday">今天</button></div>
    <div id="duBg"></div><div id="duRet"></div><div id="duPend"></div><div id="duDayBox"></div>`;
  const dateIn = el.querySelector('#duDate'), pendEl = el.querySelector('#duPend'), box = el.querySelector('#duDayBox'), retEl = el.querySelector('#duRet');
  const live = () => el.isConnected;
  if (quickAvailable(ctx)) el.insertBefore(backBar(ctx), el.firstChild);      // 手機的完整頁：上面一顆「回到一頁核定」
  if (dutyManager(ctx.session) && !S.all) el.querySelector('#duQrSlot').append(qrButton(el));      // 打卡 QR（同仁定位抓不到時給他掃），日期列上方
  // 考勤副本（2026-11-14）：背景送出被打卡系統退回的，列在最上面；點了跳到那天那位
  el.querySelector('#duBg').append(rejectBar((date, empId) => { S.focusEmp = rowKey({ emp_id: empId }); delete S.dayCache[date]; loadDay(date); }));
  refreshJobs();

  // ---------- 本月待核定提醒（manager.html:1604–1745）：沒有待核定＝整塊不畫 ----------
  function loadPending() {
    (S.all ? callAll('mgr_pending_approvals') : call('mgr_pending_approvals')).then(r => { if (!live()) return; S.pend = Array.isArray(r.items) ? r.items : []; S.pendFailed = r.failed || []; drawPending(); },
      e => { if (live()) failBar(pendEl, '本月待核定提醒', e, loadPending); });
  }
  function drawPending() {
    pendEl.innerHTML = '';
    const items = S.pend || [];
    failedStores(pendEl, S.pendFailed, loadPending);
    if (!items.length) return;
    // 天數只算核得了的（2026-11-10）：那天全部是只能看的人（督導看區內門市、原單位主管看支援帳號…）不是你的待辦，
    // 不算天數、列在最後面。首頁待辦是同一個算法（calc.js pendGroups），兩邊的天數才對得起來
    const { mine, ro } = C.pendGroups(items, it => canWriteRow('hours', it.emp_id, it.store));
    const groups = mine.concat(ro);
    const card = h('div', 'du-pa');
    card.append(h('div', 'du-pa-title', mine.length ? '本月還有 ' + mine.length + ' 天沒核定' : '本月沒有要你核定的日子'));
    if (mine.length) card.append(h('div', 'du-pa-sub', '點名字直接跳到那天核定'));
    const shown = S.pendAll ? groups : groups.slice(0, 5);
    const roNote = () => h('div', 'du-pa-ronote', mine.length ? '另有 ' + ro.length + ' 天只能看，不算在上面的天數裡' : '以下 ' + ro.length + ' 天只能看（不是你要核定的）');
    shown.forEach(g => {
      if (ro.length && g === ro[0]) card.append(roNote());
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
    if (ro.length && shown.indexOf(ro[0]) < 0) card.append(roNote());      // 只能看的日子都還收在「再顯示」裡：這行提示照樣要看得到
    if (!S.pendAll && groups.length > 5) {
      const more = h('button', 'du-more', '再顯示 ' + (groups.length - 5) + ' 天', { type: 'button' });
      more.onclick = () => { S.pendAll = true; drawPending(); };
      card.append(more);
    }
    pendEl.append(card);
  }
  // ---------- 人資退回待重核（2026-11-13，管理系統 docs/att-void-hr/return-spec.md）：沒有就整塊不畫 ----------
  function loadReturns() {
    (S.all ? callAll('hr_return_list') : call('hr_return_list')).then(r => { if (live()) drawReturns(Array.isArray(r.items) ? r.items : []); }, () => { if (live()) retEl.innerHTML = ''; });
  }
  function drawReturns(items) {
    retEl.innerHTML = '';
    if (!items.length) return;
    const card = h('div', 'du-pa du-hrret-list');
    card.append(h('div', 'du-pa-title', '人資退回 ' + items.length + ' 筆，請重新核定'));
    card.append(h('div', 'du-pa-sub', '點名字跳到那天，核對後重新送出核定就結案；原本的核定在重核前照舊算'));
    items.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))).forEach(it => {
      const row = h('div', 'du-pa-group');
      row.append(h('div', 'du-pa-date', C.weekdayLabel(it.date)));
      const right = h('div', 'du-hrret-item');
      const chip = h('button', 'du-chip', (it.emp_name || it.emp_id) + (it.storeName ? '・' + it.storeName : ''), { type: 'button' });
      chip.onclick = () => { S.focusEmp = rowKey(it); loadDay(it.date); };
      right.append(chip, h('div', 'du-hrret-why', '理由：' + it.reason + '（' + it.by_name + '）' + (it.lock_unknown ? '　⚠ 退回時沒辦法確認薪資有沒有鎖定' : '')));
      if (it.can_cancel) {
        const cb = h('button', 'btn sm ghost du-hrret-cancel', '取消退回', { type: 'button' });
        cb.onclick = () => { cb.disabled = true; call('hr_return_cancel', { id: it.id, store: it.store }).then(() => { delete S.dayCache[it.date]; loadReturns(); if (S.date === it.date) loadDay(it.date); }, e => { cb.disabled = false; cb.textContent = '✕ ' + (e.message || '取消失敗'); }); };
        right.append(cb);
      }
      row.append(right); card.append(row);
    });
    retEl.append(card);
  }
  box.addEventListener('hr-returned', () => loadReturns());
  box.addEventListener('duty-reload-day', e => { const d = e.detail || {}; S.focusEmp = rowKey(d.emp); delete S.dayCache[d.date]; loadDay(d.date); });   // 背景送出被退回：重新載入那天
  // 核定成功後即時從提醒移除（不必重打後端）
  box.addEventListener('emp-approved', e => {
    loadReturns();      // 重核後人資退回就結案（伺服器做），清單重讀
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
  // gate＝要等它到了才畫卡片的東西（假別額度）：跟名單同時抓，不再先抓完額度才去抓名單（2026-11-02 Eason：考勤每點一下都要等很久）
  function loadDay(dateOverride, gate) {
    const tok = ++S.dayTok;
    // 假別額度被清掉（核定過請假）時先重抓，再畫名單：不然新卡片拿不到額度，額度與期限的硬擋整批失效（2026-10-12 Codex 審查）
    if (S.leaveStale) { S.leaveStale = false; gate = loadLeave(); }
    loadDayNow(dateOverride, tok, gate);
  }
  function loadDayNow(dateOverride, tok, gate) {
    unStale();                     // 上一次的「先顯示上次」還沒換掉就換日期：先解除
    const wait = gate ? gate.then(() => null, () => null) : Promise.resolve(null);
    S.dayMirrorAt = 0;
    if (dateOverride && S.dayCache[dateOverride]) {
      wait.then(() => { if (tok === S.dayTok && live()) { drawDay(dateOverride, S.dayCache[dateOverride], []); prefetch(dateOverride); } });
      return;
    }
    const want = dateOverride || C.taipeiToday();
    // 那天已核准的申請跟名單同時抓（原本等名單回來才抓）
    const reqBody = { date: want };
    S.reqPre = { date: want, all: S.all, p: S.all ? callAll('mgr_req_day', reqBody) : call('mgr_req_day', reqBody) };
    S.reqPre.p.catch(() => {});
    // 今天、昨天不快取（跨夜班），但上次看到的先秀出來、灰掉不能按，新的到了再換上（2026-11-02）
    const stale = !gate && S.recent[want];
    if (stale) { drawDay(want, stale, [], true); markStale(); }
    else box.innerHTML = '<div class="card du-center" id="duLoading">載入中…</div>';
    // Mac mini 記得的上次資料先顯示（2026-11-10 Eason）：灰色不能按，最新資料到了就換掉；這次打開頁面已經看過的（stale）優先
    let fresh = false, peekAt = 0;
    if (!stale) dayRead({ date: want, peek: true }).then(r => {
      if (fresh || tok !== S.dayTok || !live() || !r || !r.snapshot_at || !Array.isArray(r.employees)) return;
      peekAt = r.snapshot_at;
      drawDay(want, r.employees, [], true);
      markStale('這是' + snapLabel(peekAt) + '的資料，正在讀取最新資料，讀到後就可以核定…');
    }, () => {});
    const body = dateOverride ? { date: dateOverride } : {};
    let gateDone = !gate;                 // 假別額度還沒到：名單先畫出來看，但不能按（2026-11-09 Eason：考勤選店後等太久）
    if (gate) wait.then(() => { gateDone = true; });
    dayRead(body).then(r => {
      fresh = true;
      if (tok !== S.dayTok || !live()) return;
      unStale();
      S.dayMirrorAt = r.mirror_at || 0;      // 考勤副本讀的：卡片上方標「資料更新於」
      const failed = r.failed || [];          // 單一門市也可能有：總部那組併進來的別家讀不到（不快取、顯示提示）
      if (!S.all) S.elsewhere = Array.isArray(r.elsewhere) ? r.elsewhere : [];      // 捷徑卡（歸屬這組、在別家打卡的人）不隨日期變，快取的日子沿用
      if (!failed.length) { if (cacheable(r.date)) S.dayCache[r.date] = r.employees; else S.recent[r.date] = r.employees; }
      if (!gateDone) { drawDay(r.date, r.employees, failed, true); markStale('假別額度還在讀取，讀到後就可以核定…'); }
      return wait.then(() => {            // 卡片的假別清單與額度檢查要用額度：到了才重畫成可操作的卡片，額度硬擋不會被繞過
        if (tok !== S.dayTok || !live()) return;
        unStale();
        drawDay(r.date, r.employees, failed); prefetch(r.date);
      });
    }, e => {
      fresh = true;
      if (tok !== S.dayTok || !live()) return;
      unStale();
      const c = h('div', 'card');
      if (peekAt) {                        // 讀不到最新的：舊資料留著看，仍然不能按；重新載入鈕放在外面才按得到
        const note = box.querySelector('#duStale');
        if (note) note.textContent = '讀不到最新資料，下面是' + snapLabel(peekAt) + '的舊資料，不能核定';
        const old = h('div', 'du-stale'); old.inert = true; old.append(...box.childNodes);
        box.append(c, old);
      } else { box.innerHTML = ''; box.append(c); }
      failBar(c, '這天的名單', e, () => loadDay(dateOverride));
    });
  }
  function unStale() { box.classList.remove('du-stale'); box.inert = false; box.removeAttribute('aria-busy'); }
  function markStale(text) {
    box.classList.add('du-stale'); box.inert = true; box.setAttribute('aria-busy', 'true');   // inert：鍵盤也按不到（2026-11-02 審查）
    box.prepend(h('div', 'du-stale-note', text || '先顯示上次看到的資料，正在更新…', { id: 'duStale' }));
  }
  function drawDay(date, employees, failed, quick) {
    S.date = date; dateIn.value = date;
    const focus = S.focusEmp;
    renderEmployees(box, date, employees, failed, () => { loadPending(); loadDay(date); });
    if (quick) { S.focusEmp = focus; return; }
    if (S.dayMirrorAt) box.prepend(h('div', 'du-mirror-at', '資料更新於 ' + snapLabel(S.dayMirrorAt) + '・從 Mac mini 讀取', { id: 'duMirrorAt' }));   // 先秀上次的資料：申請、班表等新資料到了再一起套；待核定提醒點的那位留給新資料打開
    applyDayRequests(date);
    applyDayPlan(date);
  }
  // 自動排班的班表（2026-10-11）：每人加一行「班表：早班 10:00–19:00」，打卡跟班表差達 15 分鐘（含剛好 15 分鐘，2026-11-10）標橘色。只提示，不擋核定。
  // 這家店沒開自動排班、或讀不到，就安靜略過。
  function applyDayPlan(date) {
    if (S.all || !((ctx.session && ctx.session.features) || []).includes('schedule')) return;      // 全部門市：班表比對只在單一門市（各店班表要各自讀，暫不合併）
    const tok = S.dayTok;
    api('POST', '/m/schedule/dayPlan', S.asStore ? { date, store: S.asStore } : { date }, undefined, { read: true }).then(res => {   // 管理者代看：讀該店的班表
      if (tok !== S.dayTok || S.date !== date || !live() || !res || !res.plan) return;
      const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);   // 台北今天
      box.querySelectorAll('.du-card').forEach(card => {
        if (card.dataset.store) return;      // 總部併組進來的別家：dayPlan 只有本店班表，比對會誤標「沒排班卻有打卡」（班表已由 mgr_day 帶在姓名旁）
        const r = comparePlan(res.plan[card.dataset.empId], card.__segments, { past: date <= today, brk: brk(card.dataset.store) });
        if (!r || !card.__showPlan) return;
        card.__showPlan(r);
      });
    }, () => {});
  }
  // 那天已核准的加班請假／忘打卡申請 → 對應同仁卡片顯示並預填（不快取：主管剛核准完切過來要看得到）。讀完前整塊鎖住，讀不到就停用送出並給重試：否則已核准的整天假可能被照班表核成上班（2026-11-10 Eason 選）。
  function applyDayRequests(date) {
    const tok = S.dayTok;
    const put = (store, byEmp) => Object.keys(byEmp || {}).forEach(id => {
      const key = rowKey({ store, emp_id: id });
      const card = [].filter.call(box.querySelectorAll('.du-card'), c => c.dataset.empId === key)[0];
      if (card && card.__applyReq) card.__applyReq(byEmp[id]);
    });
    const pre = S.reqPre && S.reqPre.date === date && S.reqPre.all === S.all ? S.reqPre.p : null;   // 跟名單同時送出的那一次
    S.reqPre = null;
    markStale('已核准的申請讀取中，讀到後就可以核定…');
    const current = () => tok === S.dayTok && S.date === date && live();
    const unlock = () => { unStale(); const n = box.querySelector('#duStale'); if (n) n.remove(); };      // 畫面沒有重畫，提示要自己拿掉
    // failed＝只有這幾家讀不到（全部門市、總部併組），其他店照常；沒傳＝整份讀不到
    const block = failed => {
      const prefixes = failed ? failed.map(f => f.store + '|') : null;
      [].forEach.call(box.querySelectorAll('.du-card'), c => {
        if (prefixes && !prefixes.some(x => c.dataset.empId.startsWith(x))) return;
        const b = c.querySelector('.du-submit');
        if (b) { b.disabled = true; b.title = '已核准的申請讀不到，重新載入後才能送出'; }
      });
      const bar = h('div', 'du-fail', null, { id: 'duReqFail' });
      bar.append(h('span', 'du-fail-msg', (failed ? failed.map(f => f.storeName).join('、') + '的' : '') + '已核准申請讀不到，為了避免算錯工時，暫時不能送出核定'));
      const again = h('button', 'btn sm ghost', '重新載入', { type: 'button' });
      again.onclick = () => { again.disabled = true; again.textContent = '載入中…'; loadDay(date); };
      bar.append(again);
      box.prepend(bar);
    };
    // 全部門市：by_store[店].by_emp，各店的 emp_id 分開對（同號員編不會對錯人）
    (pre || (S.all ? callAll('mgr_req_day', { date }) : call('mgr_req_day', { date }))).then(res => {
      if (!current()) return;
      unlock();
      if (!res || !(S.all ? res.by_store : res.by_emp)) return block();
      if (!S.all) put('', res.by_emp);
      Object.keys(res.by_store || {}).forEach(st => put(st, res.by_store[st] && res.by_store[st].by_emp));      // 全部門市各店；單一門市時是總部那組併進來的別家
      if (Array.isArray(res.failed) && res.failed.length) block(res.failed);
    }, () => { if (current()) { unlock(); block(); } });
  }

  dateIn.onchange = () => { if (dateIn.value) loadDay(dateIn.value); };
  el.querySelector('#duPrev').onclick = () => { if (S.date) loadDay(C.addDaysStr(S.date, -1)); };
  el.querySelector('#duNext').onclick = () => { if (S.date) loadDay(C.addDaysStr(S.date, 1)); };
  el.querySelector('#duToday').onclick = () => loadDay(null);

  if (S.pend) drawPending();
  loadPending();
  loadReturns();
  // 假別清單與額度要在畫員工卡之前到（原頁也是先 loadLeaveOptions 再 loadDay；2026-11-02 起兩個同時抓、都到了才畫）；失敗不擋人，退回內建清單
  loadDay(S.date, S.leave ? null : loadLeave());
}

function renderEmployees(box, date, employees, failed, retry) {
  box.innerHTML = '';
  failedStores(box, failed, retry);
  if (!S.all && S.elsewhere && S.elsewhere.length) box.append(elsewhereCards(S.elsewhere));
  if (!employees || !employees.length) { box.append(h('div', 'card du-center', failed && failed.length ? '讀得到的門市這天沒有任何同仁打卡紀錄。' : '這天沒有任何同仁打卡紀錄。')); return; }
  const bar = h('div', 'du-listbar');
  const count = h('span', 'du-count');
  const toggleAll = h('button', 'btn sm ghost', '全部展開', { type: 'button', id: 'duToggleAll' });
  let allOpen = false;
  toggleAll.onclick = () => { allOpen = !allOpen; toggleAll.textContent = allOpen ? '全部收合' : '全部展開'; list.querySelectorAll('.du-card').forEach(c => c.__setExpanded(allOpen)); };
  bar.append(count, toggleAll);
  const list = h('div', 'du-list');
  box.append(bar, list);
  // 排序（2026-11-04 Eason）：待核定在最上面、已核定其次、未出勤（還沒核定）放最下面，同組照原順序；只在畫面時排一次，核完不跳位置
  const rank = c => c.__pending && !c.__absent ? 0 : (c.__pending ? 2 : 1);
  employees.map(emp => buildCard(emp, date)).map((c, i) => [rank(c), i, c]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).forEach(x => list.append(x[2]));
  // 待核定人數不算「未出勤」（沒打卡也沒排上班）的人（2026-11-02 Eason）
  const pendingLeft = () => [].filter.call(list.querySelectorAll('.du-card'), c => c.__pending && !c.__absent).length;
  count.innerHTML = '共 ' + employees.length + ' 人・待核定 <b>' + pendingLeft() + '</b> 人';

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
    count.innerHTML = '共 ' + employees.length + ' 人・待核定 <b>' + pendingLeft() + '</b> 人';
  });
}

// 捷徑卡（2026-11-01 Eason 選 A）：歸屬這組、但在別家店打卡的人（例：財務部同仁固定在央廚打卡，總部那組也看得到她）。
// 資料只有一份，在打卡那家核；按鈕換店過去（同「換店」：換新 token、整頁重載）
function elsewhereCards(list) {
  const wrap = h('div', 'du-else');
  list.forEach(x => {
    const card = h('div', 'du-card du-else-card');
    card.dataset.elseEmp = String(x.emp_id); card.dataset.elseStore = String(x.store);
    const nameEl = h('div', 'du-name', x.name);
    if (x.home_tag) nameEl.append(h('span', 'du-support du-home', x.home_tag, { 'data-home': x.home_tag }));
    const btn = h('button', 'btn sm', '前往' + x.storeName + '核定', { type: 'button' });
    const err = h('div', 'du-fail-msg');
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = '切換中…'; err.textContent = '';
      try { const d = await ssoSwitch(x.store); setSession(toSession(d)); rememberOne(d.token); location.hash = '#/duty/approve'; location.reload(); }
      catch (e) { btn.disabled = false; btn.textContent = '前往' + x.storeName + '核定'; err.textContent = '換店失敗：' + ((e && e.message) || '請稍後再試'); }
    };
    card.append(nameEl, h('div', 'du-else-hint', '在' + x.storeName + '打卡，工時請到那邊核定'), btn, err);
    wrap.append(card);
  });
  return wrap;
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
  const hasPunch = !!(emp.segments && emp.segments.length) || emp.attempts > 0;
  const absent = !hasPunch && pv.mode !== 'plan';                     // 沒打卡、也沒排上班（例假／休息／沒班表）：右側寫「未出勤」不寫「待核定」（2026-11-02 Eason）

  // ---- 頭部（收合時看得到：姓名、班別、打卡摘要、精簡徽章）----
  const nameEl = h('div', 'du-name', emp.name);
  const sup = supportTag(emp); if (sup) nameEl.append(sup);      // 支援（原單位）：別單位來這家店支援的同仁
  if (emp.store) nameEl.append(h('span', 'du-where', '打卡地點：' + emp.storeName, { 'data-where': emp.store }));      // 全部門市：這個人在哪一家店打的卡（同一人同一天在多家打卡會依店分列）
  if (pv.text) nameEl.append(h('span', 'du-shift' + (pv.mode === 'off' ? ' off' : ''), pv.text, { 'data-mode': pv.mode }));
  const punchEl = h('div', 'du-punch');
  if (emp.segments && emp.segments.length) {
    const ref = (emp.reference === null || emp.reference === undefined) ? '參考 —' : '參考 ' + emp.reference + ' 小時';   // 忘刷卡整天 reference=null，不可印成 "null"
    const dupIgn = (emp.approved && emp.approved.dup_ignore) || [];  // 已認定重複的卡：打卡段已由打卡後端拿掉，這裡註明是哪幾張（2026-11-06）
    const dupNote = dupIgn.length ? '（' + dupIgn.map(t => String(t).slice(11, 16)).sort().join('、') + ' 重複）' : '';
    punchEl.textContent = '打卡：' + emp.segments.map(C.segmentText).join('、') + dupNote + '　' + ref;
  } else if (emp.attempts > 0) punchEl.textContent = '今天沒有入帳的打卡（有 ' + emp.attempts + ' 筆未入帳嘗試）';
  else punchEl.textContent = '今天沒有打卡紀錄';
  const mini = h('span', 'du-mini'), chev = h('span', 'du-chev', '▼');
  const head = h('div', 'du-head', null, { role: 'button', tabindex: '0', 'aria-expanded': 'false' });
  const hmain = h('div', 'du-hmain'); hmain.append(nameEl, punchEl);
  head.append(hmain, mini, chev);
  let planDone = !!emp.approved;                              // 已核定：不再顯示跟班表比的晚到早退（2026-11-10 Eason：主管會以為已經扣了；薪資照核定時段算）
  card.__showPlan = (r) => {                                  // 自動排班比對（只提示）
    card.__planR = r;
    const old = hmain.querySelector('.du-plan'); if (old) old.remove();
    const top = pv.mode === 'plan' || pv.mode === 'off';      // 名字旁已經寫了班表 → 這行只留提醒、沒提醒就不畫（2026-11-03 Eason：班表不要顯示兩次）
    const flags = planDone ? [] : r.flags;
    if (top && !flags.length) return;
    const line = h('div', 'du-plan', top ? null : r.text);
    flags.forEach(f => line.append(h('span', 'du-planflag', f)));
    hmain.append(line);
  };
  const body = h('div', 'du-body'); body.hidden = true;
  card.append(head, body);

  // ---- 人資退回待重核（2026-11-13）：店長看到理由；人資（return_ok）可以退回已核定的這天 ----
  if (emp.hr_return) {
    nameEl.append(h('span', 'du-hrret-tag', '人資退回'));
    body.append(h('div', 'du-hrret', '人資退回待重核：' + emp.hr_return.reason + '（' + emp.hr_return.by_name + '）。請核對後重新送出核定，送出就結案。'));
  } else if (emp.return_ok) {
    const rb = h('div', 'du-hrret-box');
    const btn = h('button', 'btn sm ghost du-hrretbtn', '退回給店長重核', { type: 'button' });
    btn.onclick = () => {
      btn.hidden = true;
      const inp = h('input', 'du-voidreason', null, { type: 'text', maxlength: '200', placeholder: '退回理由（必填，店長看得到，同仁看不到）', 'aria-label': '退回理由' });
      const go = h('button', 'btn sm du-hrretgo', '確定退回', { type: 'button' });
      const msg = h('div', 'du-reqnote');
      go.onclick = () => {
        const why = inp.value.trim();
        if (!why) { msg.textContent = '✕ 退回要寫理由'; return; }
        go.disabled = true; msg.textContent = '送出中…';
        call('hr_return_create', { store: emp.store, emp_id: emp.emp_id, date, reason: why }).then(r => {
          delete S.dayCache[date];
          rb.replaceChildren(h('div', 'du-hrret', '已退回給店長重核：' + why + (r && r.lock_unknown ? '（沒辦法確認這個月薪資有沒有鎖定，請自己確認）' : '')));
          card.dispatchEvent(new CustomEvent('hr-returned', { bubbles: true }));
        }, e => { go.disabled = false; msg.textContent = '✕ ' + (e.message || '退回失敗'); });
      };
      rb.append(inp, go, msg);
      inp.focus();
    };
    rb.append(btn);
    body.append(rb);
  }

  // ---- 防呆：有打卡段還沒配對（有上班沒下班），現在核定會核不到那段（manager.html:1003–1012）----
  const dupGroups = emp.dup_groups || [];                     // 重複打卡（2026-11-06）：重複上班卡組前面那張配不到下班卡不是「還在上班」
  const hasOpenSeg = C.hasOpenSegExceptDup(emp.segments, dupGroups);
  if (hasOpenSeg) body.append(h('div', 'du-openwarn', '⚠ 有打卡段還沒打下班卡（可能還在上班或跨夜還沒打完），現在核定會核不到這段、且之後補打卡也不會自動更新。請同仁立即打卡避免忘刷卡。'));

  // ---- 重複打卡：同一天同型兩張卡相隔 60 分鐘內，店長選以哪張為準（2026-11-06 Eason）。不選＝照系統原判定（算 1 次忘刷），不擋送出 ----
  const dupPicks = C.dupInitialPicks(dupGroups, emp.approved && emp.approved.dup_ignore);
  dupGroups.forEach((g, gi) => {
    const box = h('div', 'du-dupbox');
    box.append(h('div', 'du-duptitle', '⧉ ' + C.dupGroupTitle(g)),
      h('div', 'du-duphint', '如果是重複打卡，選一張為準；另一張不算忘刷卡，遲到也照選的那張比。不選＝照系統原判定（算 1 次忘刷）。'));
    const opts = h('div', 'du-dupopts');
    const btns = [{ ts: '', label: '不處理' }].concat(g.cards.map(c => ({ ts: c.ts, label: '以 ' + c.hm + ' 為準' }))).map(o => {
      const b = h('button', 'btn sm ghost du-dupopt', o.label, { type: 'button', 'data-ts': o.ts });
      b.disabled = readOnly;
      b.onclick = () => { dupPicks[gi] = o.ts; paint(); };
      opts.append(b); return b;
    });
    function paint() { btns.forEach(b => { const on = b.dataset.ts === dupPicks[gi]; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }); }
    paint();
    box.append(opts);
    body.append(box);
  });

  // ---- 狀態徽章：核定成功後當場翻成「已核定」----
  const badge = h('div', 'du-badge');
  let badgeNow = null;      // 申請單比卡片晚到、作廢後也要重算顏色
  function setBadge(approved, leaves) {
    badgeNow = { approved, leaves };
    if (approved) {
      const cls = C.badgeClass(approved.status_text, { approvedHours: approved.approved_hours, periods: approved.periods, leaves, reqs: card.__dayReqs });
      badge.className = 'du-badge ' + cls;
      badge.textContent = '已核定 ' + approved.approved_hours + ' 小時・' + approved.status_text + C.leavesSuffix(leaves) + '（' + approved.manager_name + '）';
      mini.className = 'du-mini ' + cls; mini.textContent = '✓ ' + approved.approved_hours + ' 小時';
    } else if (absent) { badge.className = 'du-badge absent'; badge.textContent = '未出勤'; mini.className = 'du-mini absent'; mini.textContent = '未出勤'; }
    else { badge.className = 'du-badge pending'; badge.textContent = '待核定'; mini.className = 'du-mini pending'; mini.textContent = '待核定'; }
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
      const over = total + th > C.DAY_MAX_H;        // 照實核定、只標紅（光復每天 09:00 列進通知匣）
      totalBox.classList.toggle('over', over);
      if (over) totalBox.append(h('div', 'du-total-over', '超過一天 ' + C.DAY_MAX_H + ' 小時上限（照實核定，會列進每日通知）'));
      const cw = C.contBreakWarn(rows);             // 連續 4 小時沒休 30 分（2026-11-06）：黃字、不擋
      if (cw) totalBox.append(h('div', 'du-total-cont', C.contBreakText(cw)));
    } else totalBox.classList.remove('over');
    const f8 = C.ft8Summary(emp, total, leaveList());   // 正職上班日滿 8 小時（2026-11-13）：整天請假沒有時段也要顯示
    if (f8) { totalBox.hidden = false; totalBox.append(h('div', 'du-ft8' + (f8.gap ? ' short' : ''), C.ft8Text(f8))); }
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
  // 規則 4（2026-11-16 起）：核定和打卡差 30 分鐘以上要填原因；伺服器說要填才打開，重新核定帶回上次的原因
  const diffBox = h('div', 'du-proxy du-diffbox');
  const diffIn = h('input', 'du-diff-in', null, { type: 'text', maxlength: '100', placeholder: '核定和打卡不同的原因（必填）', 'aria-label': '核定和打卡不同的原因' });
  diffBox.append(h('div', 'du-proxy-lead', '核定和打卡差 30 分鐘以上，要寫原因才能送出。原因會留在核定紀錄。'), diffIn);
  const prevDiff = emp.approved && emp.approved.diff_reason ? String(emp.approved.diff_reason) : '';
  diffIn.value = prevDiff; diffBox.hidden = !prevDiff;
  if (readOnly) diffIn.disabled = true;
  body.append(diffBox, actions, result);
  const say = (cls, text) => { result.className = 'du-result ' + cls; result.hidden = false; result.textContent = text; };
  /* 超過幾天同仁自己補不了單、才給代開（同打卡端 Requests.gs reqPastLimit_，2026-11-14 Eason）：
     請假／加班／出差 4 天；11/28 以前 11 月的日子同仁都能自己補，這段期間照忘打卡的 7 天才出現代開（打卡端會再判，沒到期限回「請同仁自己申請」）。 */
  const proxyAfterDays = () => (C.taipeiToday() <= '2026-11-28' ? 7 : 4);
  // 主管代開加班／忘打卡單（2026-11-06 核定綁定申請單）：核定被擋「缺單」、而且那天超過 7 天（同仁自己補不了）才出現；送總監層級審
  let proxyBox = null;
  const proxyForm = (d, noLine, why0) => {
    if (proxyBox) proxyBox.remove();
    proxyBox = h('div', 'du-proxy');
    const kind = h('select', 'du-proxy-kind'); [['ot', '加班單'], ['miss', '忘打卡單'], ['leave', '假單'], ['trip', '出差單']].forEach(([v, t]) => kind.append(h('option', null, t, { value: v })));
    const mt = h('select', 'du-proxy-mt'); [['out', '補下班卡'], ['in', '補上班卡'], ['both', '補上班＋下班'], ['break', '補中間休息（下班＋回來上班）']].forEach(([v, t]) => mt.append(h('option', null, t, { value: v })));
    const a = h('input', 'du-proxy-a', null, { type: 'time' }), b = h('input', 'du-proxy-b', null, { type: 'time' });
    const lt = h('select', 'du-proxy-lt', null, { 'aria-label': '假別' });
    const firstLeave = body.querySelector('.du-leave');
    [...(firstLeave ? firstLeave.options : [])].filter(o => o.value && o.value !== '出差').forEach(o => lt.append(h('option', null, o.value, { value: o.value })));
    const hr = h('input', 'du-proxy-h', null, { type: 'number', step: '0.25', min: '0.25', max: '24', placeholder: '時數', 'aria-label': '時數' });
    const pl = h('input', 'du-proxy-pl', null, { type: 'text', maxlength: '40', placeholder: '出差地點', 'aria-label': '出差地點' });
    const la = h('span', 'du-proxy-la'), lb = h('span', 'du-proxy-lb');
    const why = h('input', 'du-proxy-why', null, { type: 'text', maxlength: '100', placeholder: '原因（必填）' });
    const go = h('button', 'btn', '送出代開（送總監層級審核）', { type: 'button' });
    const sync = () => {
      const k = kind.value, ot = k === 'ot', miss = k === 'miss', m = mt.value;
      mt.hidden = !miss; lt.hidden = k !== 'leave'; hr.hidden = k !== 'leave' && k !== 'trip'; pl.hidden = k !== 'trip';
      la.textContent = ot ? '加班開始' : m === 'break' ? '回來上班' : '實際上班';
      lb.textContent = ot ? '加班結束' : m === 'break' ? '休息開始（下班）' : '實際下班';
      la.hidden = a.hidden = !(ot || miss) || (miss && m === 'out');
      lb.hidden = b.hidden = !(ot || miss) || (miss && m === 'in');
    };
    // 被擋的原因是正職上班日不滿 8 小時（2026-11-13）：先選好假單、補休、還差的時數（往上取到半小時）
    const gapM = /正職上班日要滿 8 小時[^。]*?還差 ([\d.]+) 小時/.exec(String(why0 || ''));
    if (gapM) {
      kind.value = 'leave';
      if ([...lt.options].some(o => o.value === '補休')) lt.value = '補休';
      hr.value = String(C.ft8Round(Number(gapM[1])));
    }
    kind.onchange = mt.onchange = sync; sync();
    go.onclick = async () => {
      const k = kind.value;
      const p = { store: emp.store, emp_id: emp.emp_id, date: d, kind: k, reason: why.value.trim() };
      if (k === 'miss') p.miss_type = mt.value;
      if (k === 'leave') { if (!lt.value) { say('bad', '✕ 請選假別'); return; } p.leave_type = lt.value; }
      if (k === 'leave' || k === 'trip') { if (!(Number(hr.value) > 0)) { say('bad', '✕ 請填時數'); return; } p.hours = Number(hr.value); }
      if (k === 'trip') { if (!pl.value.trim()) { say('bad', '✕ 請填出差地點'); return; } p.place = pl.value.trim(); p.why = p.reason; }
      if (!a.hidden) p.start = a.value;
      if (!b.hidden) p.end = b.value;
      if ((!a.hidden && !a.value) || (!b.hidden && !b.value)) { say('bad', '✕ 請填時間'); return; }
      if (!p.reason) { say('bad', '✕ 代開要寫原因'); return; }
      go.disabled = true; go.textContent = '送出中…';
      try {
        const res = await call('mgr_req_proxy', p);
        say('ok', '✓ 已代開：' + res.summary + '。等總監層級在「申請審核」核准後，再回來送出核定。還缺別張單的話，再按一次「送出核定」就能繼續代開。' + (k === 'leave' ? '需要附證明的假別，請同仁在 LINE「我的申請」補附。' : ''));
        proxyBox.remove(); proxyBox = null;
      } catch (e) { say('bad', '✕ 代開失敗：' + e.message); go.disabled = false; go.textContent = '送出代開（送總監層級審核）'; }
    };
    proxyBox.append(h('div', 'du-proxy-lead', (noLine ? '這位同仁沒綁 LINE，自己補不了單。' : '這天已超過 ' + proxyAfterDays() + ' 天，同仁自己補不了單。') + '可以替同仁代開，代開的單要由總監層級（品牌總監／廚藝總監；總部是人資主管）核准。'),
      h('div', 'du-proxy-row', null), why, go);
    proxyBox.children[1].append(kind, mt, lt, hr, pl, la, a, lb, b);
    result.after(proxyBox);
  };

  // 背景送出（考勤副本）：先標「已核定・送出中」，可以繼續核下一位；打卡系統接受了換成正式結果，退回就標紅、請重新載入這天
  function bgQueued(job, approveDate, lv) {
    if (lv.length || initLeaves.length) staleLeave();
    badge.className = 'du-badge sending'; badge.hidden = false; badge.textContent = '已核定・送出中（背景送到打卡系統）';
    mini.className = 'du-mini sending'; mini.textContent = '送出中';
    say('ok', '✓ 已核定，正在背景送到打卡系統，可以繼續核下一位');
    card.__pending = false;
    planDone = true; if (card.__planR) card.__showPlan(card.__planR);
    card.dispatchEvent(new CustomEvent('emp-approved', { bubbles: true, detail: { emp_id: emp.emp_id, date: approveDate, store: emp.store } }));
    watchJob(job, it => {
      if (!card.isConnected) return;
      if (it.state === 'done') {
        const r = it.result;
        if (r && r.approved_hours !== undefined) { setBadge(r, C.leavesOf(r)); say('ok', '✓ 已核定 ' + r.approved_hours + ' 小時・' + r.status_text + C.leavesSuffix(C.leavesOf(r)) + '（' + r.manager_name + '）'); }
        else { badge.className = 'du-badge normal'; badge.textContent = '已核定（已送到打卡系統）'; mini.className = 'du-mini normal'; mini.textContent = '✓ 已核定'; say('ok', '✓ 已送到打卡系統'); }
        return;
      }
      card.__pending = true;
      if (card.__setExpanded) card.__setExpanded(true);      // 核完已經收起來：被退回要打開給主管看原因
      badge.className = 'du-badge bad'; badge.hidden = false; badge.textContent = '被退回：' + (it.msg || '請重新核定');
      mini.className = 'du-mini bad'; mini.textContent = '被退回';
      say('bad', '✕ 被退回：' + (it.msg || '請重新核定'));
      const rb = h('button', 'btn sm du-bgreload', '重新載入這天', { type: 'button' });
      rb.onclick = () => card.dispatchEvent(new CustomEvent('duty-reload-day', { bubbles: true, detail: { date: approveDate, emp } }));
      result.append(rb);
    });
  }

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
      // 補休：只擋計時同仁（2026-11-01 起可以先休後補，不看餘額；同一天重送原本的補休紀錄放行）
      if (q0 && q0.comp && !q0.allowed) return say('bad', '✕ ' + emp.name + ' 是計時同仁，沒有補休，無法送出。');
      if (C.quotaHardBlocked(d0, q0)) return say('bad', '✕ ' + emp.name + ' 的「' + L.type + '」額度已用完（上限 ' + q0.cap_days + ' 日，已用 ' + (Math.round((q0.used_days || 0) * 10) / 10) + ' 日），無法送出。確有需要請聯絡 Eason 調整假別設定。');
      if (C.personalOver(d0, q0) && !await confirmBox(C.personalOverText(emp.name, q0), '仍要送出')) return;      // 事假用完不擋（2026-11-10 Eason）：超過的部分照曠職標紅
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
      if (totalH + t2 > C.DAY_MAX_H) msg += '\n⚠ 超過一天 ' + C.DAY_MAX_H + ' 小時上限（照實核定，會列進每日通知）';
      const cw2 = C.contBreakWarn(periods);
      if (cw2) msg += '\n⚠ ' + C.contBreakText(cw2);
      const dupLine = C.dupConfirmLine(dupGroups, dupPicks);
      if (dupLine) msg += '\n' + dupLine;
      if (periodRows.querySelector('.du-break')) msg += '\n（休息 ' + br.start + '–' + br.end + ' 不計入）';
      const noted = lv.filter(x => !(x.type === '出差' && Number(x.hours) > 0));      // 沒算進核定的假別（出差以外、或沒填時數的出差）列出來給主管看
      if (noted.length) msg += '\n' + (noted.every(x => x.type === '出差') ? '註記' : '請假') + '：' + C.leavesText(noted);
      if (warnings.length) msg += '\n\n⚠ 請再確認：\n' + warnings.join('\n');
      if (!await confirmBox(msg + '\n\n確定送出?', '送出')) return;
    }
    submit.disabled = true; submit.textContent = '送出中…';
    const approveDate = date;                       // 送出當下鎖定日期，避免回呼時已切到別天
    try {
      const payload = { store: emp.store, date: approveDate, emp_id: emp.emp_id, periods, late_min: lateIn.value, leaves: lv };
      if (diffIn.value.trim()) payload.diff_reason = diffIn.value.trim();
      if (dupGroups.length) payload.dup_ignore = C.dupIgnoreFrom(dupGroups, dupPicks);   // 有重複卡組才送（空陣列＝取消認定）；沒有就不送，打卡端沿用原本的
      if (canBg(emp)) { payload.base_ver = emp.ver; payload.bg = true; }      // 資料是 Mac mini 副本讀的：先顯示、背景送，打卡端比對版本（2026-11-14）
      const res = await call('mgr_approve', payload);
      delete S.dayCache[approveDate];
      if (res && res.queued) { bgQueued(res.job, approveDate, lv); return; }
      if (lv.length || initLeaves.length) staleLeave();      // 有請假的核定會動到額度，下次進核定頁重抓
      say('ok', '✓ 已核定 ' + res.approved_hours + ' 小時・' + res.status_text + C.leavesSuffix(C.leavesOf(res)) + '（' + res.manager_name + '）');
      setBadge(res, C.leavesOf(res));
      card.__pending = false;
      planDone = true; if (card.__planR) card.__showPlan(card.__planR);   // 核定後拿掉跟班表比的提醒
      card.dispatchEvent(new CustomEvent('emp-approved', { bubbles: true, detail: { emp_id: emp.emp_id, date: approveDate, store: emp.store } }));
    } catch (e) {
      say('bad', '✕ 核定失敗：' + e.message);
      if (/^核定和打卡差/.test(e.message) && !readOnly) { diffBox.hidden = false; diffIn.focus(); }
      const noLine = /沒綁 LINE/.test(e.message);                // 打卡端判斷的：沒綁 LINE 的同仁 7 天內也能代開（2026-11-09）
      if (/^這天還不能核定/.test(e.message) && (noLine || approveDate < C.addDaysStr(C.taipeiToday(), -proxyAfterDays())) && !readOnly) proxyForm(approveDate, noLine, e.message);
    }
    finally { submit.disabled = false; submit.textContent = '重新送出核定'; }
  };

  function setExpanded(on) { body.hidden = !on; card.classList.toggle('open', on); head.setAttribute('aria-expanded', on ? 'true' : 'false'); }
  setBadge(emp.approved, initLeaves);
  setExpanded(false);
  card.__pending = !emp.approved;
  card.__hasPunch = hasPunch;
  card.__absent = absent;
  card.__setExpanded = setExpanded;

  // ---- 已核准的申請（2026-10-09，照 manager.html __applyReq）：還沒核定就幫主管預填；已核定過不覆蓋，改給一顆「依申請重新填」。
  //      預填只是畫面上的值，主管按送出核定才算數（核准申請本身不寫入核定）。加班在上班日接在班表後面（2026-11-09）；
  //      班表排休那天（2026-10-29）加班申請的時段就是當天工時 → 依加班申請預填、標「來自加班申請」，並收掉補申請提示。
  card.__applyReq = reqs => {
    card.__dayReqs = reqs || [];
    if (badgeNow) setBadge(badgeNow.approved, badgeNow.leaves);
    if (!reqs || !reqs.length || card.__reqApplied) return;
    card.__reqApplied = true;
    // 同一天多張申請（2026-10-29，照 manager.html 2026-10-26；spec §1.1）：不同假別（出差＋天災假）一起填、各成一列；
    // 同一種假別兩張（多半一張是舊單）或兩張忘打卡，自動填會互蓋——不自動填，逐張列出給主管選，舊單可作廢。
    const plan = C.reqPlan(reqs), fillables = plan.fillables, multi = plan.multi;
    const otP = offDay ? C.otPeriods(reqs) : [];
    const workOt = !offDay && pv.mode === 'plan' && !multi ? C.otPeriods(reqs) : [];      // 上班日已核准的加班：和手機一樣接在時段後面（2026-11-09 Eason）
    const otMissing = workOt.filter(o => !((emp.approved && emp.approved.periods) || []).some(p => p && p.start <= o.start && p.end >= o.end));
    if (offDay && offHint && otP.length) offHint.remove();      // 加班申請沒填時段＝帶不進來，提示留著（2026-10-29 Fable 審查）
    const rbox = h('div', 'du-reqbox' + (emp.approved || multi ? ' warn' : ''));
    if (multi) rbox.append(h('div', 'du-reqlead', '⚠ 這天有 ' + fillables.length + ' 張已核准的申請，其中有同一種的（多半一張是舊單），系統不自動填：請把舊的或重複的按「作廢」，剩下的會自動填好；或按「依這張填」只填那一張。'));
    const note = h('div', 'du-reqnote'); note.hidden = true;
    const setNote = t => { note.textContent = t; note.hidden = !t; };
    let tag = null;
    const canVoid = !readOnly || canWriteRow('req', emp.emp_id, emp.store) || canVoidRow(emp.emp_id, emp.store);     // 能核他工時、或能審他申請的人（Eason 2026-10-29 選 2A）、或有考勤作廢（2026-11-13）；伺服器再驗一次
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
        if (r.void_ok === false && readOnly && !canWriteRow('req', emp.emp_id, emp.store)) { vb.disabled = true; vb.textContent = '不能作廢'; vb.title = '自己的單、主管代開的單不能作廢'; }      // 考勤作廢的唯讀者（2026-11-13 審查 7）
        else if (r.void_ok === false || (r.void_ok === undefined && (r.upper === true || r.self === true))) { vb.disabled = true; vb.textContent = '送上層處理'; vb.title = '值班主管本人的申請，由上層主管在申請審核處理'; }
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
          const clearedOt = !!(card.__otRows && card.__otRows.length);     // 自動接上的加班時段先拿掉，再依剩下的申請重建
          (card.__otRows || []).forEach(n => n.remove()); card.__otRows = []; if (clearedOt) refresh();
          const clearedLeave = wasFilled && (r.kind === 'leave' || r.kind === 'trip');      // 作廢的假單／出差單填過假別：先清掉，剩下的申請有假別會再填回（否則剩忘打卡單時，舊時數會跟著送出，2026-11-10 Codex 複審）
          if (clearedLeave) { setLeaveLines([]); refresh(); }
          rbox.remove(); if (tag) { tag.remove(); tag = null; }
          card.__reqApplied = false; card.__lastFilled = [];
          card.__applyReq(rest);
          const stale = wasFilled && !clearedOt && !card.__lastFilled.length && !(clearedLeave && r.start);           // 剩下的沒有重新填 → 畫面還是作廢那張的內容（2026-10-29 Fable 審查第 5、6 條）
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
      const noTimeLv = list.filter(r => (r.kind === 'leave' || r.kind === 'trip') && !r.start).reduce((a, r) => a + (Number(r.hours) || 0), 0);      // 沒填時段的假單＋出差合計（兩張半天＝整天）
      list.forEach(r => {
        if (r.kind === 'leave') {
          // 沒填時段的假單：整天（8 小時以上）才清掉上班時段；部分時數（例：補休 0.5 小時）保留班表時段，
          // 否則正職會變成「上班 0＋假單 0.5」被滿 8 小時擋下（2026-11-13，正職上班日滿 8 小時）
          if (!r.start && !(noTimeLv > 0 && noTimeLv < C.FT8_H)) { periodRows.textContent = ''; periodRows.append(periodRow(null, refresh)); }
        } else if (r.kind === 'trip') {
          // 整天出差（申請沒填時段、那天也沒打卡）：預設班別清掉，否則班別 8 小時＋出差 8 小時＝16 小時（2026-10-10 Codex 審查，manager.html 同步）
          if (!r.start && !(emp.segments || []).length) { periodRows.textContent = ''; periodRows.append(periodRow(null, refresh)); }
        } else if (r.kind === 'miss') {
          const full = C.missPeriods(emp.segments, r, emp.plan && emp.plan.work ? emp.plan.segs : null);
          if (full.length) {
            periodRows.textContent = '';
            full.forEach(p => periodRows.append(periodRow(p, refresh)));
            if (!tag) { tag = h('span', 'du-fromreq', '來自申請'); periodRows.parentNode.insertBefore(tag, periodRows); }
          }
        }
      });
      if (lvFill.length) setLeaveLines(lvFill);
      if (list === fillables && otMissing.length) {
        const cur = readRows().filter(x => x.start && x.end).map(x => ({ start: x.start, end: x.end }));
        const add = otMissing.filter(o => !cur.some(c => c.start === o.start && c.end === o.end));
        if (cur.length && !C.analyzePeriods(cur.concat(add)).warnings.some(w => !/跨夜/.test(w))) {
          card.__otRows = add.map(p => { const el = periodRow(p, refresh); periodRows.append(el); return el; });
          card.__lastFilled = card.__lastFilled.concat(reqs.filter(r => r.kind === 'ot').map(r => r.id));
          if (add.length && !tag) { tag = h('span', 'du-fromreq', '來自加班申請'); periodRows.parentNode.insertBefore(tag, periodRows); }
        } else if (cur.length) setNote('加班單和班表時段重疊，沒有自動帶入，請自己確認。');
      }
      refresh();
      if (readOnly) lockBody();
    }
    const fillable = otP.length > 0 || fillables.length > 0 || otMissing.length > 0;
    if (!multi && fillable && emp.approved) {
      const b = h('button', 'du-reqfill', '這天已核定過，依申請重新填', { type: 'button' });
      if (readOnly) b.hidden = true;
      b.onclick = () => { fill(fillables); b.remove(); setNote('已依申請填好，確認後按送出核定。'); };
      rbox.insertBefore(b, note);
    } else if (!multi && fillable) fill(fillables);
    periodRows.parentNode.insertBefore(rbox, tag || periodRows);    // 順序：申請說明 → 來自申請 → 時段
  };
  const lockBody = () => body.querySelectorAll('input,select,button').forEach(x => { if (!x.closest('.du-reqbox') && !x.closest('.du-hrret-box')) x.disabled = true; });      // 人資退回鈕（2026-11-13）不鎖
  if (readOnly) {                                                // 只看：姓名旁「唯讀」小字，內文所有欄位與按鈕鎖住（申請說明框裡的「作廢」另外判斷：能審他申請的人可以作廢）
    nameEl.append(h('span', 'du-ro', '唯讀'));
    lockBody();
  }
  head.onclick = () => setExpanded(body.hidden);
  head.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(body.hidden); } };
  return card;
}
