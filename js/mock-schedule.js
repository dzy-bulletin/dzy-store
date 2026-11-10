// 自動排班假後端（示範模式 ?mode=mock 與 e2e 用）。動作名稱、回傳形狀、版本與鎖定規則照 server/schedule.js；
// 檢查與自動排班直接用同一份 rules.js／auto.js。e2e 可用 window.__E2E_DATA.schedule = { pubFail: true } 模擬送 LINE 失敗。
import { checkPeriod, comboError, orderTwo, minutesOf, NOTE_COLORS } from '../modules/schedule/rules.js';
import { autoSchedule } from '../modules/schedule/auto.js';
import { periodDates, periodOf, todayTaipei, addDays, weekday, parseLabel, shiftPeriod } from '../modules/schedule/period.js';
import { shiftMinutes, breakOk, normSegs, cellShift, cellShiftIds, isExtId } from '../modules/schedule/hours.js';
import { whileLeaving } from './leaving.js';
import { hqAction, seedHq, putDay, stationNeedFor, publishPeriod, hasActiveDay, mockSupport } from './mock-schedule-hq.js';

const E2E = () => (typeof window !== 'undefined' && window.__E2E_DATA) || {};
const ok = (data) => ({ ok: true, data: data === undefined ? {} : data });
const fail = (error, message) => ({ ok: false, error, message });
let HOL = null;
async function holidays() {
  if (!HOL) HOL = await whileLeaving(fetch(new URL('../modules/schedule/holidays.json', import.meta.url)).then((r) => r.json()));
  return HOL;
}

function seed(code) {
  const names = ['王小安', '陳大華', '林美玲', '張志明', '黃怡君', '李建宏', '吳佳穎', '劉家豪', '蔡雅婷', '鄭宇翔'];
  const st = { shifts: {}, staff: [], terms: {}, tpl: {}, dayDemand: {}, pins: {}, pairs: [], days: {}, revenue: {}, periods: {}, pubs: {}, cfg: { ratio_target: 1200 }, actuals: {},
    stations: {}, stNeedTpl: {}, stNeedDay: {}, log: [] };
  st.shifts.S1 = { id: 'S1', name: '早班', start: '10:00', end: '19:00', break_min: 60, color: '#FFF4CC', sort: 1, active: 1 };
  st.shifts.S2 = { id: 'S2', name: '晚班', start: '14:00', end: '23:00', break_min: 60, color: '#FCE3D9', sort: 2, active: 1 };
  names.forEach((n, i) => {
    const e = 'E' + String(i + 1).padStart(3, '0');
    st.staff.push({ emp_id: e, name: n, hire_date: `202${3 + (i % 3)}-0${1 + (i % 9)}-15`, leave_date: null, birthday: `199${i % 10}-11-${String(3 + i * 2).padStart(2, '0')}`, phone: '09' + String(12345678 + i).padStart(8, '0'), sort: i });
    st.terms[e] = [{ from_date: '2026-10-04', kind: i < 6 ? 'ft' : 'pt', target_min: i < 6 ? 9600 : 64 * 60, week_min: i < 6 ? null : 16 * 60, same_days: 0, allowed_shifts: i === 5 ? ['S2'] : [] }];
  });
  // 工作站別（TEST2＝沒有 LINE 打卡的店不放，留一家「沒有站別」的店看畫面零變化）：4 個站，平日每站最少 1 人
  if (code !== 'TEST2') {
    [['W1', '炒鍋', '#E8590C'], ['W2', '外場', '#1C7ED6'], ['W3', '收銀', '#2F9E44'], ['W4', '備料', '#9C36B5']].forEach(([id, name, color], i) => { st.stations[id] = { id, name, color, sort: i + 1, active: 1 }; });
    st.stNeedTpl = { wd: { W1: 1, W2: 1, W3: 1, W4: 1 } };
  }
  for (const k of ['wd', 'sat', 'sun']) st.tpl[k] = { S1: { min: k === 'wd' ? 2 : 3, max: k === 'wd' ? 3 : 4 }, S2: { min: k === 'wd' ? 2 : 3, max: k === 'wd' ? 3 : 4 } };
  return st;
}
function storeOf(db, code) {
  db.sched = db.sched || {};
  if (!db.sched[code]) db.sched[code] = seed(code);
  return db.sched[code];
}
// ---- 門市互相支援排班（2026-11-09，同 server/sched-support.js、schedule.js）----
// 示範資料裡的門市＝db.accounts 的門市帳號；規則同伺服器：同品牌、啟用中、門市排班、有使用中班別、不含自己、不是 TEST 開頭
// （示範的帳號全是 TEST 開頭，e2e 用 accounts.X.supportOk=true 開例外，不然示範模式永遠看不到這個功能）
const shortOf = (a) => { const t = String((a && a.name) || '').trim().split(/\s+/); return t[t.length - 1] || (a && a.code) || ''; };
function mockExtStores(db, code) {
  const me = db.accounts[code], out = [];
  if (!me) return out;
  for (const a of Object.values(db.accounts)) {
    if (a.role !== 'store' || !a.active || a.hidden || a.mode || a.code === code || a.brand !== me.brand) continue;
    if (/^TEST/.test(a.code) && !a.supportOk) continue;
    const x = storeOf(db, a.code);
    if (!Object.values(x.shifts).some((y) => y.active)) continue;
    out.push(a.code);
  }
  return out;
}
/** 別家門市（含停用的班別）換成這家店看的代號：{ 'TEST2.S1': {…, id, name:'墨竹亭測試店 早班', store, local} } */
function mockExtShifts(db, code) {
  const out = {};
  for (const [oc, x] of Object.entries(db.sched || {})) {
    if (oc === code || !x || x.mode || !db.accounts[oc]) continue;
    for (const y of Object.values(x.shifts || {})) out[oc + '.' + y.id] = Object.assign({}, y, { id: oc + '.' + y.id, name: shortOf(db.accounts[oc]) + ' ' + y.name, store: oc, local: y.id });
  }
  return out;
}
/** 別家門市排來支援 code 這家店的班（同 server storeSupportOf）：[{key, kind:'store', from_store, from_name, origin_locked, name, emp, days}] */
function mockStoreSupport(db, code, dates, staff) {
  const pre = code + '.', out = [], per = periodOf(dates[0]);
  for (const [oc, x] of Object.entries(db.sched || {})) {
    if (oc === code || !x || x.mode || !db.accounts[oc]) continue;
    for (const s of x.staff) {
      const days = {};
      for (const d of dates) {
        const c = (x.days[s.emp_id] || {})[d];
        if (!c || (c.day_type !== 'W' && c.day_type !== 'H')) continue;
        const slots = [[c.shift_id, c.station_id], [c.shift2_id, c.station2_id]].filter(([id]) => id && id.startsWith(pre));
        if (!slots.length) continue;
        const o = { day_type: c.day_type, shift_id: slots[0][0].slice(pre.length), station_id: slots[0][1] || null };
        if (slots[1]) { o.shift2_id = slots[1][0].slice(pre.length); o.station2_id = slots[1][1] || null; }
        days[d] = o;
      }
      if (!Object.keys(days).length) continue;
      const same = (staff || []).filter((y) => y.name === s.name && !y.leave_date);
      out.push({ key: 'ST:' + oc + ':' + s.emp_id, kind: 'store', from_store: oc, from_name: shortOf(db.accounts[oc]), origin_locked: !!(per && (x.periods[per] || {}).locked), name: s.name, emp: same.length === 1 ? same[0].emp_id : null, days });
    }
  }
  return out;
}
// 身分設定從 fromDate 起生效：之後有已鎖定的期就不給改（照 server/schedule.js guardTermLocked）
function termLocked(st, fromDate, emp) {              // 影響範圍只到這人下一筆身分設定的前一天（照伺服器）
  const next = emp ? (st.terms[emp] || []).map((x) => x.from_date).filter((f) => f > fromDate).sort()[0] : null;
  const end = next ? addDays(next, -1) : '9999-12-31';
  const hit = Object.keys(st.periods).sort().find((p) => { const ds = periodDates(p); return st.periods[p].locked && ds[27] >= fromDate && ds[0] <= end; });
  return hit ? fail('LOCKED', `這個身分設定會影響已鎖定的 ${hit}，要先到「班表」解除鎖定才能改`) : null;
}
const prow = (st, p) => st.periods[p] || (st.periods[p] = { version: 0, locked: false, locked_at: null, locked_by: null, needs_recheck: false });
function demandFor(st, dates) {
  const out = {};
  for (const d of dates) { const w = weekday(d), k = w === 0 ? 'sun' : w === 6 ? 'sat' : 'wd'; out[d] = Object.assign({}, st.dayDemand[d] || st.tpl[k] || {}); }
  return out;
}
// 各站人數的 min：0–99 整數，空白＝0（同 server/schedule.js stationNeedRows）；不合回 null
const needMin = (v) => { if (v === null || v === undefined || v === '') return 0; const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null; };
function ctxOf(st, period, hol) {
  const dates = periodDates(period);
  const pins = {};
  for (const e in st.pins) for (const d in st.pins[e]) if (dates.includes(d)) (pins[e] = pins[e] || {})[d] = st.pins[e][d];
  return { period, shifts: st.shifts, staff: st.staff, terms: st.terms, days: st.days, actuals: st.actuals, demand: demandFor(st, dates), pins, pairs: st.pairs, holidays: hol, monthOtMin: {}, stations: st.stations, stationNeed: stationNeedFor(st, dates) };
}

