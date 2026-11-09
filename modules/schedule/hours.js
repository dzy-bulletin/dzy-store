// 自動排班：班別工時、§35 休息、換班間隔（spec 第 2、3 節）。
// 班別 { start:'HH:MM', end:'HH:MM', break_min, segs? }；end ≤ start＝跨夜（結束在隔天）。整班的工時算在開始那一天。
// 分段班（二段班、三段班，2026-10-27 Eason 選 A）：segs＝[{start,end,break_min}]（2～3 段）。start／end／break_min 存的是推算值：
// 第一段上班、最後一段下班、休息＝段與段中間的空檔＋各段內的休息。所以工時、換班間隔、單日上限不用分段也算得對；§35 休息改成每段各自看。
import { diffDays } from './period.js';

const toMin = (hm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('時間格式要是 HH:MM：' + hm);
  return +m[1] * 60 + +m[2];
};

export const SEG_MAX = 3;            // 一個班最多 3 段（Eason 2026-10-27 第 4 題）
export const SEG_GAP_MIN = 30;       // 段與段至少隔 30 分鐘；更短的請用「休息分鐘」

/** 在店時間（分鐘，含休息） */
export function spanMinutes(s) {
  const a = toMin(s.start), b = toMin(s.end);
  return b > a ? b - a : b + 1440 - a;
}
/** 這個班的各段（沒分段＝一段） */
export function segsOf(s) {
  return Array.isArray(s.segs) && s.segs.length >= 2 ? s.segs : [{ start: s.start, end: s.end, break_min: s.break_min || 0 }];
}
/** 檢查分段並推算整班的 start／end／break_min。不合規則就丟錯（訊息給店長看） */
export function normSegs(segs) {
  if (!Array.isArray(segs) || segs.length < 2) throw new Error('分段班至少要兩段');
  if (segs.length > SEG_MAX) throw new Error(`一個班最多 ${SEG_MAX} 段`);
  const CN = ['一', '二', '三'];
  let first = null, prevEnd = null, work = 0;
  const out = segs.map((x, i) => {
    let a = toMin(x.start), b = toMin(x.end);
    const brk = Math.max(0, Math.round(Number(x.break_min) || 0));
    if (prevEnd !== null) while (a < prevEnd) a += 1440;               // 比上一段下班早＝隔天（例：第二段 23:00–01:00 之後的第三段 02:00）
    if (first === null) first = a;
    while (b <= a) b += 1440;
    if (prevEnd !== null && a - prevEnd < SEG_GAP_MIN) throw new Error(`第${CN[i - 1]}段下班到第${CN[i]}段上班至少要隔 ${SEG_GAP_MIN} 分鐘（更短的請算在休息裡）`);
    if (brk >= b - a) throw new Error(`第${CN[i]}段的休息要比上班時間短`);
    prevEnd = b; work += b - a - brk;
    return { start: x.start, end: x.end, break_min: brk };
  });
  if (prevEnd - first > 1440) throw new Error('各段要照時間先後填，整個班（第一段上班到最後一段下班）不能超過 24 小時');
  return { start: out[0].start, end: out[out.length - 1].end, break_min: prevEnd - first - work, segs: out };
}
/** 工時（分鐘）＝在店時間 − 休息（分段班：段與段中間的空檔也算在休息裡） */
export function shiftMinutes(s) { return Math.max(0, spanMinutes(s) - (s.break_min || 0)); }
/** 一個時段沒排休息最多 6 小時（Eason 2026-10-11）：超過 6 小時而休息不到 30 分鐘＝存不進去。分段班每段各自看 */
export const NO_BREAK_MAX = 6 * 60;
const segOk = (x) => spanMinutes(x) <= NO_BREAK_MAX || (x.break_min || 0) >= 30;
export function breakOk(s) { return segsOf(s).every(segOk); }
/** §35：連續工作超過 4 小時要休息 30 分鐘；4～6 小時沒排休息可以存，但要提醒「依 §35 但書在工作時間內輪流休息」 */
export function breakWarn(s) { return breakOk(s) && segsOf(s).some((x) => spanMinutes(x) > 240 && (x.break_min || 0) < 30); }
/** 給人看的時段：「10:00–14:00、17:00–21:00」 */
export function timeText(s) { return segsOf(s).map((x) => `${x.start}–${x.end}`).join('、'); }

/** 這一班的開始、結束，換算成「距 d0 那天 00:00 幾分鐘」 */
function bounds(date, s, d0) {
  const off = diffDays(d0, date) * 1440;
  const a = toMin(s.start);
  return [off + a, off + a + spanMinutes(s)];
}
/** 前一班（date1, s1）下班到下一班（date2, s2）上班，間隔幾分鐘 */
export function gapMinutes(date1, s1, date2, s2) {
  const [, end1] = bounds(date1, s1, date1);
  const [start2] = bounds(date2, s2, date1);
  return start2 - end1;
}

