// 考勤管理「手機一頁核定」的純函式（沒有 DOM、不碰網路；node 測試直接 require）。規格：docs/duty-quick/requirements.md。
// 規則不複製：班表預填 planPrefill、申請預填 missPeriods／otPeriods／reqLeaveLines、15 分鐘比對 comparePlan／THRESHOLD_MIN 全部用既有的。
// 原則：判斷不了的一律歸「異常」、按鈕只有「到完整頁核對」。寧可多一張卡，不可錯核。
import * as C from './calc.js';
import { comparePlan, THRESHOLD_MIN } from '../schedule/compare.js';

export const OK_MAX_H = 8;           // 一鍵核定的班表時數上限（Eason 定案）
export const DIFF_MIN = 30;          // 核定和打卡差達這個分鐘數，伺服器要原因（規則 4）
export const PROXY_AFTER_DAYS = 4;   // 超過 4 天同仁自己補不了單，才給主管代開（同 approve.js；2026-11-14 忘打卡由 7 改 4，11/28 以前 11 月的日子不限）
export const REASONS = ['臨時調班', '主管同意', '打卡機問題'];   // 另有「其他」自己填
export const MAX_DATES = 10;         // 一次最多往前找幾天，避免卡很久
export const READ_BATCH_DAYS = 3;    // 自動找日期時，每批最多同時讀幾天

// 真的重疊才算；「會算成跨夜到隔天」只是提醒，同完整頁 approve.js 的判斷（2026-11-10 Fable 審查）
const realOverlap = (periods) => C.analyzePeriods(periods).warnings.some((w) => !/跨夜/.test(w));
export const keyOf = (o) => (o && o.store ? o.store + '|' : '') + String(o && o.emp_id);      // 同 state.js rowKey

// ---- 要處理哪一天 ----
// 本月未核定清單裡「已過去」的日子，最近的先；另外永遠把昨天排進去（月初時清單只含本月，昨天可能在上個月）。今天不自動出現。
// 要先依「這位主管可核工時」過濾（呼叫端做）再傳進來：待核定清單與待審申請（過去日期的假單、加班單、忘打卡單核准後都還要核定工時）。不在這裡截斷，由呼叫端分批找。
export function candidateDates(pendItems, today, reqItems) {
  const set = new Set();
  (Array.isArray(pendItems) ? pendItems : []).concat(Array.isArray(reqItems) ? reqItems : []).forEach((it) => { if (it && typeof it.date === 'string' && it.date < today) set.add(it.date); });
  set.add(C.addDaysStr(today, -1));
  return [...set].sort().reverse();
}
/**
 * 一批日期（近到遠）都分類完後，選最近一個還有人要處理的日子。
 * 只回傳選定日以前（較近日期）的跳過人數與採計筆數，讓較舊但已並行讀回的資料不影響 failed／skipN。
 * 手動選日期時固定取唯一一筆，不因為 left=0 而略過。
 * 某天整天讀不到（{ error }）：只有輪到那天才回傳 error，等同原本逐天讀時會停在那天。
 */
export function selectDateResult(days, manual) {
  const list = Array.isArray(days) ? days : [];
  if (manual && !(list[0] && list[0].error)) return { index: list.length ? 0 : -1, skipN: 0, consumed: list.length ? 1 : 0 };
  let skipN = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].error) return { index: -1, skipN, consumed: i, error: list[i].error };      // 依序走到讀失敗的那天才算錯；選定日更舊的日子失敗不影響結果
    if (Number(list[i] && list[i].left) > 0) return { index: i, skipN, consumed: i + 1 };
    const skipped = list[i] && list[i].skipped;
    skipN += Array.isArray(skipped) ? skipped.length : Math.max(0, Number(skipped) || 0);
  }
  return { index: -1, skipN, consumed: list.length };
}
// 標題上的日期：昨天 11/9（一）／前天 11/8（日）／11/6（五）
export function dayLabel(date, today) {
  const w = C.weekdayLabel(date);
  if (date === today) return '今天 ' + w;
  if (date === C.addDaysStr(today, -1)) return '昨天 ' + w;
  if (date === C.addDaysStr(today, -2)) return '前天 ' + w;
  return w;
}

// 這張申請這位主管現在核不核得了（同 request.js：忘打卡單看工時名單、其他看申請名單、代開看伺服器的 can_decide、自己的單不能核）
export function reqDecidable(it, canWrite) {
  if (!it || it.self === true || it.can_decide === false) return false;
  const isProxy = it.upper_kind === 'director' || !!it.proxy_by;
  return isProxy ? it.can_decide === true : !!canWrite(it.kind === 'miss' ? 'hours' : 'req', it.emp_id, it.store);
}

// ---- 打卡 ----
const hm = C.hhmmToMin;
const norm = (d) => ((((d + 720) % 1440) + 1440) % 1440) - 720;       // 兩個時鐘時間的差，落在 [-720, 720)（跨午夜也對）
export const segsOf = (emp) => (emp && Array.isArray(emp.segments) ? emp.segments.filter((s) => s && (s.in || s.out)) : []);
export const isOpenSeg = (s) => !!s && !(s.in && s.out);

