// 考勤核定時間軸（2026-11-15 Eason 開工，docs/duty-timeline/）：把班表、打卡、已核准／待審的單疊成一條時間軸要畫的東西。
// 純函式（沒有 DOM、不碰網路；node 測試直接 require）。只負責「畫什麼」，核定規則、要不要擋一律不在這裡判斷（照 quick-calc／打卡端）。
// 時間一律用「從工作日 00:00 起算的分鐘」：跨夜（下班卡 cross、班表或單的結束早於開始）加 1440。

export const SHOW_MIN = 5;            // 少做（遲到、早退、缺勤）小於這個分鐘數不畫（差 1～4 分鐘只是雜訊）
export const SHOW_OT_MIN = 15;        // 多做（早到、晚走）小於這個分鐘數不畫：加班照 15 分鐘一格算，早到晚走幾分鐘不算加班
const DAY = 1440;

export function toMin(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h <= 47 && mi < 60 ? h * 60 + mi : null;
}
export function hhmm(min) {
  const m = ((Math.round(min) % DAY) + DAY) % DAY;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
// 一段起訖：結束不晚於開始＝跨夜
function span(a, b) {
  const x = toMin(a), y = toMin(b);
  if (x == null || y == null) return null;
  return { a: x, b: y <= x ? y + DAY : y };
}
// 區間運算：list 減掉 cut，回傳剩下的片段
function minus(list, cut) {
  let out = list.map((s) => ({ a: s.a, b: s.b }));
  cut.forEach((c) => {
    const next = [];
    out.forEach((s) => {
      if (c.b <= s.a || c.a >= s.b) { next.push(s); return; }
      if (c.a > s.a) next.push({ a: s.a, b: c.a });
      if (c.b < s.b) next.push({ a: c.b, b: s.b });
    });
    out = next;
  });
  return out;
}
function inter(list, cut) {
  const out = [];
  list.forEach((s) => cut.forEach((c) => { const a = Math.max(s.a, c.a), b = Math.min(s.b, c.b); if (b > a) out.push({ a, b }); }));
  return out;
}
const len = (list) => list.reduce((t, s) => t + (s.b - s.a), 0);

/**
 * @param {object} o
 *   segments：mgr_day 的打卡段 [{in,out,cross}]（in／out 可能是 null＝少那張卡）
 *   plan：mgr_day 的班表 {work, segs:[{start,end}], day_type}；null／work:false＝沒排班
 *   reqs：那天這個人的申請 [{kind:'ot'|'leave'|'trip'|'miss', start, end, hours, leave_type, pending}]
 *   brk：這家店不打卡的休息帶 {start,end}（央廚、總部；沒有＝空字串）
 * @returns {{from,to,ticks,plan,punch,open,forms,devs,leaveAllDay,leavePunch}}
 */
export function timelineModel(o) {
  const segs = Array.isArray(o && o.segments) ? o.segments : [];
  const plan = o && o.plan && o.plan.work === true && Array.isArray(o.plan.segs) ? o.plan.segs.map((s) => span(s.start, s.end)).filter(Boolean) : [];
  // 班表裡不打卡的休息帶（每一段班表各自看有沒有蓋到）
  const bk = span(o && o.brk && o.brk.start, o && o.brk && o.brk.end);
  const breaks = bk ? inter(plan, [bk, { a: bk.a + DAY, b: bk.b + DAY }]) : [];

  // 打卡：完整段畫實心；只有上班卡或只有下班卡另外記（畫缺卡）
  const punch = [], open = [];
  segs.forEach((s) => {
    const a = toMin(s && s.in), b0 = toMin(s && s.out);
    if (a != null && b0 != null) { let b = b0 + (s.cross ? DAY : 0); if (b <= a) b += DAY; punch.push({ a, b }); }
    else if (a != null) open.push({ a, side: 'out' });          // 少下班卡
    else if (b0 != null) open.push({ b: b0 + (s.cross ? DAY : 0), side: 'in' });     // 少上班卡
  });

  // 單：有起訖的畫框；請假沒有時段但時數蓋滿整個班表＝整天請假
  const forms = [];
  const rs = Array.isArray(o && o.reqs) ? o.reqs : [];
  rs.forEach((r) => {
    if (!r || !['ot', 'leave', 'trip'].includes(r.kind)) return;
    const sp = span(r.start, r.end);
    if (sp) forms.push({ a: sp.a, b: sp.b, kind: r.kind, pending: !!r.pending, label: r.kind === 'leave' ? (r.leave_type || '請假') : r.kind === 'trip' ? '出差' : '加班' });
  });
  const planLen = len(minus(plan, breaks));
  const allDayReq = (pend) => rs.find((r) => r && (r.kind === 'leave' || r.kind === 'trip') && !!r.pending === pend && !span(r.start, r.end) && planLen > 0 && Number(r.hours) * 60 >= planLen - 1);
  const adr = allDayReq(false) || allDayReq(true), allDayLeave = !!adr && !adr.pending, allDayPend = !!adr && !!adr.pending;
  if (adr) plan.forEach((p) => forms.push({ a: p.a, b: p.b, kind: adr.kind, pending: allDayPend, label: (adr.kind === 'trip' ? '整天出差' : '整天請假') + (allDayPend ? '（待審）' : ''), allDay: true }));
  const leaveCover = forms.filter((f) => !f.pending && (f.kind === 'leave' || f.kind === 'trip'));
  const leavePend = forms.filter((f) => f.pending && (f.kind === 'leave' || f.kind === 'trip'));
  const otCover = forms.filter((f) => !f.pending && f.kind === 'ot');

  // 跟班表比：班表內沒打到卡＝少做（有假單蓋住＝請假）；班表外打卡＝多做（有加班單＝有單）
  const devs = [];
  const push = (list, kind) => list.forEach((s) => { if (s.b - s.a >= (kind === 'ot' || kind === 'otok' ? SHOW_OT_MIN : SHOW_MIN)) devs.push({ a: s.a, b: s.b, kind }); });
  if (plan.length) {
    const work = minus(plan, breaks);
    // 缺卡：少下班卡從上班卡畫到那段班表結束；少上班卡從那段班表開始畫到下班卡
    const missing = [];
    open.forEach((x) => {
      if (x.side === 'out') { const end = Math.max(...plan.filter((p) => p.b > x.a).map((p) => p.b), x.a); if (end > x.a) missing.push({ a: x.a, b: end }); }
      else { const st = Math.min(...plan.filter((p) => p.a < x.b).map((p) => p.a), x.b); if (x.b > st) missing.push({ a: st, b: x.b }); }
    });
    push(missing, 'miss');
    const notWorked = minus(minus(work, punch), missing);
    push(inter(notWorked, leaveCover), 'leave');
    const rest = minus(notWorked, leaveCover);
    push(inter(rest, leavePend), 'leavepend');            // 假單還在待審：先畫成「待審的假」，不當成少做
    push(minus(rest, leavePend), 'short');
    const extra = minus(punch, plan);
    push(inter(extra, otCover), 'otok');
    push(minus(extra, otCover), 'ot');
  } else {
    // 沒排班：打卡都算多做（有加班單＝有單）；請假照畫
    push(inter(punch, otCover), 'otok');
    push(minus(punch, otCover), 'ot');
  }
  devs.sort((x, y) => x.a - y.a);

  // 時間軸範圍：所有東西的最早到最晚，前後各留到整點偶數小時，至少 8 小時
  const pts = [];
  [plan, punch, forms, devs].forEach((l) => l.forEach((s) => { pts.push(s.a, s.b); }));
  open.forEach((x) => pts.push(x.a != null ? x.a : x.b));
  let from = pts.length ? Math.min(...pts) : 9 * 60, to = pts.length ? Math.max(...pts) : 18 * 60;
  from = Math.max(0, Math.floor((from - 30) / 120) * 120);
  to = Math.ceil((to + 30) / 120) * 120;
  if (to - from < 8 * 60) to = from + 8 * 60;
  const ticks = [];
  for (let t = from; t <= to; t += (to - from > 16 * 60 ? 240 : 120)) ticks.push(t);

  // 請假卻有打卡（開工確認第 5 題）：只看已核准的「請假」單（出差本來就可能在店裡打卡，不算），假單時段裡打卡合計 30 分鐘以上
  const leaveOnly = leaveCover.filter((f) => f.kind === 'leave');
  const leavePunch = punch.length > 0 && leaveOnly.some((f) => len(inter(punch, [f])) >= 30);
  return { from, to, ticks, plan, punch, open, forms, devs, breaks, leaveAllDay: allDayLeave, leavePunch };
}

// 異常排序（2026-11-15 開工確認）：缺卡 → 缺勤沒單 → 假單對不上／請假卻打卡 → 單待審 → 加班 → 遲到早退 → 其他。數字小的排前面
export function severity(tag, model) {
  const t = String(tag || '');
  if (/少打卡|少上班卡|少下班卡|沒有打卡|忘刷|無打卡/.test(t)) return 0;
  if (model && model.devs && model.devs.some((d) => d.kind === 'miss')) return 0;
  if (/未符合|沒核定成功|被退回/.test(t)) return 1;
  if (/請假卻有打卡|對不上|正職未滿/.test(t)) return 2;
  if (/審核|申請|假單|出差單|有新申請/.test(t)) return 3;
  if (/加班|超過|排休有打卡/.test(t)) return 4;
  if (/遲到|早退|晚到|早走/.test(t)) return 5;
  return 6;
}

// 摘要：排班、上班、請假時數（小時，兩位小數）
export function hoursSummary(models) {
  let plan = 0, work = 0, leave = 0;
  (models || []).forEach((m) => {
    if (!m) return;
    plan += len(minus(m.plan, m.breaks));
    work += len(m.punch);
    leave += len(m.forms.filter((f) => !f.pending && (f.kind === 'leave' || f.kind === 'trip')));
  });
  const r = (x) => Math.round(x / 60 * 100) / 100;
  return { plan: r(plan), work: r(work), leave: r(leave) };
}
