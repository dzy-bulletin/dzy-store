// 自動排班假後端（示範模式 ?mode=mock 與 e2e 用）。動作名稱、回傳形狀、版本與鎖定規則照 server/schedule.js；
// 檢查與自動排班直接用同一份 rules.js／auto.js。e2e 可用 window.__E2E_DATA.schedule = { pubFail: true } 模擬送 LINE 失敗。
import { checkPeriod, comboError, minutesOf } from '../modules/schedule/rules.js';
import { autoSchedule } from '../modules/schedule/auto.js';
import { periodDates, periodOf, todayTaipei, addDays, weekday, parseLabel, shiftPeriod } from '../modules/schedule/period.js';
import { shiftMinutes, breakOk } from '../modules/schedule/hours.js';

const E2E = () => (typeof window !== 'undefined' && window.__E2E_DATA) || {};
const ok = (data) => ({ ok: true, data: data === undefined ? {} : data });
const fail = (error, message) => ({ ok: false, error, message });
let HOL = null;
async function holidays() {
  if (!HOL) HOL = await fetch(new URL('../modules/schedule/holidays.json', import.meta.url)).then((r) => r.json());
  return HOL;
}

function seed(code) {
  const names = ['王小安', '陳大華', '林美玲', '張志明', '黃怡君', '李建宏', '吳佳穎', '劉家豪', '蔡雅婷', '鄭宇翔'];
  const st = { shifts: {}, staff: [], terms: {}, tpl: {}, dayDemand: {}, pins: {}, pairs: [], days: {}, revenue: {}, periods: {}, pubs: {}, cfg: { ratio_target: 1200 }, actuals: {} };
  st.shifts.S1 = { id: 'S1', name: '早班', start: '10:00', end: '19:00', break_min: 60, color: '#FFF4CC', sort: 1, active: 1 };
  st.shifts.S2 = { id: 'S2', name: '晚班', start: '14:00', end: '23:00', break_min: 60, color: '#FCE3D9', sort: 2, active: 1 };
  names.forEach((n, i) => {
    const e = 'E' + String(i + 1).padStart(3, '0');
    st.staff.push({ emp_id: e, name: n, hire_date: `202${3 + (i % 3)}-0${1 + (i % 9)}-15`, leave_date: null, birthday: `199${i % 10}-11-${String(3 + i * 2).padStart(2, '0')}`, phone: '09' + String(12345678 + i).padStart(8, '0'), sort: i });
    st.terms[e] = [{ from_date: '2026-10-04', kind: i < 6 ? 'ft' : 'pt', target_min: i < 6 ? 9600 : 64 * 60, week_min: i < 6 ? null : 16 * 60, same_days: 0, allowed_shifts: i === 5 ? ['S2'] : [] }];
  });
  for (const k of ['wd', 'sat', 'sun']) st.tpl[k] = { S1: { min: k === 'wd' ? 2 : 3, max: k === 'wd' ? 3 : 4 }, S2: { min: k === 'wd' ? 2 : 3, max: k === 'wd' ? 3 : 4 } };
  return st;
}
function storeOf(db, code) {
  db.sched = db.sched || {};
  if (!db.sched[code]) db.sched[code] = seed(code);
  return db.sched[code];
}
const prow = (st, p) => st.periods[p] || (st.periods[p] = { version: 0, locked: false, locked_at: null, locked_by: null, needs_recheck: false });
function demandFor(st, dates) {
  const out = {};
  for (const d of dates) { const w = weekday(d), k = w === 0 ? 'sun' : w === 6 ? 'sat' : 'wd'; out[d] = Object.assign({}, st.dayDemand[d] || st.tpl[k] || {}); }
  return out;
}
function ctxOf(st, period, hol) {
  const dates = periodDates(period);
  const pins = {};
  for (const e in st.pins) for (const d in st.pins[e]) if (dates.includes(d)) (pins[e] = pins[e] || {})[d] = st.pins[e][d];
  return { period, shifts: st.shifts, staff: st.staff, terms: st.terms, days: st.days, actuals: st.actuals, demand: demandFor(st, dates), pins, pairs: st.pairs, holidays: hol, monthOtMin: {} };
}

