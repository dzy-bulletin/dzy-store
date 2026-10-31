// 自動排班（spec 第 6 節）。純函式、不用亂數：同樣輸入一定排出同樣結果。
// autoSchedule(ctx, opts) → { ok, days, problems, results }
//   ctx：同 rules.js 的 ctx（days 內可含前期最後 13 天、要保留的手動格與請假格）
//   opts.keepManual（預設 true）：保留本期 source='manual' 的格子
// 步驟：0 輸入檢查 → 1 保留指定／手動 → 2 排日別（每週選休假日，以「休了以後各班還剩多少人」評分）
//       → 3 逐日配對（先滿足最少人數，用增廣路徑做二分圖配對）→ 4 修復（同週對調休假日）→ 4.2 備援同仁補缺人 → 5 整期檢查，沒有「擋」才回傳
import { periodDates, addDays } from './period.js';
import { shiftMinutes, gapMinutes } from './hours.js';
import { checkPeriod, termAt, employed, isHoliday, allowedList, backupAt, ptCapMin, MIN_GAP, FT_OT_MAX } from './rules.js';

const DAY_MAX = 12 * 60, REPAIR_MAX = 200;
const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

function allowedOf(ctx, emp, d) {
  const al = allowedList(termAt(ctx.terms, emp, d), ctx.holidays, d);       // 假日有另外設就用假日那組（2026-10-28 Eason）
  const all = Object.keys(ctx.shifts).filter(s => ctx.shifts[s].active !== 0);
  return al.length ? all.filter(s => al.includes(s)) : all;
}
/** 備援同仁（2026-10-28 Eason：只限計時，其他同仁都排不開才排他）。逐日看身分條款：這天是備援的日子先休、缺人才叫 */
const bkDay = (ctx, e, d) => backupAt(ctx.terms, e, d);
/** 整期在職的日子全是備援：不進一般排休（不然會擠動別人的輪替順序） */
const allBackup = (ctx, st, dates) => { const inP = dates.filter(d => employed(st, d)); return inP.length > 0 && inP.every(d => bkDay(ctx, st.emp_id, d)); };
/** 排班順位（1 最優先；沒設＝最後）與優先班別（2026-10-28 Eason） */
const staffRow = (ctx, e) => ctx.staff.find(s => s.emp_id === e) || {};
const prioOf = (ctx, e) => { const p = staffRow(ctx, e).prio; return p == null ? Infinity : p; };
const prefOf = (ctx, e) => staffRow(ctx, e).pref_shift || null;
const pinOf = (ctx, e, d) => ((ctx.pins || {})[e] || {})[d] || null;
const needOf = (ctx, d) => (ctx.demand || {})[d] || {};

/** 0. 輸入檢查：回傳問題清單（有問題就不排） */
export function inputProblems(ctx) {
  const P = [];
  const dates = periodDates(ctx.period);
  for (const st of ctx.staff) {
    const e = st.emp_id;
    if (dates.some(d => employed(st, d) && !termAt(ctx.terms, e, d))) P.push(`${st.name} 還沒設定正職或計時`);
    for (const d of dates) {
      const p = pinOf(ctx, e, d);
      if (!p) continue;
      if (!employed(st, d)) P.push(`${st.name} ${md(d)} 不在職，不能指定`);
      else if (p.kind === 'shift' && !ctx.shifts[p.shift_id]) P.push(`${st.name} ${md(d)} 指定的班別不存在`);
      else if (p.kind === 'shift' && !allowedOf(ctx, e, d).includes(p.shift_id)) P.push(`${st.name} ${md(d)} 指定的班別不在他能上的班裡`);
    }
    // 指定上班太多：正職每週至少要休 2 天、計時每週至少 1 例 1 休
    for (let w = 0; w < 4; w++) {
      const wk = dates.slice(w * 7, w * 7 + 7);
      const mustWork = wk.filter(d => { const p = pinOf(ctx, e, d); return p && p.kind !== 'off'; }).length;
      if (mustWork > 5) P.push(`${st.name} ${md(wk[0])} 這週指定上班 ${mustWork} 天，一週最多 5 天`);
    }
  }
  return P;
}

/** 每週要休幾天：正職 2 天（4 週共 4 例 4 休）；計時依目標工時推算，至少 2 天 */
function offsPerWeek(ctx, e, d) {
  const t = termAt(ctx.terms, e, d);
  if (!t || t.kind !== 'pt') return 2;
  // 平均班長用這 7 天各自能上的班算（假日可能另設一組；只看第一天＝週日會整週都用假日那組，2026-10-28 Fable 審查）
  const per = [0, 1, 2, 3, 4, 5, 6].map(i => { const al = allowedOf(ctx, e, addDays(d, i)); return al.length ? al.reduce((a, s) => a + shiftMinutes(ctx.shifts[s]), 0) / al.length : 480; });
  const avg = per.reduce((a, b) => a + b, 0) / per.length;
  const wd = t.target_min == null ? 5 : Math.max(0, Math.min(5, Math.floor(t.target_min / 4 / avg)));   // 無條件捨去：寧可少排，不超過時數上限（GPT 上線前審查 13）
  return 7 - wd;
}
function combos(arr, k) {
  const out = [];
  const rec = (i, cur) => { if (cur.length === k) { out.push(cur.slice()); return; } for (let j = i; j < arr.length; j++) { cur.push(arr[j]); rec(j + 1, cur); cur.pop(); } };
  if (k <= 0) return [[]];
  if (k > arr.length) return [arr.slice()];
  rec(0, []);
  return out;
}
function priorRun(ctx, e, start) {
  let run = 0;
  for (let i = 13; i >= 1; i--) {
    const d = addDays(start, -i);
    const c = (ctx.days[e] || {})[d];
    const a = ((ctx.actuals || {})[e] || {})[d];
    run = (a ? true : c ? !!c.shift_id : false) ? run + 1 : 0;
  }
  return run;
}

/** 期中到職／離職的正職：各週休假數，加總＝檢查規則 F2 的 ceil(在職天數×8/28)（2026-10-11 審查：原本每週各自四捨五入，28 個報到日有 12 個排不出來）。
 *  整週給 2 天，不滿一週的按比例取整數，差額依餘數大小補到不滿一週的那幾週（不超過該週在職天數）。整期在職或計時回 null（照原本每週算）。 */
