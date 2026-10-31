// 自動排班：勞基法與排班限制檢查（spec 第 3、5 節）。純函式，前端即時檢查、伺服器存檔／鎖定、自動排班收尾共用。
//
// ctx = {
//   period: 'T01',
//   shifts: { S1: {id,name,start,end,break_min}, … },
//   staff: [{ emp_id, name, hire_date, leave_date }],
//   terms: { emp_id: [{ from_date, kind:'ft'|'pt', target_min, week_min, same_days, allowed_shifts:[], allowed_shifts_hol:[], backup:0|1 }] },
//     allowed_shifts_hol＝假日（六日、國定假日、補假）只能上的班，空＝跟平日一樣；backup＝備援（只限計時：其他人排不了才排他）
//   days: { emp_id: { 'YYYY-MM-DD': { day_type:'W'|'R'|'H'|'L', shift_id, leave } } }   // 本期＋前期最後 13 天
//   actuals: { emp_id: { date: {start,end} } }       // 前期沒有 days 時用（T01 的 10 月實際出勤）
//   demand: { date: { shift_id: {min,max} } },
//   pins: { emp_id: { date: { kind:'off'|'work'|'shift', shift_id } } },
//   pairs: [[emp_a, emp_b]],
//   holidays: { validThrough, days: { date: name } },
//   monthOtMin: { 'YYYY-MM': { emp_id: 分鐘 } },     // 本期碰到的曆月、期外日子的加班分鐘（伺服器先算好）
//   stations: { id: { name, active, sort } }, stationNeed: { date: { station_id: 最少人數 } }   // 工作站別（沒有使用中的站就不檢查 T1／T2）；days 的格子多 station_id
// }
// 回傳 [{ code, level:'block'|'warn'|'info', emp_id, date, msg }]
import { periodDates, addDays, diffDays, weekday } from './period.js';
import { shiftMinutes, gapMinutes } from './hours.js';

export const H = 60;
const FT_DAY_NORMAL = 10 * H, PT_DAY_NORMAL = 8 * H, DAY_MAX = 12 * H;
const PERIOD_NORMAL = 160 * H, WEEK_NORMAL = 40 * H;
export const MONTH_OT = 46 * H, MONTH_OT_WARN = 36 * H;   // 每月加班：超過 46 擋、超過 36 警告（Eason 2026-10-27，取代 10-11 的「46 只提醒」）
const PT_OT_RUN = 6;                         // 計時連上第 6 天＝休息日加班，提醒（Eason 2026-10-27；第 7 天由 P3 擋）
export const MIN_GAP = 11 * H;                // 換班間隔（§34）：Eason 2026-10-11 改 12 小時、2026-10-31 改回 11 小時，自動排班與檢查共用這一個值
const LEAVE_MIN = 8 * H;                     // 請假、國定假日放假一天算 8 小時（F7）
/** 假別（sch_days.leave 存第一欄代號）：指定休假、班表格子共用；國定假日假「國」另外處理（2026-10-31 Eason：指定休假要能先選假別） */
export const LEAVES = [['特', '特休'], ['事', '事假'], ['病', '病假'], ['婚', '婚假'], ['喪', '喪假'], ['公', '公假'], ['產', '產假'], ['陪', '陪產假'], ['生', '生理假'], ['家', '家庭照顧假'], ['補', '補休']];
const LEAVE_CODES = LEAVES.map(x => x[0]).concat('國');
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
/** 國定假日或補假（holidays.json 的 days＋gov.off）的名稱；不是回 ''。總部自填／央廚固定排班用（門市排班的補假另有一套 C7 規則） */
export const holName = (hol, d) => (hol && ((hol.days && hol.days[d]) || (hol.gov && hol.gov.off && hol.gov.off[d]))) || '';
/** 排班用的「假日」：六日（行政院補班的週六除外）、國定假日、補假，跟班表淡紅底同一套（board.js isWe）（2026-10-28 Eason：國定假日算假日） */
export const isRedDay = (hol, d) => {
  const w = weekday(d), gov = (hol && hol.gov) || {};
  return ((w === 0 || w === 6) && !(gov.work || []).includes(d)) || !!(hol && hol.days && hol.days[d]) || !!(gov.off && gov.off[d]);
};
/** 這個身分條款在 d 那天只能上的班；空陣列＝每班都能上。假日有另外設就用假日那組（2026-10-28 Eason） */
export const allowedList = (t, hol, d) => {
  if (!t) return [];
  if (t.allowed_shifts_hol && t.allowed_shifts_hol.length && isRedDay(hol, d)) return t.allowed_shifts_hol;
  return t.allowed_shifts || [];
};
/** 這天他是不是備援（只限計時；依當天的身分條款，期中開啟／解除都照日期算） */
export const backupAt = (terms, emp, d) => { const t = termAt(terms, emp, d); return !!(t && t.kind === 'pt' && t.backup); };
/** 計時這期的時數上限（分鐘）：期中改目標工時時照天數比例分段（2026-10-28 Eason）——每天算「當天條款的目標 ÷ 28」加總。
 *  期首前還沒生效的日子沿用 first 那天的條款（同一個條款時就等於原本的目標，期中到職的人不會被打折）；有一段沒設上限就回 null（不限）。 */
