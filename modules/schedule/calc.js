// 自動排班：工時比與特休（spec 第 7 節）。
import { shiftMinutes } from './hours.js';

/** 每工時營業額＝營業額 ÷ 工時（小時），四捨五入到整數元；沒有營業額或工時是 0 回 null */
export function ratio(revenue, minutes) {
  if (revenue == null || revenue === '' || !(minutes > 0)) return null;
  return Math.round(Number(revenue) / (minutes / 60));
}
/** 某天全店排班工時（分鐘） */
export function dayMinutes(ctx, d) {
  let m = 0;
  for (const st of ctx.staff) { const c = (ctx.days[st.emp_id] || {})[d]; if (c && c.shift_id && ctx.shifts[c.shift_id]) m += shiftMinutes(ctx.shifts[c.shift_id]); }
  return m;
}
/** { daily: {date: {revenue, minutes, ratio}}, period: {revenue, minutes, ratio} } */
export function ratios(ctx, dates, revenue) {
  const daily = {};
  let rev = 0, min = 0;
  for (const d of dates) {
    const m = dayMinutes(ctx, d), r = revenue[d];
    daily[d] = { revenue: r == null ? null : r, minutes: m, ratio: ratio(r, m) };
    if (r != null) { rev += Number(r); min += m; }
  }
  return { daily, period: { revenue: rev, minutes: min, ratio: ratio(rev || null, min) } };
}

/** 勞基法 §38 年資特休天數（以 asOf 那天的年資計） */
export function leaveDays(hireDate, asOf) {
  if (!hireDate) return 0;
  const [hy, hm, hd] = hireDate.split('-').map(Number);
  const [ay, am, ad] = asOf.split('-').map(Number);
  let months = (ay - hy) * 12 + (am - hm);
  if (ad < hd) months -= 1;
  if (months < 6) return 0;
  if (months < 12) return 3;
  const y = Math.floor(months / 12);
  if (y < 2) return 7;
  if (y < 3) return 10;
  if (y < 5) return 14;
  if (y < 10) return 15;
  return Math.min(30, 15 + (y - 9));
}
/** 依身分顯示：正職或「每週上班天數與正職相同」的計時給完整天數；其他計時照工時比例折算成小時（勞動部部分工時注意事項） */
export function leaveOf(term, hireDate, asOf) {
  const days = leaveDays(hireDate, asOf);
  if (!term || term.kind !== 'pt' || term.same_days) return { days, hours: days * 8 };
  const wk = term.week_min || 0;
  return { days: null, hours: Math.round(days * 8 * wk / 2400 * 10) / 10 };
}
