// 總部自填排班／央廚固定排班的假後端（示範模式 ?mode=mock 與 e2e 用）。動作名稱、回傳形狀、狀態機與權限照 server/schedule-hq.js（docs/schedule-hq/spec.md §10.1）；
// 檢查直接用 rules.js 的 checkSelfMonth。簡化處（真伺服器才有）：fixed 的「1 分鐘合併重送」這裡改成立刻入列；每月 20 號自動產生改成每次動作前補產（同伺服器 tick 的補產規則）。
// 央廚（fixed）上線就自動切換（modeFrom＝MODE_FROM，開起來就已經有月曆）；沒設固定班別的人平日空白，fixedShift 設好後自動補上他從明天起的平日。
// e2e 看發布：db.sched[<店>].pubs[<期>]＝[{seq, kind:'publish', status, payload:{cells…}}]。
import { checkSelfMonth, comboError, employed, holName } from '../modules/schedule/rules.js';
import { periodOf, periodDates, addDays, weekday, todayTaipei, parseLabel } from '../modules/schedule/period.js';

const ok = (data) => ({ ok: true, data: data === undefined ? {} : data });
const fail = (error, message) => ({ ok: false, error, message });
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const AUTO_BY = '自動（不需核准）';
const monthDates = (m) => { const o = []; for (let d = m + '-01'; d.slice(0, 7) === m; d = addDays(d, 1)) o.push(d); return o; };
const nextMonth = (m) => addDays(m + '-01', 32).slice(0, 7);
const prevMonth = (m) => addDays(m + '-01', -1).slice(0, 7);
const toCell = (c) => { const o = { t: c.day_type }; if (c.shift_id) o.s = c.shift_id; if (c.leave) o.l = c.leave; return o; };
const sameCell = (a, b) => !!a && !!b && a.day_type === b.day_type && (a.shift_id || null) === (b.shift_id || null) && (a.leave || null) === (b.leave || null);
const MODE_FROM = '2026-11-01';

/** 這兩家店（示範用 TESTHQ、TESTCF）第一次用到時建好假資料 */
export function seedHq(db, code, hol) {
  db.sched = db.sched || {};
  if (db.sched[code]) return db.sched[code];
  const acc = db.accounts[code];
  const st = { shifts: {}, staff: [], terms: {}, tpl: {}, dayDemand: {}, pins: {}, pairs: [], days: {}, revenue: {}, periods: {}, pubs: {}, cfg: { ratio_target: null }, actuals: {},
    mode: acc.mode, modeFrom: MODE_FROM, selfMonths: {}, pending: {}, fixedVersion: 0, genLog: {} };
  if (acc.mode === 'self') {
    st.shifts.S1 = { id: 'S1', name: '早班', start: '09:00', end: '18:00', break_min: 60, color: '', sort: 1, active: 1 };
    st.shifts.S2 = { id: 'S2', name: '晚班', start: '10:00', end: '19:00', break_min: 60, color: '', sort: 2, active: 1 };
    [['H101', '許總部'], ['H102', '唐總監'], ['H103', '孫執行長'], ['H104', '全能主管']].forEach(([e, n], i) => st.staff.push({ emp_id: e, name: n, hire_date: null, leave_date: null, birthday: null, phone: null, sort: i, fixed_shift: null }));
  } else {
    st.shifts.S1 = { id: 'S1', name: '早班', start: '08:00', end: '17:00', break_min: 60, color: '', sort: 1, active: 1 };
    st.shifts.S2 = { id: 'S2', name: '中班', start: '10:00', end: '19:00', break_min: 60, color: '', sort: 2, active: 1 };
    [['C01', '葉廠長', 'S1'], ['C02', '周甲', 'S2'], ['C03', '吳乙', null]].forEach(([e, n, s], i) => st.staff.push({ emp_id: e, name: n, hire_date: null, leave_date: null, birthday: null, phone: null, sort: i, fixed_shift: s }));
    db.sched[code] = st;
    const cur = todayTaipei().slice(0, 7), last = nextMonth(cur) > MODE_FROM.slice(0, 7) ? nextMonth(cur) : MODE_FROM.slice(0, 7);
    for (let m = MODE_FROM.slice(0, 7); m <= last; m = nextMonth(m)) generate(st, m, hol);        // 開起來就已經有月曆（等於第一次切換＋每月自動產生）
  }
  db.sched[code] = st;
  return st;
}

