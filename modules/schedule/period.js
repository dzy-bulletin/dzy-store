// 自動排班：日期與週期換算（spec 第 2 節）。前端、伺服器（require(esm)）、測試共用。
// 日期一律 'YYYY-MM-DD' 字串、以台北民用日期為準；內部用 UTC 午夜換算天數，不受時區與夏令時間影響。

export const BASE = '2026-11-01';     // T01 第 1 天（週日）
export const PERIOD_DAYS = 28;
export const FIRST_OPEN = '2026-10-04'; // T00 第 1 天；之前不開放

const DAY_MS = 86400000;
const toMs = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new Error('日期格式要是 YYYY-MM-DD：' + d);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
};
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);

export function addDays(d, n) { return fromMs(toMs(d) + n * DAY_MS); }
export function diffDays(a, b) { return Math.round((toMs(b) - toMs(a)) / DAY_MS); }   // b − a
export function weekday(d) { return new Date(toMs(d)).getUTCDay(); }                  // 0＝週日

/** 期號（整數）：T01＝1、T00＝0；FIRST_OPEN 之前回 null */
export function periodNo(d) {
  if (diffDays(FIRST_OPEN, d) < 0) return null;
  return Math.floor(diffDays(BASE, d) / PERIOD_DAYS) + 1;
}
export function label(n) { return 'T' + String(n).padStart(2, '0'); }
export function parseLabel(p) {
  const m = /^T(\d{2,})$/.exec(p || '');
  if (!m) throw new Error('期代號格式要是 T + 兩位以上數字：' + p);
  return +m[1];
}
export function periodOf(d) { const n = periodNo(d); return n === null ? null : label(n); }
export function periodStart(p) { return addDays(BASE, (parseLabel(p) - 1) * PERIOD_DAYS); }
export function periodEnd(p) { return addDays(periodStart(p), PERIOD_DAYS - 1); }
export function periodDates(p) { const s = periodStart(p); return Array.from({ length: PERIOD_DAYS }, (_, i) => addDays(s, i)); }
export function shiftPeriod(p, k) { return label(parseLabel(p) + k); }
/** 期內第幾天（0–27） */
export function dayIndex(d) { return ((diffDays(BASE, d) % PERIOD_DAYS) + PERIOD_DAYS) % PERIOD_DAYS; }
/** 期內第幾週（0–3；每週都是週日到週六） */
export function weekOf(d) { return Math.floor(dayIndex(d) / 7); }

/** 台北時間的「今天」。now 可注入（測試用固定時間） */
export function todayTaipei(now) {
  const t = (now instanceof Date ? now.getTime() : (now == null ? Date.now() : now)) + 8 * 3600000;
  return fromMs(t - (t % DAY_MS));
}
