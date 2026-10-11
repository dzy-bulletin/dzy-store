// 自動排班：班別工時、§35 休息、換班間隔（spec 第 2、3 節）。
// 班別 { start:'HH:MM', end:'HH:MM', break_min }；end ≤ start＝跨夜（結束在隔天）。整班的工時算在開始那一天。
import { diffDays } from './period.js';

const toMin = (hm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('時間格式要是 HH:MM：' + hm);
  return +m[1] * 60 + +m[2];
};

/** 在店時間（分鐘，含休息） */
export function spanMinutes(s) {
  const a = toMin(s.start), b = toMin(s.end);
  return b > a ? b - a : b + 1440 - a;
}
/** 工時（分鐘）＝在店時間 − 休息 */
export function shiftMinutes(s) { return Math.max(0, spanMinutes(s) - (s.break_min || 0)); }
/** 一個時段沒排休息最多 6 小時（Eason 2026-10-11）：超過 6 小時而休息不到 30 分鐘＝存不進去 */
export const NO_BREAK_MAX = 6 * 60;
export function breakOk(s) { return spanMinutes(s) <= NO_BREAK_MAX || (s.break_min || 0) >= 30; }
/** §35：連續工作超過 4 小時要休息 30 分鐘；4～6 小時沒排休息可以存，但要提醒「依 §35 但書在工作時間內輪流休息」 */
export function breakWarn(s) { return spanMinutes(s) > 240 && (s.break_min || 0) < 30 && breakOk(s); }

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