function ftPartialQuota(ctx, st, dates) {
  const inP = dates.filter(d => employed(st, d));
  if (!inP.length || inP.length === 28 || (termAt(ctx.terms, st.emp_id, inP[0]) || {}).kind !== 'ft') return null;
  const lens = [0, 1, 2, 3].map(w => dates.slice(w * 7, w * 7 + 7).filter(d => employed(st, d)).length);
  const raw = lens.map(n => (n === 7 ? 2 : 2 * n / 7));
  const q = raw.map(Math.floor);
  let left = Math.ceil(inP.length * 8 / 28) - q.reduce((a, b) => a + b, 0);
  const order = [0, 1, 2, 3].filter(w => lens[w] > 0 && lens[w] < 7).sort((a, b) => (raw[b] - q[b]) - (raw[a] - q[a]) || a - b);
  while (left > 0) {
    const w = order.find(i => q[i] < lens[i]) ?? [0, 1, 2, 3].find(i => q[i] < lens[i]);
    if (w === undefined) break;
    q[w]++; left--;
    const at = order.indexOf(w); if (at >= 0) order.push(order.splice(at, 1)[0]);
  }
  return q;
}

/** 2. 排日別：回傳 { emp: { date: 'off'|'work'|'fixed' } }，以及 R／H 標記 */
function planOffDays(ctx, dates, fixed, guoSkip) {
  const plan = {};
  const avail = {};          // avail[d][s]：這天能上 s 班、還沒休的人數
  dates.forEach(d => { avail[d] = {}; Object.keys(ctx.shifts).forEach(s => { avail[d][s] = 0; }); });
  const staff = ctx.staff.slice();
  for (const st of staff) for (const d of dates) if (employed(st, d) && !fixed[st.emp_id][d] && !bkDay(ctx, st.emp_id, d)) allowedOf(ctx, st.emp_id, d).forEach(s => { avail[d][s]++; });
  // 備援的日子：先休（指定上班的照上），等第 4.2 步真的缺人才一天一天叫進來；不算進 avail。整期都是備援的人也不進下面的排序（不然會擠動別人的輪替順序）
  const bkPlan = (st) => { for (const d of dates) if (employed(st, d) && !fixed[st.emp_id][d] && bkDay(ctx, st.emp_id, d)) plan[st.emp_id][d] = (pinOf(ctx, st.emp_id, d) || {}).kind === 'work' ? 'work' : 'off'; };
  for (const st of staff.filter(x => allBackup(ctx, x, dates))) { plan[st.emp_id] = {}; bkPlan(st); }
  // 能上的班越多的人先選（彈性大的先讓位），能上的班少的人最後挑剩下最寬鬆的日子（整期平均：假日可能另設一組）
  staff.splice(0, staff.length, ...staff.filter(x => !allBackup(ctx, x, dates)));
  const nAllowed = (e) => dates.reduce((a, d) => a + allowedOf(ctx, e, d).length, 0);
  staff.sort((a, b) => nAllowed(b.emp_id) - nAllowed(a.emp_id) || (a.emp_id < b.emp_id ? -1 : 1));
  staff.forEach((st, si) => {
    const e = st.emp_id;
    plan[e] = {};
    bkPlan(st);
    const limit = (termAt(ctx.terms, e, dates[0]) || {}).kind === 'pt' ? 6 : 12;
    let run = priorRun(ctx, e, dates[0]);
    const quota = ftPartialQuota(ctx, st, dates);
    for (let w = 0; w < 4; w++) {
      const wk = dates.slice(w * 7, w * 7 + 7).filter(d => employed(st, d) && !bkDay(ctx, e, d));   // 期中才開始／結束備援：備援的日子另外處理（bkPlan）
      const free = wk.filter(d => !fixed[e][d]);
      const pinnedOff = free.filter(d => (pinOf(ctx, e, d) || {}).kind === 'off');
      // 正職國定假日預設上班（Eason 2026-10-12），另在第 6 步排一天國定假日假；指定休假的照休
      const ftNow = (termAt(ctx.terms, e, wk[0] || dates[0]) || {}).kind === 'ft';
      const mustWork = new Set(free.filter(d => { const p = pinOf(ctx, e, d); return (p && p.kind !== 'off') || (!p && ftNow && isHoliday(ctx.holidays, d)); }));
      const need = quota ? quota[w] : wk.length === 7 ? offsPerWeek(ctx, e, wk[0]) : Math.round(offsPerWeek(ctx, e, wk[0]) * wk.length / 7);
      // 這週已經手動排好的例假／休息日（沒排班）要扣掉，只補不足的天數（2026-10-11 Codex 審查：原本會再多排兩天休）
      const fixedOff = wk.filter(d => fixed[e][d] && (fixed[e][d].day_type === 'R' || fixed[e][d].day_type === 'H') && !fixed[e][d].shift_id).length;
      const k = Math.max(need - fixedOff, pinnedOff.length);
      const cand = free.filter(d => !mustWork.has(d) && !pinnedOff.includes(d));
      // 下一週開頭「一定要上班」的天數（固定的班、指定上班、正職國定假日）：這週結尾連上的天數要留空間給它們，
      //   不然下一週再怎麼挑都會超過連上上限（2026-10-31 光復徐佑昕：11/20、11/21 指定休湊滿第 3 週休假，11/11–11/17 被排成連上 7 天）
      let lead = 0;
      if (w < 3) {
        for (const d of dates.slice(w * 7 + 7, w * 7 + 14)) {
          const c = fixed[e][d], p = pinOf(ctx, e, d);
          const ftD = (termAt(ctx.terms, e, d) || {}).kind === 'ft';
          const forced = c ? !!c.shift_id : (employed(st, d) && ((p && p.kind !== 'off') || (!p && ftD && isHoliday(ctx.holidays, d))));
          if (!forced) break;
          lead++;
        }
      }
      const search = (nPick, ahead) => {
        let best = null, bestScore = Infinity, bestRun = run;
        for (const pick of combos(cand, Math.min(cand.length, nPick))) {
          const offs = new Set(pinnedOff.concat(pick));
          let r = run, okRun = true;
          for (const d of dates.slice(w * 7, w * 7 + 7)) {
            const c = fixed[e][d];
            const works = c ? !!c.shift_id : (employed(st, d) && !offs.has(d) && !bkDay(ctx, e, d));
            r = works ? r + 1 : 0;
            if (r > limit) { okRun = false; break; }
          }
          if (!okRun || r + ahead > limit) continue;
          let score = 0;
          for (const d of pick) {
            const need2 = needOf(ctx, d);
            for (const s of allowedOf(ctx, e, d)) {
              const slack = avail[d][s] - ((need2[s] || {}).min || 0);
              score += slack <= 0 ? 1000 : 10 / slack;
            }
            score += ((dates.indexOf(d) + si * 3) % 7) * 0.001;          // 輪替破同分
          }
          if (score < bestScore) { bestScore = score; best = offs; bestRun = r; }
        }
        return { best, bestRun };
      };
      // 照該休的天數挑；挑不出不超過連上上限的組合（休假天數已被指定休假湊滿、或下一週開頭一定要上班），就多休一天再挑，
      //   一次加一天、加到挑得出來為止（寧可多休，也不排出「擋」讓整期存不了）。真的加到底都不行才照舊硬排
      const base = Math.max(0, k - pinnedOff.length);
      let { best, bestRun } = search(base, lead);
      for (let extra = 1; !best && base + extra <= cand.length; extra++) ({ best, bestRun } = search(base + extra, lead));
      if (!best) ({ best, bestRun } = search(base, 0));
      if (!best) best = new Set(pinnedOff.concat(cand.slice(0, Math.max(0, k - pinnedOff.length))));
      for (const d of dates.slice(w * 7, w * 7 + 7)) {
        if (!employed(st, d) || fixed[e][d] || bkDay(ctx, e, d)) continue;
        if (best.has(d)) { plan[e][d] = 'off'; allowedOf(ctx, e, d).forEach(s => { avail[d][s]--; }); }
        else plan[e][d] = 'work';
      }
      run = bestRun;
      if (!best.size) { let r = run; for (const d of dates.slice(w * 7, w * 7 + 7)) { const c = fixed[e][d]; r = (c ? !!c.shift_id : plan[e][d] === 'work') ? r + 1 : 0; } run = r; }
    }
    // 正職國定假日假（Eason 2026-10-12）：本期每一天國定假日各補一天，排在離那天最近的一週（同週優先）、同一週不排兩天，
    //   再挑人手最寬裕的上班日（不挑國定假日、指定過的日子）。手動排好的國定假日假先抵掉最早的國定假日。
    const inP = dates.filter(d => employed(st, d));
    if (inP.length && (termAt(ctx.terms, e, inP[0]) || {}).kind === 'ft' && !(guoSkip && guoSkip.has(e))) {
      const hols = inP.filter(d => isHoliday(ctx.holidays, d));
      const have = inP.filter(d => fixed[e][d] && fixed[e][d].day_type === 'L' && fixed[e][d].leave === '國');
      const wkOf = (d) => Math.floor(dates.indexOf(d) / 7);
      const slack = (d) => allowedOf(ctx, e, d).reduce((m, s) => Math.max(m, avail[d][s] - ((needOf(ctx, d)[s] || {}).min || 0)), -Infinity);
      const taken = new Set(have.map(wkOf));
      for (const h of hols.slice(have.length)) {
        const cand = inP.filter(d => plan[e][d] === 'work' && !pinOf(ctx, e, d) && !isHoliday(ctx.holidays, d) && slack(d) > 0 && !taken.has(wkOf(d)));   // 同一週不排兩天
        if (!cand.length) break;
        const key = (d) => [-slack(d), Math.abs(wkOf(d) - wkOf(h)), Math.abs(dates.indexOf(d) - dates.indexOf(h))];
        cand.sort((x, y) => { const a = key(x), b = key(y); for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return x < y ? -1 : 1; });
        const d = cand[0];
        plan[e][d] = 'guo'; allowedOf(ctx, e, d).forEach(s => { avail[d][s]--; }); taken.add(wkOf(d));
      }
    }
  });
  return plan;
}

