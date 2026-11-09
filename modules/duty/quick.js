// 考勤管理「手機一頁核定」（核定工時分頁在手機寬度 ≤860px 的新畫面；規格 docs/duty-quick/requirements.md，2026-11-09 Eason 定案）。
// 一頁完成：沒問題的人一鍵核定、有異常的人一人一張卡按一下完成、少打卡又沒單的人先擋住。舊畫面（approve.js）完整保留當退路。
// 規則都在 quick-calc.js（純函式，有單元測試）；這裡只負責讀資料、畫畫面、依序呼叫既有的 mgr_approve／mgr_req_decide／mgr_req_proxy。
import { S, call, h, failBar, failedStores, supportTag, loadLeave, staleLeave, leaveFor, canWriteRow, brk, dutyManager, dutyHours, viewNoHoursStore } from './state.js';
import * as C from './calc.js';
import * as Q from './quick-calc.js';
import { qrButton } from './qr.js';
import { MOCK } from '../../js/config.js';

// 總開關：改成 false、重新發布網站，手機也回到舊畫面（不必動別的）
export const QUICK_ON = true;

const SKIP_KEY = 'dzystore_dutyquick_skip';     // 「先跳過」只存在這個分頁（sessionStorage），不寫任何資料
// 完整頁都只進去這一次，不記住（2026-11-09 Eason：切分頁不該跑回舊畫面）。這個值只有示範模式看：其他 e2e 用它預設停在舊畫面，正式網站不讀
const e2eFull = () => { if (!MOCK) return false; try { return localStorage.getItem('dzystore_dutyview') === 'full'; } catch (e) { return false; } };
const skipGet = () => { try { return JSON.parse(sessionStorage.getItem(SKIP_KEY) || '{}') || {}; } catch (e) { return {}; } };
const skipPut = (m) => { try { sessionStorage.setItem(SKIP_KEY, JSON.stringify(m)); } catch (e) {} };
const skipSet = (k) => { const m = skipGet(); m[k] = 1; skipPut(m); };
const skipDel = (keys) => { const m = skipGet(); keys.forEach((k) => delete m[k]); skipPut(m); };

// 這個人、這個畫面能不能用一頁核定：手機寬度、單一門市、不是管理者代看、有核定工時的對象。全部門市與管理者各店總覽維持舊畫面。
export function quickAvailable(ctx) {
  const s = ctx && ctx.session;
  return QUICK_ON && !!s && typeof window.matchMedia === 'function' && window.matchMedia('(max-width:860px)').matches
    && !S.all && !S.admin && s.role !== 'admin' && dutyHours(s) && !viewNoHoursStore(s);
}
export const quickWanted = (ctx) => quickAvailable(ctx) && !S.dqFull && !e2eFull();

const REQ_CLS = { leave: 'leave', ot: 'ot', trip: 'trip', miss: 'miss' };
const taipeiMin = () => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':'); return Number(p[0]) * 60 + Number(p[1]); };
const hid = (it) => String(it.id) + '|' + (it.store || '');

