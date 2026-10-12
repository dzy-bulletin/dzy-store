// 自動排班：勞基法與排班限制檢查（spec 第 3、5 節）。純函式，前端即時檢查、伺服器存檔／鎖定、自動排班收尾共用。
//
// ctx = {
//   period: 'T01',
//   shifts: { S1: {id,name,start,end,break_min}, … },
//   staff: [{ emp_id, name, hire_date, leave_date }],
//   terms: { emp_id: [{ from_date, kind:'ft'|'pt', target_min, week_min, same_days, allowed_shifts:[] }] },
//   days: { emp_id: { 'YYYY-MM-DD': { day_type:'W'|'R'|'H'|'L', shift_id, leave } } }   // 本期＋前期最後 13 天
//   actuals: { emp_id: { date: {start,end} } }       // 前期沒有 days 時用（T01 的 10 月實際出勤）
//   demand: { date: { shift_id: {min,max} } },
//   pins: { emp_id: { date: { kind:'off'|'work'|'shift', shift_id } } },
//   pairs: [[emp_a, emp_b]],
//   holidays: { validThrough, days: { date: name } },
//   monthOtMin: { 'YYYY-MM': { emp_id: 分鐘 } },     // 本期碰到的曆月、期外日子的加班分鐘（伺服器先算好）
// }
// 回傳 [{ code, level:'block'|'warn'|'info', emp_id, date, msg }]
import { periodDates, addDays, diffDays } from './period.js';
import { shiftMinutes, gapMinutes } from './hours.js';

export const H = 60;
const FT_DAY_NORMAL = 10 * H, PT_DAY_NORMAL = 8 * H, DAY_MAX = 12 * H;
const PERIOD_NORMAL = 160 * H, WEEK_NORMAL = 40 * H, MONTH_OT = 46 * H;
export const MIN_GAP = 12 * H;                // 換班間隔（內規）：Eason 2026-10-11 從 11 小時改 12 小時，自動排班與檢查共用這一個值
const LEAVE_MIN = 8 * H;                     // 請假、國定假日放假一天算 8 小時（F7）
const LOOKBACK = 13;

const hm = (m) => { const h = Math.floor(m / 60), r = m % 60; return r ? `${h} 小時 ${r} 分` : `${h} 小時`; };
const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

/** 某人某天適用的身分條款（依 from_date 生效） */
export const FT_OT_MAX = 2;                                            // 正職休息日加班每期上限（天）

export function termAt(terms, emp, date) {
  let t = null;
  for (const x of (terms[emp] || [])) if (x.from_date <= date && (!t || x.from_date >= t.from_date)) t = x;
  return t;
}
export const isHoliday = (hol, d) => !!(hol && hol.days && hol.days[d]);
export const employed = (st, d) => (!st.hire_date || st.hire_date <= d) && (!st.leave_date || d <= st.leave_date);

/** 合法組合（spec 第 3 節）。回傳錯誤字串或 null */
export function comboError(c, hol, d) {
  if (!c) return null;
  const s = !!c.shift_id;
  switch (c.day_type) {
    case 'W': return c.leave ? '工作日不能填假別' : null;
    case 'R': return s ? '例假不能排班' : (c.leave ? '例假不能填假別' : null);
    case 'H': return c.leave ? '休息日不能填假別' : null;
    case 'L':
      if (s) return '請假那天不能排班';
      if (!['特', '補', '國'].includes(c.leave)) return '請假要選特休、補休或國定假日';
      return null;   // 「國」排在哪天合法要看整期（正職可移到同期別天），由 checkPeriod 的 C7 檢查
    default: return '日別要是工作日、例假、休息日或請假';
  }
}

