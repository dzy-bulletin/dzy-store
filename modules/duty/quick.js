// 考勤管理「手機一頁核定」（核定工時分頁在手機寬度 ≤860px 的新畫面；規格 docs/duty-quick/requirements.md，2026-11-09 Eason 定案）。
// 一頁完成：沒問題的人一鍵核定、有異常的人一人一張卡按一下完成、少打卡又沒單的人先擋住。舊畫面（approve.js）完整保留當退路。
// 規則都在 quick-calc.js（純函式，有單元測試）；這裡只負責讀資料、畫畫面、依序呼叫既有的 mgr_approve／mgr_req_decide／mgr_req_proxy。
import { S, call, callAll, h, failBar, failedStores, supportTag, loadLeave, staleLeave, leaveFor, canWriteRow, brk, brkOf, dutyManager, dutyHours, viewNoHoursStore, snapLabel, checkOnce, reqShown, dropChecks } from './state.js';
import * as T from './timeline-calc.js';
import { fineCard, checkCards, pendingPanel, returnsPanel, elsewhereCards, FULL_UNTIL } from './approve.js';
import * as C from './calc.js';
import * as Q from './quick-calc.js';
import { canBg, watchJob, refreshJobs, rejectBar } from './bg.js';
import { corePeriods, OVER_BLOCK_MIN, otSuggestText, cardDiffs, cardLabel, cardReasonText } from './core-calc.js';
import { MOCK } from '../../js/config.js';

// 總開關：改成 false、重新發布網站，手機也回到舊畫面（不必動別的）
export const QUICK_ON = true;

const SKIP_KEY = 'dzystore_dutyquick_skip';     // 「先跳過」只存在這個分頁（sessionStorage），不寫任何資料
// 完整頁都只進去這一次，不記住（2026-11-09 Eason：切分頁不該跑回舊畫面）。這個值只有示範模式看：其他 e2e 用它預設停在舊畫面，正式網站不讀
// e2e 舊測試（示範模式）照舊分組：localStorage dzystore_core＝'0' 時不套「打卡＋單」（2026-11-14；正式網站一律套）
export const e2eNoCore = () => { if (!MOCK) return false; try { return localStorage.getItem('dzystore_core') === '0'; } catch (e) { return false; } };
const e2eFull = () => { if (!MOCK) return false; try { return localStorage.getItem('dzystore_dutyview') === 'full'; } catch (e) { return false; } };
const skipGet = () => { try { return JSON.parse(sessionStorage.getItem(SKIP_KEY) || '{}') || {}; } catch (e) { return {}; } };
const skipPut = (m) => { try { sessionStorage.setItem(SKIP_KEY, JSON.stringify(m)); } catch (e) {} };
const skipSet = (k) => { const m = skipGet(); m[k] = 1; skipPut(m); };
const skipDel = (keys) => { const m = skipGet(); keys.forEach((k) => delete m[k]); skipPut(m); };

// 這個人、這個畫面能不能用一頁核定：不是管理者代看、有核定工時的對象。
// 2026-11-14 考勤管理好上手第 3 項（Eason 全照推薦）：電腦也預設一頁核定、全部門市也能用（按門市分組）；系統管理員「各店總覽」維持舊畫面。
// 2026-11-15 合成一頁（docs/duty-timeline/）：所有人都用這頁（系統管理員選了門市之後也是；只看名單、沒有核定工時的人看到的是唯讀卡）
export function quickAvailable(ctx) {
  const s = ctx && ctx.session;
  return QUICK_ON && !!s;
}
// 全部門市：讀取改走合併讀（callAll），回來的列都帶 store
const rd = (op, body) => (S.all ? callAll(op, body) : call(op, body));
export const quickWanted = (ctx) => quickAvailable(ctx) && !S.dqFull && !e2eFull();

const REQ_CLS = { leave: 'leave', ot: 'ot', trip: 'trip', miss: 'miss' };
const taipeiMin = () => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':'); return Number(p[0]) * 60 + Number(p[1]); };
const hid = (it) => String(it.id) + '|' + (it.store || '');

