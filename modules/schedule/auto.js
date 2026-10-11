// 自動排班（spec 第 6 節）。純函式、不用亂數：同樣輸入一定排出同樣結果。
// autoSchedule(ctx, opts) → { ok, days, problems, results }
//   ctx：同 rules.js 的 ctx（days 內可含前期最後 13 天、要保留的手動格與請假格）
//   opts.keepManual（預設 true）：保留本期 source='manual' 的格子
// 步驟：0 輸入檢查 → 1 保留指定／手動 → 2 排日別（每週選休假日，以「休了以後各班還剩多少人」評分）
//       → 3 逐日配對（先滿足最少人數，用增廣路徑做二分圖配對）→ 4 修復（同週對調休假日）→ 5 整期檢查，沒有「擋」才回傳
import { periodDates, addDays } from './period.js';
import { shiftMinutes, gapMinutes } from './hours.js';
import { checkPeriod, termAt, employed, MIN_GAP } from './rules.js';

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

/** 2. 排日別：回傳 { emp: { date: 'off'|'work'|'fixed' } }，以及 R／H 標記 */
function planOffDays(ctx, dates, fixed) {
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
    for (let w = 0; w < 4; w++) {
      const wk = dates.slice(w * 7, w * 7 + 7).filter(d => employed(st, d));
      const free = wk.filter(d => !fixed[e][d]);
      const pinnedOff = free.filter(d => (pinOf(ctx, e, d) || {}).kind === 'off');
      const mustWork = new Set(free.filter(d => { const p = pinOf(ctx, e, d); return p && p.kind !== 'off'; }));
      const need = wk.length === 7 ? offsPerWeek(ctx, e, wk[0]) : Math.round(offsPerWeek(ctx, e, wk[0]) * wk.length / 7);
      const k = Math.max(need, pinnedOff.length);
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
export function assignDay(ctx, d, workers, prevShift, nextShift, fairness, fixedCount) {
  const need = needOf(ctx, d);
  fixedCount = fixedCount || {};                                     // 已固定的班（指定某班、手動）先算進人數（GPT 上線前審查 15）
  const shiftIds = Object.keys(ctx.shifts).filter(s => ctx.shifts[s].active !== 0);
  const ok = (e, s) => {
    if (!allowedOf(ctx, e, d).includes(s)) return false;
    const sh = ctx.shifts[s];
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
  // 不排同班的兩人（spec 5.5 D5）：配好後若同班，找別班一位可以對調的人交換（雙方都要合規）
  for (const [a, b] of (ctx.pairs || [])) {
    if (!assign[a] || !assign[b] || assign[a] !== assign[b]) continue;
    const pin = (e) => (pinOf(ctx, e, d) || {}).kind === 'shift';
    const tryMove = (x) => {
      if (pin(x)) return false;
      for (const y of workers) {
        if (y === a || y === b || !assign[y] || assign[y] === assign[x] || pin(y)) continue;
        if (ok(x, assign[y]) && ok(y, assign[x])) { const t = assign[x]; assign[x] = assign[y]; assign[y] = t; return true; }
      }
      return false;
    };
    if (!tryMove(b)) tryMove(a);
  }
  return { assign, unassigned };
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
  for (const d of dates) {
    const workers = [];
    const nextShift = {};
    const fixedCount = {};
    for (const st of ctx.staff) {
      const e = st.emp_id;
      if (!employed(st, d)) continue;
      if (fixed[e][d]) { out[e][d] = fixed[e][d]; if (fixed[e][d].shift_id) fixedCount[fixed[e][d].shift_id] = (fixedCount[fixed[e][d].shift_id] || 0) + 1; continue; }
      if (plan[e][d] === 'off') { out[e][d] = { day_type: labels[e][d], shift_id: null, leave: null, source: 'auto' }; continue; }
      workers.push(e);
      const nx = fixed[e][addDays(d, 1)];
      if (nx && nx.shift_id) nextShift[e] = ctx.shifts[nx.shift_id];
    }
    const { assign, unassigned } = assignDay(ctx, d, workers, prevShift, nextShift, fairness, fixedCount);
    for (const e of workers) {
      if (assign[e]) {
        const p = pinOf(ctx, e, d);
        out[e][d] = { day_type: 'W', shift_id: assign[e], leave: null, source: p ? 'pin' : 'auto' };
        fairness[e][assign[e]] = (fairness[e][assign[e]] || 0) + 1;
      }
    }
    for (const e of unassigned) {
      out[e][d] = { day_type: 'H', shift_id: null, leave: null, source: 'auto' };
      problems.push(`${(ctx.staff.find(s => s.emp_id === e) || {}).name} ${md(d)} 沒有能上的班（換班間隔或可上班別限制），改排休息日`);
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

export function autoSchedule(ctx, opts) {
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
      if (c && (c.day_type === 'L' || (keepManual && c.source === 'manual'))) fixed[e][d] = c;
      const p = pinOf(ctx, e, d);
      if (p && p.kind === 'shift' && !fixed[e][d]) fixed[e][d] = { day_type: 'W', shift_id: p.shift_id, leave: null, source: 'pin' };
    }
  }
  const plan = planOffDays(ctx, dates, fixed);
  let { out, problems } = buildDays(ctx, dates, fixed, plan);
  let res = checkPeriod(merged(ctx, dates, out));

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
          if (d2 === d || plan[e][d2] !== 'work' || pinOf(ctx, e, d2)) continue;
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

  // 5. 還是缺人：正職的休息日改成「休息日加班」來補（Eason 2026-10-11：只在人手不夠時才用；每人每期最多 2 天，
  //    連續上班最多 12 天由 F6 把關；加班分鐘由 rules 算進每月加班）。每補一格都整期重驗，有新的「擋」就退回。
  const OT_PER_PERIOD = 2;
  const otUsed = {};
  for (const st of ctx.staff) otUsed[st.emp_id] = dates.filter(d => out[st.emp_id][d] && out[st.emp_id][d].day_type === 'H' && out[st.emp_id][d].shift_id).length;
  const blockCount = (rs) => rs.filter(r => r.level === 'block').length;
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

  const blocks = res.filter(r => r.level === 'block');
  if (blocks.length) return { ok: false, days: null, problems: problems.concat(blocks.map(b => b.msg)), results: res };
  return { ok: true, days: out, problems, results: res };
}