function wantFixed(st, e, d, hol) {
  const w = weekday(d);
  if (w === 6) return { day_type: 'H', shift_id: null, leave: null };
  if (w === 0) return { day_type: 'R', shift_id: null, leave: null };
  if (holName(hol, d)) return { day_type: 'L', shift_id: null, leave: '國' };
  const sh = e.fixed_shift && st.shifts[e.fixed_shift];
  return sh && sh.active ? { day_type: 'W', shift_id: e.fixed_shift, leave: null } : null;
}
function generate(st, month, hol) {
  let generated = 0, kept = 0;
  for (const e of st.staff) {
    st.days[e.emp_id] = st.days[e.emp_id] || {};
    for (const d of monthDates(month)) {
      if ((st.modeFrom && d < st.modeFrom) || !employed(e, d)) continue;
      const ex = st.days[e.emp_id][d];
      if (ex && (ex.source === 'manual' || (ex.day_type === 'L' && ex.leave !== '國'))) { kept++; continue; }
      const want = wantFixed(st, e, d, hol);
      if (!want) { if (ex) { delete st.days[e.emp_id][d]; generated++; } continue; }
      if (ex && sameCell(ex, want)) { kept++; continue; }
      st.days[e.emp_id][d] = Object.assign(want, { source: 'auto' });
      generated++;
    }
  }
  return { generated, kept };
}

const periodsOfMonth = (m) => { const s = new Set(); for (const d of monthDates(m)) { const p = periodOf(d); if (p && parseLabel(p) >= 1) s.add(p); } return [...s].sort(); };
// 發布：每個重疊的 T 期入列一筆（self 只放已核准月份的格子）
function publish(st, month) {
  for (const p of periodsOfMonth(month)) {
    const dates = periodDates(p);
    const rows = st.staff.map((e) => ({ emp_id: e.emp_id, name: e.name, cells: dates.map((d) => {
      const c = (st.days[e.emp_id] || {})[d];
      if (!c) return { t: '' };
      if (st.mode === 'self') { const r = (st.selfMonths[e.emp_id] || {})[d.slice(0, 7)]; if (!(r && r.status === 'approved' && d >= st.modeFrom)) return { t: '' }; }
      return toCell(c);
    }) })).filter((r) => st.mode !== 'self' || r.cells.some((c) => c.t));
    const list = st.pubs[p] = st.pubs[p] || [];
    list.push({ seq: list.length + 1, kind: 'publish', status: 'sent', attempts: 1, created_at: new Date().toISOString(), payload: { period: p, rows } });
  }
}

const mrow = (st, e, m) => ((st.selfMonths[e] = st.selfMonths[e] || {})[m]) || { status: 'draft', version: 0, submitted_at: null, decided_at: null, decided_by: null, reject_reason: null };
function putMonth(st, e, m, patch) {
  const r = mrow(st, e, m);
  const n = Object.assign({}, r, patch, { version: r.version + 1 });
  st.selfMonths[e][m] = n;
  return n;
}
const holDefault = () => ({ day_type: 'L', shift_id: null, leave: '國' });
const holDates = (m, hol) => monthDates(m).filter((d) => holName(hol, d) && weekday(d) >= 1 && weekday(d) <= 5);      // 國定假日＋補假（days＋gov.off）

function effective(st, e, month, hol) {
  const r = mrow(st, e, month);
  const days = {};
  const mine = st.days[e] || {};
  for (const d of monthDates(month)) if (mine[d]) days[d] = mine[d];
  if (r.status === 'approved') { const p = (st.pending[e] || {}); for (const d of monthDates(month)) if (p[d]) days[d] = p[d]; }
  else for (const d of holDates(month, hol)) if (!days[d]) days[d] = holDefault();
  for (const [m, from, to] of [[prevMonth(month), addDays(month + '-01', -7), addDays(month + '-01', -1)], [nextMonth(month), addDays(monthDates(month).slice(-1)[0], 1), addDays(monthDates(month).slice(-1)[0], 7)]]) {
    const rr = mrow(st, e, m);
    if (rr.status === 'approved' || rr.status === 'submitted') for (let d = from; d <= to; d = addDays(d, 1)) { if (mine[d]) days[d] = mine[d]; if (rr.status === 'approved' && (st.pending[e] || {})[d]) days[d] = st.pending[e][d]; }      // 相鄰月份核准後又改、還在等核准的變更也算
  }
  return days;
}
function results(st, emps, month, hol) {
  const staff = st.staff.filter((s) => emps.includes(s.emp_id));
  const days = {};
  for (const s of staff) days[s.emp_id] = effective(st, s.emp_id, month, hol);
  return checkSelfMonth({ month, staff, shifts: st.shifts, days, holidays: hol, from: st.modeFrom || undefined });
}