export async function schedule(action, me, b, db, s, hooks) {
  const hol = await holidays();
  const st = storeOf(db, me.code);
  const clockAlias = me.code === 'TEST2' ? null : '';
  const period = b.period || periodOf(todayTaipei()) || 'T00';
  if (b.period !== undefined) { try { const n = parseLabel(b.period); if (n < 0 || 'T' + String(n).padStart(2, '0') !== b.period) throw 0; } catch (e) { return fail('BAD_INPUT', '期別格式不對'); } }
  const guard = (wantLocked) => {
    const r = prow(st, period);
    if (b.version !== r.version) return fail('CONFLICT', '別人剛改過這一期的班表，請重新整理後再改');
    if (!!r.locked !== !!wantLocked) return fail('LOCKED', wantLocked ? '這一期還沒鎖定' : '這一期已經鎖定，要先解鎖才能修改');
    return null;
  };
  const bump = () => { prow(st, period).version++; return prow(st, period).version; };
  const needDuty = () => (!s.duty ? fail('FORBIDDEN', '請先輸入出勤核定通行碼') : s.dutyMust ? fail('DUTY_MUST_CHANGE', '請先把出勤核定通行碼改成自己的') : null);
  const recheckNext = () => {
    const nx = shiftPeriod(period, 1), r = st.periods[nx];
    if (!r || !r.locked) return;
    r.needs_recheck = checkPeriod(ctxOf(st, nx, hol)).some((x) => x.level === 'block' && ['C1', 'F6', 'P3'].includes(x.code));
  };
  const pubSet = (kind) => {
    const list = st.pubs[period] = st.pubs[period] || [];
    const failNow = !!(E2E().schedule || {}).pubFail;
    list.push({ seq: list.length + 1, kind, status: failNow ? 'failed' : 'sent', attempts: 1, last_error: failNow ? '連不上打卡系統' : null, created_at: new Date().toISOString(), sent_at: failNow ? null : new Date().toISOString() });
  };
  const dates = periodDates(period);

  switch (action) {
    case 'load': {
      const ctx = ctxOf(st, period, hol);
      const r = prow(st, period);
      const tpl = st.tpl, ov = {};
      for (const d of dates) if (st.dayDemand[d]) ov[d] = st.dayDemand[d];
      const days = {};
      for (const e in st.days) for (const d in st.days[e]) if (d >= addDays(dates[0], -13) && d <= dates[27]) (days[e] = days[e] || {})[d] = st.days[e][d];
      const months = [...new Set(dates.map((d) => d.slice(0, 7)))].map((ym) => {
        let minutes = 0;
        for (const x of st.staff) for (const d in (st.days[x.emp_id] || {})) {
          const c = st.days[x.emp_id][d];
          if (d.slice(0, 7) === ym && c.shift_id && st.shifts[c.shift_id] && (!x.hire_date || x.hire_date <= d) && (!x.leave_date || d <= x.leave_date)) minutes += shiftMinutes(st.shifts[c.shift_id]);
        }
        const revenue = st.revenue[ym] == null ? null : st.revenue[ym];
        return { ym, revenue, minutes, ratio: revenue != null && minutes > 0 ? Math.round(revenue / (minutes / 60)) : null };
      });
      const pubs = st.pubs[period] || [];
      return ok({ period, dates, today: todayTaipei(), store: me.code,
        meta: { version: r.version, locked: !!r.locked, locked_at: r.locked_at, locked_by: r.locked_by, needs_recheck: !!r.needs_recheck, publication: pubs.length ? pubs[pubs.length - 1] : null, clockAlias, lineFrom: '2026-11-01' },
        shifts: Object.values(st.shifts).sort((a, x) => a.sort - x.sort), staff: st.staff, terms: st.terms, days, actuals: st.actuals, demand: ctx.demand, demandTpl: tpl, demandOverrides: ov,
        pins: ctx.pins, pairs: st.pairs, months, cfg: st.cfg, holidays: hol, monthOtMin: {}, results: checkPeriod(Object.assign(ctx, { days: st.days })), roster: { synced: clockAlias !== null } });
    }
    case 'saveDays': {
      const g = guard(false); if (g) return g;
      for (const c of b.cells || []) {
        if (!dates.includes(c.date) || !st.staff.some((x) => x.emp_id === c.emp_id)) return fail('BAD_INPUT', '格子的人或日期不在這一期');
        const pv = (st.days[c.emp_id] || {})[c.date];
        const otLocked = pv && pv.day_type === 'H' && pv.shift_id;
        if (c.clear) { if (otLocked) return fail('BAD_INPUT', '這天是休息日加班，不能清空；不需要上班請改回休息日'); if (st.days[c.emp_id]) delete st.days[c.emp_id][c.date]; continue; }
        const cell = { day_type: c.day_type, shift_id: c.shift_id || null, leave: c.leave || null };
        const err = comboError(cell, hol, c.date); if (err) return fail('BAD_INPUT', err);
        if (otLocked && cell.day_type === 'W') return fail('BAD_INPUT', '這天是休息日加班（要付加班費），不能改成一般工作日；不需要上班可以改回休息日');
        (st.days[c.emp_id] = st.days[c.emp_id] || {})[c.date] = Object.assign(cell, { source: 'manual' });
      }
      const v = bump(); recheckNext(); return ok({ version: v });
    }
    case 'auto': {
      const g = guard(false); if (g) return g;
      const res = autoSchedule(ctxOf(st, period, hol), { keepManual: b.keepManual !== false });
      if (!res.ok) return ok({ ok: false, problems: res.problems, version: prow(st, period).version });
      for (const x of st.staff) { st.days[x.emp_id] = st.days[x.emp_id] || {}; for (const d of dates) { if (res.days[x.emp_id] && res.days[x.emp_id][d]) st.days[x.emp_id][d] = res.days[x.emp_id][d]; else delete st.days[x.emp_id][d]; } }
      const v = bump(); recheckNext(); return ok({ ok: true, problems: res.problems, version: v });
    }
    case 'saveRevenue': {
      for (const ym of Object.keys(b.values || {})) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return fail('BAD_INPUT', '月份格式不對');
        const v = b.values[ym];
        if (v == null || v === '') delete st.revenue[ym]; else if (!(Number(v) >= 0)) return fail('BAD_INPUT', '營業額要是 0 以上的整數'); else st.revenue[ym] = Math.round(Number(v));
      }
      return ok();
    }
    case 'savePins': {
      const g = guard(false); if (g) return g;
      for (const p of b.pins || []) {
        st.pins[p.emp_id] = st.pins[p.emp_id] || {};
        if (!p.kind) delete st.pins[p.emp_id][p.date]; else st.pins[p.emp_id][p.date] = { kind: p.kind, shift_id: p.kind === 'shift' ? p.shift_id : null };
      }
      return ok({ version: bump() });
    }
    case 'saveDemandDay': {
      const g = guard(false); if (g) return g;
      if (!Array.isArray(b.rows)) delete st.dayDemand[b.date];
      else { const m = {}; for (const r of b.rows) { if (r.max != null && r.max < r.min) return fail('BAD_INPUT', '最多人數不能小於最少人數'); m[r.shift_id] = { min: r.min || 0, max: r.max }; } st.dayDemand[b.date] = m; }
      return ok({ version: bump() });
    }
    case 'saveDemandTpl': {
      const t = { wd: {}, sat: {}, sun: {} };
      for (const r of b.rows || []) { if (r.max != null && r.max < r.min) return fail('BAD_INPUT', '最多人數不能小於最少人數'); t[r.kind][r.shift_id] = { min: r.min || 0, max: r.max }; }
      st.tpl = t; return ok();
    }
    case 'saveShift': {
      const x = b.shift || {};
      if (!x.name || !String(x.name).trim()) return fail('BAD_INPUT', '班別名稱不能空白');
      if (!/^\d{2}:\d{2}$/.test(x.start || '') || !/^\d{2}:\d{2}$/.test(x.end || '')) return fail('BAD_INPUT', '上下班時間格式要是 HH:MM');
      const sh = { start: x.start, end: x.end, break_min: Number(x.break_min) || 0 };
      if (!breakOk(sh)) return fail('BAD_INPUT', '一個班超過 6 小時，休息至少要 30 分鐘（勞基法 §35）');
      if (shiftMinutes(sh) > 720) return fail('BAD_INPUT', '一班不能超過 12 小時');
      let id = x.id; if (!id) { let i = Object.keys(st.shifts).length + 1; while (st.shifts['S' + i]) i++; id = 'S' + i; }
      st.shifts[id] = Object.assign({ id, name: String(x.name).trim(), color: x.color || '', sort: Number(x.sort) || 0, active: x.active === false ? 0 : 1 }, sh);
      return ok({ id });
    }
    case 'saveStaff': {
      const x = b.staff || {};
      let e = x.emp_id;
      if (!e) { if (!x.name || !String(x.name).trim()) return fail('BAD_INPUT', '姓名不能空白'); e = 'local-' + String(st.staff.filter((y) => y.emp_id.startsWith('local-')).length + 1).padStart(6, '0'); st.staff.push({ emp_id: e, name: String(x.name).trim(), hire_date: null, leave_date: null, birthday: null, phone: null, sort: st.staff.length }); }
      const row = st.staff.find((y) => y.emp_id === e); if (!row) return fail('BAD_INPUT', '找不到這位同仁');
      if (x.phone && !/^[0-9+\-\s]{6,20}$/.test(x.phone)) return fail('BAD_INPUT', '手機格式不對');
      if (x.hire_date && x.leave_date && x.leave_date < x.hire_date) return fail('BAD_INPUT', '離職日期不能早於報到日期');
      Object.assign(row, { hire_date: x.hire_date || null, leave_date: x.leave_date || null, birthday: x.birthday || null, phone: x.phone || null });
      return ok({ emp_id: e });
    }
    case 'addHire': {   // 照 server/schedule.js addHire：先檢查欄位與同名 → 有打卡的店代建打卡帳號（假出勤核定名冊）→ 寫排班資料
      const h = b.hire || {};
      const name = String(h.name || '').trim();
      if (!name) return fail('BAD_INPUT', '姓名不能空白');
      if (name.length > 20) return fail('BAD_INPUT', '姓名太長');
      if (!h.hire_date) return fail('BAD_INPUT', '請填報到日期（報到日前不會排班）');
      if (!['ft', 'pt'].includes(h.kind)) return fail('BAD_INPUT', '請選正職或計時');
      if (h.phone && !/^[0-9+\-\s]{6,20}$/.test(h.phone)) return fail('BAD_INPUT', '手機格式不對');
      const today = todayTaipei();
      const dup = st.staff.find((x) => x.name === name && (!x.leave_date || x.leave_date >= today));
      if (dup) return fail('BAD_INPUT', `同仁清單已經有在職的「${name}」（編號 ${dup.emp_id}）。同名會讓薪資與班表對錯人，真的是不同人請改用可區分的名字（例如加姓氏或括號）。`);
      let e, key = null;
      if (clockAlias !== null) {
        const r = hooks && hooks.addEmployee ? hooks.addEmployee(name) : fail('UPSTREAM', '打卡系統暫時沒有回應，請稍後再試');
        if (!r.ok) return r;
        e = r.data.emp_id; key = r.data.key;
      } else e = 'local-' + String(st.staff.filter((y) => y.emp_id.startsWith('local-')).length + 1).padStart(6, '0');
      st.staff.push({ emp_id: e, name, hire_date: h.hire_date, leave_date: null, birthday: h.birthday || null, phone: h.phone || null, sort: st.staff.length });
      st.terms[e] = [{ from_date: '2026-10-04', kind: h.kind, target_min: h.target_min == null && h.kind === 'ft' ? 9600 : h.target_min, week_min: h.week_min == null ? null : h.week_min, same_days: h.same_days ? 1 : 0, allowed_shifts: (h.allowed_shifts || []).filter((x) => st.shifts[x]) }];
      return ok({ emp_id: e, name, clock: clockAlias !== null, clockStore: clockAlias, key });
    }
    case 'saveTerm': {
      const t = b.term || {};
      if (!['ft', 'pt'].includes(t.kind)) return fail('BAD_INPUT', '請選正職或計時');
      const from = t.from_date || '2026-10-04';
      const list = (st.terms[t.emp_id] || []).filter((x) => x.from_date !== from);
      list.push({ from_date: from, kind: t.kind, target_min: t.target_min == null && t.kind === 'ft' ? 9600 : t.target_min, week_min: t.week_min, same_days: t.same_days ? 1 : 0, allowed_shifts: t.allowed_shifts || [] });
      st.terms[t.emp_id] = list.sort((a, x) => (a.from_date < x.from_date ? -1 : 1));
      return ok();
    }
    case 'savePairs': {
      for (const p of b.pairs || []) if (p[0] === p[1]) return fail('BAD_INPUT', '不同班的兩個人要選不同的同仁');
      st.pairs = (b.pairs || []).map((p) => (p[0] < p[1] ? p : [p[1], p[0]])); return ok();
    }
    case 'saveCfg': st.cfg = { ratio_target: b.ratio_target == null ? null : Number(b.ratio_target) }; return ok();
    case 'lock': {
      const n = needDuty(); if (n) return n;
      const g = guard(false); if (g) return g;
      const blocks = checkPeriod(ctxOf(st, period, hol)).filter((r) => r.level === 'block');
      if (blocks.length) return fail('BAD_INPUT', `還有 ${blocks.length} 個地方不合規定，不能鎖定：` + blocks.slice(0, 3).map((x) => x.msg).join('；'));
      Object.assign(prow(st, period), { locked: true, locked_at: new Date().toISOString(), locked_by: me.code, needs_recheck: false });
      const publish = clockAlias !== null && parseLabel(period) >= 1;
      if (publish) pubSet('publish');
      return ok({ version: bump(), publish });
    }
    case 'unlock': {
      const n = needDuty(); if (n) return n;
      const g = guard(true); if (g) return g;
      Object.assign(prow(st, period), { locked: false, locked_at: null, locked_by: null });
      const withdraw = clockAlias !== null && (st.pubs[period] || []).some((x) => x.kind === 'publish');
      if (withdraw) pubSet('unpublish');
      return ok({ version: bump(), withdraw });
    }
    case 'resend': {
      const n = needDuty(); if (n) return n;
      const list = st.pubs[period] || []; const last = list[list.length - 1];
      if (last && last.status !== 'sent') { Object.assign(last, { status: 'sent', last_error: null, attempts: last.attempts + 1, sent_at: new Date().toISOString() }); if (E2E().schedule) E2E().schedule.pubFail = false; }
      return ok({ publication: last || null });
    }
    case 'importActuals': {
      if (clockAlias === null) return fail('FORBIDDEN', '這家店沒有打卡系統，不能帶入實際出勤');
      st.actuals = { E001: { '2026-10-31': { start: '17:00', end: '23:30' } } };
      return ok({ from: '2026-10-19', to: '2026-10-31', rows: 1 });
    }
    case 'dayPlan': {
      const out = {};
      for (const x of st.staff) { const c = (st.days[x.emp_id] || {})[b.date]; if (!c) continue; const sh = c.shift_id ? st.shifts[c.shift_id] : null; out[x.emp_id] = { name: x.name, day_type: c.day_type, leave: c.leave, shift_id: c.shift_id, shift_name: sh ? sh.name : null, start: sh ? sh.start : null, end: sh ? sh.end : null }; }
      return ok({ date: b.date, plan: out });
    }
    default: return fail('NOT_FOUND', '找不到這個功能');
  }
}
export { minutesOf };
