// 考勤核定時間軸（2026-11-15 Eason 開工，docs/duty-timeline/）：把班表、打卡、已核准／待審的單疊成一條時間軸要畫的東西。
// 純函式（沒有 DOM、不碰網路；node 測試直接 require）。只負責「畫什麼」，核定規則、要不要擋一律不在這裡判斷（照 quick-calc／打卡端）。
// 時間一律用「從工作日 00:00 起算的分鐘」：跨夜（下班卡 cross、班表或單的結束早於開始）加 1440。

export const SHOW_MIN = 5;            // 少做（遲到、早退、缺勤）小於這個分鐘數不畫（差 1～4 分鐘只是雜訊）
export const SHOW_OT_MIN = 15;        // 班表外的打卡（早到、晚走、加班）小於這個分鐘數不畫：核定照 15 分鐘對齊
export const DAY_FREE_MIN = 480;      // 一天不用加班單的上限（同 core-calc.js，2026-11-16 Eason：當天滿 8 小時以上才要加班單）
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
  const planRaw = o && o.plan && o.plan.work === true && Array.isArray(o.plan.segs) ? o.plan.segs.map((s) => ({ sp: span(s.start, s.end), bm: Math.max(0, Number(s.break_min) || 0) })).filter((x) => x.sp) : [];
  const plan = planRaw.map((x) => x.sp);
  // 不打卡的休息帶：落在當天第一段班到最後一段班之間就算（班表分兩段、中間空著也是休息；2026-11-16 吳佳宜 12–13 被畫成加班）
  const bk = span(o && o.brk && o.brk.start, o && o.brk && o.brk.end);
  const hull = plan.length ? [{ a: Math.min(...plan.map((p) => p.a)), b: Math.max(...plan.map((p) => p.b)) }] : [];
  const breaks = bk ? inter(hull, [bk, { a: bk.a + DAY, b: bk.b + DAY }]) : [];

  // 同一人這天在別家店的打卡（伺服器附的 elsewhere，2026-11-17）：只畫出來，不算本店上班；落在本店班表裡的那段不算少做
  const away = [];
  (Array.isArray(o && o.elsewhere) ? o.elsewhere : []).forEach((x) => (Array.isArray(x && x.segs) ? x.segs : []).forEach((sg) => {
    const a = toMin(sg && sg.in), b0 = toMin(sg && sg.out);
    if (a == null || b0 == null) return;
    let b = b0 + (sg.cross ? DAY : 0); if (b <= a) b += DAY;
    away.push({ a, b, label: String(x.label || '別店') });
  }));
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
    if (sp) forms.push({ a: sp.a, b: sp.b, kind: r.kind, comp: r.kind === 'leave' && /補休/.test(r.leave_type || ''), pending: !!r.pending, label: r.kind === 'leave' ? (r.leave_type || '請假') : r.kind === 'trip' ? '出差' : '加班' });
  });
  const planLen = len(minus(plan, breaks));
  const allDayReq = (pend) => rs.find((r) => r && (r.kind === 'leave' || r.kind === 'trip') && !!r.pending === pend && !span(r.start, r.end) && planLen > 0 && Number(r.hours) * 60 >= planLen - 1);
  const adr = allDayReq(false) || allDayReq(true), allDayLeave = !!adr && !adr.pending, allDayPend = !!adr && !!adr.pending;
  if (adr) plan.forEach((p) => forms.push({ a: p.a, b: p.b, kind: adr.kind, comp: adr.kind === 'leave' && /補休/.test(adr.leave_type || ''), pending: allDayPend, label: (adr.kind === 'trip' ? '整天出差' : '整天請假') + (allDayPend ? '（待審）' : ''), allDay: true }));
  const leaveCover = forms.filter((f) => !f.pending && (f.kind === 'leave' || f.kind === 'trip'));
  const leavePend = forms.filter((f) => f.pending && (f.kind === 'leave' || f.kind === 'trip'));
  const otCover = forms.filter((f) => !f.pending && f.kind === 'ot');

  // 跟班表比：班表內沒打到卡＝少做（有假單蓋住＝請假）；班表外打卡＝多做（有加班單＝有單）
  const devs = [];
  const push = (list, kind) => list.forEach((s) => { if (s.b - s.a >= (kind === 'ot' || kind === 'otok' || kind === 'extra' ? SHOW_OT_MIN : SHOW_MIN)) devs.push({ a: s.a, b: s.b, kind }); });
  // 假單蓋住的缺勤：補休一個顏色、其他請假（含出差）一個顏色（2026-11-16 Eason：一目瞭然有沒有補休）
  const pushLeave = (list, cover, pend) => {
    const comp = cover.filter((f) => f.comp), trip = cover.filter((f) => !f.comp && f.kind === 'trip'), other = cover.filter((f) => !f.comp && f.kind !== 'trip');
    push(inter(list, comp), pend ? 'comppend' : 'comp');
    push(minus(inter(list, trip), comp), pend ? 'trippend' : 'trip');      // 出差單獨一個顏色（2026-11-16 Eason 科技風配色：班別、出勤、加班、出差、忘刷）
    push(minus(minus(inter(list, other), comp), trip), pend ? 'leavepend' : 'leave');
  };
  // 班表外的打卡：加班單蓋到＝加班（有單）；其餘照時間先後補到當天 8 小時為止＝比班表多（不用單）；再多＝加班沒單
  const splitExtra = (extra, workedMin) => {
    push(inter(extra, otCover), 'otok');
    let budget = Math.max(0, DAY_FREE_MIN - workedMin);
    const free = [], rest = [];
    minus(extra, otCover).sort((x, y) => x.a - y.a).forEach((s) => {
      const take = Math.min(s.b - s.a, budget); budget -= take;
      if (take > 0) free.push({ a: s.a, b: s.a + take });
      if (s.b - s.a > take) rest.push({ a: s.a + take, b: s.b });
    });
    push(free, 'extra'); push(rest, 'ot');
  };
  if (plan.length) {
    const work = minus(plan, breaks);
    // 缺卡：少下班卡從上班卡畫到那段班表結束；少上班卡從那段班表開始畫到下班卡
    const missing = [];
    open.forEach((x) => {
      if (x.side === 'out') { const end = Math.max(...plan.filter((p) => p.b > x.a).map((p) => p.b), x.a); if (end > x.a) missing.push({ a: x.a, b: end }); }
      else { const st = Math.min(...plan.filter((p) => p.a < x.b).map((p) => p.a), x.b); if (x.b > st) missing.push({ a: st, b: x.b }); }
    });
    // 忘刷：有已核准的忘打卡單＝實心（單補上了），沒有＝斜紋（要補單）（2026-11-16）
    const missOk = rs.some((r) => r && r.kind === 'miss' && !r.pending);
    push(missing, missOk ? 'missok' : 'miss');
    let notWorked = minus(minus(work, punch), missing);
    // 班別排了休息分鐘（break_min，例 A 班 15:00–23:30 休息 30 分）：同一段班中間兩段打卡之間的空檔，休息分鐘數以內畫「空班休息」，超過的才是少做
    //   （2026-11-16 Eason：林秀縈 19:44–20:13 是休息，被畫成缺勤）。開頭、結尾沒打到卡（遲到、早退）不算休息
    const segRest = [];
    planRaw.forEach((s) => {
      if (!(s.bm > 0)) return;
      let left = s.bm;
      inter(notWorked, [s.sp]).filter((x) => x.a > s.sp.a && x.b < s.sp.b).sort((x, y) => x.a - y.a).forEach((x) => {
        if (left <= 0) return;
        const take = Math.min(x.b - x.a, left); left -= take;
        segRest.push({ a: x.a, b: x.a + take });
      });
    });
    if (segRest.length) { notWorked = minus(notWorked, segRest); push(segRest, 'rest'); }
    if (away.length) notWorked = minus(notWorked, away);      // 在別家店上班的時間：不畫成本店少做
    pushLeave(notWorked, leaveCover, false);
    const rest = minus(notWorked, leaveCover);
    pushLeave(rest, leavePend, true);                    // 假單還在待審：先畫成「待審的假」，不當成少做
    push(minus(rest, leavePend), 'short');
    // 遲到那段照「開頭留班表」算在 8 小時裡（同 core-calc）
    const first = punch.length ? Math.min(...punch.map((x) => x.a)) : null;
    const lateHead = first != null && first > plan[0].a ? minus(inter(work, [{ a: plan[0].a, b: Math.min(first, plan[0].b) }]), punch) : [];
    const workedMin = len(inter(work, punch)) + len(lateHead);
    splitExtra(minus(minus(punch, plan), breaks), workedMin);
    // 空班休息：班表兩段之間的空檔、不打卡休息帶，沒打卡的部分
    const gaps = [];
    for (let i = 1; i < plan.length; i++) if (plan[i].a > plan[i - 1].b) gaps.push({ a: plan[i - 1].b, b: plan[i].a });
    push(minus(minus(gaps, breaks).concat(breaks), punch), 'rest');        // 空檔就是休息帶時只畫一次
  } else {
    // 沒排班：打卡都算加班（有加班單＝有單；排休來上班一律要加班單）；請假照畫
    push(inter(punch, otCover), 'otok');
    push(minus(punch, otCover), 'ot');
  }
  devs.sort((x, y) => x.a - y.a);

  // 時間軸範圍：所有東西的最早到最晚，前後各留到整點偶數小時，至少 8 小時
  const pts = [];
  [plan, punch, forms, devs, away].forEach((l) => l.forEach((s) => { pts.push(s.a, s.b); }));
  open.forEach((x) => pts.push(x.a != null ? x.a : x.b));
  let from = pts.length ? Math.min(...pts) : 9 * 60, to = pts.length ? Math.max(...pts) : 18 * 60;
  from = Math.max(0, Math.floor((from - 30) / 120) * 120);
  to = Math.ceil((to + 30) / 120) * 120;
  if (to - from < 8 * 60) to = from + 8 * 60;
  const ticks = [];
  for (let t = from; t <= to; t += (to - from > 16 * 60 ? 240 : 120)) ticks.push(t);

  // 請假卻有打卡（開工確認第 5 題）：只看已核准的「請假」單（出差本來就可能在店裡打卡，不算），假單時段裡打卡合計 30 分鐘以上
  const leaveOnly = leaveCover.filter((f) => f.kind === 'leave');
  // 時間軸下方的刻度：有班表就標班表的起訖（2026-11-15 Eason：「班表時段直接取代固定的 08–24」），沒有班表才用整點
  const planTicks = [...new Set(plan.flatMap((p) => [p.a, p.b]))].sort((x, y) => x - y);
  const leavePunch = punch.length > 0 && leaveOnly.some((f) => len(inter(punch, [f])) >= 30);
  // 班內休息分鐘合計（每段班最多扣到那段的長度）：排班工時要扣掉（2026-11-17 Eason）
  const segBreakMin = planRaw.reduce((t, s) => t + Math.min(s.bm || 0, len(minus([s.sp], breaks))), 0);
  return { from, to, ticks, planTicks, plan, punch, open, forms, devs, breaks, segBreakMin, away, leaveAllDay: allDayLeave, leavePunch };
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
    plan += Math.max(0, len(minus(m.plan, m.breaks)) - (m.segBreakMin || 0));      // 排班工時：扣固定休息帶與班內休息分鐘（例 A 班 15:00–23:30 休 30 分＝8 小時）
    work += len(m.punch);
    leave += len(m.forms.filter((f) => !f.pending && (f.kind === 'leave' || f.kind === 'trip')));
  });
  const r = (x) => Math.round(x / 60 * 100) / 100;
  return { plan: r(plan), work: r(work), leave: r(leave) };
}