/** 正職：每週第一個休假日標例假、其餘休息日；計時同。已固定的 R／H 也算進去 */
function labelOffs(dates, plan, fixed, e) {
  const out = {};
  for (let w = 0; w < 4; w++) {
    const wk = dates.slice(w * 7, w * 7 + 7);
    let hasR = wk.some(d => fixed[e][d] && fixed[e][d].day_type === 'R');
    for (const d of wk) if (plan[e][d] === 'off') { out[d] = hasR ? 'H' : 'R'; hasR = true; }
  }
  return out;
}

/** 3. 單日配對。workers：[emp]；回傳 { assign: {emp: shift}, unassigned: [emp] } */
export function assignDay(ctx, d, workers, prevShift, nextShift, fairness, fixedCount, extra) {
  const need = needOf(ctx, d);
  fixedCount = fixedCount || {};                                     // 已固定的班（指定某班、手動）先算進人數（GPT 上線前審查 15）
  const capLeft = (extra && extra.capLeft) || {};                    // 計時同仁這期還剩幾分鐘可排（2026-10-11 Codex 審查：原本只用平均班長估天數，會超過上限）
  const fixedShift = (extra && extra.fixedShift) || {};              // 這天已固定班的人 → 班別（不排同班的配對要一起看）
  const shiftIds = Object.keys(ctx.shifts).filter(s => ctx.shifts[s].active !== 0);
  workers = workers.slice().sort((a, b) => prioOf(ctx, a) - prioOf(ctx, b));     // 順位前面的先挑（沒人設順位時順序不變：sort 是穩定的）
  const ok = (e, s) => {
    if (!allowedOf(ctx, e, d).includes(s)) return false;
    const sh = ctx.shifts[s];
    if (capLeft[e] !== undefined && shiftMinutes(sh) > capLeft[e]) return false;
    if (shiftMinutes(sh) > DAY_MAX) return false;
    const p = pinOf(ctx, e, d);
    if (p && p.kind === 'shift' && p.shift_id !== s) return false;
    if (prevShift[e] && gapMinutes(addDays(d, -1), prevShift[e], d, sh) < MIN_GAP) return false;
    if (nextShift[e] && gapMinutes(d, sh, addDays(d, 1), nextShift[e]) < MIN_GAP) return false;
    return true;
  };
  // 優先班別蓋過輪替公平：有設的人先拿，同一班兩人都想要時順位前面的先拿
  const prefBonus = (e, s) => (prefOf(ctx, e) === s ? -100000 + Math.min(prioOf(ctx, e), 999) * 10 : 0);
  const cost = (e, s, i) => prefBonus(e, s) + (fairness[e] && fairness[e][s] || 0) * 10 + ((i + shiftIds.indexOf(s)) % shiftIds.length) * 0.01;
  // 先滿足最少人數：每個 slot 是「某班的第 n 個最少名額」，用增廣路徑找最大配對
  const slots = [];
  for (const s of shiftIds) for (let n = 0; n < Math.max(0, ((need[s] || {}).min || 0) - (fixedCount[s] || 0)); n++) slots.push(s);
  const cand = slots.map(s => workers.map((e, i) => [e, i]).filter(([e]) => ok(e, s)).sort((a, b) => cost(a[0], s, a[1]) - cost(b[0], s, b[1])).map(x => x[0]));
  const order = slots.map((_, i) => i).sort((a, b) => cand[a].length - cand[b].length || a - b);
  const owner = {};          // emp → slot index
  const tryAug = (si, seen) => {
    for (const e of cand[si]) {
      if (seen.has(e)) continue;
      seen.add(e);
      if (owner[e] === undefined || tryAug(owner[e], seen)) { owner[e] = si; return true; }
    }
    return false;
  };
  order.forEach(si => tryAug(si, new Set()));
  const assign = {};
  const count = Object.assign({}, fixedCount);
  for (const e in owner) { const s = slots[owner[e]]; assign[e] = s; count[s] = (count[s] || 0) + 1; }
  // 其餘的人：排到還有名額（未達最多人數）的班；都滿了就排到最不超過的班
  const rest = workers.filter(e => !assign[e]);
  const unassigned = [];
  rest.forEach((e, i) => {
    const opts = shiftIds.filter(s => ok(e, s));
    if (!opts.length) { unassigned.push(e); return; }
    const room = (s) => { const mx = (need[s] || {}).max; return mx == null ? 99 : mx - (count[s] || 0); };
    opts.sort((a, b) => (room(b) > 0) - (room(a) > 0) || cost(e, a, i) - cost(e, b, i) || room(b) - room(a));
    if (room(opts[0]) <= 0 && allowedOf(ctx, e, d).length < shiftIds.length) {   // 只對「有班別限制」的人：沒限制的人超過名額本來就沒有更好的排法，不去動別人
      // 他能上的班都滿了：先試著把那班裡「還有別班可去」的人換到有名額的班，空出位置給他，免得超過最多人數
      //（例：只能上早班的人被擠進已滿的早班；2026-10-29 Codex 審查，改動前就有的問題）
      for (const sft of opts) {
        const y = workers.slice().reverse().find(x => x !== e && assign[x] === sft && (pinOf(ctx, x, d) || {}).kind !== 'shift' && shiftIds.some(t => t !== sft && room(t) > 0 && ok(x, t)));   // 換走順位最後的人（Fable 審查）
        if (!y) continue;
        const t = shiftIds.find(t2 => t2 !== sft && room(t2) > 0 && ok(y, t2));
        assign[y] = t; count[t] = (count[t] || 0) + 1;
        assign[e] = sft;                                              // sft 的人數不變（y 走、e 來）
        return;
      }
    }
    assign[e] = opts[0]; count[opts[0]] = (count[opts[0]] || 0) + 1;
  });
  // 優先班別補強：增廣路徑配對不看偏好，配完再讓順位前面的人換到他的優先班別——
  //   跟那班裡「不偏好這班、或順位比他後面」的人對調（雙方都要合規），或那班還有名額、他原本那班換走後不會低於最少人數就直接換
  for (const e of workers.filter(x => prefOf(ctx, x) && assign[x] && assign[x] !== prefOf(ctx, x))) {
    const p = prefOf(ctx, e), cur = assign[e];
    if (!ok(e, p)) continue;
    const y = workers.slice().reverse().find(x => x !== e && assign[x] === p && (prefOf(ctx, x) !== p || prioOf(ctx, x) > prioOf(ctx, e)) && ok(x, cur));
    if (y) { assign[y] = cur; assign[e] = p; continue; }
    const mx = (need[p] || {}).max;
    if ((mx == null || (count[p] || 0) < mx) && (count[cur] || 0) > ((need[cur] || {}).min || 0)) { assign[e] = p; count[p] = (count[p] || 0) + 1; count[cur]--; }
  }
  // 不排同班的兩人（spec 5.5 D5）：配好後若同班，找別班一位可以對調的人交換（雙方都要合規）。
  // 其中一人是手動固定的班也要算（2026-10-11 Codex 審查）：固定的不能動，只能動另一個人
  const shiftOf = (e) => assign[e] || fixedShift[e];
  const conflicts = [];
  // 多組配對互相牽動（修好 A-C 可能又把 A 搬回 B 那班）：最多掃 3 輪，最後一輪還衝突的才回報（2026-10-29 Codex 審查）
  for (let pass = 0; pass < 3; pass++) {
  conflicts.length = 0;
  let moved = false;
  for (const [a, b] of (ctx.pairs || [])) {
    if (!shiftOf(a) || !shiftOf(b) || shiftOf(a) !== shiftOf(b)) continue;
    const pin = (e) => (pinOf(ctx, e, d) || {}).kind === 'shift' || !assign[e];
    const tryMove = (x) => {
      if (pin(x)) return false;
      for (const y of workers) {
        if (y === a || y === b || !assign[y] || assign[y] === assign[x] || pin(y)) continue;
        if (ok(x, assign[y]) && ok(y, assign[x])) { const t = assign[x]; assign[x] = assign[y]; assign[y] = t; return true; }
      }
      return false;
    };
    const moveAlone = (x) => {                                        // 對方是固定班：先試著把這個人直接換到別的班
      if (pin(x)) return false;
      const src = shiftOf(x);
      if ((count[src] || 0) - 1 < ((need[src] || {}).min || 0)) return false;   // 搬走後原班不能低於最少人數（2026-10-29 Codex 審查）
      const over = (sh, n) => { const mx = (need[sh] || {}).max; return mx == null ? 0 : Math.max(0, n - mx); };
      // 搬過去後「全部超額人數」不能變多（原班本來就超額時，搬走一個換過去不算變差；Fable 審查：只看新班會不會超額太嚴）
      const s2 = shiftIds.find(s => s !== src && ok(x, s) && over(src, (count[src] || 0) - 1) + over(s, (count[s] || 0) + 1) <= over(src, count[src] || 0) + over(s, count[s] || 0));
      if (s2) { assign[x] = s2; count[src]--; count[s2] = (count[s2] || 0) + 1; return true; }
      return false;
    };
    if (tryMove(b) || tryMove(a) || moveAlone(b) || moveAlone(a)) moved = true; else conflicts.push([a, b]);
  }
  if (!moved) break;
  }
  // 最後再純檢查一次：最後一輪的搬動可能讓別組變成同班，要照實回報（Fable 審查）
  conflicts.length = 0;
  for (const [a, b] of (ctx.pairs || [])) if (shiftOf(a) && shiftOf(b) && shiftOf(a) === shiftOf(b)) conflicts.push([a, b]);
  return { assign, unassigned, conflicts };
}