/** 照打卡的時段：上班進位、下班捨去到 15 分（同申請預填的 round15），碰到休息帶就挖空。任何一段不齊或取整後長度為 0 → null。 */
export function punchPeriods(segments, br) {
  const out = [];
  for (const s of segments || []) {
    if (!s || !s.in || !s.out) return null;
    const a = C.round15(s.in, true), b = C.round15(s.out, false);
    const am = hm(a), bm = hm(b);
    if (am == null || bm == null) return null;
    if (!s.cross && bm <= am) return null;
    if (s.cross && bm === am) return null;
    if (C.shiftCoversBreak(br, a, b)) out.push(...[{ start: a, end: br.start }, { start: br.end, end: b }].filter((x) => x.start !== x.end));      // 取整後剛好貼著休息帶，不留零長度段
    else out.push({ start: a, end: b });
  }
  return out.length ? out : null;
}
/** 打卡實際分鐘（不取整），碰到休息帶扣掉休息帶；伺服器「核定和打卡差」比的是總時數，前端用它預先判斷要不要問原因 */
export function rawPunchMinutes(segments, br) {
  let t = 0;
  for (const s of segments || []) {
    if (!s || !s.in || !s.out) return null;
    const a = hm(s.in); let b = hm(s.out);
    if (a == null || b == null) return null;
    if (b <= a) b += 1440;
    t += b - a;
    if (C.shiftCoversBreak(br, s.in, s.out)) t -= hm(br.end) - hm(br.start);
  }
  return t;
}
export const MAX_SEND_H = 12;        // 要送出的上班時數上限；超過（或算不出來）一律到完整頁
/** 要送出的時段是否都合理：每段兩頭都有、不是零長度、總時數在 0 到 12 小時內（空陣列＝整天假單，另外算） */
export function periodsOk(periods) {
  if (!Array.isArray(periods)) return false;
  let total = 0;
  for (const p of periods) {
    const a = p && hm(p.start), b = p && hm(p.end);
    if (a == null || b == null || a === b) return false;
    total += ((b < a ? b + 1440 : b) - a) / 60;
  }
  return isFinite(total) && total >= 0 && total <= MAX_SEND_H;
}
/** 貼邊班：一段班、剛好從休息帶開始或在休息帶結束（例 09–13、休息 12–13）。半天班是否扣休息要主管判斷，一頁核定不替他決定 */
export function edgeShift(plan, br) {
  if (!plan || plan.work !== true || !Array.isArray(plan.segs) || plan.segs.length !== 1) return false;
  const a = plan.segs[0].start, b = plan.segs[0].end;
  return C.hasBreak(br) && C.shiftCoversBreak(br, a, b) && (a === br.start || b === br.end);
}
/** 分段班有一段蓋過休息帶（例 08–14＋17–20、休息 12–13）：班表預填只有一段班才挖休息，照班表會多算休息時間，一頁核定不替他決定（2026-11-10 Eason） */
export function splitBreak(plan, br) {
  if (!plan || plan.work !== true || !Array.isArray(plan.segs) || plan.segs.length < 2 || !C.hasBreak(br)) return false;
  return plan.segs.some((g) => C.shiftCoversBreak(br, g.start, g.end));
}
export const hoursOf = (periods) => C.round2(C.sumPeriods(periods || []).total);
const periodsOfPrefill = (pv) => (pv.initial || []).filter((p) => p && p.start && p.end).map((p) => ({ start: p.start, end: p.end }));