// 畫面只顯示班別代碼：「A班」「F1班」→「A」「F1」；「早班」這類不是代碼的名稱照原樣（班別設定頁仍顯示完整名稱）
export function shiftCode(name) {
  const s = String(name == null ? '' : name).trim();
  const m = /^([A-Za-z0-9Ａ-Ｚａ-ｚ０-９]+)\s*班$/.exec(s);
  return m ? m[1] : s;
}

// 一天兩個班別（2026-11-07 Eason，docs/two-shifts/requirements.md）：同一格選兩個既有班別。
// 合成一個「虛擬班別」給工時、換班間隔、單日上限、早晚人數、LINE、核定預填共用：各段照時間先後、剛好相連的兩段併成一段（休息相加）；
// 重疊就丟錯；合起來最多 SEG_MAX 段（打卡端 LINE 只認 2～3 段）。a 要是開始較早的那班。
export const TWO_SEG_MAX = SEG_MAX;
export function combineShifts(a, b) {
  const segs = [];
  let prevEnd = null, first = null, work = 0;
  for (const x of segsOf(a).concat(segsOf(b))) {
    let s0 = toMin(x.start), e0 = toMin(x.end);
    if (prevEnd !== null) while (s0 < prevEnd - 720) s0 += 1440;      // 比上一段早很多＝隔天（跨夜）
    if (prevEnd !== null && s0 < prevEnd) throw new Error(`${b.name || '第二班'}跟${a.name || '第一班'}時間重疊`);
    while (e0 <= s0) e0 += 1440;
    if (first === null) first = s0;
    const brk = Math.max(0, Number(x.break_min) || 0);
    work += e0 - s0 - brk;
    const last = segs[segs.length - 1];
    if (last && prevEnd === s0) { last.end = x.end; last.break_min += brk; }      // 剛好相連（A 到 14:00、C 從 14:00）＝同一段，不用中間打卡
    else segs.push({ start: x.start, end: x.end, break_min: brk });
    prevEnd = e0;
  }
  if (prevEnd - first > 1440) throw new Error('兩個班合起來不能超過 24 小時');
  if (segs.length > TWO_SEG_MAX) throw new Error(`兩個班合起來最多 ${TWO_SEG_MAX} 段`);
  const out = { id: `${a.id}+${b.id}`, name: `${a.name}＋${b.name}`, start: segs[0].start, end: segs[segs.length - 1].end, break_min: prevEnd - first - work, two: [a.id, b.id] };
  if (segs.length >= 2) out.segs = segs; else out.break_min = segs[0].break_min;
  if (a.color) out.color = a.color;
  return out;
}
/** 一格的班別（有第二班＝合成的虛擬班別）；沒有班別或班別不存在＝null。合不起來（舊資料重疊）＝只用第一班 */
export function cellShift(shifts, c) {
  if (!c || !c.shift_id) return null;
  const a = shifts[c.shift_id], b = c.shift2_id ? shifts[c.shift2_id] : null;
  if (!a) return b || null;      // 第一班不在這份清單（例：總部的格子第一班排在門市，算總部考勤時只看第二班）
  if (!c.shift2_id || !b) return a;
  try { return combineShifts(a, b); } catch (e) { return a; }
}
/** 一格有哪幾個班別 id（第二班放後面） */
export const cellShiftIds = (c) => (c && c.shift_id ? (c.shift2_id ? [c.shift_id, c.shift2_id] : [c.shift_id]) : []);
/** 支援別家門市的班別 id（「門市代號.班別」，本店自己的班別代號沒有「.」；門市互相支援排班，2026-11-09） */
export const isExtId = (id) => typeof id === 'string' && id.indexOf('.') > 0;
/** 只留在本店上的部分：支援別家門市的班不算本店的當天人數、早晚人數、班別人數、工作站人數、全店工時（個人工時、連上天數、一例一休照算整格，不用這個）。
 *  兩班都在別店＝沒有班別（day_type 照舊）；一班在本店、一班在別店＝只剩本店那班（站別跟著班別走） */
export function localCell(c) {
  if (!c || !c.shift_id) return c;
  const ids = cellShiftIds(c);
  if (!ids.some(isExtId)) return c;
  const keep = ids.map((id, i) => [id, i ? c.station2_id : c.station_id]).filter(([id]) => !isExtId(id));
  const o = Object.assign({}, c);
  delete o.shift2_id; delete o.station2_id;
  if (!keep.length) { o.shift_id = null; o.station_id = null; } else { o.shift_id = keep[0][0]; o.station_id = keep[0][1] || null; }
  return o;
}