function buildDays(ctx, dates, fixed, plan) {
  const out = {};
  const fairness = {};
  for (const st of ctx.staff) { out[st.emp_id] = {}; fairness[st.emp_id] = {}; }
  const labels = {};
  for (const st of ctx.staff) labels[st.emp_id] = labelOffs(dates, plan, fixed, st.emp_id);
  const prevShift = {};
  for (const st of ctx.staff) {
    const d0 = addDays(dates[0], -1);
    const c = (ctx.days[st.emp_id] || {})[d0];
    const a = ((ctx.actuals || {})[st.emp_id] || {})[d0];
    prevShift[st.emp_id] = a ? { start: a.start, end: a.end, break_min: 0 } : c ? (c.shift_id ? ctx.shifts[c.shift_id] : null) : null;
  }
  const problems = [];
  // 計時同仁每期時數上限：先扣掉已固定的班，配班時逐天扣
  const capLeft = {};
  for (const st of ctx.staff) {
    const first = dates.find(d => employed(st, d)) || dates[0];
    const t = termAt(ctx.terms, st.emp_id, first);
    const cap = ptCapMin(ctx.terms, st.emp_id, dates, first);           // 期中改目標工時：照天數比例分段，跟 P6 同一套（2026-10-28 Codex 審查）
    if (!t || t.kind !== 'pt' || cap == null) continue;
    capLeft[st.emp_id] = cap - dates.reduce((a, d) => { const c = fixed[st.emp_id][d]; return a + (c && c.shift_id && ctx.shifts[c.shift_id] ? shiftMinutes(ctx.shifts[c.shift_id]) : 0); }, 0);
  }
  for (const d of dates) {
    const workers = [];
    const nextShift = {};
    const fixedCount = {};
    const fixedShift = {};
    for (const st of ctx.staff) {
      const e = st.emp_id;
      if (!employed(st, d)) continue;
      if (fixed[e][d]) { out[e][d] = fixed[e][d]; if (fixed[e][d].shift_id) { fixedCount[fixed[e][d].shift_id] = (fixedCount[fixed[e][d].shift_id] || 0) + 1; fixedShift[e] = fixed[e][d].shift_id; } continue; }
      if (plan[e][d] === 'off') { out[e][d] = { day_type: labels[e][d], shift_id: null, leave: null, source: 'auto' }; continue; }
      if (plan[e][d] === 'guo') { out[e][d] = { day_type: 'L', shift_id: null, leave: '國', source: 'auto' }; continue; }
      workers.push(e);
      const nx = fixed[e][addDays(d, 1)];
      if (nx && nx.shift_id) nextShift[e] = ctx.shifts[nx.shift_id];
    }
    const { assign, unassigned, conflicts } = assignDay(ctx, d, workers, prevShift, nextShift, fairness, fixedCount, { capLeft, fixedShift });
    const nm = (e) => (ctx.staff.find(s => s.emp_id === e) || {}).name;
    for (const [a, b] of conflicts) problems.push(`${md(d)} ${nm(a)} 和 ${nm(b)} 設定不排同一班，但這天排不開（其中有人是手動固定的班），請手動調整`);
    for (const e of workers) {
      if (assign[e]) {
        if (capLeft[e] !== undefined) capLeft[e] -= shiftMinutes(ctx.shifts[assign[e]]);
        const p = pinOf(ctx, e, d);
        out[e][d] = { day_type: 'W', shift_id: assign[e], leave: null, source: p ? 'pin' : 'auto' };
        fairness[e][assign[e]] = (fairness[e][assign[e]] || 0) + 1;
      }
    }
    for (const e of unassigned) {
      out[e][d] = { day_type: 'H', shift_id: null, leave: null, source: 'auto' };
      problems.push(`${nm(e)} ${md(d)} 沒有能上的班（${capLeft[e] !== undefined && Object.keys(ctx.shifts).every(s => shiftMinutes(ctx.shifts[s]) > capLeft[e]) ? '這期時數已經排滿' : '換班間隔或可上班別限制'}），改排休息日`);
    }
    for (const st of ctx.staff) { const c = out[st.emp_id][d]; prevShift[st.emp_id] = c && c.shift_id ? ctx.shifts[c.shift_id] : null; }
  }
  return { out, problems };
}