export function renderQuick(ctx) {
  const el = ctx.el;
  const root = h('div', 'dq');
  el.innerHTML = ''; el.append(root);
  const live = () => el.isConnected;
  const todayNow = () => C.taipeiToday();      // 每次用都重算（頁面開過午夜也不會差一天）
  const skipKey = (date, key) => ((ctx.session && ctx.session.code) || '') + '|' + ((S.meta && S.meta.clockStore) || '') + '|' + date + '|' + key;      // 加店別：同一分頁換店，別家同員編的人不會被跳過
  const st = { tok: 0, busy: false, loading: true, error: null, date: null, emps: [], people: [], appr: {}, pending: [], handled: new Set(),
    failed: [], capped: false, manual: null, skipN: 0, loadedAt: Date.now(), loadedToday: '',
    toast: '', failLine: '', extra: [], progress: '', showReq: false, ui: {}, reqMsg: {}, reqReject: {} };
  const U = (k) => st.ui[k] || (st.ui[k] = {});
  const empOf = (key) => st.emps.find((e) => Q.keyOf(e) === key);

  // ---------- 資料 ----------
  function reqsFor(emp) {
    const key = Q.keyOf(emp);
    const appr = (st.appr[key] || []).map((r) => Object.assign({}, r, { pending: false, decidable: true }));
    const pend = st.pending.filter((it) => it.date === st.date && Q.keyOf(it) === key && !st.handled.has(hid(it)))
      .map((it) => Object.assign({}, it, { pending: true, decidable: Q.reqDecidable(it, canWriteRow) }));
    return appr.concat(pend);
  }
  function classifyOne(emp) {
    const key = Q.keyOf(emp), u = U(key);
    const p = Q.classify({ emp, date: st.date, today: todayNow(), nowMin: taipeiMin(), brk: brk(emp.store), LO: leaveFor(emp.store), canHours: canWriteRow('hours', emp.emp_id, emp.store),
      reqs: reqsFor(emp), skipped: !!skipGet()[skipKey(st.date, key)], mismatch: u.mismatch || '', person: !!(ctx.session && ctx.session.person) });
    if (p.status === 'ok' && u.failed) {                      // 一鍵核定沒成功的人：回到異常區
      const main = Object.assign({}, p.actions[0] || { id: 'plan', hours: p.hours, payload: p.payload });
      main.primary = true; main.askReason = !!u.failedDiff; main.label = '再核定一次 ' + C.round2(p.hours) + ' 小時' + (u.failedDiff ? '（選原因）' : '');
      Object.assign(p, { status: 'abnormal', tag: '沒核定成功', note: u.failed, actions: [main, { id: 'full', label: '到完整頁核對', primary: false }] });
    }
    return p;
  }
  function recompute() { st.people = st.emps.map(classifyOne); }
  const secs = () => Q.sections(st.people);

  function apprFrom(rq) {
    const appr = {};
    const put = (store, byEmp) => Object.keys(byEmp || {}).forEach((id) => { appr[Q.keyOf({ store, emp_id: id })] = byEmp[id]; });
    if (rq && rq.by_emp) put('', rq.by_emp);
    Object.keys((rq && rq.by_store) || {}).forEach((s) => put(s, rq.by_store[s] && rq.by_store[s].by_emp));
    return appr;
  }
  // 核准單回「已經處理過」（先前逾時其實成功了）：重讀這天的已核准與待審申請，卡片接到「核定 X 小時」
  async function readReqs(date) {                             // 確認用：有門市讀不到就丟錯，不拿殘缺的清單下結論
    const [rq, pd] = await Promise.all([call('mgr_req_day', { date }), call('mgr_req_pending')]);
    if (((rq && rq.failed) || []).length || ((pd && pd.failed) || []).length) throw new Error('部分門市讀不到');
    return { appr: apprFrom(rq), pending: Array.isArray(pd && pd.items) ? pd.items : [] };
  }
  async function refreshReqs() { const r = await readReqs(st.date); st.appr = r.appr; st.pending = r.pending; }
  // 逾時後確認這張單現在的狀況：pending／approved／gone（不在待審也沒核准）
  async function reqFate(id, store, date) {
    const r = await readReqs(date);
    st.pending = r.pending; if (date === st.date) st.appr = r.appr;
    if (r.pending.some((x) => String(x.id) === String(id) && (x.store || '') === (store || ''))) return 'pending';
    return Object.values(r.appr).some((list) => (list || []).some((x) => String(x.id) === String(id))) ? 'approved' : 'gone';
  }
  // 逾時或連線中斷：寫入可能其實成功了。先重讀當天的人與申請再判斷，已成功就當完成或接下一步，沒成功才讓主管重送
  const uncertain = (e) => !!e && (['TIMEOUT', 'UPSTREAM', 'NETWORK'].includes(e.code) || !e.code || /逾時|太久|沒有回應|連線|網路/.test(e.message || ''));
  async function reconcile() {                                // 三份都讀到才一起換，中途失敗不留半套
    const date = st.date;
    const [d, r] = await Promise.all([call('mgr_day', { date }), readReqs(date)]);
    if (((d && d.failed) || []).length) throw new Error('部分門市讀不到');
    if (date !== st.date) return;
    if (Array.isArray(d && d.employees)) st.emps = d.employees;
    st.appr = r.appr; st.pending = r.pending;
  }
  async function readDay(date) {
    const [d, rq] = await Promise.all([call('mgr_day', { date }), call('mgr_req_day', { date })]);
    return { emps: Array.isArray(d.employees) ? d.employees : [], appr: apprFrom(rq), failed: [].concat((d && d.failed) || [], (rq && rq.failed) || []) };
  }
  async function load() {
    if (st.busy) return;                                      // 寫入途中不換資料（含「重新載入」鈕）
    const tok = ++st.tok;
    st.loading = true; st.error = null; st.ui = {}; render();
    try {
      const leaveReady = loadLeave().catch(() => null);          // 不等額度才去抓名單；分類前（下面 readDay 那裡）才要到齊
      const [pend, rq] = await Promise.all([st.manual ? null : call('mgr_pending_approvals'), call('mgr_req_pending')]);      // 主管自己選日期時不用找待核定的日子
      if (tok !== st.tok || !live()) return;
      st.pending = Array.isArray(rq && rq.items) ? rq.items : [];
      st.handled = new Set(); st.date = null; st.emps = []; st.people = []; st.appr = {}; st.extra = []; st.capped = false; st.skipN = 0;
      st.loadedAt = Date.now(); st.loadedToday = todayNow();
      const failedAll = [].concat((pend && pend.failed) || [], (rq && rq.failed) || []);
      const wr = (it) => canWriteRow('hours', it.emp_id, it.store);      // 先依可核工時權限過濾再找日期（唯讀的人不佔名額）
      const dates = Q.candidateDates(((pend && pend.items) || []).filter(wr), todayNow(), st.pending.filter((it) => it.self !== true && wr(it)));
      let n = 0;
      for (const date of (st.manual ? [st.manual] : dates)) {
        if (++n > Q.MAX_DATES) { st.capped = true; break; }
        const [day] = await Promise.all([readDay(date), leaveReady]);
        if (tok !== st.tok || !live()) return;
        failedAll.push(...day.failed);
        st.date = date; st.emps = day.emps; st.appr = day.appr; recompute();
        if (st.manual || secs().left > 0) break;
        st.skipN += secs().skipped.length;
        st.date = null; st.emps = []; st.people = [];
      }
      st.failed = failedAll.filter((f, i, a) => a.findIndex((x) => x.store === f.store) === i);      // 任一讀取有門市讀不到：不可一鍵、不可顯示完成
      st.loading = false; render();
    } catch (e) {
      if (tok !== st.tok || !live()) return;
      st.loading = false; st.error = e; render();
    }
  }
  // 這天都處理完了 → 自動換下一天
  async function afterChange() {
    recompute();
    if (st.date && secs().left === 0) { st.manual = null; await load(); } else render();
  }

  // 資料放超過 2 分鐘才在送出前重讀；重讀後要核定的內容變了就停下來請主管再看一次（回傳 true＝可以送）
  const FRESH_MS = 2 * 60 * 1000;
  const snap = (p) => [p.key, p.status, p.hours, JSON.stringify(p.payload)].join('|');
  async function freshEnough(list) {
    if (Date.now() - st.loadedAt <= FRESH_MS) return true;
    const before = list.map(snap).join(',');
    try { await reconcile(); }
    catch (e) { st.failLine = '讀不到最新資料，這次沒有送出，請再按一次'; return false; }
    st.loadedAt = Date.now(); recompute();
    const after = list.map((p) => { const q = st.people.find((x) => x.key === p.key); return q ? snap(q) : p.key + '|gone'; }).join(',');
    if (before === after) return true;
    st.toast = '資料剛更新過，請看過再按一次';
    return false;
  }

  // 主管自己選日期（前一天／後一天）：最多到今天；這天處理完回到自動找下一個待處理的日子
  function gotoDate(date) { st.manual = date; st.toast = ''; st.failLine = ''; load(); }
  function backToAuto() { st.manual = null; st.toast = ''; st.failLine = ''; load(); }
  function navEl() {
    const cur = st.manual || st.date || todayNow();
    const off = st.busy || (st.loading && !st.manual);
    const nav = h('div', 'dq-nav');
    const prev = btn('dq-navb', '‹ 前一天', () => gotoDate(C.addDaysStr(cur, -1)), { id: 'dqPrev' });
    const next = btn('dq-navb', '後一天 ›', () => gotoDate(C.addDaysStr(cur, 1)), { id: 'dqNext' });
    prev.disabled = off; next.disabled = off || cur >= todayNow();
    nav.append(prev);
    if (st.manual) { const b = btn('dq-navb', '回待處理', backToAuto, { id: 'dqAuto' }); b.disabled = st.busy; nav.append(b); }
    nav.append(next);
    return nav;
  }

  // ---------- 動作 ----------
  function goFull(p) {                                       // 到完整頁核對：帶日期與同仁（既有 focus 機制）
    if (st.date) S.date = st.date;
    S.focusEmp = p ? p.key : null; S.dqFull = true;
    ctx.rerender();
  }
  async function approveOne(p, a, reason) {
    const emp = empOf(p.key);
    if (a.decide) {
      try { await call('mgr_req_decide', { id: a.decide.id, decision: 'approve', store: a.decide.store || undefined }); } catch (e) { e.stage = 'decide'; throw e; }      // 失敗（逾時、斷線、伺服器拒絕）就留在原卡顯示原因、原按鈕可重試；不判成「對不上」
      delete S.dayCache[st.date];
      const it = st.pending.find((x) => String(x.id) === String(a.decide.id) && (x.store || '') === (a.decide.store || ''));
      st.pending = st.pending.filter((x) => x !== it);
      if (it) (st.appr[p.key] = st.appr[p.key] || []).push(it);
      a = Object.assign({}, a, { decide: null });            // 核准過了：重試時不再核准一次
    }
    const payload = Object.assign({ store: emp.store, date: st.date, emp_id: emp.emp_id }, a.payload || p.payload);
    if (reason) payload.diff_reason = reason;
    const res = await call('mgr_approve', payload);
    delete S.dayCache[st.date];
    if ((payload.leaves || []).length) staleLeave();
    emp.approved = res;
    U(p.key).failed = ''; U(p.key).ask = null; U(p.key).msg = '';
    return res;
  }
  const mainAction = (p) => p.actions[0] && p.actions[0].id !== 'full' ? p.actions[0] : { id: 'plan', payload: p.payload };
  async function approveAll() {
    if (st.busy) return;
    const list = secs().ok.slice();
    if (!list.length) return;
    st.busy = true; st.toast = ''; st.failLine = ''; st.progress = '確認最新資料…'; render();
    if (!(await freshEnough(list))) { st.busy = false; st.progress = ''; return render(); }
    let okN = 0, halted = false; const bad = [];
    for (let i = 0; i < list.length; i++) {
      st.progress = '核定中 ' + (i + 1) + '/' + list.length; render();
      const p = list[i];
      try { await approveOne(p, mainAction(p)); okN++; }
      catch (e) {
        let msg = (e && e.message) || '沒有成功';
        if (uncertain(e)) {                                   // 逾時：資料已重讀，後面的人先停下，不拿舊清單繼續送
          halted = true;
          try { await reconcile(); const e2 = empOf(p.key); if (e2 && e2.approved) { okN++; break; } msg += '（已重讀確認：沒有寫入）'; } catch (e3) { msg += '（連線有問題，無法確認有沒有寫入）'; }
        }
        bad.push(p.name + '（' + msg + '）');
        Object.assign(U(p.key), { failed: msg, failedDiff: /^核定和打卡差/.test(msg) });
        if (halted) break;
      }
    }
    st.busy = false; st.progress = '';
    st.toast = okN ? '已核定 ' + okN + ' 人，要改可到完整頁重新核定' : '';
    st.failLine = (bad.length ? '沒有核定成功 ' + bad.length + ' 人：' + bad.join('、') : '') + (halted ? (bad.length ? '。' : '') + '連線不穩，後面的人先停下，請看過再按一次' : '');
    await afterChange();
  }
  async function act(p, a, extra) {
    if (st.busy) return;
    const u = U(p.key);
    if (a.id === 'full') return goFull(p);
    if (a.id === 'skip') { skipSet(skipKey(st.date, p.key)); u.ask = null; return afterChange(); }
    if (a.id === 'reject') {                                  // 退回：第一次只打開理由欄，再按「確定退回」才送（現行規則）
      if (!u.rejecting) { u.rejecting = true; u.msg = ''; render(); const i = root.querySelector('.dq-card[data-key="' + p.key + '"] .dq-reason'); if (i) i.focus(); return; }
      const reason = (u.reason || '').trim();
      if (!reason) { u.msg = '請寫退回理由（會原文給同仁看）'; render(); return; }
      st.busy = true; u.msg = ''; render();
      const rejected = () => {
        delete S.dayCache[st.date];
        st.handled.add(String(a.reqId) + '|' + (a.reqStore || ''));
        st.extra.push(p.name + ' 退回單');
        u.rejecting = false; u.reason = ''; u.mismatch = '';
      };
      try {
        await call('mgr_req_decide', { id: a.reqId, decision: 'reject', reason, store: a.reqStore || undefined });
        rejected();
      } catch (e) {
        u.msg = '退回沒成功：' + ((e && e.message) || '請再試一次');
        if (uncertain(e)) {                                   // 逾時：先重讀，單子已不在待審＝其實退回成功
          try {
            const fate = await reqFate(a.reqId, a.reqStore, st.date);
            if (fate === 'gone') { rejected(); u.msg = ''; }
            else u.msg = fate === 'approved' ? '這張單已被核准，沒有退回，請重新載入頁面再看' : '回應逾時，已重新讀取：沒有退回，可以再按一次';
          }
          catch (e2) { u.msg = '連線有問題，無法確認有沒有退回，請重新載入頁面再看'; }
        }
      }
      st.busy = false;
      return afterChange();
    }
    if (a.id === 'proxy') {                                   // 超過 7 天：主管代開忘打卡單（沿用 approve.js 既有 mgr_req_proxy）
      if (!u.proxyOpen) { u.proxyOpen = true; u.msg = ''; u.pa = u.pa || a.defStart; u.pb = u.pb || a.defEnd; render(); return; }
      const why = (u.pwhy || '').trim();
      const needA = a.missType !== 'out', needB = a.missType !== 'in';
      if ((needA && !u.pa) || (needB && !u.pb)) { u.msg = '請填時間'; render(); return; }
      if (!why) { u.msg = '代開要寫原因'; render(); return; }
      const emp = empOf(p.key), body = { store: emp.store, emp_id: emp.emp_id, date: st.date, kind: 'miss', miss_type: a.missType, reason: why };
      if (needA) body.start = u.pa; if (needB) body.end = u.pb;
      st.busy = true; render();
      try { const res = await call('mgr_req_proxy', body); u.proxied = res.summary || '已代開'; u.proxyOpen = false; u.msg = ''; }
      catch (e) {
        if (uncertain(e)) { u.proxyMaybe = true; u.proxyOpen = false; u.msg = '回應逾時，這張單可能已送出。請先到「申請審核」確認，不要重複代開'; }      // 代開人看不到送總監的單，無法重讀確認：收掉按鈕避免重複開單
        else u.msg = '代開失敗：' + ((e && e.message) || '請再試一次');
      }
      st.busy = false; return render();
    }
    // 核定（照班表／照打卡／核准單）
    if (a.askReason && !(extra && extra.reason)) { u.ask = a.id; u.msg = ''; render(); return; }
    st.busy = true; st.toast = ''; u.msg = ''; render();
    if (!(await freshEnough([p]))) { st.busy = false; return render(); }
    try {
      await approveOne(p, a, extra && extra.reason);
      st.busy = false;
      st.toast = '已核定 ' + p.name + ' ' + C.round2(emp2hours(p)) + ' 小時';
      return afterChange();
    } catch (e) {
      st.busy = false;
      const msg = (e && e.message) || '沒有成功，請再試一次';
      if (uncertain(e) && !/^核定和打卡差/.test(msg)) {
        try {
          await reconcile(); recompute();
          const e2 = empOf(p.key);
          if (e2 && e2.approved) { st.toast = '已核定 ' + p.name + ' ' + C.round2(Number(e2.approved.approved_hours)) + ' 小時（回應逾時，重讀後確認已寫入）'; return afterChange(); }
          const q = st.people.find((x) => x.key === p.key);
          u.msg = '回應逾時，已重新讀取：' + (q && q.actions.some((x) => x.id === 'req' && !x.decide) && e.stage === 'decide' ? '申請其實已核准，可以直接核定' : '沒有寫入，可以再按一次');
          if (e.stage !== 'decide') u.failed = msg;
        } catch (e3) { u.msg = '連線有問題，無法確認有沒有寫入，請重新載入頁面再看'; }
        recompute(); render(); return;
      }
      if (/^核定和打卡差/.test(msg)) { u.ask = a.id; u.msg = msg; }
      else if (e && e.stage === 'decide') {
        if (/^申請和打卡對不上/.test(msg)) { u.mismatch = msg; u.msg = ''; }      // 伺服器明說對不上才只剩退回
        else if (/已經?處理過|已被處理/.test(msg)) { try { await refreshReqs(); u.msg = '這張申請已經處理過，已重新讀取，可以直接核定'; } catch (e2) { u.msg = '核准單沒成功：' + msg; } }
        else u.msg = '核准單沒成功：' + msg;
      }
      else { u.msg = '核定失敗：' + msg; u.failed = msg; }      // 核准成功、核定失敗的假單也要標失敗留在異常區（不然會掉進綠框、錯誤訊息消失）
      recompute(); render();
    }
  }
  const emp2hours = (p) => { const e = empOf(p.key); return e && e.approved ? Number(e.approved.approved_hours) : Number(p.hours); };

  // 其他申請（不屬於這天卡片上的）：核准／退回
  async function decideReq(it, decision, reason) {
    if (st.busy) return;
    const k = hid(it);
    st.busy = true; st.reqMsg[k] = ''; render();
    try {
      await call('mgr_req_decide', { id: it.id, decision, store: it.store || undefined, reason: decision === 'reject' ? reason : undefined });
      delete S.dayCache[it.date];
      st.handled.add(k);
      st.extra.push(it.name + (decision === 'approve' ? ' 核准' : ' 退回') + ' ' + C.REQ_KIND_LABEL[it.kind] + '單');
    } catch (e) {
      st.reqMsg[k] = '沒有成功：' + ((e && e.message) || '請再試一次');
      if (uncertain(e)) {                                     // 逾時：先重讀，單子已不在待審＝其實處理成功
        try {
          const fate = await reqFate(it.id, it.store, it.date);
          if (fate === (decision === 'approve' ? 'approved' : 'gone')) { st.handled.add(k); st.reqMsg[k] = ''; st.extra.push(it.name + (decision === 'approve' ? ' 核准' : ' 退回') + ' ' + C.REQ_KIND_LABEL[it.kind] + '單'); }
          else if (fate === 'pending') st.reqMsg[k] = '回應逾時，已重新讀取：沒有寫入，可以再按一次';
          else { st.handled.add(k); st.extra.push(it.name + ' 的申請已被處理，結果請到申請審核看'); }
        } catch (e2) { st.reqMsg[k] = '連線有問題，無法確認有沒有寫入，請重新載入頁面再看'; }
      }
    }
    st.busy = false; render();
  }

  // ---------- 畫面 ----------
  function btn(cls, text, onclick, attrs) {
    const b = h('button', cls, text, Object.assign({ type: 'button' }, attrs || {}));
    b.disabled = st.busy; b.onclick = onclick; return b;
  }
  function line(label, text, cls) {
    if (!text) return null;
    return [h('span', 'dq-lb', label), h('span', cls || '', text)];
  }
  function cardEl(p) {
    const u = U(p.key);
    const c = h('div', 'dq-card' + (p.status === 'blocked' ? ' blocked' : ''), null, { 'data-key': p.key });
    const top = h('div', 'dq-ctop');
    const nm = h('div', 'dq-name', p.name); const emp0 = empOf(p.key); const sup = emp0 && supportTag(emp0); if (sup) nm.append(sup);
    top.append(nm, h('div', 'dq-tag' + (p.status === 'blocked' ? ' blocked' : ''), p.tag));
    const grid = h('div', 'dq-grid');
    [line('班表', p.planText), line('打卡', p.punchText, 'dq-b'), line('申請', p.note), line('比對', p.chk, 'dq-chk')].forEach((x) => { if (x) grid.append(...x); });
    c.append(top, grid);
    const pend = st.pending.filter((it) => it.date === st.date && Q.keyOf(it) === p.key && !st.handled.has(hid(it)) && it.attach_id);
    pend.forEach((it) => c.append(attachEl(it)));
    if (u.proxied) c.append(h('div', 'dq-info', '已代開：' + u.proxied + '。等總監層級在「申請審核」核准後，再回來核定。'));
    if (u.msg) c.append(h('div', 'dq-msg bad', u.msg, { role: 'alert' }));
    const acts = p.actions.filter((a) => !((u.proxied || u.proxyMaybe) && a.id === 'proxy'));
    const askA = u.ask ? p.actions.find((a) => a.id === u.ask) : null;
    if (askA) {                                               // 核定和打卡差 30 分鐘以上：選一個原因就完成
      c.append(h('div', 'dq-ask', '和打卡差 30 分鐘以上，選一個原因就完成'));
      const chips = h('div', 'dq-chips');
      Q.REASONS.forEach((r) => chips.append(btn('dq-chip', r, () => act(p, askA, { reason: r }))));
      chips.append(btn('dq-chip', '其他', () => { u.other = !u.other; render(); }));
      c.append(chips);
      if (u.other) {
        const row = h('div', 'dq-inrow');
        const inp = h('input', 'dq-reason', null, { type: 'text', maxlength: '100', placeholder: '原因（必填）', 'aria-label': '核定和打卡不同的原因' });
        inp.value = u.otherText || ''; inp.oninput = () => { u.otherText = inp.value; };
        row.append(inp, btn('dq-chip-go', '確定', () => { const t = (u.otherText || '').trim(); if (!t) { u.msg = '請寫原因'; render(); return; } act(p, askA, { reason: t }); }));
        c.append(row);
      }
      c.append(btn('dq-cancel', '取消', () => { u.ask = null; u.other = false; render(); }));
      return c;
    }
    if (u.rejecting) {
      const inp = h('input', 'dq-reason', null, { type: 'text', maxlength: '100', placeholder: '退回理由（必填，會原文給同仁看）', 'aria-label': '退回理由' });
      inp.value = u.reason || ''; inp.oninput = () => { u.reason = inp.value; };
      c.append(inp);
    }
    if (u.proxyOpen) {
      const a = p.actions.find((x) => x.id === 'proxy');
      const box = h('div', 'dq-proxy');
      box.append(h('div', 'dq-ask', '這天已超過 7 天，同仁自己補不了單。代開的單要由總監層級核准。'));
      const mk = (cls, label, key) => { const w = h('label', 'dq-tm'); w.append(h('span', null, label)); const i = h('input', cls, null, { type: 'time' }); i.value = u[key] || ''; i.oninput = () => { u[key] = i.value; }; w.append(i); return w; };
      if (a && a.missType !== 'out') box.append(mk('dq-pa', a.missType === 'both' ? '實際上班' : '補上班卡', 'pa'));
      if (a && a.missType !== 'in') box.append(mk('dq-pb', a.missType === 'both' ? '實際下班' : '補下班卡', 'pb'));
      const why = h('input', 'dq-reason', null, { type: 'text', maxlength: '100', placeholder: '原因（必填）', 'aria-label': '代開原因' });
      why.value = u.pwhy || ''; why.oninput = () => { u.pwhy = why.value; };
      box.append(why);
      c.append(box);
    }
    const row = h('div', 'dq-acts');
    acts.forEach((a) => {
      let label = a.label;
      if (a.id === 'reject' && u.rejecting) label = '確定退回';
      if (a.id === 'proxy' && u.proxyOpen) label = '送出代開（送總監層級審核）';
      row.append(btn('dq-act ' + (a.primary ? 'primary' : 'ghost'), label, () => act(p, a)));
    });
    if (u.rejecting) row.append(btn('dq-cancel', '先不退回', () => { u.rejecting = false; u.msg = ''; render(); }));
    if (u.proxyOpen) row.append(btn('dq-cancel', '先不代開', () => { u.proxyOpen = false; u.msg = ''; render(); }));
    c.append(row);
    return c;
  }
  // 看證明（同申請審核的「看附件」：line_hub_attach_get）
  function attachEl(it) {
    const wrap = h('div', 'dq-attwrap');
    const b = h('button', 'dq-att', '📎 看附件（同仁上傳的證明）', { type: 'button' });
    b.onclick = async () => {
      b.disabled = true; b.textContent = '載入中…';
      try {
        const r = await call('line_hub_attach_get', { attach_id: it.attach_id, store: it.store });
        const mime = String(r.mime || ''), data = String(r.data || '');
        if (!data) throw new Error('empty');
        b.remove();
        if (/^image\/(png|jpe?g|gif|webp|heic|heif)$/i.test(mime)) { const img = h('img', 'dq-img', null, { alt: it.name + ' 的申請附件' }); img.src = 'data:' + mime + ';base64,' + data; wrap.append(img); }
        else { const a = h('a', 'dq-file', mime.toLowerCase() === 'application/pdf' ? '下載附件（PDF）' : '下載附件（格式無法預覽，下載後用對應的程式開）', { download: 'attachment.' + (mime.toLowerCase() === 'application/pdf' ? 'pdf' : 'bin') }); a.href = 'data:' + (mime.toLowerCase() === 'application/pdf' ? mime : 'application/octet-stream') + ';base64,' + data; wrap.append(a); }
      } catch (e) { b.disabled = false; b.textContent = '附件讀不到，再試一次'; }
    };
    wrap.append(b);
    return wrap;
  }
  function otherReqEl(it) {
    const k = hid(it);
    const c = h('div', 'dq-rq', null, { 'data-id': String(it.id) });
    const t = h('div', 'dq-rtop');
    t.append(h('b', null, it.name), h('span', 'dq-rk ' + (REQ_CLS[it.kind] || ''), C.REQ_KIND_LABEL[it.kind] || it.kind), h('span', 'dq-rd', C.shortDate(it.date)));
    c.append(t, h('div', 'dq-rs', (it.summary || '') + (it.reason ? '\n原因：' + it.reason : '')));
    if (it.attach_id) c.append(attachEl(it));
    if (st.reqMsg[k]) c.append(h('div', 'dq-msg bad', st.reqMsg[k], { role: 'alert' }));
    const rej = st.reqReject[k];
    if (rej && rej.open) {
      const inp = h('input', 'dq-reason', null, { type: 'text', maxlength: '100', placeholder: '退回理由（必填，會原文給同仁看）', 'aria-label': '退回理由' });
      inp.value = rej.text || ''; inp.oninput = () => { rej.text = inp.value; };
      c.append(inp);
    }
    const row = h('div', 'dq-acts two');
    row.append(btn('dq-req-ok primary', '核准', () => decideReq(it, 'approve')),
      btn('dq-req-no ghost', rej && rej.open ? '確定退回' : '退回', () => {
        if (!rej || !rej.open) { st.reqReject[k] = { open: true, text: '' }; render(); return; }
        if (!(rej.text || '').trim()) { st.reqMsg[k] = '請寫退回理由'; render(); return; }
        decideReq(it, 'reject', rej.text.trim());
      }));
    c.append(row);
    return c;
  }

  function render() {
    if (!live()) return;
    const keepScroll = window.scrollY;
    root.innerHTML = '';
    const s = st.loading ? null : secs();
    const head = h('div', 'dq-head');
    const hl = h('div'); hl.append(h('div', 'dq-store', (S.meta && S.meta.label) || (ctx.session && ctx.session.name) || ''), h('div', 'dq-title', st.date ? Q.dayLabel(st.date, todayNow()) : '考勤管理'));
    head.append(hl, h('div', 'dq-left', st.date && s ? '還剩 ' + s.left + ' 人' : ''));
    root.append(head, navEl());
    if (st.loading) { root.append(h('div', 'card du-center', '載入中…', { id: 'dqLoading' })); return; }
    if (st.error) { const c = h('div', 'card'); root.append(c); failBar(c, '考勤資料', st.error, load); return; }

    if (st.failed.length) failedStores(root, st.failed, load);
    if (st.toast) root.append(h('div', 'dq-toast', st.toast, { role: 'status' }));
    if (st.failLine) root.append(h('div', 'dq-fails', st.failLine, { role: 'alert' }));
    if (s.ok.length) {
      const ok = h('div', 'dq-okbox');
      const t = h('div', 'dq-oktop'); t.append(h('b', null, '沒問題 ' + s.ok.length + ' 人'), h('span', 'dq-sub', '打卡和班表差在 ' + 15 + ' 分鐘內'));
      ok.append(t, h('div', 'dq-names', s.ok.map((p) => p.name).join('、')));
      const okb = btn('dq-ok-all', st.progress || '一鍵核定 ' + s.ok.length + ' 人', approveAll);
      if (st.failed.length) { okb.disabled = true; okb.textContent = '有門市讀不到，先重新載入'; }
      ok.append(okb);
      root.append(ok);
    }
    if (s.abnormal.length) { root.append(h('div', 'dq-sec', '有異常 ' + s.abnormal.length + ' 人，逐筆確認')); s.abnormal.forEach((p) => root.append(cardEl(p))); }
    if (s.blocked.length) { root.append(h('div', 'dq-sec muted', '現在不能核定 ' + s.blocked.length + ' 人')); s.blocked.forEach((p) => root.append(cardEl(p))); }
    const doneBits = s.done.map((p) => p.name + ' ' + C.round2(p.hours) + ' 小時').concat(s.skipped.map((p) => p.name + ' 先跳過'), st.extra);
    if (doneBits.length) root.append(h('div', 'dq-done', '已處理：' + doneBits.join('、')));
    if (s.skipped.length) root.append(btn('dq-unskip', '取消跳過 ' + s.skipped.length + ' 人，重新顯示', () => { skipDel(s.skipped.map((p) => skipKey(st.date, p.key))); recompute(); render(); }));
    if (st.manual && st.date && !s.left && !doneBits.length && !s.readonly.length) root.append(h('div', 'dq-done', '這天沒有要處理的人'));
    if (s.readonly.length) root.append(h('div', 'dq-done', s.readonly.length + ' 人不在你的核定名單（唯讀），請到完整頁看'));
    if (!st.date && !st.failed.length && !st.capped) root.append(h('div', 'dq-alldone', Q.allDoneText(st.skipN)));
    if (st.capped) root.append(h('div', 'dq-done', '還有更早的日期沒看完，按上方「前一天」繼續'));

    // 其他申請：沒有掛在今天卡片上的待審申請
    const onCard = new Set(st.people.filter((p) => ['ok', 'abnormal', 'blocked'].includes(p.status)).map((p) => p.key));
    const others = st.pending.filter((it) => !it.self && !st.handled.has(hid(it)) && !(it.date === st.date && onCard.has(Q.keyOf(it))) && !(it.date < todayNow() && canWriteRow('hours', it.emp_id, it.store)) && Q.reqDecidable(it, canWriteRow));      // 過去日期、可核工時的人：申請要連同工時一起在那天的卡片處理，不能只核准申請
    const tg = btn('dq-toggle', null, () => { st.showReq = !st.showReq; render(); });
    tg.append(h('span', null, '其他申請 ' + others.length + ' 筆'), h('span', null, st.showReq ? '收起' : '›'));
    tg.disabled = false;
    root.append(tg);
    if (st.showReq) { if (!others.length) root.append(h('div', 'dq-done', '目前沒有其他待審申請')); others.forEach((it) => root.append(otherReqEl(it))); }

    const foot = h('div', 'dq-foot');
    if (dutyManager(ctx.session) && !S.all) foot.append(qrButton(root));
    const fl = h('button', 'dq-fulllink', '完整頁（舊畫面，可依日期查看）', { type: 'button' });
    fl.disabled = st.busy;      // 核定進行中不離開，免得看不到失敗名單
    fl.onclick = () => { if (st.date) S.date = st.date; S.dqFull = true; ctx.rerender(); };
    foot.append(fl);
    root.append(foot);
    window.scrollTo(0, keepScroll);
  }

  render();
  load();
  // 頁面回到前景：台北日期變了、或離開超過 5 分鐘就重新載入（資料與「昨天」都會更新）
  const onVis = () => {
    if (!live()) { document.removeEventListener('visibilitychange', onVis); return; }
    if (document.visibilityState !== 'visible' || st.busy || st.loading) return;
    if (todayNow() !== st.loadedToday || Date.now() - st.loadedAt > 5 * 60 * 1000) load();
  };
  document.addEventListener('visibilitychange', onVis);
}

// 舊畫面（完整頁）上的「回到一頁核定」：手機才有
export function backBar(ctx) {
  const wrap = h('div', 'dq-back');
  const b = h('button', 'btn ghost sm', '回到一頁核定', { type: 'button', id: 'duQuickBack' });
  b.onclick = () => { S.dqFull = false; ctx.rerender(); };
  wrap.append(b);
  return wrap;
}
