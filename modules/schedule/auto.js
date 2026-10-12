// 自動排班（spec 第 6 節）。純函式、不用亂數：同樣輸入一定排出同樣結果。
// autoSchedule(ctx, opts) → { ok, days, problems, results }
//   ctx：同 rules.js 的 ctx（days 內可含前期最後 13 天、要保留的手動格與請假格）
//   opts.keepManual（預設 true）：保留本期 source='manual' 的格子
// 步驟：0 輸入檢查 → 1 保留指定／手動 → 2 排日別（每週選休假日，以「休了以後各班還剩多少人」評分）
//       → 3 逐日配對（先滿足最少人數，用增廣路徑做二分圖配對）→ 4 修復（同週對調休假日）→ 5 整期檢查，沒有「擋」才回傳
import { periodDates, addDays } from './period.js';
import { shiftMinutes, gapMinutes } from './hours.js';
import { checkPeriod, termAt, employed, isHoliday, MIN_GAP, FT_OT_MAX } from './rules.js';

const DAY_MAX = 12 * 60, REPAIR_MAX = 200;
const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;

function allowedOf(ctx, emp, d) {
  const t = termAt(ctx.terms, emp, d);
  const all = Object.keys(ctx.shifts).filter(s => ctx.shifts[s].active !== 0);
  return t && t.allowed_shifts && t.allowed_shifts.length ? all.filter(s => t.allowed_shifts.includes(s)) : all;
}
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
  const al = allowedOf(ctx, e, d);
  const avg = al.length ? al.reduce((a, s) => a + shiftMinutes(ctx.shifts[s]), 0) / al.length : 480;
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
  for (const st of staff) for (const d of dates) if (employed(st, d) && !fixed[st.emp_id][d]) allowedOf(ctx, st.emp_id, d).forEach(s => { avail[d][s]++; });
  // 能上的班越多的人先選（彈性大的先讓位），能上的班少的人最後挑剩下最寬鬆的日子
  staff.sort((a, b) => allowedOf(ctx, b.emp_id, dates[0]).length - allowedOf(ctx, a.emp_id, dates[0]).length || (a.emp_id < b.emp_id ? -1 : 1));
  staff.forEach((st, si) => {
    const e = st.emp_id;
    plan[e] = {};
    const limit = (termAt(ctx.terms, e, dates[0]) || {}).kind === 'pt' ? 6 : 12;
    let run = priorRun(ctx, e, dates[0]);
    const quota = ftPartialQuota(ctx, st, dates);
    for (let w = 0; w < 4; w++) {
      const wk = dates.slice(w * 7, w * 7 + 7).filter(d => employed(st, d));
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
      let best = null, bestScore = Infinity, bestRun = run;
      for (const pick of combos(cand, Math.min(cand.length, k - pinnedOff.length))) {
        const offs = new Set(pinnedOff.concat(pick));
        let r = run, okRun = true;
        for (const d of dates.slice(w * 7, w * 7 + 7)) {
          const c = fixed[e][d];
          const works = c ? !!c.shift_id : (employed(st, d) && !offs.has(d));
          r = works ? r + 1 : 0;
          if (r > limit) { okRun = false; break; }
        }
        if (!okRun) continue;
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
      if (!best) best = new Set(pinnedOff.concat(cand.slice(0, Math.max(0, k - pinnedOff.length))));
      for (const d of dates.slice(w * 7, w * 7 + 7)) {
        if (!employed(st, d) || fixed[e][d]) continue;
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
  const cost = (e, s, i) => (fairness[e] && fairness[e][s] || 0) * 10 + ((i + shiftIds.indexOf(s)) % shiftIds.length) * 0.01;
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
    opts.sort((a, b) => {
      const room = (s) => { const mx = (need[s] || {}).max; return mx == null ? 99 : mx - (count[s] || 0); };
      return (room(b) > 0) - (room(a) > 0) || cost(e, a, i) - cost(e, b, i) || room(b) - room(a);
    });
    assign[e] = opts[0]; count[opts[0]] = (count[opts[0]] || 0) + 1;
  });
  // 不排同班的兩人（spec 5.5 D5）：配好後若同班，找別班一位可以對調的人交換（雙方都要合規）。
  // 其中一人是手動固定的班也要算（2026-10-11 Codex 審查）：固定的不能動，只能動另一個人
  const shiftOf = (e) => assign[e] || fixedShift[e];
  const conflicts = [];
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
      const s2 = shiftIds.find(s => s !== shiftOf(x) && ok(x, s));
      if (s2) { assign[x] = s2; return true; }
      return false;
    };
    if (!(tryMove(b) || tryMove(a) || moveAlone(b) || moveAlone(a))) conflicts.push([a, b]);
  }
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
    const t = termAt(ctx.terms, st.emp_id, dates.find(d => employed(st, d)) || dates[0]);
    if (!t || t.kind !== 'pt' || t.target_min == null) continue;
    capLeft[st.emp_id] = t.target_min - dates.reduce((a, d) => { const c = fixed[st.emp_id][d]; return a + (c && c.shift_id && ctx.shifts[c.shift_id] ? shiftMinutes(ctx.shifts[c.shift_id]) : 0); }, 0);
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
        if (done || plan[e][d] !== 'off' || (pinOf(ctx, e, d) || {}).kind === 'off') continue;
        if (!lacking.some(s => allowedOf(ctx, e, d).includes(s))) continue;
        for (const d2 of wk) {
          if (d2 === d || plan[e][d2] !== 'work' || pinOf(ctx, e, d2) || holWork(e, d2)) continue;
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

  const blocks = res.filter(r => r.level === 'block');
  if (blocks.length) return { ok: false, days: null, problems: problems.concat(blocks.map(b => b.msg)), results: res };
  return { ok: true, days: out, problems, results: res };
}