const MODE_KEY = 'dzystore_dutymode';
function modeGet() { try { return localStorage.getItem(MODE_KEY) === 'detail'; } catch (e) { return false; } }
function modePut(d) { try { localStorage.setItem(MODE_KEY, d ? 'detail' : 'simple'); } catch (e) {} }
// 時間軸：一個人那天的班表（虛線）、打卡（灰條）、單（框）、差異（色塊）。資料由 timeline-calc.js 算，這裡只畫
const TL_KIND = { short: '遲到、早退或缺勤', miss: '缺卡', missok: '忘刷（忘打卡單已核准）', leave: '請假', leavepend: '請假（假單待審）', trip: '出差', trippend: '出差（出差單待審）', comp: '補休', comppend: '補休（假單待審）', extra: '比班表多（當天沒滿 8 小時，不用加班單）', ot: '加班、沒有加班單（超過 8 小時）', otok: '加班（有加班單）', rest: '空班休息' };
export function timelineEl(m, label) {
  const wrap = h('div', 'tl');
  const track = h('div', 'tl-track', null, { role: 'img', 'aria-label': label || '時間軸' });
  const W = m.to - m.from, pct = (t) => ((t - m.from) / W * 100).toFixed(2) + '%', wid = (a, b) => ((b - a) / W * 100).toFixed(2) + '%';
  const box = (cls, a, b, title) => { const d = h('div', cls, null, title ? { title } : null); d.style.left = pct(a); d.style.width = wid(a, b); track.append(d); return d; };
  const marks = m.planTicks && m.planTicks.length ? m.planTicks : m.ticks.filter((t) => t > m.from && t < m.to);
  m.plan.forEach((s) => box('tl-plan', s.a, s.b, '班表 ' + T.hhmm(s.a) + '–' + T.hhmm(s.b)));      // 班表時段＝淡色帶（2026-11-15 不用虛線）
  // A 版精準刻度（2026-11-16 Eason 選）：每小時一條淡格線、班表畫成上方括號並標起訖
  const hours = []; for (let t = Math.ceil(m.from / 60) * 60; t < m.to; t += 60) if (t > m.from) hours.push(t);
  hours.forEach((t) => { const g = h('div', 'tl-grid' + ((t / 60) % 2 ? '' : ' h')); g.style.left = pct(t); track.append(g); });
  m.plan.forEach((s) => {
    box('tl-brk', s.a, s.b, null);
    [s.a, s.b].forEach((t, i) => { const l = h('span', 'tl-blab' + (i ? ' en' : ' st'), T.hhmm(t)); l.style.left = pct(t); track.append(l); });
  });
  m.forms.forEach((f) => box('tl-form tl-f-' + f.kind + (f.comp ? ' tl-f-comp' : '') + (f.pending ? ' pend' : ''), f.a, f.b, (f.pending ? '待審 ' : '') + f.label + ' ' + T.hhmm(f.a) + '–' + T.hhmm(f.b)));
  m.devs.filter((d) => d.kind === 'rest').forEach((d) => box('tl-dev tl-rest', d.a, d.b, '空班休息 ' + T.hhmm(d.a) + '–' + T.hhmm(d.b)));
  m.punch.forEach((s) => box('tl-punch', s.a, s.b, '打卡 ' + T.hhmm(s.a) + '–' + T.hhmm(s.b)));
  m.open.forEach((x) => { const t = x.a != null ? x.a : x.b; box('tl-dot', t, t, (x.side === 'out' ? '只有上班卡 ' : '只有下班卡 ') + T.hhmm(t)); });
  m.devs.filter((d) => d.kind !== 'rest').forEach((d) => box('tl-dev tl-' + d.kind, d.a, d.b, TL_KIND[d.kind] + ' ' + T.hhmm(d.a) + '–' + T.hhmm(d.b)));
  // 多做、少做的段落直接在條下寫分鐘數（+94、−40）；太窄放不下就不寫（滑過去看提示）
  m.devs.filter((d) => /^(ot|otok|extra|short)$/.test(d.kind) && (d.b - d.a) / W * 100 >= 5).forEach((d) => {
    const n = h('span', 'tl-ann' + (d.kind === 'short' ? ' neg' : ''), (d.kind === 'short' ? '−' : '+') + Math.round(d.b - d.a)); n.style.left = pct((d.a + d.b) / 2); track.append(n);
  });
  // 實際打卡時間直接標在打卡條兩端（2026-11-16 Eason：更直觀）；太短的段落合成一個標籤，少一張卡的標「?」
  const labs = [];
  const plab = (t, cls, txt) => {
    const x = (t - m.from) / W * 100;
    const low = labs.some((y) => Math.abs(y - x) < 13);      // 跟前一個標籤太近（兩段班中間空檔短）：放到條子下面
    labs.push(x);
    const l = h('span', 'tl-plab ' + cls + (low ? ' low' : ''), txt); l.style.left = pct(t); track.append(l);
    if (low) track.classList.add('tl-two');
  };
  m.punch.forEach((s) => {
    if ((s.b - s.a) / W * 100 < 16) plab((s.a + s.b) / 2, 'mid', T.hhmm(s.a) + '–' + T.hhmm(s.b));
    else { plab(s.a, 'st', T.hhmm(s.a)); plab(s.b, 'en', T.hhmm(s.b)); }
  });
  m.open.forEach((x) => { if (x.a != null) plab(x.a, 'st', T.hhmm(x.a) + '–？'); else plab(x.b, 'en', '？–' + T.hhmm(x.b)); });
  const ax = h('div', 'tl-axis');
  // 刻度：每兩小時標一次整點（班表起訖已經標在上方括號）
  void marks;
  hours.filter((t) => (t / 60) % 2 === 0).forEach((t) => {
    const x = (t - m.from) / W * 100, hh = Math.floor(t / 60);
    const sp = h('span', null, String(hh >= 24 ? hh - 24 : hh).padStart(2, '0')); sp.style.left = x.toFixed(2) + '%';
    if (x < 4) sp.classList.add('tl-axl'); else if (x > 96) sp.classList.add('tl-axr');
    ax.append(sp);
  });
  wrap.append(track, ax);
  return wrap;
}
export function renderQuick(ctx) {
  const el = ctx.el;
  const root = h('div', 'dq');
  el.innerHTML = ''; el.append(root);
  const live = () => el.isConnected;
  const todayNow = () => C.taipeiToday();      // 每次用都重算（頁面開過午夜也不會差一天）
  const skipKey = (date, key) => ((ctx.session && ctx.session.code) || '') + '|' + ((S.meta && S.meta.clockStore) || '') + '|' + date + '|' + key;      // 加店別：同一分頁換店，別家同員編的人不會被跳過
  const st = { tok: 0, busy: false, loading: true, error: null, date: null, emps: [], people: [], appr: {}, pending: [], handled: new Set(),
    failed: [], capped: false, manual: null, skipN: 0, loadedAt: Date.now(), loadedToday: '',
    toast: '', failLine: '', extra: [], progress: '', showReq: false, ui: {}, reqMsg: {}, reqReject: {},
    // 時間軸（2026-11-15）：detail＝詳細模式（每張卡的細調都攤開，每人自己選、記在這台裝置）；fine＝簡潔模式下按了「細調」的人；
    // fineEls＝細調卡片本身（重畫時搬回去，裡面填到一半的欄位不會不見）；waits＝等同仁補單（伺服器記，null＝讀不到或還沒上線）
    detail: modeGet(), fine: new Set(), fineEls: new Map(), fineNew: [], waits: null, elsewhere: [], mirrorAt: 0, okOpen: false, doneOpen: false, openKey: null };
  const U = (k) => st.ui[k] || (st.ui[k] = {});
  const empOf = (key) => st.emps.find((e) => Q.keyOf(e) === key);
  const emp0 = (p) => empOf(p.key) || {};

  // ---------- 資料 ----------
  function reqsFor(emp, date, approved) {
    const key = Q.keyOf(emp);
    const appr = ((approved && approved[key]) || []).map((r) => Object.assign({}, r, { pending: false, decidable: true }));
    const pend = st.pending.filter((it) => it.date === date && Q.keyOf(it) === key && !st.handled.has(hid(it)))
      .map((it) => Object.assign({}, it, { pending: true, decidable: Q.reqDecidable(it, canWriteRow) }));
    return appr.concat(pend);
  }
  function classifyAt(emp, date, approved, u) {
    const key = Q.keyOf(emp);
    u = u || {};
    const p = Q.classify({ emp, date, today: todayNow(), nowMin: taipeiMin(), brk: brkOf(emp), LO: leaveFor(emp.store), canHours: canWriteRow('hours', emp.emp_id, emp.store),
      reqs: reqsFor(emp, date, approved), skipped: !!skipGet()[skipKey(date, key)], mismatch: u.mismatch || '', person: !!(ctx.session && ctx.session.person) });
    // 薪資鎖月（2026-11-15 鎖月後不可再動）：這個月薪資鎖了就列在「現在不能核定」、不給核定鈕，寫清楚要先到薪資頁解鎖（重新載入這天會再問一次）
    if (u.locked && (p.status === 'ok' || p.status === 'abnormal')) return Object.assign(p, { status: 'blocked', tag: '薪資已鎖定', note: u.locked, actions: [] });
    if (p.status === 'ok' && u.failed) {                      // 一鍵核定沒成功的人、送出前檢查說會被擋的人（u.pre）：回到異常區
      const main = Object.assign({}, p.actions[0] || { id: 'plan', hours: p.hours, payload: p.payload });
      main.primary = true; main.askReason = !!u.failedDiff;
      main.label = (u.pre ? (u.failedDiff ? '核定 ' : '仍要核定 ') : '再核定一次 ') + C.round2(p.hours) + ' 小時' + (u.failedDiff ? '（選原因）' : '');
      Object.assign(p, { status: 'abnormal', tag: u.pre ? (u.failedDiff ? '要寫原因' : '未符合') : '沒核定成功', note: u.failed, actions: [main, { id: 'full', label: '到完整頁核對', primary: false }] });
    }
    // 打卡＋單＝核定時數（2026-11-14）：檢查會過＝照算好的時段核定；異常的人也移到「核定通過」；不會過＝寫出要補齊的單
    if (u.pass && !u.failed && !p.pendReq && !e2eNoCore() && (p.status === 'ok' || p.status === 'abnormal')) {      // 已核定又有待審單：維持「有待審單」（2026-11-16）
      const cards = u.cards && u.cards.length ? u.cards : null;
      const act = { id: 'plan', label: '核定 ' + C.round2(u.pass.hours) + ' 小時' + (cards ? '（選原因）' : ''), primary: true, hours: u.pass.hours, payload: u.pass.payload, askReason: !!cards, cards };
      Object.assign(p, cards ? { status: 'abnormal', tag: '要選原因', note: '打卡跟核定差超過 30 分鐘：' + cards.map(cardLabel).join('、') }
        : { status: 'ok', tag: '核定通過', note: (u.pass.notes || []).join('；') },
        { hours: u.pass.hours, payload: u.pass.payload, actions: [act, { id: 'full', label: '到完整頁核對', primary: false }] });
    } else if (u.need && !p.pendReq && !e2eNoCore() && p.status === 'abnormal') {      // 不會過：寫出要補齊的單，不再給「選原因」（2026-11-14 不再靠寫原因放行）
      Object.assign(p, { tag: '未符合', note: '要補齊：' + u.need, actions: [{ id: 'full', label: '到完整頁補單', primary: true }, { id: 'skip', label: '先跳過', primary: false }] });
    }
    // 列進「核定通過」的人：打卡比班表晚到、早退達 15 分鐘，名單上標橘色「遲到 N 分／早退 N 分」（只提醒不擋，同完整頁的橘色標籤；2026-11-15 考勤驗收 B2-2b-4）
    if (p.status === 'ok') p.warn = Q.lateEarlyOf(emp, brkOf(emp)).tags;
    // 請假卻有打卡（2026-11-15 開工確認第 5 題）：標紅提醒、不擋。維持請假要選理由；要算上班就到細調把假單作廢
    if ((p.status === 'ok' || p.status === 'abnormal') && !emp.approved) {
      const m = modelOf(emp, date, approved);
      if (m.leavePunch) {
        const base = mainAction(p);
        const acts = [];
        if (base && base.payload) acts.push(Object.assign({}, base, { primary: true, askReason: true, reasons: ['維持請假，打卡不算工時'], reasonTitle: '維持請假：選理由後核定（理由會留在核定紀錄）', label: '維持請假，核定 ' + C.round2(base.hours != null ? base.hours : p.hours) + ' 小時' }));
        acts.push({ id: 'full', label: '細調（要算上班：作廢假單）', primary: !acts.length });
        Object.assign(p, { status: 'abnormal', tag: '請假卻有打卡', note: '核准的假單時段裡有打卡。要算上班：按細調把假單作廢；維持請假：選理由後核定。', actions: acts });
      }
    }
    // 在等同仁補單、還沒有新的單送來：不列在要處理的人裡（列在「等同仁補單」），不算「還剩幾人」；單送來了就回到原本的分類
    const w = waitOf(key, date);
    if (w && ['ok', 'abnormal', 'blocked'].includes(p.status) && !arrived(w)) p.status = 'waiting';
    return p;
  }
  // 那天這個人的時間軸資料（班表、打卡、已核准與待審的單）
  function modelOf(emp, date, approved) {
    return T.timelineModel({ segments: emp.segments, plan: emp.plan, reqs: reqsFor(emp, date, approved), brk: brkOf(emp) });
  }
  // 等同仁補單（伺服器記）：這個人這天有沒有在等；等的時候有沒有新的單送來（送來了＝回到正常流程讓主管核）
  const waitOf = (key, date) => (st.waits || []).find((w) => Q.keyOf(w) === key && w.date === date) || null;
  function arrived(w) {
    const had = new Set((w.req_ids || []).map(String));
    const emp = st.emps.find((e) => Q.keyOf(e) === Q.keyOf(w));
    const now = w.date === st.date && emp ? reqsFor(emp, w.date, st.appr) : st.pending.filter((it) => it.date === w.date && Q.keyOf(it) === Q.keyOf(w));
    return now.some((r) => r && r.id != null && !had.has(String(r.id)));
  }
  async function loadWaits() {
    try { const r = await rd('duty_wait_list'); st.waits = Array.isArray(r && r.items) ? r.items : []; }
    catch (e) { st.waits = null; }
  }
  function classifyOne(emp) { return classifyAt(emp, st.date, st.appr, U(Q.keyOf(emp))); }
  function peopleFor(date, day) { return day.emps.map((emp) => classifyAt(emp, date, day.appr, null)); }
  function recompute() { st.people = st.emps.map(classifyOne); }
  const secs = () => Q.sections(st.people);
  const storeOf = (p) => { const e = empOf(p.key); return (e && e.store) || ''; };

  function apprFrom(rq) {
    const appr = {};
    const put = (store, byEmp) => Object.keys(byEmp || {}).forEach((id) => { appr[Q.keyOf({ store, emp_id: id })] = byEmp[id]; });
    if (rq && rq.by_emp) put('', rq.by_emp);
    Object.keys((rq && rq.by_store) || {}).forEach((s) => put(s, rq.by_store[s] && rq.by_store[s].by_emp));
    return appr;
  }
  // 核准單回「已經處理過」（先前逾時其實成功了）：重讀這天的已核准與待審申請，卡片接到「核定 X 小時」
  async function readReqs(date) {                             // 確認用：有門市讀不到就丟錯，不拿殘缺的清單下結論
    const [rq, pd] = await Promise.all([rd('mgr_req_day', { date }), rd('mgr_req_pending')]);
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
    const [d, r] = await Promise.all([rd('mgr_day', { date }), readReqs(date)]);
    if (((d && d.failed) || []).length) throw new Error('部分門市讀不到');
    if (date !== st.date) return;
    if (Array.isArray(d && d.employees)) st.emps = d.employees;
    st.appr = r.appr; st.pending = r.pending;
  }
  async function readDay(date) {
    if (st.dayPre && st.dayPre.has(date)) { const p = st.dayPre.get(date); st.dayPre.delete(date); return p; }      // 副本先算出要看哪一天，已經先向打卡讀了
    const [d, rq] = await Promise.all([rd('mgr_day', { date }), rd('mgr_req_day', { date })]);
    return { emps: Array.isArray(d.employees) ? d.employees : [], appr: apprFrom(rq), failed: [].concat((d && d.failed) || [], (rq && rq.failed) || []), elsewhere: Array.isArray(d && d.elsewhere) ? d.elsewhere : [], mirrorAt: (d && d.mirror_at) || 0 };
  }
  // Mac mini 記得的上次資料先顯示（2026-11-10 Eason）：灰色不能按，最新資料到了整份換掉。少任何一份就不顯示
  async function peekFirst(tok, isFresh, round1) {
    const stop = () => isFresh() || tok !== st.tok || !live();
    const [pend, rq] = await round1;
    if (stop() || (!st.manual && !(pend && pend.snapshot_at)) || !(rq && rq.snapshot_at)) return;
    const pending = Array.isArray(rq.items) ? rq.items : [];
    const wr = (it) => canWriteRow('hours', it.emp_id, it.store);
    const dates = st.manual ? [st.manual] : Q.candidateDates(((pend && pend.items) || []).filter(wr), todayNow(), pending.filter((it) => it.self !== true && wr(it)));
    for (const date of dates.slice(0, Q.MAX_DATES)) {
      const [d, r] = await Promise.all([rd('mgr_day', { date, peek: true }), rd('mgr_req_day', { date, peek: true })]);
      if (stop() || !(d && d.snapshot_at) || !(r && r.snapshot_at) || !Array.isArray(d.employees)) return;
      st.pending = pending; st.date = date; st.emps = d.employees; st.appr = apprFrom(r); recompute();
      if (st.manual || secs().left > 0) {
        st.peekAt = Math.min(d.snapshot_at, r.snapshot_at, rq.snapshot_at, pend ? pend.snapshot_at : Infinity);
        st.peekSaved = { pending, date, emps: st.emps, appr: st.appr, people: st.people };
        render();
        return;
      }
    }
    st.date = null; st.emps = []; st.people = [];
  }
  async function load() {
    if (st.busy) return;                                      // 寫入途中不換資料（含「重新載入」鈕）
    const tok = ++st.tok;
    st.loading = true; st.error = null; st.ui = {}; st.peekAt = 0; st.peekSaved = null; st.checking = false;
    st.fine = new Set(); st.fineEls = new Map(); st.okOpen = false; st.doneOpen = false; render();
    dropChecks();
    const waitsP = loadWaits();
    retPanel.load();      // 重新載入這天時，人資退回一起重讀；本月待核定提醒沿用下面讀到的那份（不多問一次打卡系統）
    refreshJobs();
    let fresh = false;
    st.dayPre = new Map();
    const opt = { peek: true };
    const round1 = Promise.all([st.manual ? null : rd('mgr_pending_approvals', opt), rd('mgr_req_pending', opt)]).catch(() => [null, null]);
    peekFirst(tok, () => fresh, round1).catch(() => {});
    // 副本已經知道要看哪一天：同時向打卡確認那天的名單，不等申請清單回來才開始（2026-11-10）
    const preRead = (date) => { if (!date || st.dayPre.has(date)) return; const p = (async () => { const [d, rq2] = await Promise.all([rd('mgr_day', { date }), rd('mgr_req_day', { date })]); return { emps: Array.isArray(d.employees) ? d.employees : [], appr: apprFrom(rq2), failed: [].concat((d && d.failed) || [], (rq2 && rq2.failed) || []), elsewhere: Array.isArray(d && d.elsewhere) ? d.elsewhere : [], mirrorAt: (d && d.mirror_at) || 0 }; })(); p.catch(() => {}); st.dayPre.set(date, p); };
    if (st.manual) preRead(st.manual);
    else round1.then(([p, r]) => {
      if (tok !== st.tok || !live() || !p || p.snapshot_kind !== 'replica' || !r || !r.snapshot_at) return;
      const wr = (it) => canWriteRow('hours', it.emp_id, it.store), items = Array.isArray(r.items) ? r.items : [];
      Q.candidateDates((p.items || []).filter(wr), todayNow(), items.filter((it) => it.self !== true && wr(it))).slice(0, Q.READ_BATCH_DAYS).forEach(preRead);      // 跟正式讀取同一批，整批一起等
    });
    try {
      const leaveReady = loadLeave().catch(() => null);          // 不等額度才去抓名單；分類前（下面 readDay 那裡）才要到齊
      let leaveDone = false; leaveReady.then(() => { leaveDone = true; });
      // 待核定的日子只用來決定先看哪一天：有副本就用副本；申請清單要最新，不用副本
      const pendP = st.manual ? Promise.resolve(null) : round1.then(([p]) => (p && p.snapshot_kind === 'replica' ? p : rd('mgr_pending_approvals')));
      const [pend, rq] = await Promise.all([pendP, rd('mgr_req_pending')]);
      fresh = true;
      if (pend && Array.isArray(pend.items) && tok === st.tok) { S.pend = pend.items; S.pendFailed = pend.failed || []; pendPanel.draw(); }      // 本月待核定提醒：用同一份
      else if (tok === st.tok) pendPanel.load();
      if (tok !== st.tok || !live()) return;
      st.pending = Array.isArray(rq && rq.items) ? rq.items : [];
      st.handled = new Set(); st.date = null; st.emps = []; st.people = []; st.appr = {}; st.extra = []; st.capped = false; st.skipN = 0;
      st.loadedAt = Date.now(); st.loadedToday = todayNow();
      const failedAll = [].concat((pend && pend.failed) || [], (rq && rq.failed) || []);
      const wr = (it) => canWriteRow('hours', it.emp_id, it.store);      // 先依可核工時權限過濾再找日期（唯讀的人不佔名額）
      const dates = Q.candidateDates(((pend && pend.items) || []).filter(wr), todayNow(), st.pending.filter((it) => it.self !== true && wr(it)));
      const scanDates = st.manual ? [st.manual] : dates.slice(0, Q.MAX_DATES);
      let selected = null;
      for (let from = 0; from < scanDates.length; from += Q.READ_BATCH_DAYS) {
        const batchDates = scanDates.slice(from, from + Q.READ_BATCH_DAYS);
        const batch = await Promise.all(batchDates.map((date) => readDay(date).then((day) => ({ date, day }), (error) => ({ date, error }))));
        if (tok !== st.tok || !live()) return;
        // 假別額度比名單晚到（2026-11-09 規則，舊畫面搬來）：名單先畫出來看、整塊不能按，額度到了才分類成可操作的卡片
        if (!leaveDone) {
          const first = batch.find((x) => !x.error);
          if (first && from === 0 && !st.peekAt) { st.date = first.date; st.emps = first.day.emps; st.appr = first.day.appr; st.people = peopleFor(first.date, first.day); st.leaveWait = true; render(); }
          await leaveReady;
          if (tok !== st.tok || !live()) return;
        }
        st.leaveWait = false;
        const ready = batch.map((x) => (x.error ? x : Object.assign(x, { people: peopleFor(x.date, x.day) })));
        const choice = Q.selectDateResult(ready.map((x) => (x.error ? { error: x.error } : Q.sections(x.people))), !!st.manual);
        if (choice.error) throw choice.error;
        ready.slice(0, choice.consumed).forEach((x) => failedAll.push(...x.day.failed));
        st.skipN += choice.skipN;
        if (choice.index >= 0) { selected = ready[choice.index]; break; }
      }
      await waitsP;
      if (tok !== st.tok || !live()) return;
      st.fineEls = new Map(); st.fineNew = [];      // 先顯示（上次資料、額度還沒到）時建的細調卡不能沿用：最新資料、額度到了重建
      if (selected) {
        st.date = selected.date; st.emps = selected.day.emps; st.appr = selected.day.appr; st.people = selected.people;
        st.elsewhere = S.all ? [] : (selected.day.elsewhere || []); st.mirrorAt = selected.day.mirrorAt || 0;
      } else if (!st.manual && dates.length > scanDates.length) st.capped = true;
      const ok0 = st.openKey && st.people.find((p) => p.key === st.openKey);
      if (ok0) { st.fine.add(st.openKey); U(st.openKey).fold = false; st.scrollTo = st.openKey; if (ok0.status === 'ok') st.okOpen = true; if (ok0.status === 'done') st.doneOpen = true; }      // 點提醒名字跳來：核定通過、已核定的人也要看得到他的卡
      st.openKey = null;
      st.failed = failedAll.filter((f, i, a) => a.findIndex((x) => x.store === f.store) === i);      // 任一讀取有門市讀不到：不可一鍵、不可顯示完成
      st.peekAt = 0; st.peekSaved = null;
      st.loading = false; render();
      checkOk(tok);
    } catch (e) {
      fresh = true;
      if (tok !== st.tok || !live()) return;
      if (st.peekSaved) Object.assign(st, st.peekSaved);      // 讀不到最新的：舊資料留著看，仍然不能按
      st.loading = false; st.error = e; render();
    }
  }
  // 送出前先檢查（2026-11-14 考勤管理好上手第 1 項）：「沒問題」那群先用打卡系統的只檢查跑一次，會被擋的移到異常區、寫出原因；
  // 檢查中一鍵核定先停用（最多幾秒）；讀不到就照舊（按了才知道）
  // 只檢查回的錯誤代碼 → 白話；null＝格式類錯誤，不當成「要補齊」（照原本分類）
  const CHECK_CODE = { bad_periods: null, bad_items: null, bad_item: null, invalid_emp_id: '名冊找不到這位同仁', future_date: '還沒到的日子不能核定', home_review: '這位同仁由所屬部門核定', unauthorized: '沒有權限核定這位同仁' };
  async function checkOk(tok) {
    // 打卡＋單＝核定時數（2026-11-14 Eason 定案，docs/punch-plus-req/）：「沒問題」與「有異常」的人都先照原則算好時段（core-calc.js）再只檢查——
    //   會過：異常的人移到「核定通過」一起一鍵核定；沒問題的人照算好的時段送。不會過：寫出要補齊的單（會被擋的人移到異常區）。
    //   有待審申請要先核准的人不動（照原本「核准單，核定 X 小時」）。
    const date = st.date, list = secs().ok.concat(secs().abnormal.filter((p) => !p.pendReq && !(p.actions || []).some((a) => a.decide)));
    if (!date || !list.length) return;
    const by = new Map();
    list.forEach((p) => {
      const emp = empOf(p.key); if (!emp) return;
      const core = corePeriods({ segs: emp.segments, plan: emp.plan, reqs: st.appr[p.key] || [], brk: brkOf(emp) });
      const base = mainAction(p).payload || p.payload;
      // 算不出時段（沒班又沒打卡，例：排休那天只有假單）也沒有原本要送的內容：不送檢查，照原本分類（要自己核對）（2026-11-14 許芷瑄排休喪假被顯示成 bad_periods）
      if (!core && !(base && ((base.periods || []).length || (base.leaves || []).length))) return;
      const it = Object.assign({ emp_id: emp.emp_id }, base || {}, core ? { periods: core.periods } : {});
      delete it.store; delete it.date;
      const k = emp.store || ''; if (!by.has(k)) by.set(k, []); by.get(k).push([p, it, core]);
    });
    st.checking = true; render();
    await Promise.all([...by].map(async ([store, pairs]) => {
      const rs = await checkOnce(date, store, pairs.map((x) => x[1]));
      if (tok !== st.tok || st.date !== date || !rs) return;
      pairs.forEach(([p, it, core]) => {
        const r = rs.find((x) => x.emp_id === String(it.emp_id));
        if (!r) return;
        if (r.error === 'pay_locked') { U(p.key).locked = String(r.message || '這個月薪資已鎖定，請先到薪資頁解鎖這個月'); return; }      // 薪資鎖月：不是缺單，不列「要補齊」
        const pay = Object.assign({}, it); delete pay.emp_id;
        // 打卡超出班表＋加班單合計達 30 分鐘（2026-11-14 Eason 選 B）：不放進核定通過，到完整頁補加班單或主管自己調確認
        if (r.ok && core && core.overMin >= OVER_BLOCK_MIN) {
          const t = '要補加班單 ' + otSuggestText(core.over, core.overMin);      // 15 分鐘內不列、以 15 分為單位建議（2026-11-16 Eason）
          if (p.status === 'ok') Object.assign(U(p.key), { failed: '未符合：' + t, failedDiff: false, pre: true }); else Object.assign(U(p.key), { need: t });
          return;
        }
        if (r.ok) { Object.assign(U(p.key), { pass: { payload: pay, hours: r.approved_hours, notes: core ? core.notes : [] }, cards: null }); return; }
        // 每張卡跟核定差超過 30 分（2026-11-16 Eason）：單都齊了，只差每張卡選原因 → 列「要選原因」，選完就核定
        if (r.error === 'need_diff_reason') {
          const cards = Array.isArray(r.cards) && r.cards.length ? r.cards : cardDiffs(emp0(p).segments, it.periods);
          Object.assign(U(p.key), { pass: { payload: pay, hours: core ? core.hours : p.hours, notes: core ? core.notes : [] }, cards });
          return;
        }
        const probs = Array.isArray(r.probs) ? r.probs : [];
        if (!probs.length && !r.message && CHECK_CODE[r.error] === null) return;      // 格式類錯誤（不是缺單）：不標，照原本分類
        const ps = (Array.isArray(it.periods) ? it.periods : []).filter((x) => x && x.start && x.end).map((x) => x.start + '–' + x.end).join('、');
        const text = probs.length ? probs.map((x) => C.fixText(x, ps)).join('；') : String(r.message || CHECK_CODE[r.error] || '打卡系統不接受，請到完整頁核對').replace(/^這天還不能核定：/, '');
        if (p.status === 'ok') Object.assign(U(p.key), { failed: '未符合：' + text, failedDiff: false, pre: true });
        else Object.assign(U(p.key), { need: text });
      });
    }));
    if (tok !== st.tok || !live()) return;
    st.checking = false; recompute(); render();
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
    // 手機窄螢幕只留箭頭（「前一天」「後一天」收進 dq-navt，CSS 窄的時候藏起來；讀螢幕照樣念得到）
    prev.textContent = ''; prev.append(h('span', null, '‹'), h('span', 'dq-navt', ' 前一天')); prev.setAttribute('aria-label', '前一天');
    next.textContent = ''; next.append(h('span', 'dq-navt', '後一天 '), h('span', null, '›')); next.setAttribute('aria-label', '後一天');
    nav.append(prev);
    const di = h('input', 'dq-date', null, { type: 'date', id: 'dqDate', 'aria-label': '選日期', max: todayNow() });
    di.value = cur; di.disabled = off; di.onchange = () => { if (di.value && di.value <= todayNow()) gotoDate(di.value); };
    nav.append(di);
    if (st.manual) { const b = btn('dq-navb', '回待處理', backToAuto, { id: 'dqAuto' }); b.disabled = st.busy; nav.append(b); }
    nav.append(next);
    return nav;
  }

  // ---------- 動作 ----------
  // 細調（2026-11-15 合成一頁）：原本「到完整頁核對」改成在這張卡片下面展開舊畫面的整張卡片（時段、假別、遲到分鐘、重複打卡、原因、作廢、代開…）
  function goFull(p) {
    if (!p) return;
    if (st.detail) { const u = U(p.key); u.fold = !u.fold; }
    else if (st.fine.has(p.key)) st.fine.delete(p.key); else st.fine.add(p.key);
    st.scrollTo = fineShown(p.key) ? p.key : null;
    render();
  }
  const fineShown = (key) => (st.detail ? !U(key).fold : st.fine.has(key));
  function fineEl(p) {
    let c = st.fineEls.get(p.key);
    if (!c) {
      const emp = empOf(p.key); if (!emp) return null;
      const date = st.date;
      const pend = reqShown(st.pending).filter((it) => it.date === date && Q.keyOf(it) === p.key && !st.handled.has(hid(it)));
      c = fineCard(emp, date, { reqs: st.appr[p.key] || [], pending: pend, current: () => live() && st.date === date, defer: true });
      st.fineEls.set(p.key, c); st.fineNew.push(c);
    }
    const w = h('div', 'dq-fine'); w.append(c);
    return w;
  }
  // 等同仁補單：記到伺服器（能核這家店的人都看得到），這張卡先收到「等同仁補單」；單送來或核定了就回到正常流程
  async function addWait(p) {
    if (st.busy) return;
    const emp = empOf(p.key); if (!emp) return;
    const u = U(p.key);
    st.busy = true; u.msg = ''; render();
    try {
      const ids = reqsFor(emp, st.date, st.appr).map((r) => String(r.id)).filter((x) => x && x !== 'undefined');
      const what = (p.tag || '要補單') + (u.need ? '：' + u.need : p.note ? '：' + p.note : '');
      await call('duty_wait_add', { store: emp.store || undefined, emp_id: emp.emp_id, emp_name: emp.name, date: st.date, what: what.slice(0, 200), req_ids: ids.slice(0, 20) });
      await loadWaits(); recompute();
      st.toast = p.name + ' 放到「等同仁補單」，同仁補好單、核准後會回到這裡';
    } catch (e) { u.msg = '沒有記下來：' + ((e && e.message) || '請再試一次'); }
    st.busy = false; render();
  }
  async function cancelWait(w) {
    if (st.busy) return;
    st.busy = true; render();
    try { await call('duty_wait_cancel', { id: w.id, store: w.store || undefined }); await loadWaits(); }
    catch (e) { st.failLine = '取消等待沒成功：' + ((e && e.message) || '請再試一次'); }
    st.busy = false; recompute(); render();
  }
  async function approveOne(p, a, reason) {
    const emp = empOf(p.key);
    const viaDecide = !!a.decide;                            // 先核准申請再核定：核准後版本會變，核定改前景送（不帶 base_ver）
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
    if (!viaDecide && canBg(emp)) { payload.base_ver = emp.ver; payload.bg = true; }      // Mac mini 副本讀的：先顯示、背景送（2026-11-14）
    const res = await call('mgr_approve', payload);
    delete S.dayCache[st.date];
    if ((payload.leaves || []).length) staleLeave();
    if (res && res.queued) {
      const date = st.date;
      emp.approved = { approved_hours: p.hours, status_text: '送出中', manager_name: '', periods: payload.periods, queued: res.job };
      watchJob(res.job, (it) => {
        if (st.date !== date || !emp.approved || emp.approved.queued !== res.job) return;
        if (it.state === 'done') { emp.approved = it.result && it.result.approved_hours !== undefined ? it.result : Object.assign({}, emp.approved, { status_text: '已送出', queued: null }); recompute(); render(); return; }
        emp.approved = null;
        if (/薪資已鎖定/.test(it.msg || '')) { U(p.key).locked = it.msg; st.toast = ''; }      // 薪資鎖月：背景被退回也照前景，列在「現在不能核定」、不給「再核定一次」；「已核定 N 人」的提示收掉（整個月都送不進去）
        else Object.assign(U(p.key), { failed: '被退回：' + (it.msg || '請重新核定'), failedDiff: /^核定和打卡差/.test(it.msg || '') });      // 要填原因：按鈕改「選原因」，跟前景一樣
        reconcile().catch(() => {}).then(() => { recompute(); render(); });      // 重讀這天：拿最新的資料（版本）才能重核
      });
    } else emp.approved = res;
    U(p.key).failed = ''; U(p.key).ask = null; U(p.key).msg = '';
    return res;
  }
  const mainAction = (p) => p.actions[0] && p.actions[0].id !== 'full' ? p.actions[0] : { id: 'plan', payload: p.payload };
  async function approveAll(store) {
    if (st.busy) return;
    const list0 = secs().ok.filter((p) => typeof store !== 'string' || storeOf(p) === store);
    // 檢查還沒回來就按（2026-11-14）：打卡超出班表＋加班單 30 分鐘以上的人先在這裡擋下（這條打卡系統不會擋），移到異常區
    const list = list0.filter((p) => {
      if (U(p.key).pass || e2eNoCore()) return true;
      const emp = empOf(p.key), core = emp && corePeriods({ segs: emp.segments, plan: emp.plan, reqs: st.appr[p.key] || [], brk: brkOf(emp) });
      if (!core || core.overMin < OVER_BLOCK_MIN) return true;
      Object.assign(U(p.key), { failed: '未符合：要補加班單 ' + otSuggestText(core.over, core.overMin), failedDiff: false, pre: true });
      return false;
    });
    if (!list.length) { recompute(); render(); return; }
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
        if (/薪資已鎖定/.test(msg)) U(p.key).locked = msg; else Object.assign(U(p.key), { failed: msg, failedDiff: /^核定和打卡差/.test(msg) });
        if (halted) break;
      }
    }
    st.busy = false; st.progress = '';
    st.toast = okN ? '已核定 ' + okN + ' 人，要改可在下面「已核定」按細調重新送出' : '';
    st.failLine = (bad.length ? '沒有核定成功 ' + bad.length + ' 人：' + bad.join('、') : '') + (halted ? (bad.length ? '。' : '') + '連線不穩，後面的人先停下，請看過再按一次' : '');
    await afterChange();
  }
  async function act(p, a, extra) {
    if (st.busy) return;
    const u = U(p.key);
    if (a.id === 'full') return goFull(p);
    if (a.id === 'wait') return addWait(p);
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
    if (a.askReason && !(extra && extra.reason)) { u.ask = a.id; u.msg = ''; u.askCards = a.cards || null; u.picks = {}; render(); return; }
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
      if (/薪資已鎖定/.test(msg)) { u.locked = msg; u.msg = ''; }      // 薪資鎖月（核准單或核定被擋）：列在「現在不能核定」，不給「再核定一次」
      else if (/^核定和打卡差/.test(msg)) { u.ask = a.id; u.msg = msg; u.askCards = cardDiffs(emp0(p).segments, (a.payload || p.payload || {}).periods); u.picks = {}; }
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
      const r = await call('mgr_req_decide', { id: it.id, decision, store: it.store || undefined, reason: decision === 'reject' ? reason : undefined });
      delete S.dayCache[it.date];
      st.handled.add(k);
      st.extra.push(it.name + (decision === 'approve' ? ' 核准' : ' 退回') + ' ' + C.REQ_KIND_LABEL[it.kind] + '單' + (r && r.warn ? '（⚠ ' + (r.message || '那天已經核定過，請重新核定一次') + '）' : ''));      // 2026-11-13 a2
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
  // 把一句話裡的「HH:MM–HH:MM」包成小標籤（文字不變，只換外觀）
  function timeChips(el) {
    if (!el || !el.textContent) return;
    const parts = el.textContent.split(/(\d{1,2}:\d{2}–\d{1,2}:\d{2}|（[^（）]{1,12}）)/);
    if (parts.length < 2) return;
    el.textContent = '';
    parts.forEach((t, i) => { if (t) el.append(i % 2 ? h('span', t[0] === '（' ? 'dq-nowrap' : 'dq-tchip', t) : document.createTextNode(t)); });
  }
  function line(label, text, cls) {
    if (!text) return null;
    return [h('span', 'dq-lb', label), h('span', cls || '', text)];
  }
  function cardEl(p) {
    const u = U(p.key);
    const c = h('div', 'dq-card' + (p.status === 'blocked' ? ' blocked' : ''), null, { 'data-key': p.key });
    const top = h('div', 'dq-ctop');
    top.append(whoEl(p), h('div', 'dq-tag' + (p.status === 'blocked' ? ' blocked' : '') + ' sev' + sevOf(p), p.tag));
    c.append(top);
    const tl = tlFor(p); if (tl) c.append(tl);
    const grid = h('div', 'dq-grid');
    // 要同仁補單的那句是建議，不是同仁送的申請（2026-11-16 Eason：「申請那句話改成建議」）
    const adv = /^(要補齊|請同仁|還沒有|要有|要補)/.test(p.note || '');
    const noteTxt = adv ? String(p.note).replace(/^要補齊：\s*(要補)?/, '請同仁補').replace(/^要補/, '請同仁補') : p.note;
    [line(adv ? '建議' : /^打卡跟核定差/.test(p.note || '') ? '提醒' : '申請', noteTxt), line('比對', p.chk, 'dq-chk')].forEach((x) => { if (x) grid.append(...x); });
    if (adv && grid.firstChild) { grid.classList.add('adv'); timeChips(grid.childNodes[1]); }      // 建議補單：底色框＋時段做成小標籤，一眼看得出要補哪幾段（2026-11-16 Eason：更有質感、好辨識）
    if (grid.childNodes.length) c.append(grid);
    if (Q.overText(p)) c.append(h('div', 'du-total-over dq-over', Q.overText(p)));      // 超過單日 10 小時：紅字、不擋（2026-11-15）
    const pend = st.pending.filter((it) => it.date === st.date && Q.keyOf(it) === p.key && !st.handled.has(hid(it)) && it.attach_id && Q.reqDecidable(it, canWriteRow));      // 不能審的單（含自己的）伺服器不給看附件，同 request.js
    pend.forEach((it) => c.append(attachEl(it)));
    if (u.proxied) c.append(h('div', 'dq-info', '已代開：' + u.proxied + '。等總監層級在「申請審核」核准後，再回來核定。'));
    if (u.msg) c.append(h('div', 'dq-msg bad', u.msg, { role: 'alert' }));
    const acts = p.actions.filter((a) => !((u.proxied || u.proxyMaybe) && a.id === 'proxy'));
    const askA = u.ask ? p.actions.find((a) => a.id === u.ask) : null;
    const askCards = askA && !askA.reasonTitle && u.askCards && u.askCards.length ? u.askCards : null;
    if (askA && askCards) {                                   // 每張卡跟核定差超過 30 分鐘（2026-11-16 Eason）：每張卡各選一個原因，全選好就核定
      const box = h('div', 'dq-cardask');
      box.append(h('div', 'dq-ask', '打卡跟核定差超過 30 分鐘，每張卡選一個原因（會留在核定紀錄）'));
      const picks = u.picks || (u.picks = {});
      askCards.forEach((cd, i) => {
        const row = h('div', 'dq-cardrow');
        row.append(h('div', 'dq-cardlab', cardLabel(cd)));
        const chips = h('div', 'dq-chips');
        Q.REASONS.concat(['其他']).forEach((r) => {
          const on = r === '其他' ? u['other' + i] : picks[i] === r;
          const b = btn('dq-chip' + (on ? ' on' : ''), r, () => {
            if (r === '其他') { u['other' + i] = true; picks[i] = (u['otherText' + i] || '').trim(); }
            else { u['other' + i] = false; picks[i] = r; }
            render();
          });
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
          chips.append(b);
        });
        row.append(chips);
        if (u['other' + i]) {
          const inp = h('input', 'dq-reason', null, { type: 'text', maxlength: '40', placeholder: '這張卡的原因（必填）', 'aria-label': cardLabel(cd) + ' 的原因' });
          inp.value = u['otherText' + i] || ''; inp.oninput = () => { u['otherText' + i] = inp.value; picks[i] = inp.value.trim(); goBtn.disabled = !askCards.every((x, j) => picks[j]); };
          row.append(inp);
        }
        box.append(row);
      });
      const ready = askCards.every((x, j) => picks[j]);
      const goBtn = btn('dq-act primary', ready ? askA.label.replace('（選原因）', '') : '每張卡都選好原因才能核定', () => act(p, askA, { reason: cardReasonText(askCards, askCards.map((x, j) => picks[j])) }));
      goBtn.disabled = !ready || st.busy;
      box.append(goBtn, btn('dq-cancel', '取消', () => { u.ask = null; render(); }));
      c.append(box);
      return c;
    }
    if (askA) {                                               // 核定和打卡差 30 分鐘以上：選一個原因就完成
      c.append(h('div', 'dq-ask', askA.reasonTitle || '和打卡差 30 分鐘以上，選一個原因就完成'));
      const chips = h('div', 'dq-chips');
      (askA.reasons || Q.REASONS).forEach((r) => chips.append(btn('dq-chip', r, () => act(p, askA, { reason: r }))));
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
      box.append(h('div', 'dq-ask', '同仁自己補不了單（超過 4 天或沒綁 LINE）。代開的單要由總監層級核准。'));
      const mk = (cls, label, key) => { const w = h('label', 'dq-tm'); w.append(h('span', null, label)); const i = h('input', cls, null, { type: 'time' }); i.value = u[key] || ''; i.oninput = () => { u[key] = i.value; }; w.append(i); return w; };
      if (a && a.missType !== 'out') box.append(mk('dq-pa', a.missType === 'both' ? '實際上班' : '補上班卡', 'pa'));
      if (a && a.missType !== 'in') box.append(mk('dq-pb', a.missType === 'both' ? '實際下班' : '補下班卡', 'pb'));
      const why = h('input', 'dq-reason', null, { type: 'text', maxlength: '100', placeholder: '原因（必填）', 'aria-label': '代開原因' });
      why.value = u.pwhy || ''; why.oninput = () => { u.pwhy = why.value; };
      box.append(why);
      c.append(box);
    }
    const row = h('div', 'dq-acts');
    const list = acts.slice();
    if (canWait(p) && !list.some((a) => a.id === 'wait')) list.splice(list.findIndex((a) => a.id === 'skip') >= 0 ? list.findIndex((a) => a.id === 'skip') : list.length, 0, { id: 'wait', label: '請同仁補單，先放到「等同仁補單」', primary: false });
    if (!list.some((a) => a.id === 'full')) list.push({ id: 'full', label: '細調', primary: false });
    list.forEach((a) => {
      let label = a.id === 'full' ? fullLabel(a, p) : a.label;
      if (a.id === 'reject' && u.rejecting) label = '確定退回';
      if (a.id === 'proxy' && u.proxyOpen) label = '送出代開（送總監層級審核）';
      row.append(btn('dq-act ' + (a.primary ? 'primary' : 'ghost') + (a.id === 'full' ? ' dq-finebtn' : ''), label, () => act(p, a)));
    });
    if (u.rejecting) row.append(btn('dq-cancel', '先不退回', () => { u.rejecting = false; u.msg = ''; render(); }));
    if (u.proxyOpen) row.append(btn('dq-cancel', '先不代開', () => { u.proxyOpen = false; u.msg = ''; render(); }));
    c.append(row);
    if (fineShown(p.key)) { const f = fineEl(p); if (f) c.append(f); }
    return c;
  }
  // 「到完整頁核對／補單」改成「細調」；已經展開的寫「收起細調」
  function fullLabel(a, p) {
    if (fineShown(p.key)) return '收起細調';
    const l = String(a.label || '');
    return /^細調/.test(l) ? l : /補單/.test(l) ? '細調（代開或改單）' : '細調';
  }
  // 能不能「請同仁補單」：缺卡、缺單、排休有打卡、送出前檢查說要補齊（今天還沒下班、等上層審核這種不是缺單，不給）
  function canWait(p) {
    if (st.waits === null || !canWriteRow('hours', p.empId, p.store)) return false;
    if (p.status !== 'abnormal' && p.status !== 'blocked') return false;
    if (/今天還沒下班|跨夜班還沒下班|等上層審核/.test(p.tag || '')) return false;
    const e = empOf(p.key);
    const rq = e ? reqsFor(e, st.date, st.appr) : [];
    if (rq.some((r) => r.pending)) return false;      // 同仁已經送了單在等審：該做的是審單，不是等補單
    if (rq.length && !U(p.key).need) return false;      // 單已經核准（例：忘打卡單），送出前檢查也沒說還要補：問題不是缺單
    if ((p.actions || []).some((a) => a.id === 'proxy') || /超過 \d+ 天|沒綁 LINE|代開要用個人帳號/.test(p.note || '')) return false;      // 超過 4 天或沒綁 LINE：同仁自己補不了單，該做的是代開（門市帳號要改用個人帳號），不是等
    return !!U(p.key).need || /少打卡|少上班卡|少下班卡|沒有打卡|排休有打卡|未符合|要補/.test((p.tag || '') + (p.note || ''));
  }
  const sevOf = (p) => { const e = empOf(p.key); return T.severity(p.tag, e ? modelOf(e, st.date, st.appr) : null); };
  function tlFor(p) {
    const e = empOf(p.key); if (!e) return null;
    const m = modelOf(e, st.date, st.appr);
    const w = h('div', 'dq-tlw');
    w.append(timelineEl(m, p.name + ' ' + (p.planText || '') + ' ' + (p.punchText || '')));
    const pt = p.punchText || (e.segments && e.segments.length ? e.segments.map(C.segmentText).join('、') : '');
    if (!pt) { const t = h('div', 'dq-tltxt'); t.append(h('span', null, '沒有打卡')); w.append(t); }      // 打卡時間標在時間軸上（2026-11-16）、班表寫在姓名右邊（2026-11-16 Eason：省版面）
    return w;
  }
  // 姓名列：姓名、支援標籤、班表時段（2026-11-16 Eason：「班表顯示的位置移到姓名的右側」）。.dq-name 只放姓名，測試與讀螢幕照舊
  function whoEl(p, where) {
    const box = h('div', 'dq-who');
    const nm = h('div', 'dq-name', p.name); box.append(nm);
    const e = empOf(p.key); const sup = e && supportTag(e); if (sup) box.append(sup);
    if (where && S.all && e && (e.storeName || e.store)) box.append(h('span', 'du-where', e.storeName || e.store, { 'data-where': e.store || '' }));      // 全部門市：寫是哪一家店
    if (e) box.append(h('span', 'dq-plantxt', p.planText ? '班表 ' + p.planText.replace(/^班表\s*/, '') : (e.plan && e.plan.work === false ? '班表 排休' : '沒有班表')));
    return box;
  }
  // 摘要列、已核定與只能看的人（精簡卡：時間軸＋細調）
  function miniCard(p, right) {
    const c = h('div', 'dq-card dq-mini', null, { 'data-key': p.key });
    const top = h('div', 'dq-ctop');
    top.append(whoEl(p, true), h('div', 'dq-mright', right || ''));
    c.append(top);
    const tl = tlFor(p); if (tl) c.append(tl);
    const row = h('div', 'dq-acts two');
    if (p.status === 'ok') row.append(btn('dq-act primary', '核定 ' + C.round2(mainAction(p).hours != null ? mainAction(p).hours : p.hours) + ' 小時', () => act(p, Object.assign({}, mainAction(p), { label: '' }))));
    row.append(btn('dq-act ghost dq-finebtn', fineShown(p.key) ? '收起細調' : (p.status === 'done' ? '細調（重新核定）' : p.status === 'readonly' ? '細調（只能看）' : '細調'), () => goFull(p)));
    c.append(row);
    if (fineShown(p.key)) { const f = fineEl(p); if (f) c.append(f); }
    return c;
  }
  // 時間軸顏色說明（2026-11-15 Eason：「班別的時段要有顏色說明，避免主管看不懂」）
  function legendEl() {
    const box = h('div', 'dq-legend', null, { id: 'dqLegend', 'aria-label': '時間軸顏色說明' });
    [['tl-lg-plan', '班別（班表）'], ['tl-punch', '出勤'], ['tl-extra', '比班表多（沒滿 8 小時，不用單）'], ['tl-otok', '加班（有單）'], ['tl-ot', '加班沒單（要補單）'],
      ['tl-trip', '出差'], ['tl-missok', '忘刷（有單）'], ['tl-miss', '缺卡沒單（要補忘打卡單）'], ['tl-short', '遲到、早退、缺勤'], ['tl-leave', '請假'], ['tl-comp', '補休'], ['tl-rest', '空班'], ['tl-lg-pend', '單還在審（反向斜紋）']].forEach(([cls, t]) => {
      const it = h('span', 'dq-lgi'); it.append(h('i', 'dq-sw ' + cls, null, { 'aria-hidden': 'true' }), h('span', null, t)); box.append(it);
    });
    return box;
  }
  function summaryEl(s) {
    const box = h('div', 'dq-sum');
    const tile = (k, v, cls) => { const t = h('div', 'dq-sumt' + (cls ? ' ' + cls : '')); t.append(h('div', 'dq-sumk', k), h('div', 'dq-sumv', v)); box.append(t); };
    const hs = T.hoursSummary(st.emps.map((e) => modelOf(e, st.date, st.appr)));
    tile('要你處理', (s.abnormal.length + s.blocked.length) + ' 人', 'bad');
    if (st.waits !== null) tile('等同仁補單', st.waits.length + ' 筆', 'warn');
    tile('可一鍵核定', s.ok.length + ' 人', 'ok');
    tile('排班 → 上班＋請假', C.round2(hs.plan) + ' → ' + C.round2(hs.work) + (hs.leave ? '＋' + C.round2(hs.leave) : '') + ' 小時');
    return box;
  }
  function waitSection() {
    const ws = (st.waits || []).filter((w) => !(w.date === st.date && st.people.some((p) => p.key === Q.keyOf(w) && p.status === 'done')));
    const sec = h('div', 'dq-waits');
    sec.append(h('div', 'dq-sec muted', '等同仁補單 ' + ws.length + ' 筆'));
    if (!ws.length) { sec.append(h('div', 'dq-done', '沒有在等同仁補的單。按「請同仁補單」的人會放在這裡，同仁補好單、核准後會回到上面讓你核定。')); return sec; }
    ws.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach((w) => {
      const row = h('div', 'dq-wait', null, { 'data-key': Q.keyOf(w), 'data-date': w.date });
      const ok = arrived(w);
      const t = h('div', 'dq-wtop');
      t.append(h('b', null, (w.emp_name || w.emp_id) + (w.storeName ? '・' + w.storeName : '')), h('span', 'dq-rd', C.shortDate(w.date)), h('span', 'dq-wtag' + (ok ? ' ok' : ''), ok ? '單送來了' : '等同仁補單'));
      row.append(t, h('div', 'dq-rs', w.what || ''), h('div', 'dq-wby', (w.by_name || '') + ' ' + String(w.created_at || '').slice(5, 16).replace('T', ' ') + ' 記下'));
      const acts = h('div', 'dq-acts two');
      acts.append(btn('dq-act ' + (ok ? 'primary' : 'ghost'), ok ? '去核定' : '看那天', () => { st.openKey = Q.keyOf(w); gotoDate(w.date); }));
      if (w.can_cancel !== false) acts.append(btn('dq-act ghost', '不等了', () => cancelWait(w)));
      row.append(acts);
      sec.append(row);
    });
    return sec;
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
    const stale = (!!st.peekAt && (st.loading || !!st.error)) || (st.loading && !!st.leaveWait);      // 正在顯示上次資料（或名單到了、假別額度還沒到）
    const s = st.loading && !stale ? null : secs();
    const head = h('div', 'dq-head');
    const hl = h('div'); hl.append(h('div', 'dq-store', S.all ? '全部門市' : (S.meta && S.meta.label) || (ctx.session && ctx.session.name) || ''), h('div', 'dq-title', st.date ? Q.dayLabel(st.date, todayNow()) : '考勤管理'));
    const hr = h('div', 'dq-hright');
    const seg = h('div', 'dq-mode', null, { role: 'group', 'aria-label': '顯示方式' });
    [['簡潔', false], ['詳細', true]].forEach(([t, d]) => { const b = btn('dq-modeb', t, () => { if (st.detail === d) return; st.detail = d; modePut(d); st.ui && Object.values(st.ui).forEach((u) => { u.fold = false; }); render(); }, { 'aria-pressed': String(st.detail === d), id: d ? 'dqModeDetail' : 'dqModeSimple' }); b.disabled = false; seg.append(b); });
    hr.append(seg, h('div', 'dq-left', st.date && s ? '還剩 ' + s.left + ' 人' : ''));
    // 2026-11-15 Eason：不要黑底日期標題，前一天／日期／後一天放同一列：一條工具列＝這天（昨天…）＋日期切換＋還剩幾人＋簡潔／詳細；店名上方門市選單已經有，畫面上不再重複（留給讀螢幕的人）
    hl.className = 'dq-hleft'; hl.querySelector('.dq-store').classList.add('dq-sr');
    hl.append(navEl());
    head.append(hl, hr);
    root.append(head);
    root.append(rejectBar((date) => gotoDate(date)));      // 背景送出被打卡系統退回的（考勤副本，2026-11-14）
    root.append(retEl, pendEl);      // 人資退回、本月待核定提醒（舊畫面搬來，2026-11-15）
    if (st.loading && !stale) { root.append(h('div', 'card du-center', '載入中…', { id: 'dqLoading' })); return; }
    if (st.error && !stale) { const c = h('div', 'card'); root.append(c); failBar(c, '考勤資料', st.error, load); return; }
    if (stale) {
      root.append(h('div', 'du-stale-note', st.leaveWait && !st.peekAt ? '假別額度還在讀取，讀到後就可以核定…' : st.error ? '讀不到最新資料，下面是' + snapLabel(st.peekAt) + '的舊資料，不能核定' : '這是' + snapLabel(st.peekAt) + '的資料，正在讀取最新資料，讀到後就可以核定…', { id: 'dqStale' }));
      if (st.error) { const c = h('div', 'card'); root.append(c); failBar(c, '考勤資料', st.error, load); }
    }
    const staleFrom = root.children.length;

    if (st.failed.length) failedStores(root, st.failed, load);
    if (st.date && s) root.append(summaryEl(s));
    if (st.date && s && st.people.length) root.append(legendEl());
    if (st.mirrorAt) root.append(h('div', 'du-mirror-at', '資料更新於 ' + snapLabel(st.mirrorAt) + '・從 Mac mini 讀取', { id: 'dqMirrorAt' }));
    if (st.elsewhere.length) root.append(elsewhereCards(st.elsewhere));
    if (st.toast) root.append(h('div', 'dq-toast', st.toast, { role: 'status' }));
    if (st.failLine) root.append(h('div', 'dq-fails', st.failLine, { role: 'alert' }));
    // 全部門市：按門市分組，每家一個「一鍵核定」（第 3 項）；單一門市照舊
    const groups = [];
    if (S.all) {
      const seen = new Map();
      st.people.forEach((p) => { const k = storeOf(p); if (!seen.has(k)) { const e = empOf(p.key); seen.set(k, { store: k, name: (e && e.storeName) || k, people: [] }); groups.push(seen.get(k)); } seen.get(k).people.push(p); });
    } else groups.push({ store: null, name: '', people: st.people });
    groups.forEach((g) => {
      const gs = S.all ? Q.sections(g.people) : s;
      if (S.all && !(gs.ok.length || gs.abnormal.length || gs.blocked.length)) return;
      if (S.all) root.append(h('div', 'dq-grp', g.name));
      if (gs.ok.length) {
        const ok = h('div', 'dq-okbox');
        const t = h('div', 'dq-oktop'); t.append(h('b', null, (e2eNoCore() ? '沒問題 ' : '核定通過 ') + gs.ok.length + ' 人'), h('span', 'dq-sub', e2eNoCore() ? '打卡和班表差在 15 分鐘內' : '打卡＋單對得上、已先跟打卡系統檢查'));
        if (st.checking) t.append(h('span', 'dq-checking', '正在跟打卡系統檢查…可以先按，沒過的會列出原因'));
        const names = h('div', 'dq-names');
        gs.ok.forEach((p, i) => {
          if (i) names.append('、');
          const w = p.warn || [], nm = h('span', 'dq-nm' + (w.length ? ' warn' : ''), p.name);
          w.forEach((x) => nm.append(h('span', 'dq-warn', x)));
          names.append(nm);
        });
        ok.append(t, names);
        const okb = btn('dq-ok-all', st.progress || '一鍵核定 ' + gs.ok.length + ' 人', () => approveAll(S.all ? g.store : undefined));
        if (st.failed.length) { okb.disabled = true; okb.textContent = '有門市讀不到，先重新載入'; }
        // 檢查中也可以先按（2026-11-14 Eason 選 C）：名單是照打卡＋單先算好的；送出時打卡系統照樣檢查，沒過的人列出原因、回到異常區
        ok.append(okb);
        const showOk = st.detail || st.okOpen;
        ok.append(btn('dq-okopen', showOk ? '收起逐筆' : '展開逐筆看時間軸', () => { st.okOpen = !showOk; if (st.detail && !st.okOpen) { st.detail = false; modePut(false); } render(); }, { id: 'dqOkOpen' }));
        root.append(ok);
        if (showOk) gs.ok.forEach((p) => root.append(miniCard(p, '核定通過')));
      }
      // 有異常：依嚴重程度排（缺卡 → 缺勤沒單 → 假單對不上 → 單待審 → 加班 → 遲到；2026-11-15 開工確認），同級照原順序
      const sorted = gs.abnormal.map((p, i) => [sevOf(p), i, p]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
      if (sorted.length) { root.append(h('div', 'dq-sec', '有異常 ' + sorted.length + ' 人，逐筆確認')); sorted.forEach((p) => root.append(cardEl(p))); }
      if (gs.blocked.length) { root.append(h('div', 'dq-sec muted', '現在不能核定 ' + gs.blocked.length + ' 人')); gs.blocked.forEach((p) => root.append(cardEl(p))); }
    });
    if (st.waits !== null && st.date) root.append(waitSection());
    // 已核定的人：精簡卡（時間軸＋細調可重新核定）。舊畫面「依日期查看、重新送出核定」搬到這裡
    if (s.done.length) {
      const showDone = st.detail || st.doneOpen;
      root.append(btn('dq-toggle', null, () => { st.doneOpen = !showDone; render(); }, { id: 'dqDoneToggle' }));
      root.lastChild.append(h('span', null, '已核定 ' + s.done.length + ' 人：' + s.done.map((p) => p.name + ' ' + C.round2(p.hours) + ' 小時').join('、')), h('span', null, showDone ? '收起' : '›'));
      root.lastChild.disabled = false;
      if (showDone) s.done.forEach((p) => { const e = empOf(p.key), ap = e && e.approved; root.append(miniCard(p, '已核定 ' + C.round2(p.hours) + ' 小時' + (ap && ap.manager_name ? '（' + ap.manager_name + '）' : ''))); });
    }
    const doneBits = s.skipped.map((p) => p.name + ' 先跳過').concat(st.extra);
    if (doneBits.length) root.append(h('div', 'dq-done', '已處理：' + doneBits.join('、')));
    if (s.skipped.length) root.append(btn('dq-unskip', '取消跳過 ' + s.skipped.length + ' 人，重新顯示', () => { skipDel(s.skipped.map((p) => skipKey(st.date, p.key))); recompute(); render(); }));
    if (st.manual && st.date && !s.left && !doneBits.length && !s.readonly.length && !s.done.length) root.append(h('div', 'dq-done', '這天沒有要處理的人'));
    if (s.readonly.length) { root.append(h('div', 'dq-sec muted', '只能看 ' + s.readonly.length + ' 人（不在你的核定名單）')); s.readonly.forEach((p) => root.append(miniCard(p, '只能看'))); }
    // 未出勤（沒打卡、也沒排上班）：舊畫面有列，要能在細調核整天請假或出差（2026-11-15 e2e 抓到新頁漏了）
    const absent = st.people.filter((p) => p.status === 'absent');
    if (absent.length) { root.append(h('div', 'dq-sec muted', '未出勤 ' + absent.length + ' 人（沒打卡、沒排上班；要核整天請假或出差按細調）')); absent.forEach((p) => root.append(miniCard(p, '未出勤'))); }
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
    // 舊畫面只留系統管理員當緊急備用，到 FULL_UNTIL 為止（2026-11-15 Eason 定 14 天）
    if (ctx.session && ctx.session.role === 'admin' && todayNow() <= FULL_UNTIL) {
      const fl = h('button', 'dq-fulllink', '舊畫面（管理員緊急備用，' + C.shortDate(FULL_UNTIL) + ' 下架）', { type: 'button', id: 'dqFullLink' });
      fl.disabled = st.busy;      // 核定進行中不離開，免得看不到失敗名單
      fl.onclick = () => { if (st.date) S.date = st.date; S.dqFull = true; ctx.rerender(); };
      foot.append(fl);
    }
    root.append(foot);
    if (stale) [...root.children].slice(staleFrom).forEach((el) => { el.inert = true; el.classList.add('dq-stale'); });
    window.scrollTo(0, keepScroll);
    if (st.fineNew.length) {      // 這次重畫新開的細調卡：一起送檢查（卡片已經放回畫面上了）
      const list = st.fineNew.splice(0), date = st.date;
      // checkCards 會把卡片暫時搬進自己的盒子：先記下原本的位置，檢查送出後放回去
      const spots = list.map((c) => [c, c.parentNode, c.nextSibling]);
      checkCards(list, date, () => live() && st.date === date);
      spots.forEach(([c, par, nx]) => { if (par) par.insertBefore(c, nx); });
    }
    if (st.scrollTo) { const k = st.scrollTo; st.scrollTo = null; const c = root.querySelector('.dq-card[data-key="' + (window.CSS && CSS.escape ? CSS.escape(k) : k) + '"]'); if (c && c.scrollIntoView) c.scrollIntoView({ block: 'start' }); }
  }

  // 人資退回、本月待核定提醒：舊畫面搬來（2026-11-15），點名字跳到那天並打開那個人的細調
  const pendEl = h('div', 'dq-pend'), retEl = h('div', 'dq-ret');
  const pick = (date, key) => { st.openKey = key; gotoDate(date); };
  const pendPanel = pendingPanel(pendEl, pick);
  // 本月待核定提醒在新頁預設只留一行（2026-11-15）：點標題展開名單，詳細模式一律展開
  pendEl.classList.add('fold');
  pendEl.addEventListener('click', (e) => { if (e.target.closest('.du-pa-title')) { pendEl.classList.toggle('fold'); } });
  const retPanel = returnsPanel(retEl, pick, (date) => { if (date === st.date) load(); }, live);
  // 細調裡送出核定成功（或背景送出被退回）：重讀這天、收起細調，名單照新的狀態重分
  root.addEventListener('emp-approved', (e) => {
    const d = e.detail || {}, key = Q.keyOf({ store: d.store || '', emp_id: d.emp_id });
    if (d.queued) {      // 細調裡背景送出（考勤副本）：這張細調卡要留著接背景結果（被退回會在卡上標紅、給重新載入），不重建
      const emp = empOf(key);
      if (emp) emp.approved = { approved_hours: d.hours, status_text: '送出中', manager_name: '', periods: d.periods || [], queued: true };
      st.fine.add(key); U(key).fold = false; st.doneOpen = true;
      retPanel.load();
      st.toast = '已核定 ' + ((emp || {}).name || '') + '，正在背景送到打卡系統';
      recompute(); render(); return;
    }
    retPanel.load();
    if (S.pend) { const n = S.pend.length; S.pend = S.pend.filter((it) => !(it.date === d.date && String(it.emp_id) === String(d.emp_id) && (it.store || '') === (d.store || ''))); if (S.pend.length !== n) pendPanel.draw(); }
    st.toast = '已核定 ' + ((empOf(key) || {}).name || '') + '（細調送出）';
    setTimeout(() => { if (!live() || st.busy) return; st.fine.delete(key); st.fineEls.delete(key); reconcile().then(() => loadWaits()).catch(() => {}).then(() => afterChange()); }, 1200);      // 先讓主管看到細調裡的結果
  });
  // 細調裡送出被薪資鎖月擋下（前景失敗、背景被退回）：名單也照一鍵核定被擋的做法，這個人列在「現在不能核定」，不留在核定通過／已核定（送出中）
  root.addEventListener('emp-pay-locked', (e) => {
    const d = e.detail || {}, key = Q.keyOf({ store: d.store || '', emp_id: d.emp_id });
    if (d.date !== st.date) return;
    const emp = empOf(key);
    if (emp && emp.approved && emp.approved.queued) { emp.approved = null; st.toast = ''; }      // 背景送出中的假結果拿掉；原本就核定過的（重新核定被擋）照舊列在已核定
    U(key).locked = d.msg; U(key).fold = false; st.fine.add(key);      // 細調留著：卡片上的紅字原因還在
    recompute(); render();
  });
  root.addEventListener('duty-reload-day', () => { if (!st.busy) load(); });
  root.addEventListener('hr-returned', () => retPanel.load());
  render();
  load();      // load() 會順便讀上方兩個提醒
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
  const b = h('button', 'btn ghost sm', '回到新畫面', { type: 'button', id: 'duQuickBack' });
  b.onclick = () => { S.dqFull = false; ctx.rerender(); };
  wrap.append(b);
  return wrap;
}