function merged(ctx, dates, out) {
  const days = {};
  for (const st of ctx.staff) {
    days[st.emp_id] = {};
    const src = ctx.days[st.emp_id] || {};
    for (const d in src) if (!dates.includes(d)) days[st.emp_id][d] = src[d];
    Object.assign(days[st.emp_id], out[st.emp_id]);
  }
  return Object.assign({}, ctx, { days });
}

const otCells = (days) => Object.values(days || {}).reduce((a, m) => a + Object.values(m).filter(c => c && c.day_type === 'H' && c.shift_id && c.source === 'auto').length, 0);

/** 國定假日假不能逼出休息日加班（加班費比國定假日出勤的雙倍薪資貴；Eason 2026-10-12）：
 *  先照常排；若比「完全不排國定假日假」多出休息日加班，就逐一讓正職這期不排國定假日假（留 C8 提醒雙倍薪資），直到不多為止 */
export function autoSchedule(ctx, opts) {
  const dates = periodDates(ctx.period);
  const r0 = scheduleOnce(ctx, opts, null);
  if (!r0.ok || !dates.some(d => isHoliday(ctx.holidays, d)) || !otCells(r0.days)) return r0;
  const ft = ctx.staff.filter(st => (termAt(ctx.terms, st.emp_id, dates.find(d => employed(st, d)) || dates[0]) || {}).kind === 'ft').map(st => st.emp_id);
  const base = scheduleOnce(ctx, opts, new Set(ft));
  if (!base.ok || otCells(r0.days) <= otCells(base.days)) return r0;
  const skip = new Set();
  for (const e of ft.slice().reverse()) {
    skip.add(e);
    const r = scheduleOnce(ctx, opts, skip);
    if (r.ok && otCells(r.days) <= otCells(base.days)) return r;
  }
  return base;
}

function scheduleOnce(ctx, opts, guoSkip) {
  const keepManual = !opts || opts.keepManual !== false;
  // 手動排的例假／休息日（沒有班）：保留「這天休」，但「例」還是「休」交給系統依每週重新標（2026-10-31 光復范家嘉：
  //  一週的休假全是手動選的「休息日」→ 原本整格固定、系統補不出例假，整期擋「這週沒有例假」）。做法＝當成指定休假排，結果再標回手動
  const manualOff = {};
  if (keepManual) {
    const pins = {};
    for (const st of ctx.staff) {
      const e = st.emp_id;
      pins[e] = Object.assign({}, (ctx.pins || {})[e] || {});
      for (const [d, c] of Object.entries(ctx.days[e] || {})) {
        if (c && c.source === 'manual' && (c.day_type === 'R' || c.day_type === 'H') && !c.shift_id && !pins[e][d] && employed(st, d)) { pins[e][d] = { kind: 'off' }; (manualOff[e] = manualOff[e] || {})[d] = true; }
      }
    }
    const days = {};
    for (const e of Object.keys(ctx.days || {})) { days[e] = Object.assign({}, ctx.days[e]); for (const d of Object.keys(manualOff[e] || {})) delete days[e][d]; }
    ctx = Object.assign({}, ctx, { pins, days });
  }
  const r = scheduleCore(ctx, opts, guoSkip, keepManual);
  if (r.days) for (const e of Object.keys(manualOff)) for (const d of Object.keys(manualOff[e])) if (r.days[e] && r.days[e][d] && !r.days[e][d].shift_id && (r.days[e][d].day_type === 'R' || r.days[e][d].day_type === 'H')) r.days[e][d].source = 'manual';
  return r;
}