export function ptCapMin(terms, emp, dates, first) {
  const t0 = termAt(terms, emp, first || dates[0]);
  let sum = 0, any = false;
  for (const d of dates) {
    const t = termAt(terms, emp, d) || t0;
    if (!t || t.kind !== 'pt') continue;
    if (t.target_min == null) return null;
    sum += t.target_min / dates.length; any = true;
  }
  return any ? Math.round(sum) : null;
}
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
      if (!LEAVE_CODES.includes(c.leave)) return '請假要選假別（特休、事假、病假…）';
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
      // 計時連上第 6 天：這天算休息日加班。已經排成「休息日出勤」的由 P2 提醒，這裡只提醒還排成一般工作日的
      if (t.kind === 'pt' && run === PT_OT_RUN && mine[d] && mine[d].day_type === 'W') add('P7', 'warn', e, d, `${who} ${md(d)} 是連續上班第 ${PT_OT_RUN} 天，這天算休息日加班（要付加班費）：請改成「班別（休息日出勤）」`);
    }

    // 換班間隔 11 小時（§34；跨期也比）
    let lastShift = null;                                              // 上一個實際的班（跨夜班可能隔一天才接下一班，GPT 上線前審查 8）
    for (let i = 3; i >= 1; i--) { const w = workedOn(ctx, e, addDays(start, -i)); if (w && w.shift) lastShift = w; }
    for (const d of dates) {
      const cur = workedOn(ctx, e, d);
      if (!cur || !cur.shift) continue;
      if (lastShift && lastShift.shift) {
        const g = gapMinutes(lastShift.date, lastShift.shift, d, cur.shift);
        if (g < MIN_GAP) add('C1', 'block', e, d, `${who} ${md(lastShift.date)} 下班到 ${md(d)} 上班只隔 ${hm(Math.max(0, g))}，至少要 ${MIN_GAP / H} 小時`);
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
      // 請假（特休、事假、病假…）與國定假日放假一天算 8 小時；補休不算（Eason 2026-10-11：補休是用掉之前的加班，不能再抵這期的目標工時）
      const credit = dates.reduce((a, d) => a + mins[d].normal + (mine[d] && mine[d].day_type === 'L' && mine[d].leave !== '補' ? LEAVE_MIN : 0), 0);
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
      const cap = ptCapMin(ctx.terms, e, dates, inPeriod[0]);              // 期中改目標工時照天數比例分段（2026-10-28）
      if (cap != null && total > cap) add('P6', 'warn', e, end, `${who} 這期排了 ${hm(total)}，超過上限 ${hm(cap)}`);
    }

    // 曆月加班（含期外月份）：超過 46 小時擋、超過 36 小時警告（Eason 2026-10-27）
    const byMonth = {};
    for (const d of dates) { const m = d.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + mins[d].ot; }
    for (const m in byMonth) {
      const tot = byMonth[m] + ((ctx.monthOtMin && ctx.monthOtMin[m] || {})[e] || 0);
      if (tot > MONTH_OT) add('C2', 'block', e, null, `${who} ${+m.slice(5)} 月加班 ${hm(tot)}，超過上限 46 小時，要減少加班才能鎖定`);
      else if (tot > MONTH_OT_WARN) add('C9', 'warn', e, null, `${who} ${+m.slice(5)} 月加班 ${hm(tot)}，超過 36 小時（上限 46 小時）`);
    }

    // 可上班別、指定
    for (const d of dates) {
      const c = mine[d];
      const t = termAt(ctx.terms, e, d);
      const al = allowedList(t, ctx.holidays, d);
      if (c && c.shift_id && al.length && !al.includes(c.shift_id))
        add('D3', 'block', e, d, `${who} ${isRedDay(ctx.holidays, d) && t.allowed_shifts_hol && t.allowed_shifts_hol.length ? '假日' : ''}不能上${(ctx.shifts[c.shift_id] || {}).name || c.shift_id}（${md(d)}）`);
      const p = (ctx.pins && ctx.pins[e] || {})[d];
      if (!p || !c) continue;
      if (p.kind === 'off' && c.shift_id) add('D4', 'block', e, d, `${who} ${md(d)} 指定休假，卻排了班`);
      if (p.kind === 'work' && !c.shift_id) add('D4', 'block', e, d, `${who} ${md(d)} 指定上班，卻沒有排班`);
      if (p.kind === 'shift' && c.shift_id !== p.shift_id) add('D4', 'block', e, d, `${who} ${md(d)} 指定上${(ctx.shifts[p.shift_id] || {}).name || p.shift_id}，卻排了別的`);
    }

    // 備援這期被自動叫來補的日子（手動排、指定上班／班別的不算）：放進提醒清單，重新整理也看得到（2026-10-28）
    const bkDays = dates.filter(d => mine[d] && mine[d].shift_id && backupAt(ctx.terms, e, d) && mine[d].source !== 'manual' && mine[d].source !== 'pin' && ((ctx.pins && ctx.pins[e] || {})[d] || {}).kind !== 'work');   // 手動排、指定的不算補位
    if (bkDays.length) add('B1', 'info', e, null, `備援 ${who} 這期排了 ${bkDays.length} 天（${bkDays.map(md).join('、')}），是其他同仁排不開時補的`);
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

  // 工作站別（station-spec §4、§11）：店裡沒有任何使用中的站就都不跑。兩條都只提醒（warn），不擋鎖定。
  const stations = ctx.stations || {};
  if (Object.values(stations).some(x => x.active)) {
    // T1 沒選站：每人一條，最多列 5 個日期；只算在職日的上班格
    for (const st of ctx.staff) {
      const mine = ctx.days[st.emp_id] || {};
      const miss = dates.filter(d => employed(st, d) && mine[d] && mine[d].shift_id && !mine[d].station_id);
      if (miss.length) add('T1', 'warn', st.emp_id, null, `${st.name} 還有 ${miss.length} 個上班日沒選站（${miss.slice(0, 5).map(md).join('、')}${miss.length > 5 ? ' 等' : ''}）`);
    }
    // T2 站別缺人：每天一條彙總；只看使用中的站（停用站的需求列保留但不提醒）；沒選站的人不算進任何站
    for (const d of dates) {
      const need = (ctx.stationNeed || {})[d] || {};
      const count = {};
      for (const st of ctx.staff) {
        const c = employed(st, d) ? (ctx.days[st.emp_id] || {})[d] : null;
        if (c && c.shift_id && c.station_id) count[c.station_id] = (count[c.station_id] || 0) + 1;
      }
      const lack = Object.keys(need).filter(id => stations[id] && stations[id].active && (count[id] || 0) < need[id])
        .sort((a, b) => (stations[a].sort || 0) - (stations[b].sort || 0) || (a < b ? -1 : 1))
        .map(id => `${stations[id].name} ${need[id] - (count[id] || 0)}`);
      if (lack.length) add('T2', 'warn', null, d, `${md(d)} 缺人：${lack.join('、')}`);
    }
  }
  return R;
}