/** 一人逐日分鐘：{date: {work, normal, ot}}；照 spec 第 3 節分正常與加班（四週變形：日 10 小時、期 160 小時；每週制：日 8、週 40） */
export function minutesOf(ctx, emp, dates) {
  const out = {};
  let periodNormal = 0;
  const weekNormal = {};
  for (const d of dates) {
    const c = (ctx.days[emp] || {})[d];
    const sh = c && c.shift_id ? ctx.shifts[c.shift_id] : null;
    const work = sh ? shiftMinutes(sh) : 0;
    let normal = 0, ot = 0;
    if (work) {
      const t = termAt(ctx.terms, emp, d);
      const ft = !t || t.kind !== 'pt';
      if (c.day_type === 'H') ot = work;
      else {
        normal = Math.min(work, ft ? FT_DAY_NORMAL : PT_DAY_NORMAL);
        ot = work - normal;
        if (ft) {
          const over = Math.max(0, periodNormal + normal - PERIOD_NORMAL);
          normal -= over; ot += over; periodNormal += normal;
        } else {
          const w = Math.floor(diffDays(dates[0], d) / 7);
          const over = Math.max(0, (weekNormal[w] || 0) + normal - WEEK_NORMAL);
          normal -= over; ot += over; weekNormal[w] = (weekNormal[w] || 0) + normal;
        }
      }
    }
    out[d] = { work, normal, ot };
  }
  return out;
}

/** 某天有沒有上班（本期與前期用 days；前期沒有 days 時用 actuals） */
function workedOn(ctx, emp, d) {
  const a = (ctx.actuals && ctx.actuals[emp] || {})[d];
  if (a && ctx.period && d < periodDates(ctx.period)[0]) return { date: d, shift: { start: a.start, end: a.end, break_min: 0 } };   // 前期有實際出勤就以實際為準（GPT 上線前審查 6）
  const c = (ctx.days[emp] || {})[d];
  if (c) return c.shift_id ? { date: d, shift: ctx.shifts[c.shift_id] } : null;
  return a ? { date: d, shift: { start: a.start, end: a.end, break_min: 0 } } : null;
}
function hasPrior(ctx, emp, start) {
  for (let i = 1; i <= LOOKBACK; i++) {
    const d = addDays(start, -i);
    if ((ctx.days[emp] || {})[d] || (ctx.actuals && ctx.actuals[emp] || {})[d]) return true;
  }
  return false;
}