function scheduleCore(ctx, opts, guoSkip, keepManual) {
  const inp = inputProblems(ctx);
  if (inp.length) return { ok: false, days: null, problems: inp, results: [] };
  const dates = periodDates(ctx.period);
  // 1. 固定的格子：請假、手動（保留時）、指定某班
  const fixed = {};
  for (const st of ctx.staff) {
    const e = st.emp_id;
    fixed[e] = {};
    for (const d of dates) {
      const c = (ctx.days[e] || {})[d];
      // 休息日加班（H＋班）一律保留，連「全部重排」也不動：只能由店長手動改回休息日（Eason 2026-10-11，加班費不能因重排消失）
      // 自動排的國定假日假（source=auto）每次重排都重新挑日子；手動排的照請假保留
      const autoGuo = c && c.day_type === 'L' && c.leave === '國' && c.source === 'auto';
      if (c && !autoGuo && (c.day_type === 'L' || (c.day_type === 'H' && c.shift_id) || (keepManual && c.source === 'manual'))) fixed[e][d] = c;
      const p = pinOf(ctx, e, d);
      if (p && p.kind === 'shift' && !fixed[e][d]) fixed[e][d] = { day_type: 'W', shift_id: p.shift_id, leave: null, source: 'pin' };
    }
  }
  const plan = planOffDays(ctx, dates, fixed, guoSkip);
  let { out, problems } = buildDays(ctx, dates, fixed, plan);
  let res = checkPeriod(merged(ctx, dates, out));

  const holWork = (e, d) => isHoliday(ctx.holidays, d) && (termAt(ctx.terms, e, d) || {}).kind === 'ft';   // 正職國定假日要上班，修復時不能把它換成休假
  // 4. 修復：某天某班缺人 → 找那天休假、能上這班的人，跟同週他上班且那班有多餘人手的一天對調
  const shortages = () => res.filter(r => r.code === 'D1');
  let tries = 0;
  for (let progressed = true; progressed && tries < REPAIR_MAX;) {
    progressed = false;
    for (const sh of shortages()) {
      if (tries++ >= REPAIR_MAX) break;
      const d = sh.date, w = Math.floor(dates.indexOf(d) / 7);
      const wk = dates.slice(w * 7, w * 7 + 7);
      const lacking = Object.keys(needOf(ctx, d)).filter(s => ctx.staff.filter(st => (out[st.emp_id][d] || {}).shift_id === s).length < needOf(ctx, d)[s].min);
      let done = false;
      for (const st of ctx.staff) {
        const e = st.emp_id;
        if (done || plan[e][d] !== 'off' || (pinOf(ctx, e, d) || {}).kind === 'off' || bkDay(ctx, e, d)) continue;   // 備援的日子只由 4.2 叫（Fable 複驗）
        if (!lacking.some(s => allowedOf(ctx, e, d).includes(s))) continue;
        for (const d2 of wk) {
          if (d2 === d || plan[e][d2] !== 'work' || pinOf(ctx, e, d2) || holWork(e, d2) || bkDay(ctx, e, d2)) continue;
          const s2 = (out[e][d2] || {}).shift_id;
          const n2 = ctx.staff.filter(x => (out[x.emp_id][d2] || {}).shift_id === s2).length;
          if (n2 <= ((needOf(ctx, d2)[s2] || {}).min || 0)) continue;
          plan[e][d] = 'work'; plan[e][d2] = 'off';
          const trial = buildDays(ctx, dates, fixed, plan);
          const tres = checkPeriod(merged(ctx, dates, trial.out));
          const better = tres.filter(r => r.level === 'block').length <= res.filter(r => r.level === 'block').length
            && tres.filter(r => r.code === 'D1').length < res.filter(r => r.code === 'D1').length;
          if (better) { out = trial.out; problems = trial.problems; res = tres; done = true; progressed = true; break; }
          plan[e][d] = 'off'; plan[e][d2] = 'work';
        }
      }
    }
  }

  const blockCount = (rs) => rs.filter(r => r.level === 'block').length;
  const d1Count = (rs) => rs.filter(r => r.code === 'D1').length;

  // 4.1 某天上班人數超過各班「最多」加總（有任一使用中的班沒設最多＝不限）：讓那天上班的人跟同週他休、人數還沒到上限的一天對調。
  //   原本挑休假只看最少人數，週末設了最多 4 人照樣排成 5 人（2026-10-31 Eason）。整期重驗：不能多出「擋」或缺人，超額總數要變少
  const activeIds = Object.keys(ctx.shifts).filter(s => ctx.shifts[s].active !== 0);
  const capOf = (d) => { const n = needOf(ctx, d); return activeIds.reduce((a, s) => a + ((n[s] || {}).max == null ? Infinity : n[s].max), 0); };
  const onOf = (o, d) => ctx.staff.filter(st => employed(st, d) && (o[st.emp_id][d] || {}).shift_id).length;
  const overAll = (o) => dates.reduce((a, d) => a + Math.max(0, onOf(o, d) - capOf(d)), 0);
  let overTries = 0;
  for (let progressed = overAll(out) > 0; progressed && overTries < REPAIR_MAX;) {
    progressed = false;
    for (const d of dates) {
      if (onOf(out, d) <= capOf(d) || overTries++ >= REPAIR_MAX) continue;
      const wk = dates.slice(Math.floor(dates.indexOf(d) / 7) * 7, Math.floor(dates.indexOf(d) / 7) * 7 + 7);
      let done = false;
      for (const st of ctx.staff.slice().reverse()) {   // 順位最後的人先換
        const e = st.emp_id;
        if (done || plan[e][d] !== 'work' || pinOf(ctx, e, d) || holWork(e, d) || bkDay(ctx, e, d)) continue;
        for (const d2 of wk) {
          if (d2 === d || plan[e][d2] !== 'off' || pinOf(ctx, e, d2) || bkDay(ctx, e, d2) || onOf(out, d2) >= capOf(d2)) continue;
          plan[e][d] = 'off'; plan[e][d2] = 'work';
          const trial = buildDays(ctx, dates, fixed, plan);
          const tres = checkPeriod(merged(ctx, dates, trial.out));
          if (blockCount(tres) <= blockCount(res) && d1Count(tres) <= d1Count(res) && overAll(trial.out) < overAll(out)) { out = trial.out; problems = trial.problems; res = tres; done = true; progressed = true; break; }
          plan[e][d] = 'work'; plan[e][d2] = 'off';
        }
      }
    }
  }

  // 4.2 還是缺人：叫備援同仁（計時）來補，一次一天、整期重排驗證（2026-10-28 Eason：其他同仁真的排不開才排他）。
  //     排在國定假日假換回上班（4.5）、休息日加班（5）之前：備援是一般工時，比雙倍薪資、加班費便宜。
  //     不能多出「擋」，也不能讓他多出加班提醒（連上第 6 天、超過 8 小時、超過 40 小時、休息日出勤）——那種寧可留給後面的步驟或店長。
  const backups = ctx.staff.filter(st => dates.some(d => employed(st, d) && bkDay(ctx, st.emp_id, d)));
  if (backups.length) {
    // 不能叫出休息日加班（P2 休息日出勤、P7 連上第 6 天）或週超過 40 小時（P5）。單日超過 8 小時（P4）不算：
    // 班別本身超過 8 小時的店，一般計時同仁上班也一樣有 P4，擋掉會讓備援永遠叫不來、改排更貴的正職休息日加班（2026-10-28 Fable 審查）
    const otWarn = (rs, e) => rs.filter(r => r.emp_id === e && r.level === 'warn' && ['P2', 'P5', 'P7'].includes(r.code)).length;
    const missing = (o, d) => { const n = needOf(ctx, d); let k = 0; for (const sid in n) k += Math.max(0, (n[sid].min || 0) - ctx.staff.filter(x => (o[x.emp_id][d] || {}).shift_id === sid).length); return k; };   // 同一天同一班缺 2 人只算一條 D1，要看缺幾人
    const missAll = (o) => dates.reduce((a, x) => a + missing(o, x), 0);
    const used = {};
    backups.forEach(st => { used[st.emp_id] = dates.filter(d => bkDay(ctx, st.emp_id, d) && plan[st.emp_id][d] === 'work').length; });
    const tried = new Set();
    const weekFills = [0, 0, 0, 0];                                     // 每週已叫備援幾次：先補叫得少的那週，不讓時數上限在期初就用光（2026-10-29 Fable 審查）
    for (let guard = 0; guard < REPAIR_MAX; guard++) {
      const cands = res.filter(r => r.code === 'D1' && !tried.has(r.date));
      if (!cands.length) break;
      const wkOf = (dd) => Math.floor(dates.indexOf(dd) / 7);
      const sh = cands.slice().sort((x, y) => weekFills[wkOf(x.date)] - weekFills[wkOf(y.date)] || (x.date < y.date ? -1 : 1))[0];
      const d = sh.date;
      const need = needOf(ctx, d);
      const lacking = Object.keys(need).filter(sid => ctx.staff.filter(x => (out[x.emp_id][d] || {}).shift_id === sid).length < need[sid].min);
      let done = false;
      for (const st of backups.slice().sort((x, y) => used[x.emp_id] - used[y.emp_id] || (x.emp_id < y.emp_id ? -1 : 1))) {   // 這期叫得少的先叫，輪流
        const e = st.emp_id;
        if (!bkDay(ctx, e, d) || plan[e][d] !== 'off' || (pinOf(ctx, e, d) || {}).kind === 'off') continue;
        if (!lacking.some(s => allowedOf(ctx, e, d).includes(s))) continue;
        plan[e][d] = 'work';
        const trial = buildDays(ctx, dates, fixed, plan);
        const tres = checkPeriod(merged(ctx, dates, trial.out));
        // 整期缺的人數要真的變少：只把缺口從這天搬到別天（例如時數上限被前面吃光，後面原本的班排不進去）不算（Fable 複驗）
        if (blockCount(tres) <= blockCount(res) && d1Count(tres) <= d1Count(res) && missing(trial.out, d) < missing(out, d) && missAll(trial.out) < missAll(out) && otWarn(tres, e) <= otWarn(res, e) && (trial.out[e][d] || {}).shift_id) {
          out = trial.out; problems = trial.problems; res = tres; used[e]++; weekFills[Math.floor(dates.indexOf(d) / 7)]++; done = true; break;
        }
        plan[e][d] = 'off';
      }
      if (!done) tried.add(d);                                             // 這天備援也補不了：交給後面的步驟
    }
  }
  // 4.5 還是缺人：先拿國定假日假來補（國定假日當天上班付雙倍薪資，比付休息日加班費便宜；Eason 2026-10-12）。
  //     某人那天休假、且本期有排國定假日假 → 那天改上班、國定假日假那天改成休假（例休天數不變，少一天國定假日假），整期重排驗證
  for (let guard = 0, progressed = true; progressed && guard < REPAIR_MAX; guard++) {
    progressed = false;
    for (const sh of res.filter(r => r.code === 'D1')) {
      const d = sh.date;
      for (const st of ctx.staff) {
        const e = st.emp_id;
        if (plan[e][d] !== 'off' && plan[e][d] !== 'guo') continue;
        if ((pinOf(ctx, e, d) || {}).kind === 'off') continue;
        const gds = dates.filter(x => plan[e][x] === 'guo' && x !== d);
        const tries2 = plan[e][d] === 'guo' ? [null] : gds;
        for (const gd of tries2) {
          const p0 = plan[e][d];
          plan[e][d] = 'work'; if (gd) plan[e][gd] = 'off';
          const trial = buildDays(ctx, dates, fixed, plan);
          const tres = checkPeriod(merged(ctx, dates, trial.out));
          if (blockCount(tres) <= blockCount(res) && d1Count(tres) < d1Count(res)) { out = trial.out; problems = trial.problems; res = tres; progressed = true; break; }
          plan[e][d] = p0; if (gd) plan[e][gd] = 'guo';
        }
        if (progressed) break;
      }
      if (progressed) break;
    }
  }

  // 5. 還是缺人：正職的休息日改成「休息日加班」來補（Eason 2026-10-11：只在人手不夠時才用；每人每期最多 2 天，
  //    連續上班最多 12 天由 F6 把關；加班分鐘由 rules 算進每月加班）。每補一格都整期重驗，有新的「擋」就退回。
  const OT_PER_PERIOD = FT_OT_MAX;
  const otUsed = {};
  for (const st of ctx.staff) otUsed[st.emp_id] = dates.filter(d => out[st.emp_id][d] && out[st.emp_id][d].day_type === 'H' && out[st.emp_id][d].shift_id).length;
  const shortOn = (d) => { const n = needOf(ctx, d); let k = 0; for (const sid in n) k += Math.max(0, n[sid].min - ctx.staff.filter(x => employed(x, d) && (out[x.emp_id][d] || {}).shift_id === sid).length); return k; };
  const gaveUp = new Set();
  for (let guard = 0; guard < REPAIR_MAX; guard++) {
    const sh = res.find(r => r.code === 'D1' && !gaveUp.has(r.date));
    if (!sh) break;
    const d = sh.date;
    const need = needOf(ctx, d);
    const lacking = Object.keys(need).filter(sid => ctx.staff.filter(x => (out[x.emp_id][d] || {}).shift_id === sid).length < need[sid].min);
    let done = false;
    const cands = ctx.staff.filter(st => {
      const e = st.emp_id, c = out[e][d], t = termAt(ctx.terms, e, d);
      return t && t.kind === 'ft' && c && c.day_type === 'H' && !c.shift_id && c.source !== 'manual' && otUsed[e] < OT_PER_PERIOD && (pinOf(ctx, e, d) || {}).kind !== 'off';
    }).sort((x, y) => otUsed[x.emp_id] - otUsed[y.emp_id] || (x.emp_id < y.emp_id ? -1 : 1));
    for (const st of cands) {
      for (const sid of lacking) {
        if (!allowedOf(ctx, st.emp_id, d).includes(sid)) continue;
        // 不排同班的對象那天已經在這班 → 不挑他（2026-10-31 換班間隔改回 11 小時後才露出來：原本這步不看 D5）
        if ((ctx.pairs || []).some(([a, b]) => (a === st.emp_id || b === st.emp_id) && (out[a === st.emp_id ? b : a] || {})[d] && out[a === st.emp_id ? b : a][d].shift_id === sid)) continue;
        const before = out[st.emp_id][d];
        const short0 = shortOn(d);
        out[st.emp_id][d] = { day_type: 'H', shift_id: sid, leave: null, source: 'auto' };
        const tres = checkPeriod(merged(ctx, dates, out));
        if (blockCount(tres) <= blockCount(res) && shortOn(d) < short0) {
          res = tres; otUsed[st.emp_id]++; done = true;
          problems.push(`${st.name} ${md(d)} 人手不夠，排休息日加班（要付加班費）`);
          break;
        }
        out[st.emp_id][d] = before;
      }
      if (done) break;
    }
    if (!done) gaveUp.add(d);                                            // 這一天補不了：留給店長看「缺人」，換下一天
  }

  // 6. 正職國定假日假（Eason 2026-10-12）：本期有幾天國定假日就排幾天「國定假日假」，挑那班人手最寬裕、不是國定假日、
  //    沒指定的自動排班日；每排一天整期重驗，不能多出「擋」或缺人。排不出來就留 C8 提醒（當天出勤要給雙倍薪資）。
  for (const st of ctx.staff) {
    const e = st.emp_id;
    const inP = dates.filter(d => employed(st, d));
    if (!inP.length || (termAt(ctx.terms, e, inP[0]) || {}).kind !== 'ft') continue;
    let need = inP.filter(d => isHoliday(ctx.holidays, d)).length - inP.filter(d => out[e][d] && out[e][d].day_type === 'L' && out[e][d].leave === '國').length;
    if (need <= 0) continue;
    const slackOf = (d) => { const sid = out[e][d].shift_id; return ctx.staff.filter(x => (out[x.emp_id][d] || {}).shift_id === sid).length - ((needOf(ctx, d)[sid] || {}).min || 0); };
    const guoWeeks = new Set(inP.filter(d => out[e][d] && out[e][d].day_type === 'L' && out[e][d].leave === '國').map(d => Math.floor(dates.indexOf(d) / 7)));
    const cands = inP.filter(d => { const c = out[e][d]; return c && c.day_type === 'W' && c.shift_id && c.source !== 'manual' && c.source !== 'pin' && !pinOf(ctx, e, d) && !isHoliday(ctx.holidays, d) && !guoWeeks.has(Math.floor(dates.indexOf(d) / 7)); })
      .sort((a, b) => slackOf(b) - slackOf(a) || (a < b ? -1 : 1));
    for (const d of cands) {
      if (need <= 0) break;
      if (slackOf(d) <= 0 || guoWeeks.has(Math.floor(dates.indexOf(d) / 7))) continue;   // 同一週不排兩天
      const before = out[e][d];
      out[e][d] = { day_type: 'L', shift_id: null, leave: '國', source: 'auto' };
      const tres = checkPeriod(merged(ctx, dates, out));
      if (blockCount(tres) <= blockCount(res) && d1Count(tres) <= d1Count(res)) { res = tres; need--; guoWeeks.add(Math.floor(dates.indexOf(d) / 7)); }
      else out[e][d] = before;
    }
    if (need > 0) problems.push(`${st.name} 本期還有 ${need} 天國定假日假排不出來，國定假日當天出勤要給雙倍薪資`);
  }

  // 備援補了哪幾天：由 rules.js 的 B1 放進提醒清單（重新整理也看得到），這裡不再另外列
  // 7. 優先排上班（2026-10-28 Eason）：有人設了排班順位時，某天某班超過最多人數，就讓順位最後的計時同仁那天改休（沒設順位的算最後），
  //    直到不超過；正職、指定、手動、請假的格子不動。整期重驗，不能多出「擋」或缺人。沒有任何人設順位就跳過（維持原本的排法）
  if (ctx.staff.some(st => st.prio != null && dates.some(d => employed(st, d)))) {   // 只看本期在職的人（離職的人留著順位不該啟動，Fable 審查）
    const trimmed = {};
    const worked = (e) => dates.filter(x => out[e][x] && out[e][x].shift_id).length;
    const offType = (e, d) => { const w = Math.floor(dates.indexOf(d) / 7); return dates.slice(w * 7, w * 7 + 7).some(x => out[e][x] && out[e][x].day_type === 'R') ? 'H' : 'R'; };
    for (const d of dates) {
      const need = needOf(ctx, d);
      for (const sid in need) {
        if (need[sid].max == null) continue;
        const on = () => ctx.staff.filter(st => employed(st, d) && (out[st.emp_id][d] || {}).shift_id === sid);
        const cands = on().filter(st => { const c = out[st.emp_id][d], t = termAt(ctx.terms, st.emp_id, d); return t && t.kind === 'pt' && c.day_type === 'W' && c.source === 'auto' && !pinOf(ctx, st.emp_id, d); })
          .sort((a, b) => prioOf(ctx, b.emp_id) - prioOf(ctx, a.emp_id) || worked(b.emp_id) - worked(a.emp_id) || (a.emp_id < b.emp_id ? 1 : -1));   // 同順位：這期上班天數多的先休，輪流（Codex 審查：原本照編號固定刷同一人，會有人整期 0 天）
        for (const st of cands) {
          if (on().length <= need[sid].max) break;
          const e = st.emp_id, before = out[e][d];
          out[e][d] = { day_type: offType(e, d), shift_id: null, leave: null, source: 'auto' };
          const tres = checkPeriod(merged(ctx, dates, out));
          if (blockCount(tres) <= blockCount(res) && d1Count(tres) <= d1Count(res)) { res = tres; (trimmed[e] = trimmed[e] || []).push(d); }
          else out[e][d] = before;
        }
      }
    }
    // 被刷掉的天數列在提醒裡（有時整週一天都沒排到），店長才知道為什麼他班少（Fable 審查）
    for (const e in trimmed) problems.push(`${staffRow(ctx, e).name || e} 順位在後，人手過多的 ${trimmed[e].length} 天改休（${trimmed[e].map(md).join('、')}）`);
  }

  const blocks = res.filter(r => r.level === 'block');
  if (blocks.length) return { ok: false, days: null, problems: problems.concat(blocks.map(b => b.msg)), results: res };
  return { ok: true, days: out, problems, results: res };
}