/** emp.plan（mgr_day 的班表）→ comparePlan 要的形狀；沒有上班班表回 undefined */
export function comparePlanOf(plan) {
  if (!plan || plan.work !== true || !Array.isArray(plan.segs) || !plan.segs.length || !plan.segs.every((s) => s && s.start && s.end)) return undefined;
  const segs = plan.segs;
  return { day_type: 'W', shift_name: plan.shift_name || '', start: segs[0].start, end: segs[segs.length - 1].end, segs: segs.length >= 2 ? segs.map((s) => [s.start, s.end]) : undefined, station: plan.station || '' };
}
/** comparePlan 的 flags → { late, early, other }。只認「晚到 N 分」「早退 N 分」（含分段班「第一段」開頭）；其他字樣（沒打卡、中間沒打卡離開…）歸 other */
export function parseFlags(flags) {
  const r = { late: 0, early: 0, other: [] };
  (flags || []).forEach((f) => {
    const m = /^(?:第.段)?(晚到|早退) (\d+) 分$/.exec(f);
    if (!m) { r.other.push(f); return; }
    const n = Number(m[2]);
    if (m[1] === '晚到') r.late = Math.max(r.late, n); else r.early = Math.max(r.early, n);
  });
  return r;
}
/** 打卡比班表晚到／早退多少分（只算不足的部分，各自 ≥ 0）；plan＝comparePlanOf 的結果 */
export function lag(plan, segments) {
  const segs = segsOf({ segments }).filter((x) => x.in && x.out);
  if (!plan || !segs.length) return { late: 0, early: 0 };
  const s0 = hm(plan.start), e0 = hm(plan.end), fi = hm(segs[0].in), lo = hm(segs[segs.length - 1].out);
  if (s0 == null || e0 == null || fi == null || lo == null) return { late: 0, early: 0 };
  return { late: Math.max(0, norm(fi - s0)), early: Math.max(0, -norm(lo - e0)) };
}
/** 分段班段數相同時逐段比：每段的晚到、早退取最大（中間那兩個邊界 lag 看不到） */
export function segLag(planSegs, segments) {
  const segs = segsOf({ segments }).filter((x) => x.in && x.out);
  const r = { late: 0, early: 0 };
  if (!Array.isArray(planSegs) || planSegs.length !== segs.length) return r;
  segs.forEach((s, i) => {
    const a = hm(planSegs[i].start), b = hm(planSegs[i].end), fi = hm(s.in), lo = hm(s.out);
    if (a == null || b == null || fi == null || lo == null) return;
    r.late = Math.max(r.late, norm(fi - a)); r.early = Math.max(r.early, -norm(lo - b));
  });
  return r;
}
/** 申請時段裡有幾分鐘沒被打卡涵蓋（休息帶不算） */
export function uncoveredMin(rs, re, segs, br) {
  const len = (((re - rs) % 1440) + 1440) % 1440;
  const bs = br && C.hasBreak(br) ? hm(br.start) : null, be = br && C.hasBreak(br) ? hm(br.end) : null;
  const inRange = (t, a, b) => (a <= b ? t >= a && t < b : t >= a || t < b);
  let n = 0;
  for (let m = 0; m < len; m++) {
    const t = (rs + m) % 1440;
    if (bs != null && be != null && inRange(t, bs, be)) continue;
    if (!segs.some((s) => { const a = hm(s.in), b = hm(s.out); return a != null && b != null && inRange(t, a, b); })) n++;
  }
  return n;
}
const periodsCover = (periods, r) => (periods || []).some((p) => p && p.start <= r.start && p.end >= r.end);
/** 打卡比班表早到／晚走多少分（只算超出的部分，各自 ≥ 0）；plan＝comparePlanOf 的結果 */
export function overshoot(plan, segments) {
  const segs = segsOf({ segments }).filter((s) => s.in && s.out);
  if (!plan || !segs.length) return { early: 0, late: 0 };
  const s = hm(plan.start), e = hm(plan.end);
  const fi = hm(segs[0].in), lo = hm(segs[segs.length - 1].out);
  if (s == null || e == null || fi == null || lo == null) return { early: 0, late: 0 };
  return { early: Math.max(0, -norm(fi - s)), late: Math.max(0, norm(lo - e)) };
}

// ---- 假別額度／期限（同 approve.js 送出前的硬擋；回字串＝擋下或要確認的原因，'' ＝可以）----
export function leaveProblem(LO, empId, leaves, date) {
  if (!LO) return '';
  for (const L of leaves || []) {
    const d0 = C.leaveDefOf(LO, L.type), q0 = d0 ? C.quotaOf(LO, String(empId), d0.code) : null;
    if (d0) {
      const wc = C.windowCheck(d0, LO.events, String(empId), date);
      if (!wc.ok) return wc.msg;
      if (wc.note) return wc.note;
    }
    if (q0 && q0.comp && !q0.allowed) return '計時同仁沒有補休';
    if (C.quotaHardBlocked(d0, q0)) return L.type + ' 額度已用完';      // 事假用完不擋，改走 personalOverText（到完整頁）
  }
  return '';
}

/** 事假超額：手機一頁不一鍵，回提示字串（到完整頁由送出前確認框處理）；沒有回 '' */
export function personalOverProblem(LO, empId, leaves) {
  if (!LO) return '';
  for (const L of leaves || []) {
    const d0 = C.leaveDefOf(LO, L.type), q0 = d0 ? C.quotaOf(LO, String(empId), d0.code) : null;
    if (C.personalOver(d0, q0)) return C.personalOverText(L.type, q0);
  }
  return '';
}

// ---- 申請說明 ----
const stripDate = (s) => String(s || '').replace(/^\d+\/\d+\s*/, '');
export const reqLine = (r) => {
  const head = (C.REQ_KIND_LABEL[r.kind] || '') + '單', sm = stripDate(r.summary);
  return r.hours_only || !sm ? head : head + '：' + sm + (r.reason ? '（' + r.reason + '）' : '');      // hours_only＝只在工時名單的人只看得到有一張單，沒有內容（伺服器 duty.js 最小列）
};
const missUsed = (periods, r) => {
  const has = (f) => periods.some(f);
  if (r.miss_type === 'out') return has((p) => p.end === r.end);
  if (r.miss_type === 'in') return has((p) => p.start === r.start);
  if (r.miss_type === 'both') return has((p) => p.start === r.start && p.end === r.end);
  if (r.miss_type === 'break') return has((p) => p.end === r.end) && has((p) => p.start === r.start);
  return false;
};
const fmtH = (h) => String(C.round2(h));

/**
 * 分類一個人。純函式，輸入：
 *   emp（mgr_day 一列）、date、today、brk（休息帶）、LO（假別額度，可為 null）、canHours（在不在核定工時名單）、
 *   reqs（這人這天的申請：[{...申請, pending:boolean, decidable:boolean}]，已核准的 pending=false）、skipped（畫面上先跳過了）、
 *   mismatch（核准單時伺服器說對不上的原因，有就只剩退回）。
 * 輸出：{ key, name, status, tag, planText, punchText, note, chk, hours, actions[], ... }
 *   status：done 已核定／absent 未出勤（不列）／readonly 不在核定名單（不列）／ok 沒問題／abnormal 異常／blocked 現在不能核定
 *   actions：{ id, label, primary, ... } id＝plan 照班表／punch 照打卡／req 核定（可含先核准單）／reject 退回單／skip 先跳過／proxy 代開忘打卡單／full 到完整頁核對
 */
