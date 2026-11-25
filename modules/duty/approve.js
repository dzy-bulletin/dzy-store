// 核定工時：照原系統 ~/mala-clock-in/manager.html 搬。日期列（前一天／後一天／今天）、本月待核定提醒、員工卡（收合展開、時段、
// 核定時數即時算、休息、假別、出差、遲到分鐘）、送出核定。外觀換成營運系統風格，規則與文案不改。
import { confirmBox } from '../../js/ui.js';
import { S, cancelSyncWaits, dutyManager, call, callAll, readPend, pendTake, pendDrop, brk, brkOf, h, failBar, failedStores, loadLeave, staleLeave, leaveFor, rowKey, canWriteRow, canVoidRow, supportTag, rememberOne, snapLabel, tipText, checkOnce, reqShown, refreshReqBadge, reqCanDecide } from './state.js';
import { isSyncCancelled } from './sync-wait.js';      // 資料更新中被取消（換頁、換日期）：不顯示結果（2026-11-21）
import { buildReqItem } from './request.js';
import { approvedSegTag, proxyOtSegs, segWord, SEG_MAX_OT_ADMIN } from './req-group.js';
import { corePeriods, OVER_BLOCK_MIN, otSuggestText, cardDiffs, cardLabel, cardReasonText } from './core-calc.js';
import * as C from './calc.js';
import { api } from '../../js/api.js';
import { leaveOverText } from './core-calc.js';      // 2026-11-18 第 5 題提醒（另起一行：上面那行同時有別的分支在改）
import { planFlags, REASONS, pendSplit, planOtText } from './quick-calc.js';
import { leaveIncrements, leaveShort } from './leave-batch.js';
import { pendingFor } from './pend-gate.js';
import { capLockMark, capUnmatched } from './cap-note.js';      // 系統鎖卡標示（2026-11-23）
import { ssoSwitch, setSession, toSession } from '../../js/auth.js';
import { renderQuick, backBar, e2eNoCore, isMock } from './quick.js';
import { canBg, watchJob, refreshJobs, rejectBar } from './bg.js';
import { mirrorLine, mirrorFlags } from './mirror-line.js';      // 「資料更新於」那一行＋只讀 mini 的過期黃條（第 1 階段）

