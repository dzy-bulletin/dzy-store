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