/** 打卡段數和班表相符：段數一樣；一段班＋休息帶可分兩段打卡；二段班的空檔就是休息帶可一段打卡穿過；沒有班表（排休）只允許一段 */
export function segCountOk(plan, segs, br) {
  const n = plan && plan.work === true && Array.isArray(plan.segs) ? plan.segs.length : 1;
  const hm = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
  const near = (a, b) => hm(a) !== null && hm(b) !== null && Math.abs(hm(a) - hm(b)) < THRESHOLD_MIN;
  // 一段班分兩段打卡，只有中間空檔真的貼近休息帶才算相符；其他空檔（例 11:00–11:30）是中途離店
  const splitAtBreak = n === 1 && !!plan && C.hasBreak(br) && segs.length === 2 && near(segs[0].out, br.start) && near(segs[1].in, br.end);
  return segs.length === n || splitAtBreak || (n === 2 && segs.length === 1 && C.gapIsBreak(br, plan.segs[0].end, plan.segs[1].start));
}
function classifyRaw(inp) {
  const { emp, date, today, brk, LO, canHours, skipped } = inp;
  const reqs = inp.reqs || [];
  const key = keyOf(emp);
  const base = { key, name: emp.name, empId: emp.emp_id, store: emp.store || '', date, status: '', tag: '', planText: '', punchText: '', note: '', chk: '', hours: null, payload: null, actions: [], skipped: !!skipped, reqId: null };
  if (emp.approved) {
    const otLate = canHours ? reqs.filter((r) => r.kind === 'ot' && !r.pending && r.start && r.end && !periodsCover(emp.approved.periods, r)) : [];
    if (otLate.length) return Object.assign(base, { status: 'abnormal', tag: '已核定過，加班單沒算進去', note: '核定後才核准的加班單，要重新核定', actions: [{ id: 'full', label: '到完整頁核對', primary: true }, { id: 'skip', label: '先跳過', primary: false }] });
    if (canHours && reqs.some((r) => r.pending)) return Object.assign(base, { status: 'abnormal', tag: '已核定過，有新申請', note: '核定後又有新的申請，要重新核定', actions: [{ id: 'full', label: '到完整頁核對', primary: true }, { id: 'skip', label: '先跳過', primary: false }] });
    return Object.assign(base, { status: 'done', hours: Number(emp.approved.approved_hours) });
  }

  const pv = C.planPrefill(emp, emp.plan, brk);
  const segs = segsOf(emp);
  const hasPunch = !!(emp.segments && emp.segments.length) || emp.attempts > 0;
  const absent = !hasPunch && pv.mode !== 'plan';
  base.planText = pv.mode === 'plan' ? pv.text.replace(/^班表 /, '') : (pv.text || '沒有班表');
  base.punchText = segs.length ? segs.map(C.segmentText).join('、') : (emp.attempts > 0 ? '沒有入帳的打卡' : '沒有打卡');
  if (absent && !reqs.length) return Object.assign(base, { status: 'absent' });
  if (!canHours) return Object.assign(base, { status: 'readonly' });

  const full = (tag, note) => Object.assign(base, { status: 'abnormal', tag, note: note || '', actions: [{ id: 'full', label: '到完整頁核對', primary: true }, { id: 'skip', label: '先跳過', primary: false }] });      // 手機上做不完的人可以先跳過，不擋更早的日子（2026-11-09 Eason）
  const skip = (label) => ({ id: 'skip', label: label || '先跳過', primary: false });
  const fullAct = { id: 'full', label: '到完整頁核對', primary: false };
  const payloadOf = (periods, leaves) => ({ periods, leaves: leaves || [], late_min: '' });

  if ((emp.dup_groups || []).length) return full('重複打卡', '有重複打卡，要選以哪張為準');
  if (C.leavesOf(emp).length) return full('已有假別記錄', '這天已經記過假別');
  if (reqs.some((r) => r.pending && !r.decidable)) {
    const r = reqs.find((q) => q.pending && !q.decidable);
    return Object.assign(base, { status: 'blocked', tag: '等上層審核', note: (r.hours_only ? '這天有一張' + reqLine(r) + '在審核中，內容你沒有權限看，' : reqLine(r) + ' ') + '要由上層主管審核，審完才能核定', actions: [skip('先跳過，等上層審核')] });
  }
  if (reqs.length > 1) return full('有多張申請', '這天有 ' + reqs.length + ' 張申請');

  const br = brk;
  const openOrMissing = segs.some(isOpenSeg);
  const complete = segs.length > 0 && !openOrMissing;
  const missTag = () => (!segs.length ? '沒有打卡' : segs.some((s) => !s.out) && segs.some((s) => !s.in) ? '少打卡' : segs.some((s) => !s.out) ? '少下班卡' : '少上班卡');
  const planPeriods = periodsOfPrefill(pv);
  const planHours = hoursOf(planPeriods);
  if (date === today && pv.mode === 'plan' && inp.nowMin != null) {                      // 今天：最後一段班表結束前一律不核定；跨夜班今天還結束不了
    const ps = emp.plan.segs, st0 = hm(ps[0].start), en0 = hm(ps[ps.length - 1].end);
    if (st0 != null && en0 != null && (en0 <= st0 || inp.nowMin < en0)) return Object.assign(base, { status: 'blocked', tag: '今天還沒下班', note: '班表還沒結束，下班後再核定', actions: [skip('先跳過，下班後再核')] });
  }
  if (pv.mode === 'plan' && splitBreak(emp.plan, brk)) return full('分段班碰到休息帶', '其中一段班蓋過休息時間，照班表會多算休息，請到完整頁核對');


  // ================= 有一張申請 =================
  if (reqs.length === 1) {
    const r = reqs[0], line = reqLine(r);
    base.note = line; base.reqId = r.id;
    if (r.pending && !r.attach_id && r.has_attach) return full('有附件但看不到', '同仁附了證明，打卡系統還沒更新，要到完整頁看');
    const reqAct = (hours, extra) => {
      const label = (r.pending ? '核准單，核定 ' : '核定 ') + fmtH(hours) + ' 小時';
      return Object.assign({ id: 'req', label, primary: true, hours, decide: r.pending ? { id: r.id, store: r.store || emp.store || '' } : null }, extra);
    };
    const rejectAct = r.pending ? [{ id: 'reject', label: '退回單', primary: false, reqId: r.id, reqStore: r.store || emp.store || '' }] : [];
    const mismatch = (why) => (r.pending
      ? Object.assign(base, { status: 'abnormal', tag: '申請和打卡對不上', chk: why, actions: [{ id: 'reject', label: '退回，請同仁改時間', primary: true, reqId: r.id, reqStore: r.store || emp.store || '' }, fullAct] })
      : full('申請和打卡對不上', why));
    if (inp.mismatch && r.pending) return mismatch(inp.mismatch);
    let periods = null, leaves = [], tag = '';

    if (r.kind === 'leave' || r.kind === 'trip') {
      // 班表休假日＋沒打卡＋一張整天假單（有時數）：照假單核定，可一鍵（2026-11-14 Eason：許芷瑄排休那天請喪假 8 小時；班表沒有喪假可排，只能排休）
      const offLeave = pv.mode === 'off' && !emp.plan.away && r.kind === 'leave' && !r.start && Number(r.hours) > 0;
      if (pv.mode !== 'plan' && !offLeave) return full('排休或沒班表又有' + (r.kind === 'trip' ? '出差單' : '假單'), '這天不是上班日，要自己核對');
      if (r.kind === 'trip' && !(Number(r.hours) > 0)) return full('出差單沒有時數', '整天出差要填時數，到完整頁處理');
      if (r.start) return full('部分時段' + (r.kind === 'trip' ? '出差' : '請假'), '有填時段，要自己核對時數');
      if (segs.length || emp.attempts > 0) return full('有打卡又有' + (r.kind === 'trip' ? '出差單' : '假單'), '整天的單，當天卻有打卡');
      leaves = C.reqLeaveLines([r]).map((x) => ({ type: x.type, hours: (x.hours === 0 || x.hours) ? String(x.hours) : '' }));      // 舊卡片從輸入框送字串
      if (!leaves.length) return full('假單內容不明', '');
      const lp = leaveProblem(LO, emp.emp_id, leaves, date);
      if (lp) return full('假別要確認', lp);
      const po = personalOverProblem(LO, emp.emp_id, leaves);
      if (po) return full('事假超過 14 天', po);
      const lvH = leaves.reduce((a, x) => a + (Number(x.hours) || 0), 0);
      if (r.kind === 'leave' && lvH > 0 && lvH < planHours - 0.01) return full('只請部分時數又沒打卡', '請假 ' + fmtH(lvH) + ' 小時，班表 ' + fmtH(planHours) + ' 小時，當天沒有打卡，其他時間要自己核對');      // 2026-11-09 Eason：半天假另一半沒來不可一鍵
      periods = [];
      const total = C.tripHoursOfList(leaves);
      const status = r.pending ? 'abnormal' : 'ok';
      Object.assign(base, { status, tag: r.kind === 'trip' ? '出差單' : '假單', hours: total, payload: payloadOf(periods, leaves) });
      base.actions = [reqAct(total), ...rejectAct];
      base.chk = '那天沒有打卡，和' + (r.kind === 'trip' ? '出差' : '請假') + '相符';
      return base;
    }

    if (r.kind === 'ot') {
      if (!complete) return r.pending ? mismatch('加班單，但當天沒有完整的上下班打卡') : full('加班單，但打卡不齊', '');
      if (!segCountOk(pv.mode === 'plan' ? emp.plan : null, segs, br)) return full('打卡有缺口', '有加班單，但打卡不是連續一段（或和班表段數不同），要自己核對');
      const lastOut = hm(segs[segs.length - 1].out), firstIn = hm(segs[0].in), rs = hm(r.start), re = hm(r.end);
      if (rs == null || re == null) return full('加班單沒有時段', '');
      const offDay = pv.mode === 'off';
      if (!offDay && pv.mode !== 'plan') return full('沒有班表', '有加班單，但沒有班表可以對');
      if (uncoveredMin(rs, re, segs, br) >= THRESHOLD_MIN) {
        return mismatch('打卡 ' + segs[0].in + '–' + segs[segs.length - 1].out + '，沒有涵蓋加班單 ' + r.start + '–' + r.end);
      }
      if (!offDay) {
        const cp = comparePlan(comparePlanOf(emp.plan), emp.segments, { past: true, brk: br });
        if (cp && cp.flags.length) return full('遲到或早退又有加班單', cp.flags.join('、'));
      }
      const ot = C.otPeriods([r]);
      if (!ot.length) return full('加班單沒有時段', '');
      periods = offDay ? ot : planPeriods.concat(ot);
      if (realOverlap(periods)) return full('班表和加班單時段重疊', '');
      const total = hoursOf(periods);
      const rawP = rawPunchMinutes(segs, br);
      if (rawP == null || Math.abs(rawP - total * 60) >= DIFF_MIN) return full('打卡和核定時段差太多', '打卡 ' + segs[0].in + '–' + segs[segs.length - 1].out + '（扣休息 ' + fmtH((rawP || 0) / 60) + ' 小時）和要核定的 ' + fmtH(total) + ' 小時差 30 分鐘以上，不算涵蓋');
      if (!offDay && edgeShift(emp.plan, br)) return full('班表貼著休息帶', '半天班剛好碰到休息帶，要自己判斷扣不扣休息');
      tag = offDay ? '排休有打卡' : '超過班表，有加班單';
      Object.assign(base, { status: 'abnormal', tag, hours: total, payload: payloadOf(periods), chk: '打卡 ' + segs[0].in + '–' + segs[segs.length - 1].out + '，涵蓋加班單' });
      base.actions = [reqAct(total), ...rejectAct];
      return base;
    }

    if (r.kind === 'miss') {
      if (!segs.length && pv.mode !== 'plan' && r.miss_type !== 'both') return mismatch('沒有打卡可以接');
      const mp = C.missPeriods(emp.segments, r, emp.plan && emp.plan.work ? emp.plan.segs : null);
      const nOpen = segs.filter(isOpenSeg).length;
      if ((r.miss_type === 'in' || r.miss_type === 'out') ? nOpen > 1 : nOpen > 0) return full('還有別段沒打卡', '一張忘打卡單只補一段，其他段還缺卡');
      if (!mp.length || !missUsed(mp, r)) return mismatch('打卡 ' + (segs.length ? segs.map(C.segmentText).join('、') : '沒有') + '，和忘打卡單對不上');
      const hasNoIn = segs.some((x) => !x.in && x.out), hasNoOut = segs.some((x) => x.in && !x.out);
      if (pv.mode === 'off') return full('排休日有忘打卡單', '排休日要有加班單，不能用忘打卡單增加工時');
      if (r.miss_type === 'in' && !(hasNoIn && nOpen === 1)) return full('忘打卡單和缺卡對不上', '單子補上班，但打卡不是缺上班卡');
      if (r.miss_type === 'out' && !(hasNoOut && nOpen === 1)) return full('忘打卡單和缺卡對不上', '單子補下班，但打卡不是缺下班卡');
      if (r.miss_type === 'both' && !(pv.mode === 'plan' && segs.length === 0)) return full('忘打卡單和缺卡對不上', '補上班＋下班只能用在有班表、整天沒打卡的人');
      if (r.miss_type === 'break' && (pv.mode !== 'plan' || nOpen !== 0)) return full('忘打卡單和缺卡對不上', '補中間休息只能用在有班表、打卡齊全的人');
      if (realOverlap(mp)) return full('補完後時段重疊', '補完忘打卡後時段重疊，要自己核對');
      const total = hoursOf(mp);
      if (total > OK_MAX_H || (pv.mode === 'plan' && total > planHours + 0.25)) return full('補完後超過班表', '補完忘打卡後共 ' + fmtH(total) + ' 小時，比班表 ' + fmtH(planHours) + ' 小時多，沒有加班單');
      Object.assign(base, { status: 'abnormal', tag: missTag(), hours: total, payload: payloadOf(mp), chk: '補上之後 ' + mp.map((p) => p.start + '–' + p.end).join('、') });
      base.actions = [reqAct(total), ...rejectAct];
      return base;
    }
    return full('不認得的申請', '');
  }

  // ================= 沒有申請 =================
  if (date === today && !complete) return Object.assign(base, { status: 'blocked', tag: '今天還沒下班', note: '打完下班卡再核定', actions: [skip('先跳過，下班後再核')] });      // 主管自己選到今天：還沒打完卡不算缺卡
  const old = !(today <= '2026-11-28' && date >= '2026-11-01') && date < C.addDaysStr(today, -PROXY_AFTER_DAYS);
  if (!complete && pv.mode === 'plan' && date === C.addDaysStr(today, -1) && inp.nowMin != null && segs.length && segs.every((s) => s.in) && segs.some((s) => !s.out)) {
    const ps0 = emp.plan.segs, st0 = hm(ps0[0].start), en0 = hm(ps0[ps0.length - 1].end);      // 跨夜班昨天上班、現在還沒到下班時間：還在上班，不叫人補單
    if (st0 != null && en0 != null && en0 <= st0 && inp.nowMin < en0 + 60) {
      return Object.assign(base, { status: 'blocked', tag: '跨夜班還沒下班', note: '跨夜班可能還在上班，打完下班卡再核', actions: [skip('先跳過，等打完卡')] });
    }
  }
  if (!complete) {                                          // 少打卡（含整天沒打卡）、沒有單
    const tag = missTag();
    const lackIn = segs.some((s) => !s.in), lackOut = segs.some((s) => !s.out);
    const proxy = !segs.length ? 'both' : lackIn && lackOut ? '' : lackOut ? 'out' : 'in';
    const ps = pv.mode === 'plan' ? emp.plan.segs : null;
    const noLine = !!emp.no_line && date <= today;            // 沒綁 LINE（打卡端 mgr_day 帶）：7 天內也能代開（2026-11-10）
    const canProxy = old || noLine;
    Object.assign(base, { status: 'blocked', tag, note: old ? '超過 ' + PROXY_AFTER_DAYS + ' 天，同仁自己補不了單，可以由主管代開' : noLine ? '同仁沒綁 LINE，自己補不了單，可以由主管代開' : '請同仁到 LINE 補忘打卡單' });
    if (canProxy && proxy && !inp.person) {
      base.note = (old ? '超過 ' + PROXY_AFTER_DAYS + ' 天' : '同仁沒綁 LINE') + '；代開要用個人帳號登入（門市帳號不能代開）';
      base.actions = [fullAct, skip('先跳過')];
    } else if (canProxy && proxy) {
      base.actions = [{ id: 'proxy', label: '主管代開忘打卡單', primary: true, missType: proxy, defStart: ps ? ps[0].start : '', defEnd: ps ? ps[ps.length - 1].end : '' }, skip('先跳過')];
    } else if (canProxy) base.actions = [fullAct, skip('先跳過')];
    else {
      if (inp.person) base.note = '請同仁到 LINE 補忘打卡單；同仁沒綁 LINE，請到完整頁代開';      // 這裡不知道誰沒綁，完整頁送出時打卡端會判斷（2026-11-09）
      base.actions = inp.person ? [skip('先跳過，等同仁補單'), fullAct] : [skip('先跳過，等同仁補單')];
    }
    return base;
  }
  if (pv.mode === 'off') {
    return Object.assign(base, { status: 'blocked', tag: '排休有打卡', note: '還沒有加班單，請同仁到 LINE 補加班單', actions: [skip('先跳過，等同仁補單'), fullAct] });
  }
  if (pv.mode !== 'plan') return full('沒有班表', '沒有排這天的班，要自己核對');

  if (edgeShift(emp.plan, br)) return full('班表貼著休息帶', '半天班剛好碰到休息帶，要自己判斷扣不扣休息');
  const cp = comparePlan(comparePlanOf(emp.plan), emp.segments, { past: true, brk: br });
  const fl = parseFlags(cp ? cp.flags : []);
  const nPlanSegs = emp.plan.segs.length;
  if (!segCountOk(emp.plan, segs, br)) return full('打卡段數和班表不同', '班表 ' + nPlanSegs + ' 段，打卡 ' + segs.length + ' 段（可能中途離店）');
  if (fl.other.length) return full('班表和打卡對不上', fl.other.join('、'));
  const pp = punchPeriods(segs, br);
  if (!pp) return full('打卡時間要核對', '');
  const punchHours = hoursOf(pp);
  const dev = overshoot(comparePlanOf(emp.plan), segs);
  const planPayload = payloadOf(planPeriods), punchPayload = payloadOf(pp);
  const raw = rawPunchMinutes(segs, br);
  const needReason = raw != null && Math.abs(planHours * 60 - raw) >= DIFF_MIN;      // 預先判斷（以伺服器為準：它說要才會真的卡住，我們會再打開原因）
  const planAct = (primary) => ({ id: 'plan', label: '照班表 ' + fmtH(planHours) + ' 小時' + (needReason ? '（選原因）' : ''), primary, hours: planHours, payload: planPayload, askReason: needReason });
  const punchAct = (primary) => ({ id: 'punch', label: '照打卡 ' + fmtH(punchHours) + ' 小時', primary, hours: punchHours, payload: punchPayload, askReason: false });

  const lg = nPlanSegs >= 2 && segs.length === nPlanSegs ? segLag(emp.plan.segs, segs) : lag(comparePlanOf(emp.plan), segs);
  const lateV = Math.max(fl.late, lg.late >= THRESHOLD_MIN ? lg.late : 0), earlyV = Math.max(fl.early, lg.early >= THRESHOLD_MIN ? lg.early : 0);      // 達 15 分鐘就算（compare.js 2026-11-10 起同一個標準；這裡另外用 lag／segLag 再算一次，兩邊取大的）
  if (lateV || earlyV) {
    if (planHours > OK_MAX_H) return full('班表超過 ' + OK_MAX_H + ' 小時', '有遲到早退，要自己核對');
    if (punchHours > OK_MAX_H) return full('打卡超過 ' + OK_MAX_H + ' 小時', '打卡 ' + fmtH(punchHours) + ' 小時，沒有加班單');
    const tag = [lateV ? '遲到 ' + lateV + ' 分' : '', earlyV ? '早退 ' + earlyV + ' 分' : ''].filter(Boolean).join('、');
    // 核定一定照班表：打卡和核定時段比才標得出遲到早退分鐘，薪資與績效靠這個（改成打卡取整會變成沒遲到，2026-11-10 Eason）
    return Object.assign(base, { status: 'abnormal', tag, chk: '遲到早退的分鐘由薪資照扣', hours: planHours, payload: planPayload, actions: [planAct(true), fullAct] });
  }
  if (dev.early >= THRESHOLD_MIN || dev.late >= THRESHOLD_MIN) {
    const tag = [dev.early >= THRESHOLD_MIN ? '早到 ' + dev.early + ' 分' : '', dev.late >= THRESHOLD_MIN ? '晚走 ' + dev.late + ' 分' : ''].filter(Boolean).join('、');
    const acts = [planAct(true)];
    if (punchHours <= OK_MAX_H && !lg.late && !lg.early) acts.push(punchAct(false));      // 另一端有未滿 15 分的遲到早退時不給照打卡：取整後會標不出分鐘
    return Object.assign(base, { status: 'abnormal', tag, note: '沒有加班單', hours: planHours, payload: planPayload, actions: acts });
  }
  if (planHours > OK_MAX_H) {
    return Object.assign(base, { status: 'abnormal', tag: '班表超過 ' + OK_MAX_H + ' 小時', hours: planHours, payload: planPayload, actions: [planAct(true), fullAct] });
  }
  if (!planPeriods.length) return full('班表時段不全', '');
  if (raw != null && Math.abs(planHours * 60 - raw) >= DIFF_MIN) return full('打卡時數和班表差太多', '班表 ' + fmtH(planHours) + ' 小時，實際打卡 ' + fmtH(raw / 60) + ' 小時');
  return Object.assign(base, { status: 'ok', hours: planHours, payload: planPayload });
}