export function checkPeriod(ctx) {
  const R = [];
  const add = (code, level, emp_id, date, msg) => R.push({ code, level, emp_id: emp_id || null, date: date || null, msg });
  const dates = periodDates(ctx.period);
  const start = dates[0], end = dates[27];
  const name = {};
  ctx.staff.forEach(s => { name[s.emp_id] = s.name; });
  const hol = ctx.holidays || { days: {} };

  if (hol.validThrough && end > hol.validThrough) add('C5', 'block', null, end, `國定假日表只到 ${hol.validThrough}，要先補上下一年的假日才能鎖定`);

  const noPrior = [];
  for (const st of ctx.staff) {
    const e = st.emp_id, who = st.name;
    const mine = ctx.days[e] || {};
    const inPeriod = dates.filter(d => employed(st, d));
    // 制度別看「這期在職第一天」的身分：期中才報到、身分從報到日起算時，期首那天沒有身分，不能因此整段跳過檢查（2026-10-11 審查）
    const t0 = inPeriod.length ? termAt(ctx.terms, e, inPeriod[0]) : null;
    if (!inPeriod.length) {
      for (const d of dates) if (mine[d] && mine[d].shift_id) add('C6', 'block', e, d, `${who} ${md(d)} 不在職（到職 ${st.hire_date || '—'}、離職 ${st.leave_date || '—'}），不能排班`);
      continue;
    }
    if (inPeriod.some(d => !termAt(ctx.terms, e, d))) { add('S1', 'block', e, start, `${who} 還沒設定正職或計時`); continue; }
    const fullPeriod = inPeriod.length === 28;
    const kinds = new Set(inPeriod.map(d => (termAt(ctx.terms, e, d) || {}).kind));
    if (kinds.size > 1) { add('S2', 'block', e, start, `${who} 這期中間從${t0 && t0.kind === 'pt' ? '計時' : '正職'}改了身分，身分變更請從某一期的第一天開始生效`); continue; }
    const mins = minutesOf(ctx, e, dates);

    // 合法組合、到職離職、班別存在、日別沒填（沒排的天數每人只列一條，從第一天標起）
    const blank = inPeriod.filter(d => !mine[d]);
    if (blank.length) add('V1', 'block', e, blank[0], `${who} 有 ${blank.length} 天還沒排（從 ${md(blank[0])} 起）`);
    for (const d of dates) {
      const c = mine[d];
      if (!employed(st, d)) { if (c && c.shift_id) add('C6', 'block', e, d, `${who} ${md(d)} 不在職（到職 ${st.hire_date || '—'}、離職 ${st.leave_date || '—'}），不能排班`); continue; }
      if (!c) continue;
      const err = comboError(c, hol, d);
      if (err) { add('V0', 'block', e, d, `${who} ${md(d)}：${err}`); continue; }
      if (c.day_type === 'W' && !c.shift_id) add('V1', 'block', e, d, `${who} ${md(d)} 是工作日但沒有排班`);
      if (c.shift_id && !ctx.shifts[c.shift_id]) add('V0', 'block', e, d, `${who} ${md(d)} 的班別已不存在`);
    }

    // 單日總工時（兩種制度都擋 12 小時）
    for (const d of dates) if (mins[d].work > DAY_MAX) add('F4', 'block', e, d, `${who} ${md(d)} 一天 ${hm(mins[d].work)}，超過 12 小時`);

    // 連續上班（跨期接續；沒有前期資料就從本期起算並提醒）
    if (!hasPrior(ctx, e, start) && inPeriod[0] === start) noPrior.push(who);
    let run = 0;
    for (let i = LOOKBACK; i >= 1; i--) run = workedOn(ctx, e, addDays(start, -i)) ? run + 1 : 0;
    let told = false;                                                  // 同一段連續上班只報一次（前期已連上很多天時，本期第一天就要擋）
    for (const d of dates) {
      run = workedOn(ctx, e, d) ? run + 1 : 0;
      if (!run) { told = false; continue; }
      const t = termAt(ctx.terms, e, d);
      if (!t || told) continue;
      if (t.kind === 'ft' && run >= 13) { add('F6', 'block', e, d, `${who} 到 ${md(d)} 已連續上班 ${run} 天，最多 12 天`); told = true; }
      if (t.kind === 'pt' && run >= 7) { add('P3', 'block', e, d, `${who} 到 ${md(d)} 已連續上班 ${run} 天，一定要休一天`); told = true; }
    }

    // 換班間隔 12 小時（內規，比 §34 的 11 小時嚴；跨期也比）
    let lastShift = null;                                              // 上一個實際的班（跨夜班可能隔一天才接下一班，GPT 上線前審查 8）
    for (let i = 3; i >= 1; i--) { const w = workedOn(ctx, e, addDays(start, -i)); if (w && w.shift) lastShift = w; }
    for (const d of dates) {
      const cur = workedOn(ctx, e, d);
      if (!cur || !cur.shift) continue;
      if (lastShift && lastShift.shift) {
        const g = gapMinutes(lastShift.date, lastShift.shift, d, cur.shift);
        if (g < MIN_GAP) add('C1', 'block', e, d, `${who} ${md(lastShift.date)} 下班到 ${md(d)} 上班只隔 ${hm(Math.max(0, g))}，至少要 12 小時`);
      }
      lastShift = cur;
    }

    // 國定假日（Eason 2026-10-12）：正職預設國定假日照常上班，同一期另排一天「國定假日假」（L＋國，可排在任何一天）；
    //   國定假日假天數＝本期在職的國定假日天數。排不夠只提醒（當天出勤要給雙倍薪資），排太多擋。
    //   計時維持原規則：國定假日假只能排在國定假日當天，當天上班提醒工資加倍、碰到例休提醒補假。
    const hols = inPeriod.filter(d => isHoliday(hol, d));
    const guo = inPeriod.filter(d => mine[d] && mine[d].day_type === 'L' && mine[d].leave === '國');
    if (t0 && t0.kind === 'ft') {
      if (guo.length > hols.length) add('C7', 'block', e, guo[hols.length], `${who} 排了 ${guo.length} 天國定假日假，這期${hols.length ? `只有 ${hols.length} 天國定假日` : '沒有國定假日'}`);
      else if (guo.length < hols.length) add('C8', 'warn', e, hols[0], `${who} 本期有 ${hols.length - guo.length} 天國定假日假還沒排；國定假日（${hols.map(d => `${md(d)} ${hol.days[d]}`).join('、')}）當天出勤要給雙倍薪資`);
    } else {
      for (const d of guo) if (!isHoliday(hol, d)) add('C7', 'block', e, d, `${who} ${md(d)} 不是國定假日；計時同仁的國定假日假只能排在國定假日當天`);
      for (const d of hols) {
        const c = mine[d];
        if (!c) continue;
        if (c.shift_id) add('C3', 'info', e, d, `${who} ${md(d)}（${hol.days[d]}）國定假日上班，要本人同意、工資加倍`);
        if (c.day_type === 'R' || c.day_type === 'H') add('C4', 'info', e, d, `${who} ${md(d)}（${hol.days[d]}）剛好是${c.day_type === 'R' ? '例假' : '休息日'}，要另外補一天假`);
      }
    }

    // 制度別：正職四週變形、計時每週制
    if (t0 && t0.kind === 'ft') {
      if (!blank.length) {                                               // 還沒排完的人先只提示「還沒排」，不重複列例休天數
        // 到職或離職落在期內：依在職天數比例（每 14 天在職至少 2 天例假、滿 7 天至少 1 天；例＋休 至少 在職天數×8/28 無條件進位）
        for (const [half, label] of [[dates.slice(0, 14), '前兩週'], [dates.slice(14), '後兩週']]) {
          const inH = half.filter(d => employed(st, d));
          const need = inH.length >= 14 ? 2 : inH.length >= 7 ? 1 : 0;
          const r = inH.filter(d => mine[d] && mine[d].day_type === 'R').length;
          if (r < need) add('F1', 'block', e, half[0], `${who} ${label}${inH.length < 14 ? `（在職 ${inH.length} 天）` : ''}只有 ${r} 天例假，至少要 ${need} 天`);
        }
        const needRH = Math.ceil(inPeriod.length * 8 / 28);
        const rh = inPeriod.filter(d => mine[d] && (mine[d].day_type === 'R' || mine[d].day_type === 'H')).length;
        if (rh < needRH) add('F2', 'block', e, start, `${who} 這期${fullPeriod ? '' : `（在職 ${inPeriod.length} 天）`}例假加休息日只有 ${rh} 天，至少要 ${needRH} 天`);
      }
      // 休息日加班每人每期最多 2 天：自動排班自己守，手動排超過只提醒（2026-10-11 Eason 審查決定 3）
      const otDays = inPeriod.filter(d => mine[d] && mine[d].day_type === 'H' && mine[d].shift_id);
      if (otDays.length > FT_OT_MAX) add('F8', 'warn', e, otDays[FT_OT_MAX], `${who} 這期排了 ${otDays.length} 天休息日加班，超過每期 ${FT_OT_MAX} 天（要付加班費）`);
      const normal = dates.reduce((a, d) => a + (mine[d] && mine[d].day_type === 'W' ? Math.min(mins[d].work, FT_DAY_NORMAL) : 0), 0);
      if (normal > PERIOD_NORMAL) add('F5', 'info', e, end, `${who} 這期正常工時 ${hm(normal)}，超過 160 小時的部分要付加班費`);
      // 特休、國定假日放假一天算 8 小時；補休不算（Eason 2026-10-11：補休是用掉之前的加班，不能再抵這期的目標工時）
      const credit = dates.reduce((a, d) => a + mins[d].normal + (mine[d] && mine[d].day_type === 'L' && (mine[d].leave === '特' || mine[d].leave === '國') ? LEAVE_MIN : 0), 0);
      const target = t0.target_min == null ? PERIOD_NORMAL : t0.target_min;
      if (fullPeriod && !blank.length && credit < target) add('F7', 'warn', e, end, `${who} 這期只排到 ${hm(credit)}，目標 ${hm(target)}，還差 ${hm(target - credit)}`);
    } else if (t0) {
      for (let w = 0; w < 4; w++) {
        const wk = dates.slice(w * 7, w * 7 + 7).filter(d => employed(st, d));
        if (wk.length < 7 || wk.some(d => !mine[d])) continue;
        const rs = wk.filter(d => mine[d] && mine[d].day_type === 'R').length;
        const hs = wk.filter(d => mine[d] && mine[d].day_type === 'H');
        if (rs < 1) add('P1', 'block', e, wk[0], `${who} ${md(wk[0])} 這週沒有例假`);
        if (!hs.length) add('P2', 'block', e, wk[0], `${who} ${md(wk[0])} 這週沒有休息日`);
        hs.filter(d => mine[d].shift_id).forEach(d => add('P2', 'warn', e, d, `${who} ${md(d)} 休息日出勤，要付加班費`));
        const wn = wk.reduce((a, d) => a + (mine[d] && mine[d].day_type === 'W' ? Math.min(mins[d].work, PT_DAY_NORMAL) : 0), 0);
        if (wn > WEEK_NORMAL) add('P5', 'warn', e, wk[0], `${who} ${md(wk[0])} 這週上班 ${hm(wn)}，超過 40 小時的部分算加班`);
      }
      for (const d of dates) if (mins[d].work > PT_DAY_NORMAL && mins[d].work <= DAY_MAX && mine[d].day_type !== 'H') add('P4', 'warn', e, d, `${who} ${md(d)} 上班 ${hm(mins[d].work)}，超過 8 小時的部分算加班`);
      const total = dates.reduce((a, d) => a + mins[d].work, 0);
      if (t0.target_min != null && total > t0.target_min) add('P6', 'warn', e, end, `${who} 這期排了 ${hm(total)}，超過上限 ${hm(t0.target_min)}`);
    }

    // 曆月加班 46 小時（含期外月份）
    const byMonth = {};
    for (const d of dates) { const m = d.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + mins[d].ot; }
    for (const m in byMonth) {
      const tot = byMonth[m] + ((ctx.monthOtMin && ctx.monthOtMin[m] || {})[e] || 0);
      if (tot > MONTH_OT) add('C2', 'info', e, null, `${who} ${+m.slice(5)} 月加班 ${hm(tot)}，超過 46 小時`);
    }

    // 可上班別、指定
    for (const d of dates) {
      const c = mine[d];
      const t = termAt(ctx.terms, e, d);
      if (c && c.shift_id && t && t.allowed_shifts && t.allowed_shifts.length && !t.allowed_shifts.includes(c.shift_id))
        add('D3', 'block', e, d, `${who} 不能上${(ctx.shifts[c.shift_id] || {}).name || c.shift_id}（${md(d)}）`);
      const p = (ctx.pins && ctx.pins[e] || {})[d];
      if (!p || !c) continue;
      if (p.kind === 'off' && c.shift_id) add('D4', 'block', e, d, `${who} ${md(d)} 指定休假，卻排了班`);
      if (p.kind === 'work' && !c.shift_id) add('D4', 'block', e, d, `${who} ${md(d)} 指定上班，卻沒有排班`);
      if (p.kind === 'shift' && c.shift_id !== p.shift_id) add('D4', 'block', e, d, `${who} ${md(d)} 指定上${(ctx.shifts[p.shift_id] || {}).name || p.shift_id}，卻排了別的`);
    }
  }

  if (noPrior.length) add('N0', 'info', null, null, `${noPrior.length === ctx.staff.length ? '全部同仁' : noPrior.join('、')}沒有前期出勤資料，連續上班天數與換班間隔從本期第 1 天開始算`);

  // 人力需求、不同班配對
  for (const d of dates) {
    const need = (ctx.demand || {})[d] || {};
    const count = {};
    const onShift = {};
    for (const st of ctx.staff) {
      if (!employed(st, d)) continue;                                  // 不在職的人就算格子有班也不算人力
      const c = (ctx.days[st.emp_id] || {})[d];
      if (c && c.shift_id) { count[c.shift_id] = (count[c.shift_id] || 0) + 1; (onShift[c.shift_id] = onShift[c.shift_id] || []).push(st.emp_id); }
    }
    for (const sid in need) {
      const n = count[sid] || 0, sh = (ctx.shifts[sid] || {}).name || sid;
      if (n < need[sid].min) add('D1', 'warn', null, d, `${md(d)} ${sh}缺 ${need[sid].min - n} 人`);
      if (need[sid].max != null && n > need[sid].max) add('D2', 'warn', null, d, `${md(d)} ${sh}多了 ${n - need[sid].max} 人`);
    }
    for (const [a, b] of (ctx.pairs || [])) {
      for (const sid in onShift) if (onShift[sid].includes(a) && onShift[sid].includes(b))
        add('D5', 'warn', a, d, `${name[a] || a} 和 ${name[b] || b} ${md(d)} 排在同一班`);
    }
  }
  return R;
}

export const blocks = (results) => results.filter(r => r.level === 'block');