export const blocks = (results) => results.filter(r => r.level === 'block');

// ---------------------------------------------------------------------------
// 總部自填排班／央廚固定排班：整月檢查（docs/schedule-hq/spec.md §3.3、§4）。純函式，伺服器（存檔、送出、載入）、央廚固定排班與前端共用。
//
// ctx = {
//   month: 'YYYY-MM',
//   staff: [{ emp_id, name, hire_date?, leave_date? }],
//   shifts: { id: {id,name,start,end,break_min} },
//   days: { emp_id: { 'YYYY-MM-DD': { day_type, shift_id, leave } } }   // 該月全部格子＋前後相鄰日子（跨月的週、換班間隔用；伺服器只放「已送出／已核准」的相鄰月份）
//   holidays: { days: { date: name }, gov?: { off: { date: name } } },      // gov.off＝補假等額外放假日（算國定假日假）
//   from?: 'YYYY-MM-DD'     // 這套排班從哪天起（mode_from）；之前的日子不用選、不檢查整月都要選
//   soft?: true      // 央廚固定排班：只提醒不擋，block 一律降成 warn
// }
// 規則（Q1 推薦版）：以週日到週六為一週，每週至少 1 天例假（R）＋1 天休息日（H，沒排班的）；換班間隔 < 11 小時、單日 > 12 小時＝block；
// 每週超過 40 小時＝warn；國定假日上班＝warn（工資加倍）；整月還有沒選的天＝block。
// 跨月的週：相鄰日子沒有資料時不能判斷，只有「剩下沒資料的天數也補不齊」才擋（不然永遠送不出去）。
// 回傳 [{ code, level:'block'|'warn', emp_id, date, msg }]
export function checkSelfMonth(ctx) {
  const R = [];
  const lvl = (l) => (ctx.soft && l === 'block' ? 'warn' : l);
  const add = (code, level, emp_id, date, msg) => R.push({ code, level: lvl(level), emp_id: emp_id || null, date: date || null, msg });
  // ctx.dates：央廚以期（28 天）為單位時直接給日期清單（2026-10-27）；沒給就是 ctx.month 整月
  const dates = ctx.dates ? ctx.dates.slice() : [];
  if (!ctx.dates) for (let d = ctx.month + '-01'; d.slice(0, 7) === ctx.month; d = addDays(d, 1)) dates.push(d);
  const first = dates[0], last = dates[dates.length - 1];
  const hol = ctx.holidays || { days: {} };
  const shifts = ctx.shifts || {};
  for (const st of ctx.staff) {
    const e = st.emp_id, who = st.name || e;
    const mine = (ctx.days || {})[e] || {};
    const inMonth = dates.filter((d) => employed(st, d));
    if (!inMonth.length) continue;

    // 沒選的天、合法組合、班別存在（只算在職、而且在這套排班起用日（ctx.from）以後的日子）
    const blank = inMonth.filter((d) => !mine[d] && (!ctx.from || d >= ctx.from));
    if (blank.length) add('V1', 'block', e, blank[0], `${who} 有 ${blank.length} 天還沒選（從 ${md(blank[0])} 起）`);
    for (const d of inMonth) {
      const c = mine[d];
      if (!c) continue;
      const err = comboError(c, hol, d);
      if (err) { add('V0', 'block', e, d, `${who} ${md(d)}：${err}`); continue; }
      if (c.day_type === 'W' && !c.shift_id) add('V1', 'block', e, d, `${who} ${md(d)} 是工作日但沒有選班別`);
      if (c.shift_id && !shifts[c.shift_id]) add('V0', 'block', e, d, `${who} ${md(d)} 的班別已不存在`);
    }

    // 單日超過 12 小時
    for (const d of inMonth) {
      const c = mine[d], sh = c && c.shift_id ? shifts[c.shift_id] : null;
      if (sh && shiftMinutes(sh) > DAY_MAX) add('F4', 'block', e, d, `${who} ${md(d)} 一天 ${hm(shiftMinutes(sh))}，超過 12 小時`);
    }

    // 換班間隔 11 小時（含跨月：月初前、月底後各 3 天的相鄰格）
    let prev = null;
    for (let d = addDays(first, -3); d <= addDays(last, 3); d = addDays(d, 1)) {
      const c = mine[d], sh = c && c.shift_id ? shifts[c.shift_id] : null;
      if (!sh) continue;
      if (prev) {
        const g = gapMinutes(prev.date, prev.shift, d, sh);
        if (g < MIN_GAP && (d <= last && d >= first || prev.date >= first && prev.date <= last)) add('C1', 'block', e, d, `${who} ${md(prev.date)} 下班到 ${md(d)} 上班只隔 ${hm(Math.max(0, g))}，至少要 ${MIN_GAP / H} 小時`);
      }
      prev = { date: d, shift: sh };
    }

    // 每週（日～六）至少 1 天例假、1 天休息日；每週超過 40 小時提醒
    const w0 = addDays(first, -weekday(first));
    for (let ws = w0; ws <= last; ws = addDays(ws, 7)) {
      const wk = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
      const known = wk.filter((d) => mine[d]);
      const missing = 7 - known.length;
      const rs = known.filter((d) => mine[d].day_type === 'R').length;
      const hs = known.filter((d) => mine[d].day_type === 'H' && !mine[d].shift_id).length;
      const lack = (rs < 1 ? 1 : 0) + (hs < 1 ? 1 : 0);
      const at = wk.find((d) => d >= first && d <= last);
      if (rs < 1 && missing < lack) add('W1', 'block', e, at, `${who} ${md(wk[0])} 這週沒有例假，每週至少要 1 天例假`);
      if (hs < 1 && missing < lack) add('W2', 'block', e, at, `${who} ${md(wk[0])} 這週沒有休息日，每週至少要 1 天休息日`);
      const mins = known.reduce((a, d) => a + (mine[d].shift_id && shifts[mine[d].shift_id] ? shiftMinutes(shifts[mine[d].shift_id]) : 0), 0);
      if (mins > WEEK_NORMAL) add('W3', 'warn', e, at, `${who} ${md(wk[0])} 這週排了 ${hm(mins)}，超過 40 小時的部分算加班`);
    }

    // 國定假日（含補假）上班：提醒工資加倍（同門市 C8）；「國定假日假」只能排在國定假日或補假當天（同門市 C7，總部是每週制、沒有同期別可移）
    for (const d of inMonth) {
      const c = mine[d];
      const hn = holName(hol, d);
      if (c && c.shift_id && hn) add('C8', 'warn', e, d, `${who} ${md(d)}（${hn}）國定假日上班，工資要加倍`);
      if (c && c.day_type === 'L' && c.leave === '國' && !hn) add('C7', 'block', e, d, `${who} ${md(d)} 不是國定假日或補假，不能排國定假日假`);
    }
  }
  return R;
}