/** 全域防呆：任何按鈕要送的時段不合理、或時數不在 0～12 小時 → 只剩「到完整頁核對」，不出現一鍵或照打卡／照班表 */
export function classify(inp) {
  const res = classifyRaw(inp);
  const sends = [res.payload].concat((res.actions || []).map((a) => a.payload)).filter(Boolean);
  const hs = [res.hours].concat((res.actions || []).map((a) => a.hours)).filter((h) => h != null);
  const bad = sends.some((x) => !periodsOk(x.periods)) || hs.some((h) => !isFinite(h) || h < 0 || h > MAX_SEND_H);
  if (bad && (res.status === 'ok' || res.status === 'abnormal')) {
    return Object.assign(res, { status: 'abnormal', tag: '時數要核對', note: '算出來的時段或時數不合理', chk: '', hours: null, payload: null, actions: [{ id: 'full', label: '到完整頁核對', primary: true }, { id: 'skip', label: '先跳過', primary: false }] });
  }
  // 正職上班日滿 8 小時（2026-11-13 Eason）：任何一顆按鈕送出的上班＋出差＋假單不滿 8 小時 → 只能到完整頁（要補假單或跨店相加）
  if (res.status === 'ok' || res.status === 'abnormal') {
    const gaps = sends.map((x) => C.ft8Summary(inp.emp, C.sumPeriods((x.periods || []).map((p) => ({ start: p.start, end: p.end }))).total, x.leaves)).filter((f) => f && f.gap);
    if (gaps.length) {
      const g = gaps[0];
      return Object.assign(res, { status: 'abnormal', tag: '正職未滿 8 小時', note: '上班 ' + g.work + '＋出差 ' + g.trip + '＋假單 ' + g.leave + '＝' + g.sum + ' 小時，還差 ' + g.gap + ' 小時，要有已核准的假單或補休單', chk: '', hours: null, payload: null,
        actions: [{ id: 'full', label: '到完整頁核對', primary: true }, { id: 'skip', label: '先跳過', primary: false }] });
    }
  }
  return res;
}