// 2026-11-15 考勤核定合成一頁時間軸（docs/duty-timeline/）：所有人都用新頁（quick.js）；舊的完整頁只留系統管理員從新頁最下面切回，
// 到 FULL_UNTIL 為止當緊急備用（Eason 定 14 天），之後連程式一起刪。卡片的編輯（buildCard）搬進新頁的「細調」，所以這支檔留著。
export const FULL_UNTIL = '2026-11-30';
export const fullAllowed = (ctx) => !!S.dqFull && !!(ctx && ctx.session && ctx.session.role === 'admin') && C.taipeiToday() <= FULL_UNTIL;
export function renderApprove(ctx) {
  if (!fullAllowed(ctx)) return renderQuick(ctx);
  const el = ctx.el;
  el.innerHTML = `<div class="du-datebar"><button type="button" class="btn ghost du-nav" id="duPrev" aria-label="前一天">‹</button>
    <input type="date" id="duDate" aria-label="日期"><button type="button" class="btn ghost du-nav" id="duNext" aria-label="後一天">›</button>
    <button type="button" class="btn ghost" id="duToday">今天</button></div>
    <div id="duBg"></div><div id="duRet"></div><div id="duPend"></div><div id="duDayBox"></div>`;
  const dateIn = el.querySelector('#duDate'), pendEl = el.querySelector('#duPend'), box = el.querySelector('#duDayBox'), retEl = el.querySelector('#duRet');
  const live = () => el.isConnected;
  el.insertBefore(backBar(ctx), el.firstChild);      // 舊畫面（管理員緊急備用）：上面一顆「回到新畫面」
  // 考勤副本（2026-11-14）：背景送出被打卡系統退回的，列在最上面；點了跳到那天那位
  el.querySelector('#duBg').append(rejectBar((date, empId) => { cancelSyncWaits(); S.focusEmp = rowKey({ emp_id: empId }); delete S.dayCache[date]; loadDay(date); }));
  refreshJobs();

  const pendPanel = pendingPanel(pendEl, (date, key) => { cancelSyncWaits(); S.focusEmp = key; loadDay(date); });
  const loadPending = pendPanel.load, drawPending = pendPanel.draw;
  const loadReturns = returnsPanel(retEl, (date, key) => { cancelSyncWaits(); S.focusEmp = key; loadDay(date); }, (date) => { if (S.date === date) loadDay(date); }, live).load;
  box.addEventListener('hr-returned', () => loadReturns());
  box.addEventListener('duty-reload-day', e => { const d = e.detail || {}; S.focusEmp = rowKey(d.emp); delete S.dayCache[d.date]; loadDay(d.date); });   // 背景送出被退回：重新載入那天
  // 核定成功後即時從提醒移除（不必重打後端）
  box.addEventListener('emp-approved', e => {
    loadReturns();      // 重核後人資退回就結案（伺服器做），清單重讀
    const d = e.detail; if (!d || !S.pend) return;
    if (pendDrop(d)) drawPending();
  });

  // ---------- 某天的名單（manager.html:1540–1590、1840–1930）----------
  // 昨天以前才快取（昨天不快取）：跨夜班同仁午夜後才打下班卡，掛在昨天，快取會一直顯示舊的（2026-10-11 審查）
  const cacheable = d => !!d && d < C.addDaysStr(C.taipeiToday(), -1);
  function prefetch(date) {                                   // 背景預抓前幾天，‹ 幾乎瞬間；循序一次一天（原頁抓 6 天，這裡經營運系統轉送，縮成 3 天）
    const targets = []; for (let i = 1; i <= 3; i++) targets.push(C.addDaysStr(date, -i));
    (function next() {
      const d = targets.shift(); if (!d) return;
      if (!cacheable(d) || S.dayCache[d]) return next();
      dayRead(d).then(r => { if (r && r.date && !(r.failed && r.failed.length) && !r.mirror_stale) S.dayCache[r.date] = r.employees; next(); }, () => next());      // 全部門市有店讀不到的那天不快取（讀不到的店不能被當成「這天沒人」記住）
    })();
  }
  const dayRead = body => (S.all ? callAll('mgr_day', typeof body === 'string' ? { date: body } : body) : call('mgr_day', typeof body === 'string' ? { date: body } : body));
  // gate＝要等它到了才畫卡片的東西（假別額度）：跟名單同時抓，不再先抓完額度才去抓名單（2026-11-02 Eason：考勤每點一下都要等很久）
  // 完整頁背景再問（2026-11-19）：伺服器先給副本時 6、15 秒再讀同一天；名單有差就在上方插一行「打卡系統有更新的資料［更新］」，按了才重讀（打字、選項不會被清掉）
  function fullNewer(date, emps, tok) {
    [6000, 15000].forEach((ms) => setTimeout(async () => {
      if (tok !== S.dayTok || !live() || S.date !== date || document.querySelector('#duNewer')) return;
      let r; try { r = await dayRead({ date }); } catch (e) { return; }
      if (tok !== S.dayTok || !live() || S.date !== date || !r || !Array.isArray(r.employees)) return;
      if (JSON.stringify(r.employees) === JSON.stringify(emps)) return;
      const box0 = document.querySelector('#duMirrorAt'); if (!box0 || document.querySelector('#duNewer')) return;
      const nb = h('div', 'du-mirror-at', '打卡系統有更新的資料 ', { id: 'duNewer', role: 'status' });
      const b = h('button', 'btn ghost sm', '更新', { type: 'button', id: 'duNewerGo' }); b.onclick = () => { const y = window.scrollY; loadDay(date); requestAnimationFrame(() => window.scrollTo(0, y)); };
      nb.append(b); box0.after(nb);
    }, ms));
  }
  function loadDay(dateOverride, gate) {
    const tok = ++S.dayTok;
    // 假別額度被清掉（核定過請假）時先重抓，再畫名單：不然新卡片拿不到額度，額度與期限的硬擋整批失效（2026-10-12 Codex 審查）
    if (S.leaveStale) { S.leaveStale = false; gate = loadLeave(); }
    loadDayNow(dateOverride, tok, gate);
  }
  function loadDayNow(dateOverride, tok, gate) {
    unStale();                     // 上一次的「先顯示上次」還沒換掉就換日期：先解除
    const wait = gate ? gate.then(() => null, () => null) : Promise.resolve(null);
    S.dayMirrorAt = 0; S.dayMirrorStale = false; S.dayReqStale = false; S.dayPendStale = false; S.dayReqs = {};
    const freshReq = !!S.dayFreshNext; S.dayFreshNext = false; S.dayFreshErr = !!S.dayFreshErrNext; S.dayFreshErrNext = false;      // 黃條的「直接向打卡系統讀取」：這一次直接問打卡（第 1 階段）
    if (!freshReq) { S.dayFreshAt = 0; S.dayMirrorRo = false; S.dayMirrorFeed = false; }
    if (dateOverride && S.dayCache[dateOverride] && !freshReq) {
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
    if (freshReq) body.fresh = true;
    let gateDone = !gate;                 // 假別額度還沒到：名單先畫出來看，但不能按（2026-11-09 Eason：考勤選店後等太久）
    if (gate) wait.then(() => { gateDone = true; });
    dayRead(body).then(r => {
      fresh = true;
      if (tok !== S.dayTok || !live()) return;
      unStale();
      S.dayMirrorAt = r.mirror_at || 0; S.dayMirrorStale = !!r.mirror_stale;      // 考勤副本讀的：卡片上方標「資料更新於」；上游慢先給的舊值另加一句（2026-11-18）
      { const f = mirrorFlags(r); if (freshReq) { S.dayFreshAt = Date.now(); S.dayMirrorFeed = false; const at = S.dayFreshAt; setTimeout(() => { if (S.dayFreshAt !== at || tok !== S.dayTok || !live()) return; S.dayFreshAt = 0; S.dayMirrorAt = at; const el = document.querySelector('#duMirrorAt'); const nl = dayLine(); if (el && nl) el.replaceWith(nl); }, 3000); } else { S.dayMirrorRo = f.ro; S.dayMirrorFeed = f.ro && f.feed; } }
      if (S.dayMirrorStale) fullNewer(r.date, r.employees, tok);      // 完整頁：背景再問，有差只顯示「有更新的資料［更新］」（不偷換畫面，2026-11-19）
      const failed = r.failed || [];          // 單一門市也可能有：總部那組併進來的別家讀不到（不快取、顯示提示）
      if (!S.all) S.elsewhere = Array.isArray(r.elsewhere) ? r.elsewhere : [];      // 捷徑卡（歸屬這組、在別家打卡的人）不隨日期變，快取的日子沿用
      if (!failed.length && !r.mirror_stale) { if (cacheable(r.date)) S.dayCache[r.date] = r.employees; else S.recent[r.date] = r.employees; }      // 副本舊值不進快取（審查 R1：從快取打開會被當成新的直接可核定）
      if (!gateDone) { drawDay(r.date, r.employees, failed, true); markStale('假別額度還在讀取，讀到後就可以核定…'); }
      return wait.then(() => {            // 卡片的假別清單與額度檢查要用額度：到了才重畫成可操作的卡片，額度硬擋不會被繞過
        if (tok !== S.dayTok || !live()) return;
        unStale();
        drawDay(r.date, r.employees, failed); prefetch(r.date);
      });
    }, e => {
      fresh = true;
      if (tok !== S.dayTok || !live()) return;
      if (freshReq && S.dayMirrorRo) { S.dayFreshErrNext = true; loadDay(dateOverride); return; }      // 直接讀也讀不到：回到副本那份，黃條多一行「還是讀不到」
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
  // 「資料更新於」那一行（只讀 mini 時：平常換字樣、過期出黃條＋按鈕；沒開＝跟以前一樣）
  function dayLine() {
    return mirrorLine({ at: S.dayMirrorAt, stale: S.dayMirrorStale, ro: S.dayMirrorRo, feed: S.dayMirrorFeed, freshAt: S.dayFreshAt, freshErr: S.dayFreshErr, freshBusy: false,
      onFresh: () => { const b = document.querySelector('#duMirrorAtFresh'); if (b) { b.textContent = '讀取中…'; b.disabled = true; } S.dayFreshNext = true; loadDay(S.date); }, id: 'duMirrorAt' });
  }
  function unStale() { box.classList.remove('du-stale'); box.inert = false; box.removeAttribute('aria-busy'); }
  function markStale(text) {
    box.classList.add('du-stale'); box.inert = true; box.setAttribute('aria-busy', 'true');   // inert：鍵盤也按不到（2026-11-02 審查）
    box.prepend(h('div', 'du-stale-note', text || '先顯示上次看到的資料，正在更新…', { id: 'duStale' }));
  }
  function drawDay(date, employees, failed, quick) {
    if (S.date && S.date !== date) cancelSyncWaits();      // 換日期：正在等的「資料更新中」取消（#354）
    S.date = date; dateIn.value = date;
    const focus = S.focusEmp;
    renderEmployees(box, date, employees, failed, () => { loadPending(); loadDay(date); });
    if (quick) { S.focusEmp = focus; return; }
    { const ml = dayLine(); if (ml) box.prepend(ml); }   // 先秀上次的資料：申請、班表等新資料到了再一起套；待核定提醒點的那位留給新資料打開
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
        const r = planFlags(res.plan[card.dataset.empId], card.__segments, { past: date <= today, brk: brk(card.dataset.store) });
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
      S.dayReqs[key] = byEmp[id];      // 送出前重讀時比對（審查 R1）
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
    // 待審清單跟已核准申請同時讀（第三輪審查）：兩份都有結果才解鎖；待審清單讀不到＝每張卡都不能核定（fail-closed）、給重讀鈕
    const pendP = readPending();
    (pre || (S.all ? callAll('mgr_req_day', { date }) : call('mgr_req_day', { date }))).then(async res => {
      if (!current()) return;
      S.dayReqStale = !!(res && res.mirror_stale);      // 已核准申請是副本舊值：送出前要重讀（審查 R1：名單新、申請舊的組合）
      if (!res || !(S.all ? res.by_store : res.by_emp)) { unlock(); return block(); }
      if (!S.all) put('', res.by_emp);
      Object.keys(res.by_store || {}).forEach(st => put(st, res.by_store[st] && res.by_store[st].by_emp));      // 全部門市各店；單一門市時是總部那組併進來的別家
      if (Array.isArray(res.failed) && res.failed.length) block(res.failed);
      const pr = await pendP.then(r => ({ r }), e => ({ e }));
      if (!current()) return;
      unlock();
      applyPendingReqs(date, current, pr);      // 那天還沒審的申請放進各人卡片（第 2 項）
      runChecks(box, date, current);      // 申請都套好、時段是最後的樣子：整天先跟打卡系統「只檢查」一次（2026-11-14 考勤管理好上手第 1 項）
    }, () => { if (current()) { unlock(); block(); } });
  }
  const readPending = () => { const p = S.all ? callAll('mgr_req_pending', {}) : call('mgr_req_pending', {}); p.catch(() => {}); return p; };

  // 卡片裡審申請（2026-11-14 考勤管理好上手第 2 項）：那天還沒審的申請（只算自己看得到、不是自己送的）列進那位同仁的卡片，單筆核准／退回；
  // 批次與作廢留在申請審核分頁。核准後重讀那天已核准的申請、照舊預填，主管再按一次送出（不自動核定）
  // pr＝{ r } 讀到的待審清單／{ e } 讀不到（第三輪審查：讀不到不再吞掉，該卡一律不能核定、可重讀）；沒傳＝現在讀一次
  async function applyPendingReqs(date, current, pr) {
    if (!pr) pr = await readPending().then(r => ({ r }), e => ({ e }));
    if (!current()) return;
    const res = pr.r;
    const cards = [].slice.call(box.querySelectorAll('.du-card'));
    const retry = () => { const n = box.querySelector('#duPendFail'); if (n) n.remove(); cards.forEach(c => c.__pendFail && c.__pendFail('待審的申請重新讀取中…', null)); applyPendingReqs(date, current); };
    const failBar = names => {
      if (box.querySelector('#duPendFail')) return;
      const bar = h('div', 'du-fail', null, { id: 'duPendFail' });
      bar.append(h('span', 'du-fail-msg', (names ? names + '的' : '') + '待審申請讀不到：還有沒審的單就不能核定，為了避免核錯，暫時不能送出核定'));
      const again = h('button', 'btn sm ghost', '重新讀取待審申請', { type: 'button', id: 'duPendRetry' });
      again.onclick = () => { again.disabled = true; again.textContent = '讀取中…'; retry(); };
      bar.append(again);
      box.prepend(bar);
    };
    const FAIL_MSG = '這天的待審申請讀不到，暫時不能核定（按上面「重新讀取待審申請」）';
    if (pr.e || !res || !Array.isArray(res.items)) { cards.forEach(c => c.__pendFail && c.__pendFail(FAIL_MSG, retry)); failBar(''); return; }
    S.dayPendStale = !!(res && res.mirror_stale);
    const failedPre = (Array.isArray(res.failed) ? res.failed : []).map(f => f.store + '|');
    const items = reqShown(res.items).filter(it => it.date === date);
    const by = new Map(), byAll = new Map();      // byAll＝連本人自己的、只給最小列的（這位主管審不了）也算：擋核定要看全部待審單（2026-11-19）
    items.forEach(it => { const k = rowKey({ store: it.store || '', emp_id: it.emp_id }); if (!by.has(k)) by.set(k, []); by.get(k).push(it); });
    (res.items.filter(it => it && it.date === date)).forEach(it => { const k = rowKey({ store: it.store || '', emp_id: it.emp_id }); if (!byAll.has(k)) byAll.set(k, []); byAll.get(k).push(it); });
    cards.forEach(c => {
      if (failedPre.some(x => c.dataset.empId.startsWith(x))) { if (c.__pendFail) c.__pendFail(FAIL_MSG, retry); return; }      // 讀不到的那幾家店：那幾家的卡不能核定
      if (c.__applyPending) c.__applyPending(by.get(c.dataset.empId) || [], byAll.get(c.dataset.empId) || []);
    });
    if (failedPre.length) failBar(res.failed.map(f => f.storeName).join('、'));
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


// ---------- 本月待核定提醒（manager.html:1604–1745）：沒有待核定＝整塊不畫。新頁與舊畫面共用（2026-11-15）----------
export function pendingPanel(pendEl, onPick) {
  const el = pendEl;
  function loadPending() {
    readPend().then(r => { if (!el.isConnected) return; pendTake(r, () => { if (el.isConnected) drawPending(); }); drawPending(); },
      e => { if (el.isConnected) failBar(pendEl, '本月待核定提醒', e, loadPending); });
  }
  const lateHint = () => h('div', 'du-pa-late', '上個月的還在讀取，請稍等…', { role: 'status' });
  const missHint = () => h('div', 'du-pa-miss', C.PREV_MISS_TEXT, { role: 'status' });
  function drawPending() {
    pendEl.innerHTML = '';
    const items = S.pend || [];
    failedStores(pendEl, S.pendFailed, loadPending);
    if (!items.length) { if (S.pendPrevWait) pendEl.append(lateHint()); else if (S.pendPrevFail) pendEl.append(missHint()); return; }      // 本月沒有、上個月還在讀（或讀不到）：只留一行提示
    // 天數只算核得了的（2026-11-10）：那天全部是只能看的人（督導看區內門市、原單位主管看支援帳號…）不是你的待辦，
    // 不算天數、列在最後面。首頁待辦是同一個算法（calc.js pendGroups），兩邊的天數才對得起來
    const { mine, ro } = C.pendGroups(items, it => canWriteRow('hours', it.emp_id, it.store));
    const groups = mine.concat(ro);
    const card = h('div', 'du-pa');
    card.append(h('div', 'du-pa-title', mine.length ? C.pendTitle(mine, S.pendPrev || '') : '本月沒有要你核定的日子'));
    if (S.pendPrevWait) card.append(lateHint()); else if (S.pendPrevFail) card.append(missHint());      // 月初：上個月沒核定的清單還在讀，讀到會補在前面（2026-11-20）      // 月初會併上個月（「11 月還有 2 天、本月還有 1 天沒核定」，2026-11-19）
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
        chip.onclick = () => onPick(g.date, rowKey(n));
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
  return { load: loadPending, draw: drawPending };
}
// ---------- 人資退回待重核（2026-11-13，管理系統 docs/att-void-hr/return-spec.md）：沒有就整塊不畫 ----------
export function returnsPanel(retEl, onPick, onCancel, live) {
  function loadReturns() {
    (S.all ? callAll('hr_return_list') : call('hr_return_list')).then(r => { if (live()) drawReturns(Array.isArray(r.items) ? r.items : []); }, () => { if (live()) retEl.innerHTML = ''; });
  }
  function drawReturns(items) {
    retEl.innerHTML = '';
    if (!items.length) return;
    const card = h('div', 'du-pa du-hrret-list');
    card.append(h('div', 'du-pa-title', '人資退回 ' + items.length + ' 筆，請重新核定'));
    card.append(h('div', 'du-pa-sub', '點名字跳到那天，核對後重新送出核定就結案；原本的核定在重新核定前照舊算'));
    items.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))).forEach(it => {
      const row = h('div', 'du-pa-group');
      row.append(h('div', 'du-pa-date', C.weekdayLabel(it.date)));
      const right = h('div', 'du-hrret-item');
      const chip = h('button', 'du-chip', (it.emp_name || it.emp_id) + (it.storeName ? '・' + it.storeName : ''), { type: 'button' });
      chip.onclick = () => onPick(it.date, rowKey(it));
      right.append(chip, h('div', 'du-hrret-why', '理由：' + it.reason + '（' + it.by_name + '）' + (it.lock_unknown ? '　⚠ 退回時沒辦法確認薪資有沒有鎖定' : '')));
      if (it.can_cancel) {
        const cb = h('button', 'btn sm ghost du-hrret-cancel', '取消退回', { type: 'button' });
        cb.onclick = () => { cb.disabled = true; call('hr_return_cancel', { id: it.id, store: it.store }).then(() => { delete S.dayCache[it.date]; loadReturns(); onCancel(it.date); }, e => { cb.disabled = false; cb.textContent = '✕ ' + (e.message || '取消失敗'); }); };
        right.append(cb);
      }
      row.append(right); card.append(row);
    });
    retEl.append(card);
  }
  return { load: loadReturns };
}

// ---------- 送出前先檢查（2026-11-14 Eason「五個全做」第 1 項，docs/duty-easy/）----------
// 打卡系統 mgr_approve_check：用「送出核定」同一套檢查跑到寫入前就停，回每個人會不會被擋、被擋的原因。
// 一天打開時整批算一次（每家店一次），之後主管改了某人的時段或假別，停手 0.35 秒只重算那一位（buildCard 的 queueCheck）。
// 讀不到（舊版打卡、連不上）就不標：畫面照舊，按送出才知道。
// 出差地點下拉（與打卡 req-line.js TRIP_PLACES 同一份，2026-11-17）
const TRIP_PLACES = ['總部辦公室', '新竹光復', '新竹金山', '台北六張犁', '台北瑞光', '台中美村'];
const TRIP_OTHER = '其他';
const CHECK_MAX = 40;
// 改時段後這一張卡的單人檢查最多等多久（2026-11-20）：超過就當「讀不到」、按鈕恢復、顯示逾時提示；晚回來的結果只要對得上最後一次輸入就補上顯示（取代逾時提示），改過輸入就丟掉。
// 只管這條路徑，不動全域 api()；整天那次檢查另有 30 秒上限（quick.js CHECK_WAIT_MS）。示範模式 e2e 可用 window.__duEditCheckMs 縮短
const EDIT_CHECK_MS = 10000;
const editCheckMs = () => (isMock() && Number(window.__duEditCheckMs)) || EDIT_CHECK_MS;
const TIMEOUT_HINT = '檢查逾時（打卡系統回得比較慢）。可以直接按「送出核定」，送出時系統會再檢查一次。';
const STALE_TITLE = '時段剛改過，檢查完才能送出';
const CHECK_DEBOUNCE_MS = 350;      // 改了時段後停手多久才問打卡系統（2026-11-20 由 1000 縮短；畫面上的「檢查中…」是當下就標）
function runChecks(box, date, current) {
  const cards = [].filter.call(box.querySelectorAll('.du-card'), c => c.__checkItem);
  cards.forEach(c => { if (c.__propose) c.__propose(); });      // 先照「打卡＋單」算好核定時段（2026-11-14）
  const byStore = new Map();
  cards.forEach(c => { const it = c.__checkItem(); if (!it) return; const st = c.dataset.store || ''; if (!byStore.has(st)) byStore.set(st, []); byStore.get(st).push([c, it]); });
  byStore.forEach((pairs, st) => {
    for (let i = 0; i < pairs.length; i += CHECK_MAX) {
      const part = pairs.slice(i, i + CHECK_MAX);
      part.forEach(([c]) => c.__checking(true));
      checkOnce(date, st, part.map(x => x[1])).then(results => {
        if (current && !current()) return;
        part.forEach(([c, it]) => { c.__checkOn = true; c.__setCheck(results ? results.find(r => r.emp_id === String(it.emp_id)) || null : null); });
      });
    }
  });
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
  const recount = () => {      // 送出前檢查的結果也算進來：「送出會被擋 N 人・可以送出 N 人」
    const pend = [].filter.call(list.querySelectorAll('.du-card'), c => c.__pending && !c.__absent);
    const bad = pend.filter(c => c.__check && c.__check.ok === false).length, good = pend.filter(c => c.__check && c.__check.ok === true && !(c.__pendBlocked && c.__pendBlocked())).length;
    count.innerHTML = '共 ' + employees.length + ' 人・待核定 <b>' + pend.length + '</b> 人' + (good ? '・<b class="du-cok">核定通過 ' + good + ' 人</b>' : '') + (bad ? '・<b class="du-cbad">還不能核定 ' + bad + ' 人</b>' : '');
  };
  recount();
  list.addEventListener('emp-checked', recount);

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
    recount();
  });
}

// 捷徑卡（2026-11-01 Eason 選 A）：歸屬這組、但在別家店打卡的人（例：財務部同仁固定在央廚打卡，總部那組也看得到她）。
// 資料只有一份，在打卡那家核；按鈕換店過去（同「換店」：換新 token、整頁重載）
export function elsewhereCards(list) {
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
      try { const d = await ssoSwitch(x.store); setSession(toSession(d)); rememberOne(x.store); location.hash = '#/duty/approve'; location.reload(); }
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

// 新頁的「細調」（2026-11-15，docs/duty-timeline/）：舊畫面的整張卡片搬進新頁的時間軸卡片，展開就能改時段、假別、遲到分鐘、
// 重複打卡、原因、作廢申請、代開…；規則一行都不重寫。reqs＝那天這個人已核准的申請，pending＝還沒審的；開好就先跟打卡系統檢查一次。
// 完整頁送出前重讀（2026-11-19）：直接問打卡那天的名單（fresh），這位同仁的版本跟畫面上的不一樣＝資料變了，不送。回 true／不送的原因
async function freshCheck(emp, date, card) {      // 名單、已核准申請、待審清單一起直接問打卡（審查 R1：任一份是副本舊值都要一起重讀比對；第三輪：待審清單也要）
  const st = emp.store || undefined;
  const [r, q, pd] = await Promise.all([call('mgr_day', { date, fresh: true, store: st }), call('mgr_req_day', { date, fresh: true, store: st }), call('mgr_req_pending', { fresh: true, store: st })]);
  if (!pd || !Array.isArray(pd.items) || (Array.isArray(pd.failed) && pd.failed.length)) return '待審的申請讀不到，這次沒有送出，請稍後再試';
  const pendNow = pendOf(pd.items, emp, date);
  const pendShown = card ? (card.__pendAll || []) : [];
  if (pendNow.length) { if (card && card.__applyPending) card.__applyPending(reqShown(pendNow), pendNow); return '這天還有待審的申請，請先審單'; }      // 剛送來的待審單：放進卡片、不送
  if (pendShown.length) return '待審的申請剛有變動，請重新整理這天、確認後再送';
  const cur = (r && Array.isArray(r.employees) ? r.employees : []).find((x) => String(x.emp_id) === String(emp.emp_id));
  if (!cur) return '這位同仁這天的資料讀不到，這次沒有送出，請重新整理';
  if (!emp.ver || !cur.ver || cur.ver !== emp.ver || JSON.stringify(cur.segments || []) !== JSON.stringify(emp.segments || []) || (cur.calc_ver || '') !== (emp.calc_ver || '')) return '資料剛更新，請重新整理這天、確認後再送';
  const freshReqs = (q && q.by_emp && q.by_emp[String(emp.emp_id)]) || [];
  const shown = (S.dayReqs || {})[rowKey({ store: emp.store || '', emp_id: emp.emp_id })] || [];
  if (JSON.stringify(freshReqs) !== JSON.stringify(shown)) return '已核准的申請剛有變動，請重新整理這天、確認後再送';
  return true;
}
// 這位同仁這天的待審單（同卡片 __applyPending 的 byAll：連本人的、只給最小列的都算；跟伺服器 server/duty-pend-gate.js 同一條規則）
const pendOf = (items, emp, date) => pendingFor(items, emp.emp_id, date, emp.store || '');
// 含請假的核定送出前（審查 R5；main 也沒有這道＝既有缺口）：直接問打卡最新的假別額度，讀不到或不夠就不送。原本就登記著的假別照舊放行（同畫面上的硬擋）
export async function leaveFreshOk(emp, date, leaves, prevLeaves) {      // prevLeaves：原本登記的假別（同一假別時數增加的部分也要查）
  const lv = leaveIncrements(leaves, prevLeaves);
  if (!lv.length) return true;
  let r;
  try { r = await call('payroll_leave_options', { fresh: true, store: emp.store || undefined }); } catch (e) { return '假別額度讀不到，含請假的核定這次沒有送出，請稍後再試'; }
  const LO = r && Array.isArray(r.types) ? r : null;
  if (!LO) return '假別額度讀不到，含請假的核定這次沒有送出，請稍後再試';
  const r2 = leaveShort(LO, emp.emp_id, lv, date);      // 跟一鍵整批同一個判斷：用完、期限、計時沒有補休，以及增加的時數超過剩餘（第三輪審查）
  return r2.why || true;
}
export function fineCard(emp, date, o) {
  const card = buildCard(emp, date, { single: true });      // 手動修改只留一條路（2026-11-24 方案一）：一頁核定裡的手動區用新呈現；完整頁（renderEmployees）照舊
  if (o && typeof o.beforeSubmit === 'function') card.__beforeSubmit = o.beforeSubmit;
  if (o && typeof o.current === 'function') card.__current = o.current;      // 送出前最後檢查：還是目前這天（第三輪審查）
  card.classList.add('du-fine');
  if (card.__single) card.classList.add('du-single');      // 新呈現的樣式掛在這個 class 上
  card.__setExpanded(true);
  if (card.__applyReq) card.__applyReq((o && o.reqs) || []);
  if (card.__applyPending) card.__applyPending((o && o.pending) || [], o && o.pendingAll);
  if (!(o && o.defer)) { const box = h('div'); box.append(card); runChecks(box, date, o && o.current); }
  return card;
}
// 一次開很多張細調（詳細模式）：先建好、最後合併成每家店一批（最多 40 人）跟打卡系統檢查，不要一張一個請求
export function checkCards(cards, date, current) {
  const box = h('div'); cards.forEach(c => box.append(c));
  runChecks(box, date, current);
}
const NOT_COUNT_REASONS = ['下班後私人逗留', '等人來載', '忘按下班，其實已經離開'];
const NC_WHY = '請先選不算工時的原因（會留在核定紀錄）';      // 就是送出時「✕ …」那句，single 改成不能按時直接寫在送出鈕下面
function buildCard(emp, date, bopt) {
  const br = brkOf(emp);
  const readOnly = !canWriteRow('hours', emp.emp_id, emp.store);      // 不在核定工時名單（只看）：不出現送出核定，欄位不可改
  // 手動修改只留一條路（2026-11-24 Eason 方案一，docs 見 PR）：只有一頁核定的手動區（fineCard）、而且有權限核定的卡才用。
  // single＝手動區一開就全部攤開、上方不再有「核定 N 小時」「收起」「手動改時段」，整張卡只有最下面一顆紅色「送出核定 N 小時」；其餘（完整頁、只看）逐字照舊
  const single = !!(bopt && bopt.single) && !readOnly;
  let syncLabel = () => {};      // single：送出鈕文字（送出鈕建好之後換成真的；時段變動時 refresh 會叫它）
  const card = h('div', 'du-card'); card.dataset.empId = rowKey(emp); if (emp.store) card.dataset.store = emp.store;
  // 這天還有待審的申請不能核定（2026-11-19）：__pendMine＝這位主管審得了的、__pendUpper＝要上層審的；__recalc 0 沒事／1 剛審完、重讀那天已核准的申請／2 讀好了、重新檢查中（沒回到 0 都不給核定）
  card.__pendMine = []; card.__pendUpper = []; card.__recalc = 0;
  // __pendErr（第三輪審查）：待審清單還沒讀到／讀不到的原因。有就不能核定（fail-closed）；__applyPending 讀到清單才清掉，__pendRetry＝提示裡的重讀
  card.__pendErr = '待審的申請讀取中，讀到後才能核定'; card.__pendRetry = null;
  const recalcDone = () => { if (card.__recalc !== 2) return false; card.__recalc = 0; return true; };
  // 改了時段、假別、遲到、原因：畫面當下就把舊結果標成「檢查中…」（不讓舊的「核定通過」看起來像新時段的結果、核定鈕先停用），
  // 停手 0.35 秒才只重算這一位（不是每個按鍵都問打卡系統）；還在路上的舊回應一律作廢（2026-11-20，改前停手 1 秒、舊結果照亮著）。
  // 整天那次跑完 __checkOn 才開始；卡片初始化時呼叫會直接略過
  function queueCheck(now) {
    if (!card.__checkOn || !card.__checkItem) { if (recalcDone()) card.__pendRelease(); return; }
    clearTimeout(card.__checkTimer);
    card.__checkSeq = (card.__checkSeq || 0) + 1;      // 改了就作廢還在路上的檢查：它回來也不能蓋掉「檢查中…」或新一輪的結果
    if (!now && card.__markStale) card.__markStale();
    card.__checkTimer = setTimeout(() => {
      const it = card.__checkItem(); if (!it) { if (recalcDone()) card.__pendRelease(); return; }
      const seq = (card.__checkSeq = (card.__checkSeq || 0) + 1);
      card.__checking(true);
      let tm = null, timedOut = false;
      const chk = checkOnce(date, emp.store || '', [it]);
      const timeout = new Promise(res => { tm = setTimeout(() => res('timeout'), editCheckMs()); });
      const mineOf = rs => (rs ? rs.find(r => r.emp_id === String(emp.emp_id)) || null : null);
      Promise.race([chk, timeout]).then(rs => {
        clearTimeout(tm);
        if (seq !== card.__checkSeq) return;
        if (!card.isConnected) { card.__needRecheck = true; return; }      // 檢查途中手動區被收起來（卡片不在畫面上）：結果丟掉，下次打開（quick.js manualBody）重新檢查，不留「檢查中…」
        if (rs === 'timeout') {      // 逾時：視同讀不到（按鈕恢復可按），多一句說明。seq 不動：下面 chk.then 晚到時，輸入沒再改過（seq 還對得上）才顯示結果
          timedOut = true; recalcDone(); card.__setCheck(null);
          preBox.className = 'du-pre'; preBox.hidden = false; preBox.textContent = TIMEOUT_HINT;
          return;
        }
        recalcDone(); card.__setCheck(mineOf(rs));
      });
      // 逾時後才回來的結果（2026-11-20 做法 b）：只有「輸入沒再改過」（改時段／假別／遲到／原因都會讓 __checkSeq 前進；送出也會）、
      // 卡片還沒核定、這張卡此刻沒有送出流程在跑、而且結果是正常的檢查結果，才顯示並取代逾時提示；其餘（改過、已送出、失敗／讀不到）一律照舊，維持逾時提示
      chk.then(rs => {
        if (!timedOut || seq !== card.__checkSeq || !card.isConnected || card.__subBusy || !card.__pending || emp.approved) return;
        const mine = mineOf(rs);
        if (!mine || typeof mine.ok !== 'boolean' || mine.error === 'unknown_action') return;
        card.__setCheck(mine);
      });
    }, now ? 50 : CHECK_DEBOUNCE_MS);
  }
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
  // 班表排的是休息日（或例假）出勤（2026-11-15 Eason：休假加班要看得出來，主管才不會忘了要加班單）：整天都算加班
  if (pv.mode === 'plan' && emp.plan && (emp.plan.day_type === 'H' || emp.plan.day_type === 'R')) nameEl.append(h('span', 'du-restot', (emp.plan.day_type === 'R' ? '例假出勤' : '休息日加班') + '・整天算加班，要有加班單'));
  { const ot8 = planOtText(emp, br); if (ot8) nameEl.append(h('span', 'du-restot du-ot8', ot8)); }      // 班表本身超過 8 小時：準時下班也要加班單（2026-11-20，跟一頁核定那張卡同一句）
  const punchEl = h('div', 'du-punch');
  if (emp.segments && emp.segments.length) {
    const ref = (emp.reference === null || emp.reference === undefined) ? '參考 —' : '參考 ' + emp.reference + ' 小時';   // 忘刷卡整天 reference=null，不可印成 "null"
    const dupIgn = (emp.approved && emp.approved.dup_ignore) || [];  // 已認定重複的卡：打卡段已由打卡後端拿掉，這裡註明是哪幾張（2026-11-06）
    const dupNote = dupIgn.length ? '（' + dupIgn.map(t => String(t).slice(11, 16)).sort().join('、') + ' 重複）' : '';
    const capSys = emp.cap_sys || [];                             // 單日滿 10 小時系統代打的下班卡（2026-11-14，打卡 Cap10.gs）
    // 2026-11-23 Eason：系統鎖卡在那一筆打卡時間後面標「（系統鎖定）」（cap-note.js）；對不到打卡段的系統卡才照原本另外註明
    const capLeft = capUnmatched(capSys, emp.segments);
    const capNote = capLeft.length ? '（' + capLeft.join('、') + ' 系統自動補的卡）' : '';
    punchEl.textContent = '打卡：' + emp.segments.map(s => C.segmentText(s) + capLockMark(s.out, capSys)).join('、') + dupNote + capNote + '　' + ref;
    if (capSys.length) nameEl.append(h('span', 'du-capsys', '滿 10 小時・系統自動打下班卡', { title: '這天的下班卡是系統在滿 10 小時時代打的，請照同仁實際離開的時間核定' }));
  } else if (emp.attempts > 0) punchEl.textContent = '今天沒有打卡成功（試了 ' + emp.attempts + ' 次沒成功）';
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
    body.append(h('div', 'du-hrret', '人資退回，要重新核定：' + emp.hr_return.reason + '（' + emp.hr_return.by_name + '）。請核對後重新送出核定，送出就結案。'));
  } else if (emp.return_ok) {
    const rb = h('div', 'du-hrret-box');
    const btn = h('button', 'btn sm ghost du-hrretbtn', '退回給店長重新核定', { type: 'button' });
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
          rb.replaceChildren(h('div', 'du-hrret', '已退回給店長重新核定：' + why + (r && r.lock_unknown ? '（沒辦法確認這個月薪資有沒有鎖定，請自己確認）' : '')));
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
  if (hasOpenSeg) body.append(h('div', 'du-openwarn', '⚠ 有打卡段還沒打下班卡（可能還在上班或跨夜還沒打完），現在核定會核不到這段、且之後補打卡也不會自動更新。請同仁立即打卡避免忘打卡。'));

  // ---- 重複打卡：同一天同型兩張卡相隔 60 分鐘內，店長選以哪張為準（2026-11-06 Eason）。不選＝照系統原判定（算 1 次忘刷），不擋送出 ----
  const dupPicks = C.dupInitialPicks(dupGroups, emp.approved && emp.approved.dup_ignore);
  const dupInit = dupPicks.slice(), dupPaints = [];      // 「取消手動修改」要還原重複打卡的選擇
  dupGroups.forEach((g, gi) => {
    const box = h('div', 'du-dupbox');
    box.append(h('div', 'du-duptitle', '⧉ ' + C.dupGroupTitle(g)),
      (() => { const t = h('div', 'du-duphint'); t.append(tipText('重複打卡就選一張為準', '另一張不算忘打卡，遲到也照選的那張比。不選＝照系統原判定（算 1 次忘打卡）。')); return t; })());
    const opts = h('div', 'du-dupopts');
    const btns = [{ ts: '', label: '不處理' }].concat(g.cards.map(c => ({ ts: c.ts, label: '以 ' + c.hm + ' 為準' }))).map(o => {
      const b = h('button', 'btn sm ghost du-dupopt', o.label, { type: 'button', 'data-ts': o.ts });
      b.disabled = readOnly;
      b.onclick = () => { dupPicks[gi] = o.ts; paint(); if (card.__propose) card.__propose({ user: true }); queueCheck(true); };      // 選了馬上照那張重算、重新檢查（2026-11-15 Eason）
      opts.append(b); return b;
    });
    function paint() { btns.forEach(b => { const on = b.dataset.ts === dupPicks[gi]; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }); }
    paint(); dupPaints.push(paint);
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
  // single：一行步驟說明（原型 .dq-steps），卡片裡「已核准的申請」「待審的申請」都放在它上面、時段在它下面
  const stepsEl = single ? h('div', 'dq-steps') : null;
  if (stepsEl) { ['1. 改上下班時間', '2. 需要時填請假、遲到', '3. 按最下面送出'].forEach((t, i) => { if (i) stepsEl.append('　'); stepsEl.append(h('span', null, t)); }); body.append(stepsEl); }
  body.append(periodRows, totalBox);
  // 「更多」（2026-11-14 第 4 項）：今天沒休息、請假註記、遲到分鐘、加一段平常收起來；有假單、出差、遲到、已填過值就自動打開
  const moreBtn = h('button', 'du-morebtn', '更多：請假、遲到分鐘、加一段 ▾', { type: 'button', 'aria-expanded': 'false' });
  const moreBox = h('div', 'du-morebox'); moreBox.hidden = true;
  const setMore = on => { moreBox.hidden = !on; moreBtn.setAttribute('aria-expanded', on ? 'true' : 'false'); moreBtn.textContent = on ? (single ? '更多' : '收起') + '：請假、遲到分鐘、加一段 ▴' : '更多：請假、遲到分鐘、加一段 ▾'; };      // single：展開後標題不再出現「收起」（2026-11-24）
  // 這台裝置上次是開是關就照著（常用請假欄的人打開一次就一直開著）；localStorage 讀寫失敗＝收起
  const MORE_KEY = 'dzystore_dutymore';
  moreBtn.onclick = () => { setMore(moreBox.hidden); try { localStorage.setItem(MORE_KEY, moreBox.hidden ? '0' : '1'); } catch (e) { /* 記不住就算了 */ } };
  try { if (localStorage.getItem(MORE_KEY) === '1' || readOnly) setMore(true); } catch (e) { /* 預設收起 */ }
  moreBox.append(breakToggle);

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
  const tripHint = h('div', 'du-triphint'); tripHint.append(tipText('出差：填幾小時就核定幾小時', '出差時數會跟上方上班時段相加。出差那段不用再填進上班時段（填了會重複算）；整天出差可以不填上班時段。'));
  function syncLeave() {                            // 時數只在有選假別時可填；出差換提示（manager.html:1376–1386）
    leaveLines.forEach(l => {
      const on = !!l.sel.value;
      l.hours.disabled = !on || readOnly; if (!on) l.hours.value = '';
      l.hours.placeholder = l.sel.value === '出差' ? '出差時數' : '時數';
    });
    tripHint.hidden = !leaveLines.some(l => l.sel.value === '出差');
    addLeaveBtn.hidden = readOnly || leaveLines.length >= C.MAX_LEAVE_LINES;
    refresh();
    if (typeof autoMore === 'function') autoMore();
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
  const lateRow = h('div', 'du-row'); lateRow.append(h('label', null, '遲到分鐘'), lateIn, h('span', 'du-unit', '分鐘'), tipText('留空＝自動', '留空＝照打卡自動判定；填 0＝認定不算遲到；填數字＝照你填的分鐘算。'));
  moreBox.append(leaveBox, tripHint, lateRow);
  body.append(moreBtn, moreBox);
  const autoMore = () => { if (moreBox.hidden && (leaveList().length || lateIn.value !== '' || (emp.approved && /遲到/.test(emp.approved.status_text || '')))) setMore(true); };
  lateIn.addEventListener('input', () => queueCheck());

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
      const over = C.dayLoadOver(emp, total + th, leaveList());        // 照實核定、只標紅（光復每天 09:00 列進通知匣）；開關 CAP10_NEWDEF_ON 開著＝加請假、滿 10 就紅（calc.js dayLoadOver）
      totalBox.classList.toggle('over', over);
      if (over) totalBox.append(h('div', 'du-total-over', C.dayOverText(emp)));
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
    syncLabel();
    queueCheck();
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
  const actions = h('div', 'du-actions'); actions.append(submit);
  moreBox.append(addBtn);
  // ---- single（手動修改只留一條路）：送出鈕帶時數、不能送時在下方寫一句原因、「取消手動修改」還原成系統建議 ----
  let ncLabel = '';      // 「確認沒加班，照班表核定 N 小時」那條路的送出鈕文字（approve.js overBlock）；空＝一般
  const whyEl = single ? h('div', 'du-verdict-n dq-submitwhy', '', { role: 'status' }) : null;
  if (whyEl) whyEl.hidden = true;
  const setWhy = t => { if (!whyEl) return; whyEl.textContent = t || ''; whyEl.hidden = !t; };      // 不能送出時畫在送出鈕下面的一句話（原本只是按鈕的 title 提示）
  const curHours = () => { const { total, filled } = C.sumPeriods(readRows()), th = tripH(); return filled || th ? C.round2(total + th) : null; };
  const subLabel = () => {
    if (!single) return '重新送出核定';      // 完整頁：照舊
    if (ncLabel) return ncLabel;
    const base = card.__pending ? '送出核定' : '重新送出核定';
    const hrs = pendBlocked() ? null : curHours();      // 還有待審單：時數審完才定，不帶時數
    return hrs === null ? base : base + ' ' + hrs + ' 小時';
  };
  if (single) syncLabel = () => { if (!card.__subBusy) submit.textContent = subLabel(); };
  if (readOnly) actions.hidden = true;
  const result = h('div', 'du-result'); result.hidden = true;
  // 規則 4（2026-11-16 起）：核定和打卡差 30 分鐘以上要填原因；伺服器說要填才打開，重新核定帶回上次的原因
  const diffBox = h('div', 'du-proxy du-diffbox');
  const diffIn = h('input', 'du-diff-in', null, { type: 'text', maxlength: '100', placeholder: '核定和打卡不同的原因（必填）', 'aria-label': '核定和打卡不同的原因' });
  diffBox.append(h('div', 'du-proxy-lead', '核定和打卡差 30 分鐘以上，要寫原因才能送出。原因會留在核定紀錄。'), diffIn);
  const prevDiff = emp.approved && emp.approved.diff_reason ? String(emp.approved.diff_reason) : '';
  diffIn.value = prevDiff; diffBox.hidden = !prevDiff;
  if (readOnly) diffIn.disabled = true;
  const preBox = h('div', 'du-pre', null, { role: 'status' }); preBox.hidden = true;      // 送出前檢查的結果與處理按鈕
  body.append(diffBox, preBox, actions);
  if (whyEl) body.append(whyEl);
  body.append(result);
  const say = (cls, text) => { result.className = 'du-result ' + cls; result.hidden = false; result.textContent = text; };
  // single：「系統建議（參考）」一行＝預填完成那一刻的內容（__propose 照打卡＋單算好、申請預填完）；「取消手動修改，回到系統建議」把輸入還原成它。
  //   位置由 quick.js 放在時間軸下面（card.__sysEl）；已核定的卡（重新核定）沒有系統建議，不畫
  const sysEl = single && !emp.approved ? h('div', 'dq-sysref') : null;
  let sysSnap = null;
  const snapNow = () => ({ rows: readRows().map(r => ({ start: r.start, end: r.end })), leaves: leaveList(), late: lateIn.value, diff: diffIn.value });
  const paintSys = () => {
    if (!sysEl) return;
    sysEl.textContent = '';
    const sn = sysSnap, filled = sn ? sn.rows.filter(x => x.start && x.end) : [];
    if (!sn || (!filled.length && !sn.leaves.length)) { sysEl.hidden = true; return; }      // 沒有可建議的時段（沒班表又沒打卡）：不畫
    sysEl.hidden = false;
    const hrs = C.round2(C.sumPeriods(filled).total + C.tripHoursOfList(sn.leaves)), pr = card.__prop;
    sysEl.append('系統建議（參考）：');
    if (!filled.length) sysEl.append('整天請假');
    filled.forEach((x, i) => { if (i) sysEl.append('、'); sysEl.append(h('span', null, x.start + '–' + x.end)); });      // 每一段時間不拆開；後面的「，N 小時，遲到 N 分」照一般文字換行（中文標點不能放行首，整串都不能斷會把手機版撐出橫向捲動）
    sysEl.append('，' + hrs + ' 小時');
    if (pr && pr.late > 0) sysEl.append('，遲到 ' + pr.late + ' 分');
    if (pr && pr.early > 0) sysEl.append('，早退 ' + pr.early + ' 分');
    const pend = card.__pendMine.concat(card.__pendUpper);
    if (pend.length) sysEl.append('；' + [...new Set(pend.map(it => (C.REQ_KIND_LABEL[it.kind] ? C.REQ_KIND_LABEL[it.kind] + '單' : '申請單')))].join('、') + '審完後會重算');
  };
  const markSys = () => { if (!single) return; sysSnap = snapNow(); paintSys(); };
  card.__sysEl = sysEl;
  card.__single = single;
  card.__restoreSys = () => {
    if (!single || !sysSnap) return;
    const sn = sysSnap;
    periodRows.textContent = '';
    sn.rows.forEach(x => periodRows.append(periodRow(x, refresh)));
    setLeaveLines(sn.leaves);      // 內部會 refresh（重算時數、重新檢查）
    lateIn.value = sn.late; diffIn.value = sn.diff; diffBox.hidden = !sn.diff;
    card.__cardPicks = {}; card.__notCount = '';
    dupInit.forEach((v, i) => { dupPicks[i] = v; }); dupPaints.forEach(f => f());
    result.hidden = true; result.textContent = '';
    refresh();
    clearTimeout(card.__checkTimer); card.__checkSeq = (card.__checkSeq || 0) + 1; card.__needRecheck = true;      // 接著就收起來（卡片離開畫面）：現在不送檢查，下次打開才重新檢查
  };
  card.__recheck = () => queueCheck(true);
  if (single) {
    const undo = h('button', 'dq-cancel dq-undo', emp.approved ? '取消手動修改，回到已核定的內容' : '取消手動修改，回到系統建議', { type: 'button' });
    undo.onclick = () => {
      if (card.__subBusy) return;      // 送出進行中不收
      card.__restoreSys();
      card.dispatchEvent(new CustomEvent('duty-manual-cancel', { bubbles: true, detail: { emp_id: emp.emp_id, store: emp.store } }));
    };
    body.append(undo);
  }

  // ---- 送出前先檢查（2026-11-14 第 1 項）：結果畫在卡片右上角（可以送出／要寫原因／會被擋）與 preBox（原因＋處理按鈕） ----
  const CHECK_ERR = { bad_periods: '上班時段格式不對', future_date: '不能核定還沒到的日子', home_review: '這位同仁由所屬部門核定', unauthorized: '沒有權限核定這位同仁' };
  card.__checkItem = () => {
    if (readOnly || !card.__pending || absent || emp.approved) return null;
    const periods = []; let half = false;
    readRows().forEach(r => { if (r.start && r.end) periods.push({ start: r.start, end: r.end }); else if (r.start || r.end) half = true; });
    const lv = leaveList();
    if (half || (!periods.length && !lv.length)) return null;      // 還沒填完：不算
    const it = { emp_id: emp.emp_id, periods, leaves: lv, late_min: lateIn.value };
    if (diffIn.value.trim()) it.diff_reason = diffIn.value.trim();
    if (dupGroups.length) it.dup_ignore = C.dupIgnoreFrom(dupGroups, dupPicks);
    return it;
  };
  // single：檢查結果那一行顯示「檢查中…」、送出鈕暫時不能按（等結果回來整張重畫）。完整頁照舊只標右上角
  const showChecking = () => {
    verdict.hidden = false; verdict.textContent = ''; verdict.className = 'du-verdict gray du-verdict-ck';
    verdict.append(h('div', 'du-verdict-t', '檢查中…', { role: 'status' }));
    submit.disabled = true; submit.title = STALE_TITLE; setWhy('');
  };
  card.__checking = on => {
    if (on && card.__pending) { mini.className = 'du-mini pending'; mini.textContent = '檢查中…'; if (single && !emp.approved && !absent && !pendBlocked()) showChecking(); }
  };
  // 改了時段等，檢查結果還沒回來：舊結果標成過期（淡色、核定鈕與送出鈕停用、右上角「檢查中…」）。結果回來由 __setCheck 整張重畫（它會把送出鈕、提示全部重設）
  card.__markStale = () => {
    if (readOnly || !card.__pending || absent || emp.approved || pendBlocked()) return;      // 這幾種本來就不檢查，或畫面已經在說「待審單」
    const it = card.__checkItem();      // null＝時段還沒填完（只填一邊、整張清空）：不會問打卡系統，送出鈕照舊可按（按了會說明哪裡沒填完），只把舊結果標成過期
    mini.className = 'du-mini pending'; mini.textContent = it ? '檢查中…' : '時段填完才檢查';
    preBox.hidden = true; preBox.className = 'du-pre'; preBox.textContent = '';      // 上一次的逾時提示
    if (!it) { verdict.hidden = true; verdict.textContent = ''; verdict.className = 'du-verdict'; }      // 時段還沒填完：不留舊的通過／未通過框，免得看起來像這個時段的結果
    else if (single) { showChecking(); return; }      // single：舊結果換成「檢查中…」一行，送出鈕停用（結果回來由 __setCheck 整張重畫）
    else if (!verdict.hidden) {
      verdict.classList.add('stale');
      verdict.querySelectorAll('.du-verdict-go').forEach(b => { b.disabled = true; });
      let note = verdict.querySelector('.du-verdict-stale');
      if (!note) { note = h('div', 'du-verdict-n du-verdict-stale', '時段剛改過，下面是改之前的結果，正在重新檢查…', { role: 'status' }); verdict.insertBefore(note, verdict.firstChild); }
    }
    if (it) { submit.disabled = true; submit.title = STALE_TITLE; }
    else if (submit.title === STALE_TITLE) { submit.disabled = false; submit.title = ''; }
  };
  // ---- 打卡＋單＝核定時數（2026-11-14 Eason 定案，docs/punch-plus-req/）：系統先照原則算好時段（core-calc.js），檢查會過＝亮燈「核定通過」，
  //      不會過＝灰底「未符合規定」＋要補齊的單（每項有處理鈕）、核定鈕灰掉；檢查讀不到＝照舊（可以送出，由打卡系統送出時判）
  const verdict = h('div', 'du-verdict'); verdict.hidden = true;
  const leaveWarn = h('div', 'du-leavewarn', '', { role: 'note' }); leaveWarn.hidden = true;
  if (single) body.insertBefore(verdict, moreBtn);      // single：檢查結果在時數下面（時段 → 時數 → 檢查結果 → 更多 → 送出）
  else body.insertBefore(verdict, badge.nextSibling);
  const topAnchor = () => (single ? stepsEl : verdict);      // 卡片裡的待審單、提醒放在這個元素上面
  let editOpen = single;      // single：手動區一直是開的
  const editEls = () => [periodRows, totalBox, moreBtn, actions].concat(moreBox.hidden ? [] : [moreBox]);
  const setEdit = on => { if (single) on = true; editOpen = on; editEls().forEach(x => { x.hidden = !on; }); if (!on) moreBox.hidden = true; else { try { if (localStorage.getItem('dzystore_dutymore') === '1') moreBox.hidden = false; } catch (e) {} } };
  // ---- 這天還有待審的申請：不能核定（2026-11-19）。打卡端不擋待審單（檢查會說可以），所以這裡不看檢查結果：只要還有待審單就換成黃色提示、核定鈕與送出鈕停用。
  //      沒權限核定的人（readOnly）本來就沒有送出鈕，不顯示。判斷「待審單」與一頁核定共用 quick-calc.js pendSplit。
  const PEND_TITLE = '這天還有待審的申請：審完才能送出核定';
  const pendBlocked = () => !readOnly && (!!card.__pendErr || card.__pendMine.length > 0 || card.__pendUpper.length > 0 || card.__recalc > 0);
  const pendWhy = () => (card.__pendMine.length || card.__pendUpper.length || !card.__pendErr ? '這天還有待審的申請，審完才能核定' : card.__pendErr);
  card.__pendBlocked = pendBlocked;
  const pendWord = it => (C.REQ_KIND_LABEL[it.kind] || '') + '單' + (it.start && it.end ? ' ' + it.start + '–' + it.end : '');
  const pendVerdict = () => {
    const mine = card.__pendMine, up = card.__pendUpper;
    verdict.hidden = false; verdict.textContent = ''; verdict.className = 'du-verdict warn du-verdict-pend';
    mini.className = 'du-mini pending'; mini.textContent = mine.length || up.length ? '有待審單' : card.__pendErr ? '待審單讀取中' : '重新計算中…';
    if (!mine.length && !up.length && card.__pendErr) {      // 待審清單沒讀到（讀取中、讀不到、核准後重讀失敗）：不能核定
      verdict.append(h('div', 'du-verdict-t', card.__pendErr));
      if (card.__pendRetry) { const rb = h('button', 'btn sm ghost du-pend-retry', '重新讀取', { type: 'button' }); const f = card.__pendRetry; rb.onclick = () => { rb.disabled = true; f(); }; verdict.append(rb); }
    } else if (mine.length) {
      verdict.append(h('div', 'du-verdict-t', '這天還有 ' + mine.length + ' 張申請沒審：請先在上面核准或退回，審完會自動重新計算'));
      if (up.length) verdict.append(h('div', 'du-verdict-n', '另外還有 ' + up.length + ' 張申請在等上層審核（' + up.map(pendWord).join('、') + '），審完才能核定'));
    } else if (up.length) verdict.append(h('div', 'du-verdict-t', '這天還有 ' + up.length + ' 張申請在等上層審核，審完才能核定（' + up.map(pendWord).join('、') + '）'));
    else verdict.append(h('div', 'du-verdict-t', '單審完了，正在用最新的申請重新計算…'));
    if (!single) {      // single：提示框不帶核定鈕、不帶「收起／手動改時段」，只有最下面那顆送出鈕（灰、下方寫原因）
      const acts = h('div', 'du-pre-acts');
      const go = h('button', 'btn du-verdict-go', '核定（審完單才能按）', { type: 'button' }); go.disabled = true;
      acts.append(go);
      if (card.__pending && !emp.approved) {
        const adj = h('button', 'btn ghost du-verdict-adj', editOpen ? '收起' : '手動改時段', { type: 'button' });
        adj.onclick = () => { setEdit(!editOpen); adj.textContent = editOpen ? '收起' : '手動改時段'; };
        acts.append(adj);
      }
      verdict.append(acts);
    }
    submit.disabled = true; submit.title = PEND_TITLE; setWhy(PEND_TITLE); syncLabel();
    if (card.__pending && !emp.approved) setEdit(editOpen);
    card.dispatchEvent(new CustomEvent('emp-checked', { bubbles: true }));
  };
  // 不再擋了（審完、重新檢查完）：還沒核定的卡片照最新的檢查結果重畫；已核定的卡片只收掉提示、送出鈕恢復
  card.__pendFail = (msg, retry) => { card.__pendErr = msg || '待審的申請讀不到，暫時不能核定'; card.__pendRetry = retry || null; if (!readOnly) pendVerdict(); };
  card.__pendRelease = () => {
    if (card.__pending && !emp.approved) { card.__setCheck(card.__check); return; }
    verdict.hidden = true; verdict.textContent = ''; verdict.className = 'du-verdict';
    submit.disabled = false; if (submit.title === PEND_TITLE) submit.title = '';
    setWhy(''); syncLabel();
  };
  card.__propose = (po) => {      // po.user＝主管自己選了重複打卡哪張：重算時段，但那不是新的「系統建議」（取消手動修改要還原到選之前）
    if (readOnly || !card.__pending || emp.approved || e2eNoCore()) return;
    const pr = corePeriods({ segs: C.segsWithDupPicks(emp.segments, dupGroups, dupPicks), plan: emp.plan, reqs: card.__dayReqs || [], brk: br });
    card.__prop = pr;
    // 假單沒填時段、上班＋假單比班表多（2026-11-18 Eason 第 5 題）：只提醒、不擋
    const lw = leaveOverText(pr);
    if (lw && !leaveWarn.isConnected) body.insertBefore(leaveWarn, topAnchor());
    leaveWarn.textContent = lw; leaveWarn.hidden = !lw;
    if (!pr) return;
    periodRows.textContent = '';
    pr.periods.forEach(x => periodRows.append(periodRow(x, refresh)));
    refresh();
    if (!(po && po.user)) markSys();      // single：這就是「系統建議」
  };
  const NEED_LABEL = (p, need) => {
    if (p.rule === 'ot_hours' && need && need.ot_hours > 0) return '加班單 ' + C.round2(need.ot_hours - (need.ot_have || 0)) + ' 小時';
    if (p.rule === 'miss') return '忘打卡單（' + p.text.replace(/^少了 (\d+) 張打卡.*$/, '$1 張') + '）';
    if (/^ft8/.test(p.rule)) return '假單或補休單 ' + C.round2((need && need.leave_hours) || 0) + ' 小時';
    if (p.rule === 'over_credit') return '沒有打卡的 ' + ((need && need.over_min) || '') + ' 分鐘：忘打卡單、假單或補休單';
    return p.text;
  };
  const DOC_RULES = p => (p.rule === 'ot_hours' && /要有加班單/.test(p.text)) || p.rule === 'miss' || /^ft8/.test(p.rule) || p.rule === 'over_credit';
  const setCheckInner = res => {
    card.__check = res && typeof res === 'object' && typeof res.ok === 'boolean' && res.error !== 'unknown_action' ? res : null;
    preBox.hidden = true; preBox.className = 'du-pre'; preBox.textContent = '';
    submit.classList.remove('du-submit-warn'); submit.disabled = false; setWhy(''); ncLabel = '';
    verdict.hidden = true; verdict.textContent = ''; verdict.className = 'du-verdict';
    if (submit.title === PEND_TITLE || submit.title === STALE_TITLE) submit.title = '';
    if (!card.__pending) { if (pendBlocked()) pendVerdict(); return; }
    if (submit.textContent === '仍要送出' || /^確認沒加班/.test(submit.textContent)) submit.textContent = '送出核定';
    if (pendBlocked()) { pendVerdict(); return; }      // 還有待審單：不看檢查結果（不亮綠燈、不給核定鈕）
    const ck = card.__check;
    if (!ck) { setBadge(null, initLeaves); setEdit(true); card.dispatchEvent(new CustomEvent('emp-checked', { bubbles: true })); return; }
    if (e2eNoCore()) {      // 示範模式舊測試：只標右上角、照舊可以送出
      mini.className = 'du-mini ' + (ck.ok ? 'ok' : 'bad'); mini.textContent = ck.ok ? '核定通過' : '還不能核定';
      if (!ck.ok) { preBox.className = 'du-pre bad'; preBox.hidden = false; preBox.append(h('b', null, '還不能核定：' + String(ck.message || ck.error || '').replace(/^這天還不能核定：/, ''))); }
      card.dispatchEvent(new CustomEvent('emp-checked', { bubbles: true })); return;
    }
    const pr = card.__prop;
    const ps = readRows().filter(r => r.start && r.end).map(r => r.start + '–' + r.end).join('、');
    verdict.hidden = false;
    // 打卡超出班表合計達 30 分鐘、沒有加班單（2026-11-14 Eason 選 B）：不亮燈；補加班單，或主管按「自己調」確認同仁沒加班後照班表送出
    const overBlock = ck.ok && pr && pr.overMin >= OVER_BLOCK_MIN;
    if (overBlock) {
      const noLine = false, canProxy = proxyOpen(date);
      mini.className = 'du-mini bad'; mini.textContent = '還不能核定';
      verdict.className = 'du-verdict gray du-verdict-over';
      verdict.append(h('div', 'du-verdict-t', '還不能核定：要補加班單'));
      verdict.append(h('div', 'du-needk', '要補齊：'));
      const ul = h('ul', 'du-needs'), li = h('li');
      li.append(h('span', 'du-need-t', '☐ 加班單 ' + otSuggestText(pr.over, pr.overMin)));
      if (canProxy) { const b = h('button', 'btn sm ghost du-preproxy', '幫同仁開單', { type: 'button' }); b.onclick = () => proxyForm(date, noLine, '打卡比班表多，沒有加班單'); li.append(b); }
      ul.append(li); verdict.append(ul);
      verdict.append(h('div', 'du-verdict-n', (canProxy ? '' : '有加班：請同仁在 LINE「加班請假」補申請，核准後這裡會自動重算。') + (single ? '沒有加班（例：提早到、晚打卡）：選好下面的原因後，照班表送出 ' : '沒有加班（例：提早到、晚打卡）：按「手動改時段」確認後照班表送出 ') + ck.approved_hours + ' 小時，多出的時段不算。'));
      // single：手動區一直開著，沒有「手動改時段」那顆鈕；下面送出鈕就是「確認沒加班，照班表核定 N 小時」（要先選不算工時的原因才能按）
      if (!single) {
      const acts = h('div', 'du-pre-acts');
      // 只留一條路（2026-11-15 Eason：同一天兩顆核定鈕會混淆）：沒按「自己調」＝灰色「補齊後才能按」；按了「自己調」＝灰色收起，
      // 下面送出鈕改成「確認沒加班，照班表核定 N 小時」（送出前照舊確認框）
      const adj = h('button', 'btn ghost du-verdict-adj', editOpen ? '收起' : '手動改時段', { type: 'button' });
      adj.onclick = () => { setEdit(!editOpen); card.__setCheck(card.__check); };
      if (!editOpen) { const go = h('button', 'btn du-verdict-go', '核定通過（補齊後才能按）', { type: 'button' }); go.disabled = true; acts.append(go); }
      acts.append(adj); verdict.append(acts);
      }
      setEdit(editOpen);
      if (editOpen) {
        submit.textContent = ncLabel = '確認沒加班，照班表核定 ' + ck.approved_hours + ' 小時';
        // 多做的時段不認列要選理由（2026-11-15 開工確認第 2 題）：理由寫進核定紀錄（diff_reason），不通知同仁
        const nc = h('div', 'du-notcount');
        nc.append(h('div', 'du-needk', '不算工時的原因（必選，會留在核定紀錄）'));
        const sel = h('select', 'du-nc-sel', null, { 'aria-label': '不算工時的原因' });
        ['', ...NOT_COUNT_REASONS, '其他'].forEach((t) => sel.append(h('option', null, t || '請選一個', { value: t })));
        const other = h('input', 'du-nc-other', null, { type: 'text', maxlength: '80', placeholder: '其他理由（必填）', 'aria-label': '其他理由' });
        const cur = String(diffIn.value || '').replace(/^不認列：/, '');
        if (/^不認列：/.test(diffIn.value || '')) { if (NOT_COUNT_REASONS.includes(cur)) sel.value = cur; else { sel.value = '其他'; other.value = cur; } }
        other.hidden = sel.value !== '其他';
        const put = () => {
          other.hidden = sel.value !== '其他'; const t = sel.value === '其他' ? other.value.trim() : sel.value; card.__notCount = t; diffIn.value = t ? '不算工時：' + t : '';
          if (single) { submit.disabled = !t; setWhy(t ? '' : NC_WHY); }      // single：沒選原因＝灰色送出鈕，下方寫一句話（不再只靠按了才跳錯誤）
        };
        sel.onchange = put; other.oninput = put; put();
        nc.append(sel, other);
        verdict.append(nc);
      }
    } else if (ck.ok) {
      mini.className = 'du-mini ok'; mini.textContent = '核定通過';
      verdict.className = 'du-verdict ok';
      verdict.append(h('div', 'du-verdict-t', (single ? '✓ 檢查通過：' : '✓ 核定通過：') + (ps || '整天請假') + '＝' + ck.approved_hours + ' 小時'));      // single：這一行不再是按鈕，改叫「檢查通過」
      C.crossNotes(emp, pr && !editOpen ? pr.notes : [], ck.approved_hours).forEach(n => verdict.append(h('div', 'du-verdict-n', n)));   // 跨店加班歸屬提醒（2026-11-18）
      if (!single) {
      const acts = h('div', 'du-pre-acts');
      const go = h('button', 'btn du-verdict-go', '核定 ' + ck.approved_hours + ' 小時', { type: 'button' });
      go.onclick = () => { card.__noConfirm = true; submit.onclick(); };
      const adj = h('button', 'btn ghost du-verdict-adj', editOpen ? '收起' : '手動改時段', { type: 'button' });
      adj.onclick = () => { setEdit(!editOpen); adj.textContent = editOpen ? '收起' : '手動改時段'; };
      acts.append(go, adj); verdict.append(acts);
      }
      setEdit(editOpen);
    } else if (ck.error === 'need_diff_reason') {
      // 每張卡跟核定差超過 30 分鐘（2026-11-16 Eason）：單都齊了，每張卡選一個原因；選好寫進原因欄（diff_reason）→ 重新檢查 → 變「核定通過」
      const cards = Array.isArray(ck.cards) && ck.cards.length ? ck.cards : cardDiffs(emp.segments, readRows().filter(r => r.start && r.end), String(lateIn.value || '').trim() === '' ? null : Number(lateIn.value));      // 主管填的遲到分鐘算已涵蓋（2026-11-18）
      mini.className = 'du-mini pending'; mini.textContent = '要選原因';
      verdict.className = 'du-verdict gray du-verdict-why';
      verdict.append(h('div', 'du-verdict-t', '打卡跟核定差超過 30 分鐘，每張卡選一個原因' + (ps ? '（核定 ' + ps + '）' : '')));
      const box = h('div', 'du-cardask');
      const picks = card.__cardPicks || (card.__cardPicks = {});
      const put = () => { const all = cards.every((x, j) => picks[j]); diffIn.value = all ? cardReasonText(cards, cards.map((x, j) => picks[j])) : ''; if (all) diffIn.dispatchEvent(new Event('input')); };
      cards.forEach((cd, i) => {
        const row = h('div', 'du-cardrow');
        const sel = h('select', 'du-card-sel', null, { 'aria-label': cardLabel(cd) + ' 的原因' });
        ['', ...REASONS, '其他'].forEach(t => sel.append(h('option', null, t || '選原因', { value: t })));
        const other = h('input', 'du-card-other', null, { type: 'text', maxlength: '40', placeholder: '原因（必填）', 'aria-label': cardLabel(cd) + ' 的其他原因' });
        const cur = picks[i] || '';
        if (REASONS.includes(cur)) sel.value = cur; else if (cur) { sel.value = '其他'; other.value = cur; }
        other.hidden = sel.value !== '其他';
        sel.onchange = () => { other.hidden = sel.value !== '其他'; picks[i] = sel.value === '其他' ? other.value.trim() : sel.value; put(); };
        other.onchange = () => { picks[i] = other.value.trim(); put(); };
        row.append(h('span', 'du-cardlab', cardLabel(cd)), sel, other);
        box.append(row);
      });
      verdict.append(box);
      if (!single) {
      const acts = h('div', 'du-pre-acts');
      const go = h('button', 'btn du-verdict-go', '核定（每張卡選好原因後）', { type: 'button' }); go.disabled = true;
      const adj = h('button', 'btn ghost du-verdict-adj', editOpen ? '收起' : '手動改時段', { type: 'button' });
      adj.onclick = () => { setEdit(!editOpen); adj.textContent = editOpen ? '收起' : '手動改時段'; };
      acts.append(go, adj); verdict.append(acts);
      }
      submit.disabled = true; submit.title = '每張卡選好原因才能送出'; setWhy(submit.title);
      setEdit(editOpen);
    } else {
      const msg = String(ck.message || CHECK_ERR[ck.error] || ck.error || '打卡系統不接受');
      const probs = Array.isArray(ck.probs) ? ck.probs : [];
      const payLock = ck.error === 'pay_locked';      // 薪資鎖月（2026-11-15）：不是缺單，寫清楚是鎖月、要到薪資頁解鎖
      mini.className = 'du-mini bad'; mini.textContent = '還不能核定';
      verdict.className = 'du-verdict gray';
      verdict.append(h('div', 'du-verdict-t', payLock ? '這個月薪資已鎖定，不能核定' : '還不能核定' + (ps ? '（照打卡＋單算：' + ps + '）' : '')));
      if (probs.length) {
        const docs = probs.filter(DOC_RULES), fixes = probs.filter(p => !DOC_RULES(p));
        const noLine = /沒綁 LINE/.test(msg), canProxy = noLine || proxyOpen(date);
        if (docs.length) {
          verdict.append(h('div', 'du-needk', '要補齊：'));
          const ul = h('ul', 'du-needs');
          docs.forEach(p => {
            const li = h('li'); li.append(h('span', 'du-need-t', '☐ ' + NEED_LABEL(p, ck.need)));
            if (canProxy) { const b = h('button', 'btn sm ghost du-preproxy', '幫同仁開單', { type: 'button' }); b.onclick = () => proxyForm(date, noLine, msg); li.append(b); }
            ul.append(li);
          });
          verdict.append(ul);
          if (!canProxy) verdict.append(h('div', 'du-verdict-n', '請同仁在 LINE「加班請假」補申請；補好、核准後這裡會自動變成「核定通過」。'));
        }
        if (fixes.length) {
          verdict.append(h('div', 'du-needk', '要處理：'));
          const ul = h('ul', 'du-needs');
          fixes.forEach(p => ul.append(h('li', null, '☐ ' + C.fixText(p, ps))));      // 直接講要怎麼改單（2026-11-15）
          verdict.append(ul, h('div', 'du-verdict-n', '已核准的單要作廢或請同仁改：點上面「已核准的申請」。'));
        }
      } else verdict.append(h('div', 'du-verdict-n', msg.replace(/^這天還不能核定：/, '')));
      if (!single) {
      const acts = h('div', 'du-pre-acts');
      const go = h('button', 'btn du-verdict-go', payLock ? '核定（解鎖後才能按）' : '核定通過（補齊後才能按）', { type: 'button' }); go.disabled = true;
      const adj = h('button', 'btn ghost du-verdict-adj', editOpen ? '收起' : '手動改時段', { type: 'button' });
      adj.onclick = () => { setEdit(!editOpen); adj.textContent = editOpen ? '收起' : '手動改時段'; };
      acts.append(go, adj); verdict.append(acts);
      }
      submit.disabled = true; submit.title = payLock ? '這個月薪資已鎖定：先到薪資頁解鎖才能送出' : '還不能核定：補齊後才能送出'; setWhy(submit.title);      // Eason 定：灰底不能按（自己調也一樣）
      setEdit(editOpen);
    }
    card.dispatchEvent(new CustomEvent('emp-checked', { bubbles: true }));
  };
  card.__setCheck = res => { setCheckInner(res); syncLabel(); };      // single：結果畫完再把送出鈕文字照目前時數、狀態校正一次（完整頁 syncLabel 是空的）
  diffIn.addEventListener('input', () => queueCheck());
  card.addEventListener('emp-approved', () => { preBox.hidden = true; submit.classList.remove('du-submit-warn'); verdict.hidden = true; setEdit(true); });
  /* 超過幾天同仁自己補不了單、才給代開（同打卡端 Requests.gs reqPastLimit_，2026-11-14 Eason）：
     請假／加班／出差／忘打卡都是 4 天（忘打卡 2026-11-14 由 7 改 4）；11/28 以前 11 月的日子同仁都能自己補，不出現代開（打卡端會再判，沒到期限回「請同仁自己申請」）。 */
  const PROXY_AFTER_DAYS = 4;
  const proxyOpen = (dt) => !(C.taipeiToday() <= '2026-11-28' && dt >= '2026-11-01') && dt < C.addDaysStr(C.taipeiToday(), -PROXY_AFTER_DAYS);
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
    // 出差地點（2026-11-17）：跟 LINE 申請頁同一份下拉，薪資照地點決定給不給出差餐費（六個地點不給、其他地點給 100）
    const plPick = h('select', 'du-proxy-plpick', null, { 'aria-label': '出差地點' });
    [['', '出差地點'], ...TRIP_PLACES.map(v => [v, v]), [TRIP_OTHER, '其他（自己填）']].forEach(([v, t]) => plPick.append(h('option', null, t, { value: v })));
    const pl = h('input', 'du-proxy-pl', null, { type: 'text', maxlength: '40', placeholder: '其他地點（例如：廠商）', 'aria-label': '其他出差地點' });
    const la = h('span', 'du-proxy-la'), lb = h('span', 'du-proxy-lb');
    // 加班第二～第四段（2026-11-18 一次填兩段；2026-11-21 加班最多四段）：只有加班單有；多段送出後打卡端拆成好幾張、標同一次送出。請假、出差本來只填時數，不分段（Eason N3）
    //   extra＝已加的段數（0～3）；第 k 段（k＝2～4）的欄位 class：du-proxy-a{k}／du-proxy-b{k}、整列 du-proxy-seg{k}、移除鈕 du-proxy-rm{k}；「＋ 加第N段」鈕 class 一直是 du-proxy-add2
    let extra = 0;
    const SEG_NAMES = ['第一段', '第二段', '第三段', '第四段'];
    const rowsX = [0, 1, 2].map(i => {
      const k = i + 2;
      const ai = h('input', 'du-proxy-a' + k, null, { type: 'time', 'aria-label': SEG_NAMES[i + 1] + '加班開始' }), bi = h('input', 'du-proxy-b' + k, null, { type: 'time', 'aria-label': SEG_NAMES[i + 1] + '加班結束' });
      const rm = h('button', 'du-proxy-rm' + k + ' btn sm ghost', '移除' + SEG_NAMES[i + 1], { type: 'button' });
      const row = h('div', 'du-proxy-row du-proxy-segx du-proxy-seg' + k); row.append(h('span', 'seg-k', SEG_NAMES[i + 1]), h('span', null, '加班開始'), ai, h('span', null, '加班結束'), bi, rm);
      return { a: ai, b: bi, rm, row };
    });
    const add2 = h('button', 'du-proxy-add2 btn sm ghost', '＋ 加第二段', { type: 'button' });
    const segSum = h('div', 'seg-sum du-proxy-segsum');
    const why = h('input', 'du-proxy-why', null, { type: 'text', maxlength: '100', placeholder: '原因（必填）' });
    const go = h('button', single ? 'btn ghost' : 'btn', '送出（幫同仁開單，等總監審核）', { type: 'button' });      // single：整張卡只有最下面那顆「送出核定」是紅色主按鈕，幫同仁開單改白底
    const curSegs = () => [{ start: a.value, end: b.value }].concat(rowsX.slice(0, extra).map(r => ({ start: r.a.value, end: r.b.value })));
    const sync = () => {
      const k = kind.value, ot = k === 'ot', miss = k === 'miss', m = mt.value;
      mt.hidden = !miss; lt.hidden = k !== 'leave'; hr.hidden = k !== 'leave' && k !== 'trip'; plPick.hidden = k !== 'trip'; pl.hidden = k !== 'trip' || plPick.value !== TRIP_OTHER;
      la.textContent = ot ? '加班開始' : m === 'break' ? '回來上班' : '實際上班';
      lb.textContent = ot ? '加班結束' : m === 'break' ? '休息開始（下班）' : '實際下班';
      la.hidden = a.hidden = !(ot || miss) || (miss && m === 'out');
      lb.hidden = b.hidden = !(ot || miss) || (miss && m === 'in');
      const two = extra > 0;
      add2.hidden = !ot || extra >= 3; add2.textContent = '＋ 加' + SEG_NAMES[extra + 1];
      rowsX.forEach((r, i) => { r.row.hidden = !ot || i >= extra; });
      // 合計列：兩段一直顯示；只填一段時，開始、結束都填了就顯示「加班 N 小時」（2026-11-20：原本只有兩段才有，改了時間沒有任何數字跟著變）
      const one1 = ot && !two && !!a.value && !!b.value;
      segSum.hidden = !ot || !(two || one1);
      if (ot && (two || one1)) {
        const v = proxyOtSegs(curSegs(), SEG_MAX_OT_ADMIN);
        segSum.className = 'seg-sum du-proxy-segsum' + (v.ok || !v.total ? '' : ' bad');
        const over = !v.ok && v.total > SEG_MAX_OT_ADMIN && /店長代開最多/.test(v.msg);   // 合計超過上限：一句講完，不重複上限
        const lead = two ? segWord(extra + 1) + '共 ' : '加班 ';
        segSum.textContent = over ? lead + v.total + ' 小時，超過店長代開上限 ' + SEG_MAX_OT_ADMIN + ' 小時'
          : lead + v.total + ' 小時（店長代開上限 ' + SEG_MAX_OT_ADMIN + ' 小時）' + (v.ok || !v.total ? '' : '：' + v.msg);
      }
    };
    add2.onclick = () => { if (extra >= 3) return; extra++; sync(); rowsX[extra - 1].a.focus(); };
    // 移除第 k 段：後面的往前補（填的時間跟著往前），最後一列清空收起來
    rowsX.forEach((r, i) => { r.rm.onclick = () => { for (let j = i; j < extra - 1; j++) { rowsX[j].a.value = rowsX[j + 1].a.value; rowsX[j].b.value = rowsX[j + 1].b.value; } rowsX[extra - 1].a.value = rowsX[extra - 1].b.value = ''; extra--; sync(); }; });
    const timeInputs = [a, b]; rowsX.forEach(r => { timeInputs.push(r.a, r.b); });
    timeInputs.forEach(x => { x.addEventListener('input', sync); x.addEventListener('change', sync); });      // 有些手機的時間欄只在選好收起時才發 change，兩個都接
    // 被擋的原因是正職上班日不滿 8 小時（2026-11-13）：先選好假單、補休、還差的時數（往上取到半小時）
    const gapM = /正職上班日要滿 8 小時[^。]*?還差 ([\d.]+) 小時/.exec(String(why0 || ''));
    if (gapM) {
      kind.value = 'leave';
      if ([...lt.options].some(o => o.value === '補休')) lt.value = '補休';
      hr.value = String(C.ft8Round(Number(gapM[1])));
    }
    kind.onchange = mt.onchange = plPick.onchange = sync; sync();
    go.onclick = async () => {
      const k = kind.value;
      const p = { store: emp.store, emp_id: emp.emp_id, date: d, kind: k, reason: why.value.trim() };
      if (k === 'miss') p.miss_type = mt.value;
      if (k === 'leave') { if (!lt.value) { say('bad', '✕ 請選假別'); return; } p.leave_type = lt.value; }
      if (k === 'leave' || k === 'trip') { if (!(Number(hr.value) > 0)) { say('bad', '✕ 請填時數'); return; } p.hours = Number(hr.value); }
      if (k === 'trip') { const place = plPick.value === TRIP_OTHER ? pl.value.trim() : plPick.value; if (!plPick.value) { say('bad', '✕ 請選出差地點'); return; } if (!place) { say('bad', '✕ 請填出差地點'); return; } p.place = place; p.why = p.reason; }
      const twoSeg = k === 'ot' && extra > 0;      // 兩段以上（最多四段）
      if (!twoSeg) {      // 只填一段：送出的內容、檢查跟以前完全一樣
        if (!a.hidden) p.start = a.value;
        if (!b.hidden) p.end = b.value;
      }
      if ((!a.hidden && !a.value) || (!b.hidden && !b.value)) { say('bad', '✕ 請填時間'); return; }
      let segTxt = '';
      if (twoSeg) {      // 多段：先在這裡擋掉明顯錯的（重疊、相接、合計超過代開上限）；打卡端還會再驗一次，任一段不過張數都不開
        const miss = rowsX.slice(0, extra).findIndex(r => !r.a.value || !r.b.value);
        if (miss >= 0) { say('bad', '✕ 請填' + SEG_NAMES[miss + 1] + '的時間'); return; }
        const v = proxyOtSegs(curSegs(), SEG_MAX_OT_ADMIN);
        if (!v.ok) { say('bad', '✕ ' + v.msg); return; }
        const sorted = v.norm.slice().sort((x, y) => x.a - y.a);
        p.segments = sorted.map(x => ({ start: x.start, end: x.end }));      // 不再另送 start／end：舊的打卡端不認 segments 時會因缺時間而擋，不會默默只開一張
        segTxt = C.shortDate(d) + ' 加班' + segWord(sorted.length) + ' ' + sorted.map(x => x.start + '–' + x.end).join('、') + '（共 ' + v.total + ' 小時）（主管代開）';
      }
      if (!p.reason) { say('bad', '✕ 幫同仁開單要寫原因'); return; }
      go.disabled = true; go.textContent = '送出中…';
      try {
        const res = await call('mgr_req_proxy', p);
        say('ok', '✓ 已幫同仁開單：' + ((twoSeg && res.summary) || segTxt || res.summary) + '。等總監在「申請審核」核准後，再回來送出核定。還缺別張單的話，再按一次「送出核定」就能繼續幫同仁開單。' + (k === 'leave' ? '需要附證明的假別，請同仁在 LINE「我的申請」補附。' : ''));
        proxyBox.remove(); proxyBox = null;
      } catch (e) { say('bad', '✕ 開單失敗：' + e.message); go.disabled = false; go.textContent = '送出（幫同仁開單，等總監審核）'; }
    };
    proxyBox.append(h('div', 'du-proxy-lead', (noLine ? '這位同仁沒綁 LINE，自己補不了單。' : '這天已超過 ' + PROXY_AFTER_DAYS + ' 天，同仁自己補不了單。') + '可以幫同仁開單，幫同仁開的單要由總監（品牌總監／廚藝總監；總部是人資主管）核准。'),
      h('div', 'du-proxy-row', null), why, go);
    proxyBox.children[1].append(kind, mt, lt, hr, plPick, pl, la, a, lb, b);
    rowsX.forEach(r => { proxyBox.insertBefore(r.row, why); }); proxyBox.insertBefore(add2, why); proxyBox.insertBefore(segSum, why);
    sync();
    result.after(proxyBox);
  };

  // 打卡端擋下時給主管下一步：差 30 分鐘以上打開原因欄；「這天還不能核定」且可代開（沒綁 LINE 或超過 7 天）打開代開表單。前景失敗、背景被退回共用（2026-11-14）
  // 回 true＝已打開可以直接處理的欄位（不用重新載入）
  function failHelp(msg, approveDate) {
    if (/薪資已鎖定/.test(msg)) {                        // 薪資鎖月（2026-11-15）：下一步是到薪資頁解鎖，重新載入這天沒有用，不給那顆鈕
      if (card.__pending) card.__setCheck({ emp_id: String(emp.emp_id), ok: false, error: 'pay_locked', message: msg });      // 先檢查時還沒鎖、送出才被擋：卡片改成鎖月的灰框（核定鈕灰掉），不留綠色「核定 N 小時」
      card.dispatchEvent(new CustomEvent('emp-pay-locked', { bubbles: true, detail: { emp_id: emp.emp_id, store: emp.store, date: approveDate, msg } }));      // 新頁（quick.js）：這個人改列「現在不能核定」
      return true;
    }
    if (readOnly) return false;
    if (/^核定和打卡差/.test(msg)) { diffBox.hidden = false; diffIn.focus(); return true; }
    const noLine = /沒綁 LINE/.test(msg);                // 打卡端判斷的：沒綁 LINE 的同仁 7 天內也能代開（2026-11-09）
    if (/^這天還不能核定/.test(msg) && (noLine || proxyOpen(approveDate))) { proxyForm(approveDate, noLine, msg); return true; }
    return false;
  }

  // 背景送出（考勤副本）：先標「已核定・送出中」，可以繼續核下一位；打卡系統接受了換成正式結果，退回就標紅、請重新載入這天
  function bgQueued(job, approveDate, lv) {
    if (lv.length || initLeaves.length) staleLeave();
    badge.className = 'du-badge sending'; badge.hidden = false; badge.textContent = '已核定・送出中（背景送到打卡系統）';
    mini.className = 'du-mini sending'; mini.textContent = '送出中';
    say('ok', '✓ 已核定，正在背景送到打卡系統，可以繼續核下一位');
    card.__pending = false;
    planDone = true; if (card.__planR) card.__showPlan(card.__planR);
    const qp = readRows().filter(r => r.start && r.end).map(r => ({ start: r.start, end: r.end }));
    card.dispatchEvent(new CustomEvent('emp-approved', { bubbles: true, detail: { emp_id: emp.emp_id, date: approveDate, store: emp.store, queued: true, hours: C.round2(C.sumPeriods(readRows()).total + tripH()), periods: qp } }));
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
      if (!failHelp(it.msg || '', approveDate)) {      // 規則擋下（要填原因、要代開單）照前景打開原因欄／代開表單；只有資料變了才要重新載入
        const rb = h('button', 'btn sm du-bgreload', '重新載入這天', { type: 'button' });
        rb.onclick = () => card.dispatchEvent(new CustomEvent('duty-reload-day', { bubbles: true, detail: { date: approveDate, emp } }));
        result.append(rb);
      }
    });
  }

  submit.onclick = async () => {
    if (pendBlocked()) { pendVerdict(); return say('bad', '✕ ' + pendWhy()); }      // 所有送出的路（送出鈕、綠燈「核定 N 小時」、手動改時段後的送出、重新核定）都從這裡過
    if (/^確認沒加班/.test(submit.textContent) && !card.__notCount) return say('bad', '✕ 請先選不算工時的原因（會留在核定紀錄）');
    // 硬擋（Eason 2026-08-22「硬擋，不給送出」，manager.html:1296–1320）：額度用完、期限過了的假別不給送出。
    // 下拉的 disabled 只擋滑鼠，程式指定仍設得進去，所以送出前用同一份資料再判一次；原本就選著這個假別的既有紀錄放行，否則已超額的人連重送核定都做不了
    const lv = leaveList();
    const dupT = C.dupLeaveType(lv);
    if (dupT) return say('bad', '✕ 「' + dupT + '」選了兩次，同一種假別請合併成一列（時數加起來）。');
    const mensOver = C.menstrualDayOverText(lv);      // 生理假一天最多 8 小時（跟一頁核定同一句；後端也擋，這裡先擋免得送出才被退回）
    if (mensOver) return say('bad', '✕ ' + mensOver + '，無法送出。');
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
    // 第三輪審查：送出的內容以「現在畫面上的」為準；中間每個等待（確認框、重讀）之後都要跟這份一樣才送
    const formNow = () => { const ps = []; periodRows.querySelectorAll('.du-prow').forEach(r => { const a = r.querySelector('.p-start').value, b = r.querySelector('.p-end').value; if (a && b) ps.push([a, b]); }); return JSON.stringify([ps, leaveList(), lateIn.value, diffIn.value.trim(), JSON.stringify(dupPicks || null)]); };
    const form0 = formNow();
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
      if (hasOpenSeg) warnings.push('・這天有打卡段還沒打下班卡，現在核定可能會核不到那一段，且之後補打卡不會自動重算——請同仁立即打卡避免忘打卡。');
      let msg = '即將核定 ' + emp.name + '：\n' + segs.map(s => s.start + '–' + s.end).join('、')
        + (t2 ? '\n上班 ' + totalH + ' 小時＋出差 ' + t2 + ' 小時\n核定時數共 ' + C.round2(totalH + t2) + ' 小時' : '\n核定時數共 ' + totalH + ' 小時');
      if (C.dayLoadOver(emp, totalH + t2, lv)) msg += '\n⚠ ' + C.dayOverText(emp);      // 同上面的紅字（開關關著＝跟改之前逐字相同）
      const cw2 = C.contBreakWarn(periods);
      if (cw2) msg += '\n⚠ ' + C.contBreakText(cw2);
      const dupLine = C.dupConfirmLine(dupGroups, dupPicks);
      if (dupLine) msg += '\n' + dupLine;
      if (periodRows.querySelector('.du-break')) msg += '\n（休息 ' + br.start + '–' + br.end + ' 不計入）';
      const noted = lv.filter(x => !(x.type === '出差' && Number(x.hours) > 0));      // 沒算進核定的假別（出差以外、或沒填時數的出差）列出來給主管看
      if (noted.length) msg += '\n' + (noted.every(x => x.type === '出差') ? '註記' : '請假') + '：' + C.leavesText(noted);
      if (warnings.length) msg += '\n\n⚠ 請再確認：\n' + warnings.join('\n');
      const skip = card.__noConfirm; card.__noConfirm = false;      // 「核定 N 小時」綠燈：已先檢查過會過，不跳確認框
      if (!skip && !await confirmBox(msg + '\n\n確定送出?', '送出')) return;
    }
    // 畫面是伺服器先給的副本舊值（2026-11-19）：送出前先向打卡重讀這位同仁這天，跟畫面不一樣就不送（一頁核定由 quick.js 傳 __beforeSubmit；完整頁用 freshCheck）
    {
      const chk = card.__beforeSubmit || (S.dayMirrorStale || S.dayReqStale || S.dayPendStale || S.leaveMirrorStale ? () => freshCheck(emp, date, card) : null);
      if (chk) {
        submit.disabled = true; submit.textContent = '確認最新資料…';
        let okGo = false, why = '';
        try { const r = await chk(); okGo = r === true; why = typeof r === 'string' ? r : ''; } catch (e) { why = '讀不到打卡系統的最新資料，這次沒有送出，請稍後再試'; }
        submit.disabled = false; submit.textContent = subLabel();
        if (!okGo) { say('bad', '✕ ' + (why || '資料剛更新，請確認後再送')); return; }
      }
      if (emp.ver_req && !(typeof emp.ver === 'string' && emp.ver)) { say('bad', '✕ 這位同仁這天的資料版本讀不到，這次沒有送出，請重新整理後再按一次'); return; }      // 一律要帶版本（審查 R2）
      submit.disabled = true; submit.textContent = '確認最新資料…';
      let lq; try { lq = await leaveFreshOk(emp, date, leaveList(), initLeaves); } catch (e) { lq = '假別額度讀不到，含請假的核定這次沒有送出，請稍後再試'; }
      submit.disabled = false; submit.textContent = subLabel();
      if (lq !== true) { say('bad', '✕ ' + lq); return; }
    }
    // 最後一個 await 之後再檢查一次（第三輪審查）：卡片還在畫面上、還是目前這天；待審單（重讀時可能剛送來）；內容跟確認時一樣
    if (!card.isConnected || (card.__current && !card.__current())) { say('bad', '✕ 畫面剛更新，這次沒有送出，請確認後再按一次'); return; }
    if (pendBlocked()) { pendVerdict(); return say('bad', '✕ ' + pendWhy()); }
    if (formNow() !== form0) { say('bad', '✕ 時段或假別剛有變動，這次沒有送出，請確認後再按一次'); return; }
    clearTimeout(card.__checkTimer); card.__checkSeq = (card.__checkSeq || 0) + 1;      // 送出了：還沒回來的檢查結果作廢，不蓋掉送出的結果
    submit.disabled = true; submit.textContent = '送出中…';
    const approveDate = date;                       // 送出當下鎖定日期，避免回呼時已切到別天
    try {
      const payload = { store: emp.store, date: approveDate, emp_id: emp.emp_id, periods, late_min: lateIn.value, leaves: lv };
      if (diffIn.value.trim()) payload.diff_reason = diffIn.value.trim();
      if (dupGroups.length) payload.dup_ignore = C.dupIgnoreFrom(dupGroups, dupPicks);   // 有重複卡組才送（空陣列＝取消認定）；沒有就不送，打卡端沿用原本的
      if (typeof emp.ver === 'string' && emp.ver) payload.base_ver = emp.ver;      // 所有送出核定一律帶版本（2026-11-19；上面已擋：伺服器要求版本時沒有就不送）：畫面看的資料跟打卡端現在的不一樣就退回，不會照舊資料核定
      if (typeof emp.calc_ver === 'string' && emp.calc_ver) payload.calc_ver = emp.calc_ver;      // 營運系統的班表版本（審查 R4）：伺服器比對當下班表
      if (canBg(emp)) payload.bg = true;      // 資料是 Mac mini 副本讀的：先顯示、背景送（2026-11-14）
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
      if (isSyncCancelled(e)) return;      // 畫面已換（資料更新中被取消）：不顯示
      say('bad', '✕ 核定失敗：' + e.message);
      failHelp(e.message, approveDate);
    }
    finally { submit.disabled = !!(card.__pending && card.__check && card.__check.error === 'pay_locked' && !e2eNoCore()); submit.textContent = subLabel(); }      // 薪資鎖月：送出鈕維持不能按
  };
  // 送出流程進行中（含確認框、重讀額度那幾個 await）：逾時後晚到的檢查結果不可重畫這張卡、不可動送出鈕
  { const submitRun = submit.onclick; submit.onclick = async () => { card.__subBusy = true; try { return await submitRun(); } finally { card.__subBusy = false; } }; }

  function setExpanded(on) { body.hidden = !on; card.classList.toggle('open', on); head.setAttribute('aria-expanded', on ? 'true' : 'false'); }
  setBadge(emp.approved, initLeaves);
  setExpanded(false);
  card.__pending = !emp.approved;
  card.__hasPunch = hasPunch;
  card.__absent = absent;
  card.__setExpanded = setExpanded;
  markSys(); syncLabel();      // single：這一刻（班表預填）就是系統建議的起點；之後 __applyReq、__propose 預填完會再記一次

  // ---- 已核准的申請（2026-10-09，照 manager.html __applyReq）：還沒核定就幫主管預填；已核定過不覆蓋，改給一顆「依申請重新填」。
  //      預填只是畫面上的值，主管按送出核定才算數（核准申請本身不寫入核定）。加班在上班日接在班表後面（2026-11-09）；
  //      班表排休那天（2026-10-29）加班申請的時段就是當天工時 → 依加班申請預填、標「來自加班申請」，並收掉補申請提示。
  // 卡片裡審申請（第 2 項）：核准後重讀那天已核准的申請、重新預填，再重算送出前檢查
  card.__applyPending = (list, all) => {
    const old = body.querySelector('.du-inreq'); if (old) old.remove();
    // 這天還有哪些待審單：list＝列在卡片裡的（自己看得到、不是本人送的）、all＝連本人的、只給最小列的也算（沒給就用 list）
    const onlyErr = !!card.__pendErr && !card.__pendMine.length && !card.__pendUpper.length && !card.__recalc;      // 只是「待審清單還沒讀到／讀不到」在擋
    const was = pendBlocked();
    card.__pendErr = ''; card.__pendRetry = null; card.__pendAll = (all || list || []).slice();      // 讀到待審清單了
    const sp = pendSplit((all || list || []).map(it => Object.assign({}, it, { pending: true, decidable: reqCanDecide(it) })));
    card.__pendMine = sp.mine; card.__pendUpper = sp.upper;
    paintSys(); syncLabel();      // single：系統建議那行有待審單時多寫「…審完後會重算」；送出鈕文字（待審單擋著＝不帶時數）
    if (pendBlocked()) pendVerdict();
    else if (was && onlyErr && !card.__check) { if (verdict.classList.contains('du-verdict-pend')) { verdict.hidden = true; verdict.textContent = ''; verdict.className = 'du-verdict'; setBadge(emp.approved, initLeaves); } submit.disabled = false; if (submit.title === PEND_TITLE) submit.title = ''; }      // 還沒檢查過：只收掉「讀取中」，等檢查結果再畫（不打開手動修改）
    else if (was) card.__pendRelease();
    if (!list.length) return;
    const box2 = h('div', 'du-inreq');
    box2.append(h('div', 'du-inreq-k', '這天還沒審的申請（' + list.length + ' 張）'));
    list.forEach(it => box2.append(buildReqItem(it, decision => {
      S.reqAt = 0; refreshReqBadge();      // 申請審核分頁的數字跟著更新
      // 這張審完了（核准或退回）：從待審名單拿掉；單都審完（上層那種也沒有）才恢復，但要等重讀申請、重新檢查完（__recalc）才給核定，不拿審單前的結果亮燈
      card.__pendMine = card.__pendMine.filter(x => !(String(x.id) === String(it.id) && (x.store || '') === (it.store || '')));
      if (!card.__pendMine.length && !card.__pendUpper.length) card.__recalc = 1;
      paintSys(); syncLabel();
      if (pendBlocked()) pendVerdict();
      const rechecking = () => { if (card.__recalc === 1) card.__recalc = 2; queueCheck(true); };
      if (decision !== 'approve') { rechecking(); return; }
      // 核准後重讀那天已核准的申請：讀不到就維持不能核定（第三輪審查；原本讀不到也解鎖），提示裡可重讀
      const reload = () => {
        card.__pendErr = ''; card.__pendRetry = null; card.__recalc = 1; if (pendBlocked()) pendVerdict();
        call('mgr_req_day', Object.assign({ date }, emp.store ? { store: emp.store } : {})).then(res => {
          if (!card.isConnected) return;
          const by = (emp.store && res && res.by_store && res.by_store[emp.store]) ? res.by_store[emp.store].by_emp : (res && res.by_emp);
          if (!by || (Array.isArray(res.failed) && res.failed.length)) throw new Error('部分讀不到');
          card.__reqApplied = false;
          card.__applyReq(by[emp.emp_id] || []);
          if (card.__propose) card.__propose();      // 核准的單算進「打卡＋單」
          rechecking();
        }).catch(() => { if (card.isConnected) card.__pendFail('核准好了，但重新讀取已核准的申請失敗，暫時不能核定', reload); });
      };
      reload();
    })));
    body.insertBefore(box2, topAnchor());      // 待審單放在提示上面（提示寫「在上面核准或退回」）；single：放在步驟說明上面
  };
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
    if (card.__rbox) card.__rbox.remove();      // 卡片裡核准後重套：換掉舊的那一框
    // 已核定過、而且核定跟申請單一致（2026-11-15）：綠框寫「核定已跟申請單一致」、不給「依申請重新填」、一開始收起
    const matched = !!emp.approved && !multi && C.approvedMatchesReqs(initLeaves, emp.approved.periods, reqs);
    const rbox = h('div', 'du-reqbox' + ((emp.approved && !matched) || multi ? ' warn' : ''));
    if (matched) rbox.append(h('div', 'du-reqmatch', '✓ 核定已跟申請單一致'));
    card.__rbox = rbox;
    if (multi) rbox.append(h('div', 'du-reqlead', '⚠ 這天有 ' + fillables.length + ' 張已核准的申請，其中有同一種的（多半一張是舊單），系統不自動填：請把舊的或重複的按「作廢」，剩下的會自動填好；或按「依這張填」只填那一張。'));
    const note = h('div', 'du-reqnote'); note.hidden = true;
    const setNote = t => { note.textContent = t; note.hidden = !t; };
    let tag = null;
    const canVoid = !readOnly || canWriteRow('req', emp.emp_id, emp.store) || canVoidRow(emp.emp_id, emp.store);     // 能核他工時、或能審他申請的人（Eason 2026-10-29 選 2A）、或有考勤作廢（2026-11-13）；伺服器再驗一次
    const hrsSum = C.reqHoursSummary(reqs);
    reqs.forEach(r => {
      const row = h('div', 'du-reqrow');
      const line = h('div', null, '✓ 已核准的申請：' + r.summary + '（' + r.decided_by + ' 核准）');
      const segT = approvedSegTag(reqs, r);      // 同一次送出的兩段（2026-11-18）：只在這一列後面標「第 N／M 段」，不影響上面任何計算
      if (segT) line.append(h('span', 'seg-tag du-seg-tag', '同一次送出 第 ' + segT.n + '／' + segT.m + ' 段'));
      row.append(line);
      const dupR = hrsSum.dup[r.id];      // 加班單和出差／請假同時段：加班單是超過 8 小時的憑證要留著，但時數不另計
      if (dupR) row.append(h('div', 'du-reqdup', dupR.full ? '加班單與' + dupR.by + '同時段，不另計' : '加班單有 ' + dupR.min + ' 分鐘與' + dupR.by + '同時段，這段不另計'));
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
        const vb = h('button', 'btn sm ghost du-reqvoid', '作廢', { type: 'button', title: '作廢＝這張單不算' });
        // 伺服器有給 void_ok（個人登入）就照它；沒有（門市登入、舊伺服器）就保守：值班主管本人與自己的單停用（2026-10-29 Fable 審查第 1 條）
        if (r.void_ok === false && readOnly && !canWriteRow('req', emp.emp_id, emp.store)) { vb.disabled = true; vb.textContent = '不能作廢'; vb.title = '自己的單、主管幫同仁開的單不能作廢'; }      // 考勤作廢的唯讀者（2026-11-13 審查 7）
        else if (r.void_ok === false || (r.void_ok === undefined && (r.upper === true || r.self === true))) { vb.disabled = true; vb.textContent = '交給上一層主管處理'; vb.title = '值班主管本人的申請，由上層主管在申請審核處理'; }
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
    // 作廢回應不確定（逾時、連線中斷、打卡端說找不到這筆已核准的）：可能其實已經作廢
    const voidUncertain = (e) => !!e && (['TIMEOUT', 'UPSTREAM', 'NETWORK', 'NOT_FOUND'].includes(e.code) || !e.code || /逾時|太久|沒有回應|連線|網路/.test(e.message || ''));
    // 重讀那天的申請：這張已不在「已核准」裡＝已作廢（讀不到就不知道，回 false 照原本顯示失敗）
    async function voidDone(id, date, store) {
      try {
        const d = await call('mgr_req_day', store ? { date, store } : { date });
        const by = (d && d.by_emp) || {};
        for (const list of Object.values(by)) for (const q of (Array.isArray(list) ? list : [])) if (q && String(q.id) === String(id) && q.status !== 'voided') return false;
        return !!(d && d.by_emp);
      } catch (e) { return false; }
    }
    function askVoid(r, vb, row) {                  // 作廢理由（必填，同仁在 LINE「我的申請」看得到）：就地開輸入框，不用 prompt（嵌入頁的 prompt 不一定能跳）
      if (row.querySelector('.du-voidreason')) return;
      const inp = h('input', 'du-voidreason', null, { type: 'text', maxlength: '100', placeholder: '作廢理由（必填，同仁在 LINE 看得到）', 'aria-label': '作廢理由' });
      const go = h('button', 'btn sm du-voidgo', '確定作廢', { type: 'button' });
      const box2 = h('div', 'du-voidbox');
      if (emp.approved) box2.append(h('div', 'du-voidwarn', '這天已經核定過。作廢後，這天的核定會打回「待核定」，原本核定的工時、假別、出差、加班也會一起拿掉，請重新核定。'));      // 打卡端作廢連動打回核定（2026-11-14 Eason 1A）
      box2.append(inp, go); row.append(box2); inp.focus();
      go.onclick = async () => {
        const why = inp.value.trim();
        if (!why) return setNote('✕ 作廢要寫理由');
        go.disabled = vb.disabled = true; setNote('作廢中…');
        try {
          let vr;
          try { vr = await call('mgr_req_void', { id: r.id, reason: why, date, store: emp.store }); }
          catch (e) {
            // 逾時、連線中斷、或「找不到這筆已核准的申請」：打卡端可能其實已經作廢了（2026-11-16 墨竹亭光復：打卡端忙，40 秒逾時但已作廢，重按變「找不到」）。
            // 重讀那天的申請確認：這張已不在已核准裡＝當作作廢成功（那天的核定可能已打回待核定，一律請主管重新載入）
            if (!voidUncertain(e)) throw e;
            setNote('回應太慢，確認作廢結果中…');
            if (!(await voidDone(r.id, date, emp.store))) throw e;
            vr = { revoked: { approved: 1, leave: 0 }, confirmed: true };
          }
          const rv = vr && vr.revoked, revokedN = rv ? (Number(rv.approved) || 0) + (Number(rv.leave) || 0) : 0;
          if (revokedN) {                                  // 那天的核定被打回：這張卡片的內容與版本都是舊的，請主管重新載入再核定（照舊卡片送出會被「資料有變動」退回）
            rbox.remove(); delete S.dayCache[date];
            const done = h('div', 'du-reqbox warn du-voided', vr.confirmed ? '已作廢：' + r.summary + '（剛才回應太慢，已向打卡系統確認作廢成功）。這天若已核定過會打回「待核定」，請按「重新載入這天」看最新資料，照實際打卡重新核定。' : '已作廢：' + r.summary + '。這天的核定已打回「待核定」，請按「重新載入這天」看最新資料，照實際打卡重新核定。');
            const rl = h('button', 'btn sm', '重新載入這天', { type: 'button' });
            rl.onclick = () => card.dispatchEvent(new CustomEvent('duty-reload-day', { bubbles: true, detail: { date, emp } }));
            done.append(' ', rl);
            periodRows.parentNode.insertBefore(done, periodRows);
            card.querySelectorAll('.du-submit').forEach(b => { b.disabled = true; b.title = '請先重新載入這天'; }); setWhy('請先重新載入這天');
            return;
          }
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
    if (!multi && fillable && emp.approved && !matched) {
      const b = h('button', 'du-reqfill', '這天已核定過，依申請重新填', { type: 'button' });
      if (readOnly) b.hidden = true;
      b.onclick = () => { fill(fillables); b.remove(); setNote('已依申請填好，確認後按送出核定。'); };
      rbox.insertBefore(b, note);
    } else if (!multi && fillable && !emp.approved) { fill(fillables); markSys(); }
    periodRows.parentNode.insertBefore(rbox, single ? stepsEl : (tag || periodRows));    // 順序：申請說明 → 來自申請 → 時段（single：申請說明 → 步驟說明 → 來自申請 → 時段）
    // 已核准的申請收成一行（2026-11-14）：點開才看每張與作廢鈕；有多張同類要主管選、或已核定過要重填的才一開始就打開
    if (card.__rline) card.__rline.remove();
    const KL = { ot: '加班', leave: '請假', trip: '出差', miss: '忘打卡' };
    const kinds = [...new Set(reqs.map(r => KL[r.kind] || '申請'))].join('、');
    const hrs = hrsSum.hours;      // 加班單跟同日出差／請假同時段的部分不重複計入（2026-11-24）
    const rline = h('button', 'du-reqline', null, { type: 'button', 'aria-expanded': 'false' });
    rline.append(h('span', null, '✓ 已核准' + kinds + ' ' + reqs.length + ' 張' + (hrs ? '，共 ' + hrs + ' 小時' : '')), h('span', 'du-reqline-more', '明細、作廢 ▸'));
    const openR = on => { rbox.hidden = !on; rline.setAttribute('aria-expanded', on ? 'true' : 'false'); rline.lastChild.textContent = on ? '收起 ▴' : '明細、作廢 ▸'; };
    rline.onclick = () => openR(rbox.hidden);
    openR(!!(multi || (emp.approved && !matched) || e2eNoCore()));      // 示範模式舊測試（dzystore_core＝0）照舊打開
    rbox.parentNode.insertBefore(rline, rbox);
    card.__rline = rline;
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