export function hqAction(action, me, b, db, hol, pa) {
  const st = seedHq(db, me.code, hol);
  const person = me.person;
  if (!person) return fail('FORBIDDEN', '排班請用管理系統個人帳號：人資部門 → 排班管理');
  const today = todayTaipei();
  const monthArg = () => (typeof b.month === 'string' && MONTH_RE.test(b.month) ? b.month : null);
  const month = monthArg();
  if (!month && action !== 'fixedShift') return fail('BAD_INPUT', '月份格式不對（要是 YYYY-MM）');      // fixedShift 不分月
  const shiftList = () => Object.values(st.shifts).filter((s) => s.active).map((s) => ({ id: s.id, name: s.name, start: s.start, end: s.end, break_min: s.break_min }));
  const mine = pa.selfIds || [];
  if (st.mode === 'self') for (const e of mine) if (!st.staff.some((x) => x.emp_id === e)) st.staff.push({ emp_id: e, name: person.name, hire_date: null, leave_date: null, birthday: null, phone: null, sort: st.staff.length, fixed_shift: null });      // 同 server ensureStaff：本人的員編沒有列就建
  const canApproveEmp = (e) => (pa.approveAll || (pa.approveIds || []).includes(e)) && !mine.includes(e);
  const isAuto = (e) => (pa.selfAuto || []).includes(e);

  if (action.startsWith('fixed')) {
    if (st.mode !== 'fixed') return fail('BAD_INPUT', '這家店不是央廚固定排班');
    const edit = () => (pa.scheduleAdmin ? null : fail('FORBIDDEN', '只有廠長（本店店長同等職）、人資主管或管理員可以改央廚班表'));
    // 每月補產（同伺服器 tick）：從 mode_from 所在月到下個月，沒產生過的月份補（下個月要 20 號起）
    if (st.modeFrom) {
      const cur = today.slice(0, 7), nm = nextMonth(cur);
      for (let m = st.modeFrom.slice(0, 7); m <= nm; m = nextMonth(m)) { if (m === nm && Number(today.slice(8, 10)) < 20) continue; if (!st.genLog[m]) { generate(st, m, hol); st.genLog[m] = 1; } }
    }
    const fixedResults = () => checkSelfMonth({ month, staff: st.staff, shifts: st.shifts, days: Object.fromEntries(st.staff.map((s) => [s.emp_id, st.days[s.emp_id] || {}])), holidays: hol, soft: true });
    if (action === 'fixedLoad') {
      const dates = monthDates(month);
      const cells = {};
      for (const s of st.staff) { cells[s.emp_id] = {}; for (const d of dates) { const c = (st.days[s.emp_id] || {})[d]; if (c) cells[s.emp_id][d] = Object.assign(toCell(c), { src: c.source }); } }
      const res = fixedResults();
      for (const s of st.staff) if (!s.fixed_shift) res.push({ level: 'warn', code: 'X1', emp_id: s.emp_id, date: null, msg: `${s.name} 還沒設固定班別，平日不會自動排班` });
      return ok({ month, mode: 'fixed', canEdit: !!pa.scheduleAdmin, version: st.fixedVersion, mode_from: st.modeFrom, shifts: shiftList(),
        holidays: Object.fromEntries(Object.entries(Object.assign({}, (hol.gov && hol.gov.off) || {}, hol.days)).filter(([k]) => k.slice(0, 7) === month)),
        staff: st.staff.map((s) => ({ emp_id: s.emp_id, name: s.name, fixed_shift: s.fixed_shift || null })), cells, results: res });
    }
    const e0 = edit(); if (e0) return e0;
    if (action === 'fixedSave') {
      if (Number(b.version) !== st.fixedVersion) return fail('CONFLICT', '別人剛改過央廚班表，請重新整理後再改');
      let n = 0; const touched = [];
      for (const emp of Object.keys(b.cells || {})) {
        if (!st.staff.some((s) => s.emp_id === emp)) return fail('BAD_INPUT', '找不到這位同仁');
        for (const d of Object.keys(b.cells[emp] || {})) {
          if (d.slice(0, 7) !== month) return fail('BAD_INPUT', '格子的日期不在這個月');
          if (d < st.modeFrom) return fail('BAD_INPUT', `${st.modeFrom} 以前的日子不在固定排班`);
          const sf = st.staff.find((x) => x.emp_id === emp);
          if (!employed(sf, d)) return fail('BAD_INPUT', `${sf.name} ${d.slice(5)} 不在職，不能排班`);
          const c = b.cells[emp][d];
          if (c && c.t === '') { delete (st.days[emp] || {})[d]; touched.push(d); n++; continue; }
          const cell = { day_type: c.t, shift_id: c.s || null, leave: c.l || null };
          const err = comboError(cell, hol, d); if (err) return fail('BAD_INPUT', err);
          (st.days[emp] = st.days[emp] || {})[d] = Object.assign(cell, { source: 'manual' }); touched.push(d); n++;
        }
      }
      if (!n) return fail('BAD_INPUT', '沒有要存的格子');
      st.fixedVersion++;
      publish(st, month);
      return ok({ version: st.fixedVersion, results: fixedResults() });
    }
    if (action === 'fixedGenerate') {
      const r = generate(st, month, hol);
      if (r.generated > 0) { st.fixedVersion++; publish(st, month); }
      return ok({ generated: r.generated, kept: r.kept });
    }
    if (action === 'fixedShift') {
      const emp = st.staff.find((s) => s.emp_id === b.emp_id);
      if (!emp) return fail('BAD_INPUT', '找不到這位同仁');
      const sid = b.shift_id == null || b.shift_id === '' ? null : String(b.shift_id);
      if (sid !== null && !(st.shifts[sid] && st.shifts[sid].active)) return fail('BAD_INPUT', '班別不存在或已停用');
      emp.fixed_shift = sid;
      // 同伺服器：自動重產他從 max(mode_from, 明天) 到已產生最後一天、不是 manual 的平日格子（請假 L 不動），有變動就送 LINE
      const from = st.modeFrom > addDays(today, 1) ? st.modeFrom : addDays(today, 1);
      const last = st.staff.flatMap((x) => Object.keys(st.days[x.emp_id] || {})).sort().pop();
      let generated = 0;
      if (last && last >= from) {
        const mine2 = st.days[emp.emp_id] = st.days[emp.emp_id] || {};
        for (let d = from; d <= last; d = addDays(d, 1)) {
          if (weekday(d) < 1 || weekday(d) > 5 || !employed(emp, d)) continue;
          const ex = mine2[d];
          if (ex && (ex.source === 'manual' || (ex.day_type === 'L' && ex.leave !== '國'))) continue;
          const want = wantFixed(st, emp, d, hol);
          if (!want) { if (ex) { delete mine2[d]; generated++; } continue; }
          if (ex && sameCell(ex, want)) continue;
          mine2[d] = Object.assign(want, { source: 'auto' }); generated++;
        }
      }
      if (generated > 0) { st.fixedVersion++; for (let m = from.slice(0, 7); m <= last.slice(0, 7); m = nextMonth(m)) publish(st, m); }
      return ok({ ok: true, generated });
    }
    return fail('NOT_FOUND', '找不到這個功能');
  }

  // ---- self ----
  if (st.mode !== 'self') return fail('BAD_INPUT', '這家店不是總部自填排班');
  const canApprove = !!(pa.approveAll || (pa.approveIds || []).length);
  const window_ = () => {
    const cur = today.slice(0, 7), lo = st.modeFrom.slice(0, 7);
    if (month < (cur > lo ? cur : lo)) return fail('BAD_INPUT', '這個月份已經過了，不能修改');
    if (month > nextMonth(cur)) return fail('BAD_INPUT', '只能填到下個月');
    if (month === nextMonth(cur) && Number(today.slice(8, 10)) < 20) return fail('BAD_INPUT', '下個月的班表 20 號起才能填');
    return null;
  };
  if (action === 'selfLoad') {
    if (!mine.length && !canApprove) return fail('FORBIDDEN', '你沒有這家店的排班權限');
    const ids = new Set(mine);
    if (pa.approveAll) st.staff.forEach((s) => ids.add(s.emp_id)); else (pa.approveIds || []).forEach((e) => ids.add(e));
    const rows = st.staff.filter((s) => ids.has(s.emp_id)).sort((a, c) => (mine.includes(c.emp_id) ? 1 : 0) - (mine.includes(a.emp_id) ? 1 : 0));
    const dates = monthDates(month), staff = [], cells = {};
    for (const s of rows) {
      const r = mrow(st, s.emp_id, month), pend = st.pending[s.emp_id] || {};
      const pd = dates.filter((d) => pend[d]);
      staff.push({ emp_id: s.emp_id, name: s.name, status: r.status, version: r.version, submitted_at: r.submitted_at, decided_at: r.decided_at, decided_by: r.decided_by, reject_reason: r.reject_reason, pendingDays: pd.length });
      const base = Object.assign({}, st.days[s.emp_id] || {});
      if (r.status !== 'approved') for (const d of holDates(month, hol)) if (!base[d]) base[d] = holDefault();
      const out = {};
      for (const d of dates) { const c = base[d]; if (!c && !pend[d]) continue; const o = c ? toCell(c) : { t: '' }; if (pend[d]) o.pending = toCell(pend[d]); out[d] = o; }
      cells[s.emp_id] = out;
    }
    return ok({ month, mode: 'self', me: mine, canApprove, shifts: shiftList(), holidays: Object.fromEntries(Object.entries(Object.assign({}, (hol.gov && hol.gov.off) || {}, hol.days)).filter(([k]) => k.slice(0, 7) === month)),
      staff, cells, results: results(st, rows.map((s) => s.emp_id), month, hol), mode_from: st.modeFrom });
  }
  const own = () => (typeof b.emp_id === 'string' && mine.includes(b.emp_id) ? null : fail('FORBIDDEN', '只能改自己的班表'));
  const prefill = (e) => { st.days[e] = st.days[e] || {}; for (const d of holDates(month, hol)) if (!st.days[e][d] && d >= st.modeFrom) st.days[e][d] = Object.assign(holDefault(), { source: 'self' }); };
  if (action === 'selfSave') {
    const f = own(); if (f) return f;
    const w = window_(); if (w) return w;
    const e = b.emp_id, row = mrow(st, e, month);
    if (row.version !== Number(b.version)) return fail('CONFLICT', '別人剛改過這個月的班表，請重新整理後再改');
    if (row.status === 'submitted') return fail('CONFLICT', '已送出，要先撤回才能修改');
    const items = [];
    for (const d of Object.keys(b.cells || {})) {
      if (d.slice(0, 7) !== month) return fail('BAD_INPUT', '格子的日期不在這個月');
      if (d < st.modeFrom) return fail('BAD_INPUT', `${st.modeFrom} 以前的日子不在這套排班`);
      const c = b.cells[d];
      if (c && c.t === '') { items.push([d, null]); continue; }
      const cell = { day_type: c.t, shift_id: c.s || null, leave: c.l || null };
      const err = comboError(cell, hol, d); if (err) return fail('BAD_INPUT', err);
      if (cell.shift_id && !(st.shifts[cell.shift_id] && st.shifts[cell.shift_id].active)) return fail('BAD_INPUT', '班別不存在或已停用');
      items.push([d, cell]);
    }
    if (!items.length) return fail('BAD_INPUT', '沒有要存的格子');
    st.days[e] = st.days[e] || {};
    let pub = false;
    if (row.status === 'approved' && !isAuto(e)) {
      const pend = st.pending[e] = st.pending[e] || {};
      for (const [d, c] of items) {
        if (!c) return fail('BAD_INPUT', '核准後的班表不能清空，請選一種班別或假別');
        if (sameCell(st.days[e][d], c)) delete pend[d]; else pend[d] = c;
      }
    } else {
      if (row.status !== 'approved') prefill(e);
      for (const [d, c] of items) { if (!c) delete st.days[e][d]; else st.days[e][d] = Object.assign(c, { source: 'self' }); }
      if (row.status === 'approved') pub = true;
    }
    const n = putMonth(st, e, month, {});
    if (pub) publish(st, month);
    return ok({ version: n.version, results: results(st, [e], month, hol) });
  }
  if (action === 'selfSubmit') {
    const f = own(); if (f) return f;
    const w = window_(); if (w) return w;
    const e = b.emp_id, row = mrow(st, e, month);
    if (row.version !== Number(b.version)) return fail('CONFLICT', '別人剛改過這個月的班表，請重新整理後再改');
    if (row.status !== 'draft' && row.status !== 'rejected') return fail('CONFLICT', row.status === 'submitted' ? '已經送出了' : '這個月已經核准，修改請直接改格子');
    prefill(e);
    const blocks = results(st, [e], month, hol).filter((r) => r.level === 'block');
    if (blocks.length) return fail('BAD_INPUT', `還有 ${blocks.length} 個地方不合規定，不能送出：` + blocks.slice(0, 3).map((x) => x.msg).join('；'));
    const t = new Date().toISOString();
    if (isAuto(e)) { const n = putMonth(st, e, month, { status: 'approved', submitted_at: t, decided_at: t, decided_by: AUTO_BY, reject_reason: null }); publish(st, month); return ok({ status: 'approved', version: n.version }); }
    const n = putMonth(st, e, month, { status: 'submitted', submitted_at: t, reject_reason: null });
    return ok({ status: 'submitted', version: n.version });
  }
  if (action === 'selfWithdraw') {
    const f = own(); if (f) return f;
    const e = b.emp_id, row = mrow(st, e, month);
    if (row.version !== Number(b.version)) return fail('CONFLICT', '別人剛改過這個月的班表，請重新整理後再改');
    if (row.status !== 'submitted') return fail('CONFLICT', '只有已送出、還沒核准的班表可以撤回');
    const n = putMonth(st, e, month, { status: 'draft', submitted_at: null });
    return ok({ status: 'draft', version: n.version });
  }
  if (action === 'selfApprove' || action === 'selfReject') {
    const e = typeof b.emp_id === 'string' ? b.emp_id : '';
    if (!e || !canApproveEmp(e)) return fail('FORBIDDEN', mine.includes(e) ? '不能核准自己的班表' : '你不能核准這位同仁的班表');
    const row = mrow(st, e, month), pend = st.pending[e] || {};
    const pd = monthDates(month).filter((d) => pend[d]);
    if (row.version !== Number(b.version)) return fail('CONFLICT', '別人剛改過這個月的班表，請重新整理後再核准');
    if (action === 'selfApprove') {
      if (!(row.status === 'submitted' || (row.status === 'approved' && pd.length))) return fail('CONFLICT', '這份班表現在沒有等待核准的內容');
      st.days[e] = st.days[e] || {};
      for (const d of pd) { st.days[e][d] = Object.assign({}, pend[d], { source: 'self' }); delete pend[d]; }
      const n = putMonth(st, e, month, { status: 'approved', decided_at: new Date().toISOString(), decided_by: person.name, reject_reason: null });
      publish(st, month);
      return ok({ status: 'approved', version: n.version });
    }
    const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
    if (!reason || reason.length > 200) return fail('BAD_INPUT', '退回要寫原因（1–200 字）');
    if (row.status === 'submitted') { const n = putMonth(st, e, month, { status: 'rejected', decided_at: new Date().toISOString(), decided_by: person.name, reject_reason: reason }); return ok({ status: 'rejected', version: n.version }); }
    if (row.status === 'approved' && pd.length) { for (const d of pd) delete pend[d]; const n = putMonth(st, e, month, { decided_at: new Date().toISOString(), decided_by: person.name, reject_reason: reason }); return ok({ status: 'rejected', version: n.version }); }
    return fail('CONFLICT', '這份班表現在沒有等待核准的內容');
  }
  return fail('NOT_FOUND', '找不到這個功能');
}