export async function schedule(action, me, b, db, s, hooks) {
  const hol = await holidays();
  if (/^(self|fixed)[A-Z]/.test(action)) return hqAction(action, me, b, db, hol, (hooks && hooks.pa) || {}, () => { if (db.accounts.TEST1) storeOf(db, 'TEST1'); });      // 總部自填／央廚固定排班（docs/schedule-hq/spec.md）
  if (db.accounts[me.code] && db.accounts[me.code].mode) seedHq(db, me.code, hol);      // 這兩家店的班別、同仁用自己的假資料
  const st = storeOf(db, me.code);
  const clockAlias = me.code === 'TEST2' ? null : '';
  const period = b.period || periodOf(todayTaipei()) || 'T00';
  if (b.period !== undefined) { try { const n = parseLabel(b.period); if (n < 0 || 'T' + String(n).padStart(2, '0') !== b.period) throw 0; } catch (e) { return fail('BAD_INPUT', '期別格式不對'); } }
  const guard = (wantLocked) => {
    const r = prow(st, period);
    if (b.version !== r.version) return fail('CONFLICT', '別人剛改過這一期的班表，請重新整理後再改');
    if (wantLocked !== null && !!r.locked !== !!wantLocked) return fail('LOCKED', wantLocked ? '這一期還沒鎖定' : '這一期已經鎖定，要先解鎖才能修改');
    return null;
  };
  const bump = () => { prow(st, period).version++; return prow(st, period).version; };
  // 個人帳號看排班管理權（店長、人資主管、管理員、排班單位），不看出勤核定通行碼——同 server/schedule.js needDutyPass（2026-11-05 Fable 審查）
  const needDuty = () => (me.person ? (me.scheduleAdmin ? null : fail('FORBIDDEN', '只有店長、人資主管或管理員可以鎖定、解鎖或重送班表')) : !s.duty ? fail('FORBIDDEN', '請先輸入出勤核定通行碼') : s.dutyMust ? fail('DUTY_MUST_CHANGE', '請先把出勤核定通行碼改成自己的') : null);
  const recheckNext = () => {
    const nx = shiftPeriod(period, 1), r = st.periods[nx];
    if (!r || !r.locked) return;
    r.needs_recheck = checkPeriod(Object.assign(ctxOf(st, nx, hol), { shifts: Object.assign({}, st.shifts, mockExtShifts(db, me.code)) })).some((x) => x.level === 'block' && ['C1', 'F6', 'P3'].includes(x.code));
  };
  const pubSet = (kind, per) => {
    const list = st.pubs[per || period] = st.pubs[per || period] || [];
    const failNow = !!(E2E().schedule || {}).pubFail;
    list.push({ seq: list.length + 1, kind, status: failNow ? 'failed' : 'sent', attempts: 1, last_error: failNow ? '連不上打卡系統' : null, created_at: new Date().toISOString(), sent_at: failNow ? null : new Date().toISOString() });
  };
  const dates = periodDates(period);
  // 鎖定紀錄（照 server/schedule.js lockLog：個人登入記姓名、門市帳號記代號；新的在前）
  const lockLogAdd = (act, detail) => { st.lockLog = st.lockLog || []; st.lockLog.push({ id: st.lockLog.length + 1, period, at: new Date().toISOString(), who: (me.person && me.person.name) || me.code, action: act, detail }); };

  switch (action) {
    case 'lockLog': return ok({ log: (st.lockLog || []).slice().reverse() });
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
        // 別家門市排來支援這家店的班，算進這家店的工時比（門市互相支援排班；總部來源不算）
        const mFirst = ym + '-01', mLast = addDays(addDays(mFirst, 32).slice(0, 7) + '-01', -1), mDates = []; for (let d = mFirst; d <= mLast; d = addDays(d, 1)) mDates.push(d);
        if (!st.__hq) for (const x of mockStoreSupport(db, me.code, mDates, st.staff)) for (const c of Object.values(x.days)) { const sh = cellShift(st.shifts, c); if (sh) minutes += shiftMinutes(sh); }
        const revenue = st.revenue[ym] == null ? null : st.revenue[ym];
        return { ym, revenue, minutes, ratio: revenue != null && minutes > 0 ? Math.round(revenue / (minutes / 60)) : null };
      });
      const pubs = st.pubs[period] || [];
      const support = st.__hq ? [] : mockSupport(db, me.code, dates, st.staff).concat(mockStoreSupport(db, me.code, dates, st.staff));      // 總部支援＋門市支援（同 server buildCtx）
      const extEmp = new Map();
      for (const x of support) if (x.emp) { const prev = extEmp.get(x.emp); extEmp.set(x.emp, x.kind === 'store' && (prev === undefined || prev === 'store') ? 'store' : true); }
      const supStaff = extEmp.size ? st.staff.map((x) => (extEmp.has(x.emp_id) ? Object.assign({}, x, { ext: extEmp.get(x.emp_id) }) : x)) : st.staff;
      const extAll = mockExtShifts(db, me.code), extCodes = new Set(mockExtStores(db, me.code));      // 這家店能選的支援門市＋格子裡已經用到的
      for (const m of Object.values(days)) for (const c of Object.values(m)) for (const id of [c.shift_id, c.shift2_id]) if (isExtId(id)) extCodes.add(id.slice(0, id.indexOf('.')));
      const pickX = (y) => Object.assign({ id: y.id, name: y.name, start: y.start, end: y.end, break_min: y.break_min, color: y.color, active: y.active, store: y.store, local: y.local }, y.segs ? { segs: y.segs } : {});
      return ok({ period, dates, today: todayTaipei(), store: me.code,
        meta: { version: r.version, locked: !!r.locked, locked_at: r.locked_at, locked_by: r.locked_by, needs_recheck: !!r.needs_recheck, publication: pubs.length ? pubs[pubs.length - 1] : null, clockAlias, lineFrom: '2026-11-01' },
        shifts: Object.values(st.shifts).sort((a, x) => a.sort - x.sort), staff: supStaff, terms: st.terms, days, support, actuals: st.actuals, demand: ctx.demand, demandTpl: tpl, demandOverrides: ov,
        pins: ctx.pins, pairs: st.pairs, months, cfg: st.cfg, holidays: hol, monthOtMin: {}, results: checkPeriod(Object.assign(ctx, { days: st.days, support, staff: supStaff, shifts: Object.assign({}, st.shifts, extAll) })), roster: { synced: clockAlias !== null },
        extStores: st.__hq ? [] : [...extCodes].filter((c) => mockExtStores(db, me.code).includes(c)).map((c) => ({ code: c, name: shortOf(db.accounts[c]), shifts: Object.values(extAll).filter((y) => y.store === c && y.active).map(pickX), stations: Object.values(storeOf(db, c).stations).filter((y) => y.active).sort((a, x) => a.sort - x.sort) })),
        extShifts: Object.values(extAll).filter((y) => extCodes.has(y.store)).map(pickX), extStations: Object.fromEntries([...extCodes].map((c) => [c, storeOf(db, c).stations])),
        notes: Object.fromEntries(dates.filter((d) => (st.notes || {})[d]).map((d) => [d, st.notes[d]])),
        stations: Object.values(st.stations).sort((a, x) => a.sort - x.sort || (a.id < x.id ? -1 : 1)), stationNeedTpl: st.stNeedTpl, stationNeedDay: Object.fromEntries(dates.filter((d) => hasActiveDay(st, d)).map((d) => [d, st.stNeedDay[d]])), stationNeed: ctx.stationNeed });
    }
    case 'saveDays': {
      const g = guard(false); if (g) return g;
      const cells = b.cells || [];
      if (!cells.length) return fail('BAD_INPUT', '沒有要存的格子');
      if (cells.length > 2000) return fail('BAD_INPUT', '一次最多改 2000 格');
      // 門市互相支援排班（同 server/schedule.js saveDays）：支援別家門市的班由伺服器自己驗；別家門市排來支援的人，被排的日子這邊不能改（清空可以）
      const okStores = mockExtStores(db, me.code), extAll = mockExtShifts(db, me.code);
      const supported = new Set();
      if (!st.__hq) for (const x of mockStoreSupport(db, me.code, dates, st.staff)) if (x.emp) for (const d of Object.keys(x.days)) supported.add(x.emp + '|' + d);
      const extErr = (id, xs) => {
        const oc = id.slice(0, id.indexOf('.'));
        if (oc === me.code) return '不能選自己這家店的班當支援';
        if (!okStores.includes(oc) || !extAll[id]) return '這家門市不能支援：只能選同品牌、啟用中、有排班的別家門市';
        if (!extAll[id].active) return '支援的班別已停用，請改選別的班';
        if (xs) { const sx = storeOf(db, oc).stations[xs]; if (!(sx && sx.active)) return '支援門市的工作站不存在或已停用'; }
        return null;
      };
      for (const c of cells) {
        const sf = st.staff.find((x) => x.emp_id === c.emp_id);
        if (!dates.includes(c.date) || !sf) return fail('BAD_INPUT', '格子的人或日期不在這一期');
        const pv = (st.days[c.emp_id] || {})[c.date];
        const otLocked = pv && pv.day_type === 'H' && pv.shift_id;
        if (c.clear) { if (otLocked) return fail('BAD_INPUT', '這天是休息日加班，不能清空；不需要上班請改回休息日'); if (st.days[c.emp_id]) delete st.days[c.emp_id][c.date]; continue; }
        let cell = { day_type: c.day_type, shift_id: c.shift_id || null, leave: c.leave || null, shift2_id: c.shift2_id || null };
        if (supported.has(c.emp_id + '|' + c.date)) return fail('BAD_INPUT', `${sf.name} ${+c.date.slice(5, 7)}/${+c.date.slice(8, 10)} 已被別家門市排了支援這家店，這天在這裡不能改；要先清空才能收掉原本手動排的班`);
        if (isExtId(cell.shift_id) || isExtId(cell.shift2_id)) {
          const e1 = isExtId(cell.shift_id) ? extErr(cell.shift_id, c.xst || null) : null, e2 = isExtId(cell.shift2_id) ? extErr(cell.shift2_id, c.xst2 || null) : null;
          if (e1 || e2) return fail('BAD_INPUT', e1 || e2);
          cell.xst = isExtId(cell.shift_id) && c.xst !== undefined ? c.xst || null : undefined;
          cell.xst2 = isExtId(cell.shift2_id) && c.xst2 !== undefined ? c.xst2 || null : undefined;
        }
        const err = comboError(cell, hol, c.date); if (err) return fail('BAD_INPUT', err);
        const shiftsAll = Object.assign({}, st.shifts, extAll);
        if (cell.shift2_id) {                                     // 一天兩班（同 server/schedule.js saveDays）
          if (!shiftsAll[cell.shift2_id]) return fail('BAD_INPUT', '第二班的班別不存在');
          const o = orderTwo(shiftsAll, cell); if (o.err) return fail('BAD_INPUT', o.err); cell = o.cell;
        }
        if (otLocked && cell.day_type !== 'H') return fail('BAD_INPUT', '這天是休息日加班（要付加班費），只能改回休息日；不能改成工作日、例假或請假');   // 同 server/schedule.js saveDays
        if (cell.shift_id && !((!sf.hire_date || sf.hire_date <= c.date) && (!sf.leave_date || c.date <= sf.leave_date))) return fail('BAD_INPUT', `${+c.date.slice(5, 7)}/${+c.date.slice(8, 10)} 不在職，不能排班`);
        putDay(st, c.emp_id, c.date, cell, 'manual');
      }
      const allClear = cells.every((c) => c.clear);
      st.log.push({ period, who: me.code, action: 'save', detail: (b.reason === 'import' ? '匯入 Excel ' : allClear && b.reason === 'clearPeriod' ? '整期清空 ' : allClear ? '清空 ' : '') + cells.length + ' 格' });
      const v = bump(); recheckNext(); return ok({ version: v });
    }
    case 'auto': {
      const g = guard(false); if (g) return g;
      if (!Object.values(st.shifts).some((s) => s.active)) return fail('BAD_INPUT', '還沒建班別，請先到「班別與設定」建立班別');   // 同 server/schedule.js NO_SHIFT_MSG
      const actx = ctxOf(st, period, hol);
      actx.support = st.__hq ? [] : mockSupport(db, me.code, dates, st.staff).concat(mockStoreSupport(db, me.code, dates, st.staff));      // 總部＋門市支援：先扣人數、名冊裡對到的支援帳號不排（同 server auto）
      actx.shifts = Object.assign({}, st.shifts, mockExtShifts(db, me.code));      // 這家店的人支援別家門市的班：算工時、換班間隔，自動排班不會排它（auto.js 認得「.」）並整格保留
      const extEmp = new Set(actx.support.map((x) => x.emp).filter(Boolean));
      actx.staff = st.staff.filter((x) => !extEmp.has(x.emp_id));
      const res = autoSchedule(actx, { keepManual: b.keepManual !== false });
      if (!res.ok) return ok({ ok: false, problems: res.problems, version: prow(st, period).version });
      for (const x of actx.staff) { st.days[x.emp_id] = st.days[x.emp_id] || {}; for (const d of dates) { const c = (res.days[x.emp_id] || {})[d]; if (c) putDay(st, x.emp_id, d, c, c.source || 'auto'); else delete st.days[x.emp_id][d]; } }
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
    case 'saveNotes': {      // 每天的午餐／晚餐備註（同 server/schedule.js saveNotes：不帶 version、鎖定後也能改，改了重送 LINE）
      const keys = Object.keys(b.notes || {});
      if (!keys.length) return fail('BAD_INPUT', '沒有要存的備註');
      st.notes = st.notes || {};
      for (const d of keys) {
        if (!dates.includes(d)) return fail('BAD_INPUT', '備註的日期不在這一期');
        const n = b.notes[d] || {}, lunch = String(n.lunch || '').trim(), dinner = String(n.dinner || '').trim();
        if (lunch.length > 60) return fail('BAD_INPUT', '午餐備註太長');
        if (dinner.length > 60) return fail('BAD_INPUT', '晚餐備註太長');
        const old = st.notes[d] || {};
        const colorOf = (k) => { if (!(k in n)) return old[k] || ''; const v = n[k] == null ? '' : String(n[k]); return v; };
        const lc = lunch ? colorOf('lunch_color') : '', dc = dinner ? colorOf('dinner_color') : '';
        if ((lc && !NOTE_COLORS[lc]) || (dc && !NOTE_COLORS[dc])) return fail('BAD_INPUT', '備註顏色不對');
        if (!lunch && !dinner) delete st.notes[d]; else st.notes[d] = Object.assign({ lunch, dinner }, lc ? { lunch_color: lc } : {}, dc ? { dinner_color: dc } : {});
      }
      const resend = !!prow(st, period).locked && clockAlias !== null && period !== 'T00';
      if (resend) pubSet('publish');
      return ok({ resend });
    }
    case 'savePins': {
      const g = guard(false); if (g) return g;
      for (const p of b.pins || []) {
        if (p.kind && !['off', 'work', 'shift'].includes(p.kind)) return fail('BAD_INPUT', '指定只能是休假、上班或某個班');   // 同 server/schedule.js savePins
        if (p.kind === 'shift' && !st.shifts[p.shift_id]) return fail('BAD_INPUT', '指定的班別不存在');
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
      let sh = { start: x.start, end: x.end, break_min: Number(x.break_min) || 0 };
      if (Array.isArray(x.segs) && x.segs.length >= 2) { try { sh = normSegs(x.segs); } catch (e) { return fail('BAD_INPUT', e.message); } }   // 分段班（同 server/schedule.js saveShift）
      if (!breakOk(sh)) return fail('BAD_INPUT', sh.segs ? '有一段超過 6 小時，那一段休息至少要 30 分鐘（勞基法 §35）' : '一個班超過 6 小時，休息至少要 30 分鐘（勞基法 §35）');
      if (shiftMinutes(sh) > 600) return fail('BAD_INPUT', '一班不能超過 10 小時');   // 同伺服器（2026-11-01 由 12 改 10）
      let id = x.id; if (!id) { let i = Object.keys(st.shifts).length + 1; while (st.shifts['S' + i]) i++; id = 'S' + i; }
      st.shifts[id] = Object.assign({ id, name: String(x.name).trim(), color: x.color || '', sort: Number(x.sort) || 0, active: x.active === false ? 0 : 1 }, sh);
      return ok({ id });
    }
    case 'shiftUses':
    case 'deleteShift': {   // 照 server/schedule.js shiftUses／deleteShift：沒被用過才刪，用過就列出用在哪裡
      const id = String(b.id || '');
      if (!st.shifts[id]) return fail('BAD_INPUT', '找不到這個班別（可能別人剛刪掉了），請重新整理');
      const nm = (e) => (st.staff.find((x) => x.emp_id === e) || {}).name || e;
      const md = (d) => `${+d.slice(5, 7)}/${+d.slice(8, 10)}`;
      const list = (rows, n) => rows.slice(0, n).map(([d, e]) => [d ? md(d) : '', e ? nm(e) : ''].filter(Boolean).join(' ')).join('、') + (rows.length > n ? ' 等' : '');
      const cells = (src, hit) => Object.entries(src || {}).flatMap(([e, m]) => Object.entries(m || {}).filter(([, c]) => c && hit(c)).map(([d]) => [d, e])).sort((a, x) => (a[0] + a[1] < x[0] + x[1] ? -1 : 1));
      const uses = [];
      const days = cells(st.days, (c) => c.shift_id === id || c.shift2_id === id); if (days.length) uses.push(`班表 ${days.length} 格（${list(days, 2)}）`);
      const supCells = Object.entries(db.sched || {}).filter(([oc, x]) => oc !== me.code && x && !x.mode).flatMap(([oc, x]) => cells(x.days, (c) => c.shift_id === me.code + '.' + id || c.shift2_id === me.code + '.' + id).map(([d, e]) => [d, (x.staff.find((y) => y.emp_id === e) || {}).name || e]));
      if (supCells.length) uses.push(`別家門市排的支援 ${supCells.length} 格（${supCells.slice(0, 2).map(([d, n]) => [md(d), n].join(' ')).join('、')}${supCells.length > 2 ? ' 等' : ''}）`);
      const pend = cells(st.pending, (c) => c.shift_id === id); if (pend.length) uses.push(`待核准的班表變更 ${pend.length} 格（${list(pend, 2)}）`);
      const tpl = [['wd', '平日'], ['sat', '週六'], ['sun', '週日']].filter(([k]) => (st.tpl[k] || {})[id]).map(([, n]) => n); if (tpl.length) uses.push(`每班人數範本（${tpl.join('、')}）`);
      const dd = Object.keys(st.dayDemand).filter((d) => (st.dayDemand[d] || {})[id]).sort().map((d) => [d, null]); if (dd.length) uses.push(`單日人數 ${dd.length} 天（${list(dd, 3)}）`);
      const pins = cells(st.pins, (c) => c.kind === 'shift' && c.shift_id === id); if (pins.length) uses.push(`指定班別 ${pins.length} 格（${list(pins, 2)}）`);
      const allow = st.staff.filter((x) => (st.terms[x.emp_id] || []).some((t) => (t.allowed_shifts || []).includes(id) || (t.allowed_shifts_hol || []).includes(id))).map((x) => [null, x.emp_id]); if (allow.length) uses.push(`同仁「只能上的班」${allow.length} 人（${list(allow, 3)}）`);
      const pf = st.staff.filter((x) => x.pref_shift === id).map((x) => [null, x.emp_id]); if (pf.length) uses.push(`同仁「優先班別」${pf.length} 人（${list(pf, 3)}）`);
      const fx = st.staff.filter((x) => x.fixed_shift === id).map((x) => [null, x.emp_id]); if (fx.length) uses.push(`央廚固定班別 ${fx.length} 人（${list(fx, 3)}）`);
      if (action === 'shiftUses') return ok({ uses });
      if (uses.length) return fail('BAD_INPUT', `這個班別已經用在：${uses.join('；')}。用過的班別不能刪除（舊班表、LINE 班表與出勤核定都還要對照它），不用的話請取消「使用中」再按儲存。`);
      delete st.shifts[id];
      return ok({ id });
    }
    case 'saveStaff': {
      const x = b.staff || {};
      let e = x.emp_id;
      if (!e) { if (!x.name || !String(x.name).trim()) return fail('BAD_INPUT', '姓名不能空白'); e = 'local-' + String(st.staff.filter((y) => y.emp_id.startsWith('local-')).length + 1).padStart(6, '0'); st.staff.push({ emp_id: e, name: String(x.name).trim(), hire_date: null, leave_date: null, birthday: null, phone: null, sort: st.staff.length }); }
      const row = st.staff.find((y) => y.emp_id === e); if (!row) return fail('BAD_INPUT', '找不到這位同仁');
      let filled = 0;
      if (x.phone && !/^[0-9+\-\s]{6,20}$/.test(x.phone)) return fail('BAD_INPUT', '手機格式不對');
      if (x.hire_date && x.leave_date && x.leave_date < x.hire_date) return fail('BAD_INPUT', '離職日期不能早於報到日期');
      if (Object.prototype.hasOwnProperty.call(x, 'default_station')) {
        const ds = x.default_station || null;
        if (ds && ds !== row.default_station && !(st.stations[ds] && st.stations[ds].active)) return fail('BAD_INPUT', '預設站別不存在或已停用');
        // 照 server saveStaff：換了預設站別 → 今天起、未鎖定期別裡這人沒選站的上班日一起帶入（2026-10-31 Eason）
        if (ds && ds !== row.default_station) {
          const t = todayTaipei(), byP = {};
          for (const [d, c] of Object.entries(st.days[e] || {})) {
            const p = periodOf(d);
            if (d >= t && c.shift_id && !c.station_id && p && !prow(st, p).locked) { c.station_id = ds; (byP[p] = byP[p] || []).push(d); }
          }
          for (const [p, list] of Object.entries(byP)) { prow(st, p).version++; st.log.push({ period: p, who: me.code, action: 'station_default', detail: `${row.name} ${list.length} 個沒選站的上班日帶入 ${st.stations[ds].name}` }); }
          filled = Object.values(byP).reduce((a, x) => a + x.length, 0);
        }
        row.default_station = ds;
      }
      if (Object.prototype.hasOwnProperty.call(x, 'prio')) {
        const pr = x.prio === null || x.prio === '' ? null : typeof x.prio === 'number' || (typeof x.prio === 'string' && /^\d+$/.test(x.prio)) ? Number(x.prio) : NaN;
        if (pr !== null && !(Number.isInteger(pr) && pr >= 1 && pr <= 99)) return fail('BAD_INPUT', '排班順位要是 1～99 的整數（1 最優先），不設就留空白');
        row.prio = pr;
      }
      if (Object.prototype.hasOwnProperty.call(x, 'pref_shift')) {
        const ps = x.pref_shift || null;
        if (ps && ps !== row.pref_shift && !(st.shifts[ps] && st.shifts[ps].active)) return fail('BAD_INPUT', '優先班別不存在或已停用');
        row.pref_shift = ps;
      }
      Object.assign(row, { hire_date: x.hire_date || null, leave_date: x.leave_date || null, birthday: x.birthday || null, phone: x.phone || null });
      return ok({ emp_id: e, station_filled: filled });
    }
    case 'addHire': {   // 照 server/schedule.js addHire：先檢查欄位與同名 → 有打卡的店代建打卡帳號（假出勤核定名冊）→ 寫排班資料
      const h = b.hire || {};
      const name = String(h.name || '').trim();
      if (!name) return fail('BAD_INPUT', '姓名不能空白');
      if (name.length > 20) return fail('BAD_INPUT', '姓名太長');
      if (!h.hire_date) return fail('BAD_INPUT', '請填報到日期（報到日前不會排班）');
      if (!['ft', 'pt'].includes(h.kind)) return fail('BAD_INPUT', '請選正職或計時');
      if (h.backup && h.kind !== 'pt') return fail('BAD_INPUT', '備援只限計時同仁（正職每週要排滿基本天數）');
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
      st.terms[e] = [{ from_date: '2026-10-04', kind: h.kind, target_min: h.target_min == null && h.kind === 'ft' ? 9600 : h.target_min, week_min: h.week_min == null ? null : h.week_min, same_days: h.same_days ? 1 : 0, allowed_shifts: (h.allowed_shifts || []).filter((x) => st.shifts[x]),
        allowed_shifts_hol: (h.allowed_shifts_hol || []).filter((x) => st.shifts[x]), backup: h.backup ? 1 : 0 }];
      return ok({ emp_id: e, name, clock: clockAlias !== null, clockStore: clockAlias, key });
    }
    case 'saveTerm': {
      const t = b.term || {};
      if (!['ft', 'pt'].includes(t.kind)) return fail('BAD_INPUT', '請選正職或計時');
      if (t.backup && t.kind !== 'pt') return fail('BAD_INPUT', '備援只限計時同仁（正職每週要排滿基本天數）');
      const from = t.from_date || '2026-10-04';
      const nt = { kind: t.kind, target_min: t.target_min == null && t.kind === 'ft' ? 9600 : t.target_min, week_min: t.week_min == null ? null : t.week_min, same_days: t.same_days ? 1 : 0,
        allowed_shifts: (t.allowed_shifts || []).filter((x) => st.shifts[x]), allowed_shifts_hol: (t.allowed_shifts_hol || []).filter((x) => st.shifts[x]), backup: t.backup ? 1 : 0 };
      const old = (st.terms[t.emp_id] || []).find((x) => x.from_date === from);
      const norm = (x) => ({ kind: x.kind, target_min: x.target_min ?? null, week_min: x.week_min ?? null, same_days: x.same_days ? 1 : 0, backup: x.backup ? 1 : 0 });   // 舊資料／示範種子少欄位：先正規化再比（Codex 審查）
      if (old && ['kind', 'target_min', 'week_min', 'same_days', 'backup'].every((k) => norm(old)[k] === norm(nt)[k])
        && JSON.stringify(old.allowed_shifts || []) === JSON.stringify(nt.allowed_shifts) && JSON.stringify(old.allowed_shifts_hol || []) === JSON.stringify(nt.allowed_shifts_hol)) return ok();   // 內容沒變放行（照伺服器）
      const lk = termLocked(st, from, t.emp_id); if (lk) return lk;
      const list = (st.terms[t.emp_id] || []).filter((x) => x.from_date !== from);
      list.push({ from_date: from, kind: t.kind, target_min: t.target_min == null && t.kind === 'ft' ? 9600 : t.target_min, week_min: t.week_min, same_days: t.same_days ? 1 : 0, allowed_shifts: t.allowed_shifts || [],
        allowed_shifts_hol: (t.allowed_shifts_hol || []).filter((x) => st.shifts[x]), backup: t.backup ? 1 : 0 });
      st.terms[t.emp_id] = list.sort((a, x) => (a.from_date < x.from_date ? -1 : 1));
      return ok();
    }
    case 'deleteTerm': {   // 照伺服器：至少留一筆；會影響已鎖定的期就擋
      const list = st.terms[b.emp_id] || [];
      if (list.length <= 1) return fail('BAD_INPUT', '至少要留一筆身分設定');
      if (b.from_date === list.map((x) => x.from_date).sort()[0]) return fail('BAD_INPUT', '最早那一筆身分設定不能刪（刪了之後那段日子就沒有身分、排不了班）；要改內容請直接修改它');
      const lk = termLocked(st, String(b.from_date || ''), b.emp_id); if (lk) return lk;
      st.terms[b.emp_id] = list.filter((x) => x.from_date !== b.from_date);
      return ok();
    }
    case 'savePairs': {
      for (const p of b.pairs || []) if (p[0] === p[1]) return fail('BAD_INPUT', '不同班的兩個人要選不同的同仁');
      st.pairs = (b.pairs || []).map((p) => (p[0] < p[1] ? p : [p[1], p[0]])); return ok();
    }
    case 'saveCfg': st.cfg = { ratio_target: b.ratio_target == null ? null : Number(b.ratio_target) }; return ok();
    // ---- 工作站別（照 server/schedule.js）----
    case 'saveStation': {
      const x = b.station || b;
      const name = String(x.name || '').trim();
      if (!name) return fail('BAD_INPUT', '站別名稱不能空白');
      if (name.length > 10) return fail('BAD_INPUT', '站別名稱太長');
      const color = x.color || '';
      if (!/^(#[0-9A-Fa-f]{6})?$/.test(color)) return fail('BAD_INPUT', '顏色格式不對');
      if (x.id && !/^W[0-9A-Za-z]{1,8}$/.test(String(x.id))) return fail('BAD_INPUT', '站別代號格式不對');
      let sort = 0;
      if (x.sort !== null && x.sort !== undefined && x.sort !== '') { sort = Number(x.sort); if (!Number.isInteger(sort) || sort < 0 || sort > 999) return fail('BAD_INPUT', '排序要是 0 以上的整數'); }
      let active = 1;
      if (x.active !== undefined) {
        if (x.active === true || x.active === 1 || x.active === '1' || x.active === 'true') active = 1;
        else if (x.active === false || x.active === 0 || x.active === '0' || x.active === 'false') active = 0;
        else return fail('BAD_INPUT', '啟用狀態格式不對');
      }
      const before = x.id ? st.stations[x.id] : null;
      if (x.id && !before) return fail('BAD_INPUT', '找不到這個站別');
      if (active && Object.values(st.stations).some((y) => y.name === name && y.active && y.id !== x.id)) return fail('BAD_INPUT', `已經有使用中的「${name}」站別`);
      let id = x.id; if (!id) { let i = Object.keys(st.stations).length + 1; while (st.stations['W' + i]) i++; id = 'W' + i; }
      st.stations[id] = { id, name, color, sort, active };
      // 改名或停用／啟用：已鎖定、會送 LINE、還沒結束、有格子用到這個站的期重送（照 server/schedule.js saveStation）
      const republished = [];
      if (before && (before.name !== name || before.active !== active) && clockAlias !== null) {
        // 央廚固定排班（fixed）沒有「鎖定」：用到這個站、今天以後還有格子的每一期都重送
        const cands = st.mode === 'fixed' ? [...new Set(Object.values(st.days).flatMap((m) => Object.entries(m).filter(([d, c]) => c.shift_id && c.station_id === id && d >= todayTaipei()).map(([d]) => periodOf(d))).filter(Boolean))].sort() : Object.keys(st.periods).sort();
        for (const per of cands) {
          if (st.mode !== 'fixed' && !st.periods[per].locked) continue;
          if (parseLabel(per) < 1) continue;
          const dts = periodDates(per);
          if (dts[27] < todayTaipei()) continue;
          if (!st.staff.some((m) => dts.some((d) => { const c = (st.days[m.emp_id] || {})[d]; return c && c.shift_id && c.station_id === id; }))) continue;
          if (st.mode === 'fixed') publishPeriod(st, per); else pubSet('publish', per);
          republished.push(per);
          st.log.push({ period: per, who: me.code, action: 'station_rename', detail: `${before.name}${before.active ? '' : '（停用）'}→${name}${active ? '' : '（停用）'}，重送 LINE` });
        }
      }
      return ok({ id, republished });
    }
    case 'saveStationNeedTpl': {
      const keep = {};
      for (const k of ['wd', 'sat', 'sun']) for (const id in (st.stNeedTpl[k] || {})) if (st.stations[id] && !st.stations[id].active) (keep[k] = keep[k] || {})[id] = st.stNeedTpl[k][id];
      for (const r of b.rows || []) {
        if (!['wd', 'sat', 'sun'].includes(r.kind) || !st.stations[r.station_id] || !st.stations[r.station_id].active) return fail('BAD_INPUT', '各站人數的站別不存在或已停用');
        const mn = needMin(r.min);
        if (mn === null) return fail('BAD_INPUT', '最少人數要是 0 以上的整數');
        (keep[r.kind] = keep[r.kind] || {})[r.station_id] = mn;
      }
      st.stNeedTpl = keep; return ok();
    }
    case 'saveStationNeedDay': {
      const g = guard(null); if (g) return g;
      if (!dates.includes(b.date)) return fail('BAD_INPUT', '日期不在這一期');
      const rows = Array.isArray(b.rows) ? b.rows : [];
      for (const r of rows) {
        if (!st.stations[r.station_id] || !st.stations[r.station_id].active) return fail('BAD_INPUT', '各站人數的站別不存在或已停用');
        if (needMin(r.min) === null) return fail('BAD_INPUT', '最少人數要是 0 以上的整數');
      }
      if (!rows.length) delete st.stNeedDay[b.date];                    // rows 空＝改回範本：該日全部列都刪（含停用站）
      else {
        const kept = {};                                                // 非空更新：停用站的單日列保留（同範本）
        for (const id in (st.stNeedDay[b.date] || {})) if (st.stations[id] && !st.stations[id].active) kept[id] = st.stNeedDay[b.date][id];
        st.stNeedDay[b.date] = Object.assign(kept, Object.fromEntries(rows.map((r) => [r.station_id, needMin(r.min)])));
      }
      return ok({ version: bump() });
    }
    case 'setStation': {                  // 鎖定中也能改、不要求核定密碼；已鎖定且會送 LINE 的期重送一筆
      const g = guard(null); if (g) return g;
      const cells = b.cells || [];
      if (!cells.length) return fail('BAD_INPUT', '沒有要存的格子');
      if (cells.length > 2000) return fail('BAD_INPUT', '一次最多改 2000 格');
      let changed = 0;
      const todo = [];
      const seen = new Set();
      for (const c of cells) {
        if (!dates.includes(c.date) || !st.staff.some((x) => x.emp_id === c.emp_id)) return fail('BAD_INPUT', '格子的人或日期不在這一期');
        const slot2 = c.slot === 2;                               // 第二班的站（同 server/schedule.js setStation）
        const key = c.emp_id + '|' + c.date + (slot2 ? '|2' : '');
        if (seen.has(key)) return fail('BAD_INPUT', '同一格送了兩次');
        seen.add(key);
        const row = (st.days[c.emp_id] || {})[c.date];
        if (!row || !row.shift_id) return fail('BAD_INPUT', '這天沒有上班，不能選站別');
        if (slot2 && !row.shift2_id) return fail('BAD_INPUT', '這天沒有第二班，不能選第二班的站別');
        const cur = { row, slot2, station_id: slot2 ? row.station2_id : row.station_id };
        const sf = st.staff.find((x) => x.emp_id === c.emp_id);
        if (!((!sf.hire_date || sf.hire_date <= c.date) && (!sf.leave_date || c.date <= sf.leave_date))) return fail('BAD_INPUT', '這天不在職，不能選站別');
        const to = c.station_id || null;
        const sidOf = slot2 ? row.shift2_id : row.shift_id, stOf = isExtId(sidOf) ? storeOf(db, sidOf.slice(0, sidOf.indexOf('.'))).stations : st.stations;      // 支援別家門市的那班，站別是那家店的
        if (to && (!stOf[to] || (!stOf[to].active && to !== cur.station_id))) return fail('BAD_INPUT', '站別不存在或已停用');
        if ((cur.station_id || null) !== to) todo.push([cur, c, to, stOf]);
      }
      for (const [cur, c, to, stOf] of todo) {
        const nm = (id) => (id ? stOf[id].name : '未選站'), who = st.staff.find((x) => x.emp_id === c.emp_id).name;
        st.log.push({ period, who: me.code, action: 'station', detail: `${who} ${+c.date.slice(5, 7)}/${+c.date.slice(8)} ${nm(cur.station_id)}→${nm(to)}` });
        if (cur.slot2) cur.row.station2_id = to; else cur.row.station_id = to; changed++;
      }
      if (!changed) return ok({ version: prow(st, period).version, changed: 0, publication: null });
      const publish = !!prow(st, period).locked && clockAlias !== null && parseLabel(period) >= 1;
      if (publish) pubSet('publish');
      return ok({ version: bump(), changed, publication: publish ? { status: 'pending' } : null });
    }
    case 'lock': {
      const n = needDuty(); if (n) return n;
      const g = guard(false); if (g) return g;
      const blocks = checkPeriod(Object.assign(ctxOf(st, period, hol), { shifts: Object.assign({}, st.shifts, mockExtShifts(db, me.code)) })).filter((r) => r.level === 'block');
      if (blocks.length) return fail('BAD_INPUT', `還有 ${blocks.length} 個地方不合規定，不能鎖定：` + blocks.slice(0, 3).map((x) => x.msg).join('；'));
      Object.assign(prow(st, period), { locked: true, locked_at: new Date().toISOString(), locked_by: me.code, needs_recheck: false });
      const publish = clockAlias !== null && parseLabel(period) >= 1;
      if (publish) pubSet('publish');
      lockLogAdd('lock', publish ? '送 LINE' : (clockAlias === null ? '這家店沒有 LINE 打卡，不送' : '試排期不送 LINE'));
      return ok({ version: bump(), publish });
    }
    case 'unlock': {
      const n = needDuty(); if (n) return n;
      const g = guard(true); if (g) return g;
      Object.assign(prow(st, period), { locked: false, locked_at: null, locked_by: null });
      const withdraw = clockAlias !== null && (st.pubs[period] || []).some((x) => x.kind === 'publish');
      if (withdraw) pubSet('unpublish');
      lockLogAdd('unlock', withdraw ? '從 LINE 撤下' : '');
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
    case 'annual': {   // 照 server/schedule.js A.annual：沒有打卡的店回 null；正職給假的剩餘天數（e2e 可用 st.annual 指定），計時不列
      if (clockAlias === null) return ok({ annual: null });
      if (st.annual) return ok({ annual: st.annual });
      const out = {};
      st.staff.forEach((x, i) => { const t = (st.terms[x.emp_id] || []).slice(-1)[0]; if (t && t.kind === 'ft') out[x.emp_id] = [7, 5.5, 3, 10, 0.5, 14][i % 6]; });
      return ok({ annual: out });
    }
    case 'dayPlan': {
      const out = {};
      // 總部自填店：只回已核准月份的格子；人資主管／管理員看全部，其他人只回自己與自己能核准的人（同 server/schedule.js dayPlan）
      const pa = (hooks && hooks.pa) || {};
      const mine = st.mode === 'self' && !pa.approveAll ? new Set([].concat(pa.selfIds || [], pa.approveIds || [])) : null;
      for (const x of st.staff) {
        if (st.mode === 'self') { const r = ((st.selfMonths || {})[x.emp_id] || {})[b.date.slice(0, 7)]; if (!(r && r.status === 'approved' && b.date >= st.modeFrom) || (mine && !mine.has(x.emp_id))) continue; }
        const c = (st.days[x.emp_id] || {})[b.date]; if (!c) continue; const sh = cellShift(st.shifts, c); out[x.emp_id] = { name: x.name, day_type: c.day_type, leave: c.leave, shift_id: c.shift_id, shift_name: sh ? sh.name : null, start: sh ? sh.start : null, end: sh ? sh.end : null, ...(sh && sh.segs ? { segs: sh.segs.map((y) => [y.start, y.end]) } : {}), station: sh && c.station_id && st.stations[c.station_id] ? st.stations[c.station_id].name : null }; }
      return ok({ date: b.date, plan: out });
    }
    default: return fail('NOT_FOUND', '找不到這個功能');
  }
}
export { minutesOf };