/** 畫面上沒有待辦時的文字：月初（1～7 日）清單只有本月，上個月沒核定的看不到，不能說都核定完了 */
export function allDoneText(skipN) {
  if (skipN > 0) return '還有 ' + skipN + ' 人先跳過、沒有核定。按上方「前一天」回到那天，再按「取消跳過」就能處理';
  return '本月都核定完了，上個月未核定請到完整頁確認';      // 只讀得到本月，不宣稱全部完成
}

/** 把一整天的人分成畫面上的幾區（先跳過的 blocked 與只能到完整頁的異常不算「還剩」） */
export function sections(people) {
  const s = { ok: [], abnormal: [], blocked: [], skipped: [], done: [], readonly: [] };
  (people || []).forEach((p) => {
    if (p.status === 'ok') s.ok.push(p);
    else if (p.status === 'abnormal') (p.skipped && (p.actions || []).some((a) => a.id === 'skip') ? s.skipped : s.abnormal).push(p);
    else if (p.status === 'blocked') (p.skipped ? s.skipped : s.blocked).push(p);
    else if (p.status === 'done') s.done.push(p);
    else if (p.status === 'readonly') s.readonly.push(p);
  });
  s.left = s.ok.length + s.abnormal.length + s.blocked.length;
  return s;
}
