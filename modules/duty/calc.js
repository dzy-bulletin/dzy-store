// 出勤核定：純函式（沒有 DOM）。規則全部照原系統 ~/mala-clock-in/manager.html 搬，來源行號標在各函式上。
// ⚠ 核定時數的「正本」在後端 mgr_approve（~/mala-gas/mala-clock-in/程式碼.js handleMgrApprove）；這裡只是畫面上即時顯示用，
//    規則要與後端一致：時段相加（end<=start 視為隔天）＋出差時數。

// manager.html:905–909（shiftDay/addDaysStr）
export function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// manager.html:1589–1592：「今天」一律以台北時區為準，不用裝置時區
export function taipeiToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
}
// manager.html:1649–1655：'2026-10-07' → '10/7（三）'
export function weekdayLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getUTCDay()];
  const p = dateStr.split('-');
  return parseInt(p[1], 10) + '/' + parseInt(p[2], 10) + '（' + wd + '）';
}
// manager.html:1772–1775：'2026-08-01T21:43:12+08:00' → '8/1 21:43'
export function tsLabel(ts) {
  ts = String(ts || '');
  return parseInt(ts.slice(5, 7), 10) + '/' + parseInt(ts.slice(8, 10), 10) + ' ' + ts.slice(11, 16);
}

// manager.html:605–611
export function hhmmToMin(t) {
  if (!t) return null;
  const a = String(t).split(':');
  if (a.length < 2) return null;
  const m = (+a[0]) * 60 + (+a[1]);
  return isFinite(m) ? m : null;
}

// ---- 休息帶（manager.html:612–634）。休息只影響預填與畫面標示，絕不影響計算：核定時數永遠等於畫面上的時段相加。
export function hasBreak(br) {
  if (!br || !br.start || !br.end) return false;
  const s = hhmmToMin(br.start), e = hhmmToMin(br.end);
  return s != null && e != null && e > s;
}
// 班別要「完整蓋過」休息帶才拆成兩段；半天班維持一段交給主管判斷
export function shiftCoversBreak(br, a, b) {
  if (!hasBreak(br)) return false;
  const s = hhmmToMin(a), e = hhmmToMin(b);
  if (s == null || e == null || e <= s) return false;
  return s <= hhmmToMin(br.start) && e >= hhmmToMin(br.end);
}
// 相鄰兩段之間的空檔是不是就是休息帶（純比字串）
export function gapIsBreak(br, prevEnd, nextStart) { return hasBreak(br) && prevEnd === br.start && nextStart === br.end; }
export function breakHoursText(br) {
  return hasBreak(br) ? String(Math.round((hhmmToMin(br.end) - hhmmToMin(br.start)) / 60 * 100) / 100) : '';
}

// manager.html:912–914
export function segmentText(s) { return (s.in || '？') + '–' + (s.out || '？') + (s.cross ? '(+1)' : ''); }
// manager.html:916–919
// 第二個參數（2026-11-10 Eason）：出差、全天請假有已核准的申請單，假別、時數、核定時數都對得上＝正常（綠色）；沒傳或對不上維持 warn
const LEAVE_ONLY_STATUS = ['出差', '全天請假'];
export function badgeClass(statusText, day) {
  if (!statusText || statusText === '正常') return 'normal';
  const parts = String(statusText).split('、').map(s => s.trim()).filter(Boolean);
  return day && parts.length && parts.every(p => LEAVE_ONLY_STATUS.includes(p)) && leavesMatchReqs(day) ? 'normal' : 'warn';
}
/** 核定的假別與時數＝當天已核准的請假／出差單，且核定時數＝上班時段＋出差時數。day：{approvedHours, periods, leaves, reqs} */
export function leavesMatchReqs(day) {
  const total = list => (list || []).reduce((m, x) => { m[x.type] = (m[x.type] || 0) + (x.hours === '' || x.hours == null ? NaN : Number(x.hours)); return m; }, {});
  const want = total(day.leaves), got = total(reqLeaveLines(day.reqs)), types = Object.keys(want);
  if (!types.length || types.length !== Object.keys(got).length) return false;
  if (!types.every(t => want[t] > 0 && Math.abs(want[t] - got[t]) < 0.01)) return false;
  return Math.abs(Number(day.approvedHours) - (sumPeriods(day.periods || []).total + tripHoursOfList(day.leaves))) < 0.01;
}
// manager.html:955–959：假別＋時數的顯示後綴，如「・病假2.5h」
export function leaveSuffix(type, hours) {
  if (!type) return '';
  const h = (hours === 0 || hours) && hours !== '' ? Number(hours) : null;
  return '・' + type + (h != null && isFinite(h) ? h + 'h' : '');
}

// manager.html:1083–1087：出差時數（只有假別選「出差」且時數 > 0 才算）
export function tripHoursOf(leaveType, hoursStr) {
  if (leaveType !== '出差') return 0;
  const h = Number(hoursStr);
  return isFinite(h) && h > 0 ? Math.round(h * 100) / 100 : 0;
}
// manager.html:1099–1141 的 (2)：畫面上時段相加（跨夜 end<=start 視為隔天），空的半段略過
export function sumPeriods(rows) {
  let total = 0, filled = 0;
  rows.forEach(r => {
    const s0 = hhmmToMin(r.start); let e0 = hhmmToMin(r.end);
    if (s0 == null || e0 == null) return;
    if (e0 <= s0) e0 += 1440;
    total += (e0 - s0) / 60; filled++;
  });
  return { total, filled };
}
export const round2 = n => Math.round(n * 100) / 100;
export const DAY_MAX_H = 10;   // 單日上限（2026-11-01 Eason）：照實核定、超過標紅；與打卡 Rest.gs、排班 rules.js 同一個數字
// 連續工作 4 小時要休息 30 分鐘（勞基法 §35；2026-11-06 Eason：核定頁黃字提醒、不擋）。與打卡 manager.html contBreakWarn 同一套：
// 時段照開始排序，中間空檔不到 30 分鐘就當接著上；接起來超過 4 小時的第一塊 → {start, end, h}，沒有回 null。
export const CONT_MAX_MIN = 240, CONT_BREAK_MIN = 30;
export function contBreakWarn(periods) {
  const segs = (periods || []).map(p => {
    const s0 = hhmmToMin(p.start); let e0 = hhmmToMin(p.end);
    if (s0 == null || e0 == null) return null;
    if (e0 <= s0) e0 += 1440;
    return { s: s0, e: e0, start: p.start, end: p.end };
  }).filter(Boolean).sort((a, b) => a.s - b.s);
  let cur = null;
  for (const g of segs) {
    if (cur && g.s - cur.e < CONT_BREAK_MIN) { if (g.e > cur.e) { cur.e = g.e; cur.end = g.end; } }
    else cur = { s: g.s, e: g.e, start: g.start, end: g.end };
    if (cur.e - cur.s > CONT_MAX_MIN) return { start: cur.start, end: cur.end, h: round2((cur.e - cur.s) / 60) };
  }
  return null;
}
export const contBreakText = w => '連續上班 ' + w.h + ' 小時沒休息 30 分鐘（' + w.start + '–' + w.end + '；每 4 小時要休 30 分，提醒不擋）';
// 申請的黃字提醒（2026-11-06，打卡 Requests.gs reqWarns_／miss_n）：舊打卡後端沒有這兩欄＝不顯示
export function reqWarnLines(it) {
  const out = (it && Array.isArray(it.warns) ? it.warns : []).slice();
  if (it && it.kind === 'miss' && it.miss_n) out.unshift('本月第 ' + it.miss_n + ' 次忘刷' + (it.miss_n >= 3 ? '（第 3 次起出勤紀錄表會標記）' : ''));
  return out;
}

// manager.html:1368–1400：送出前的確認資訊——總時數、跨夜提醒、時段重疊（含「長段包兩短段」的掃描法）
export function analyzePeriods(periods) {
  const segs = periods.map(p => {
    const sm = hhmmToMin(p.start); let em = hhmmToMin(p.end);
    const overnight = em <= sm; if (overnight) em += 1440;
    return { start: p.start, end: p.end, sm, em, overnight };
  });
  const totalH = round2(segs.reduce((a, s) => a + (s.em - s.sm) / 60, 0));
  const warnings = [];
  segs.forEach(s => { if (s.overnight) warnings.push('・' + s.start + '–' + s.end + ' 會算成跨夜到隔天（' + round2((s.em - s.sm) / 60) + ' 小時），若是打錯請改回。'); });
  const sorted = segs.slice().sort((a, b) => a.sm - b.sm);
  let runMax = -Infinity, runSeg = null;
  sorted.forEach((s, i) => {
    if (i > 0 && s.sm < runMax) warnings.push('・' + runSeg.start + '–' + runSeg.end + ' 與 ' + s.start + '–' + s.end + ' 時段重疊，會重複計算。');
    if (s.em > runMax) { runMax = s.em; runSeg = s; }
  });
  return { segs, totalH, warnings };
}

// manager.html:1244–1250：帶出主管填過的遲到分鐘（系統自動判的不填）。「主管認定不計遲到」＝0
export function lateFromStatus(statusText) {
  const st = String(statusText || '');
  if (st.indexOf('主管認定不計遲到') !== -1) return '0';
  const m = st.split('、').filter(x => x.indexOf('遲到') === 0 && x.indexOf('(認定)') > 0)[0];
  if (m) { const g = m.match(/^遲到(\d+(?:\.\d+)?)分/); if (g) return g[1]; }
  return '';
}

// 假別清單：平時由 payroll_leave_options 動態帶出（薪酬假別表是正本：在那裡加一列這裡就多一個選項，manager.html:1171–1173）；
// 拿不到才退回下面這份——後端 mgr_approve 的 LEAVE_TYPES 白名單（~/mala-gas/mala-clock-in/程式碼.js:134–142），選什麼後端都收。
export const LEAVE_TYPES = [
  '特休假', '事假', '病假', '住院傷病假', '安胎休養假', '生理假', '家庭照顧假', '喪假（父母・配偶）', '喪假（祖父母・子女・配偶父母）',
  '喪假（曾祖父母・兄弟姊妹）', '婚假', '天災假', '公傷病假', '產假（分娩）', '流產假（妊娠3個月以上）', '流產假（妊娠2～未滿3個月）',
  '流產假（妊娠未滿2個月）', '產檢假', '陪產檢及陪產假', '公假', '謀職假', '育嬰假', '喪假', '產假', '出差',
];
export function leaveNames(opts) {
  return opts && Array.isArray(opts.types) && opts.types.length ? opts.types.map(t => t.name) : LEAVE_TYPES;
}
export const leaveDefOf = (opts, name) => (opts && Array.isArray(opts.types) ? opts.types.filter(x => x.name === name)[0] : null) || null;
// manager.html:675–679：某人某假別的額度資料
export function quotaOf(opts, empId, code) {
  if (!opts || !opts.quotas) return null;
  return (opts.quotas[empId] || {})[code] || null;
}
// manager.html:1184–1206：下拉選項的文字與是否反灰（額度用完）。曆年制與每子女制才擋；婚喪產檢是「每次事件」，標每次上限
export function leaveOptionView(name, def, q) {
  if (q && q.comp) {                                // 補休（2026-11-01 改每月加減結算，同 manager.html）：只有正職；不看餘額（可以先休後補），標本月補休帳
    if (!q.allowed) return { text: name + '（只有正職）', disabled: true };
    return { text: name + '（本月' + compBalWord(q) + '）', disabled: false };
  }
  if (!def || !q || q.cap_days == null) return { text: name, disabled: false };
  const remain = Math.round((q.remain_days || 0) * 10) / 10;
  if (q.blocked) return { text: name + '（額度已用完）', disabled: true };
  if (q.basis === 'event') return { text: name + '（每次上限 ' + q.cap_days + ' 日）', disabled: false };
  if (def.code === 'parental') return { text: name + '（剩 ' + (Math.round(remain / 30 * 10) / 10) + ' 個月）', disabled: false };   // 育嬰留停以月計
  return { text: name + '（剩 ' + remain + ' 日）', disabled: false };
}
// manager.html:659–673：期限規則（婚假 3 個月內、陪產假前後 15 日內…；與後端 payLeaveWindowCheck 同一套，改這裡兩邊都要改）。
// 以事件日為基準：婚假＝結婚登記日、陪產假＝分娩日。事件日沒登記就不擋、只提示。
export function windowCheck(def, events, empId, leaveDate) {
  if (!def || def.window_days == null) return { ok: true };
  const ev = ((events && events[empId]) || {})[def.code];
  if (!ev) return { ok: true, note: def.name + ' 有期限規定，但還沒登記事件日，系統無法檢查' };
  const from = addDaysStr(ev, -(Number(def.window_before) || 0));
  const to = addDaysStr(from, Number(def.window_days) || 0);
  const toMax = def.window_max == null ? null : addDaysStr(from, Number(def.window_max));
  if (leaveDate < from) return { ok: false, msg: def.name + ' 最早只能從 ' + from + ' 開始請（事件日 ' + ev + '）' };
  if (leaveDate <= to) return { ok: true };
  if (toMax && leaveDate <= toMax) return { ok: true, note: def.name + ' 已超過 ' + to + ' 的期限，需雇主同意才可延至 ' + toMax };
  return { ok: false, msg: def.name + ' 請畢期限是 ' + to + (toMax ? '（經同意最多延至 ' + toMax + '）' : '') + '，已超過' };
}

// manager.html:1956–1959：員工專屬打卡連結（各店頁面檔名不同）
export function clockLink(clockStore, key) {
  const page = clockStore ? 'clock-' + clockStore + '.html' : 'clock.html';
  return 'https://eason0728.github.io/mala-clock-in/' + page + '?k=' + key;
}

// ---- 加班請假／忘打卡申請（2026-10-09，照 ~/mala-clock-in manager.html feature/requests-qr 的 punchEvidence／__applyReq）----
export const REQ_KIND_LABEL = { leave: '請假', ot: '加班', trip: '出差', miss: '忘打卡' };   // 出差 2026-10-09 加入
// 批次核准一次最多幾筆（與打卡後端 Requests.gs REQ_BATCH_MAX 同）
export const REQ_BATCH_MAX = 30;
// 'yyyy-mm-dd' → 'm/d'
export function shortDate(d) { d = String(d || ''); return parseInt(d.slice(5, 7), 10) + '/' + parseInt(d.slice(8, 10), 10); }
// 待審申請的「當天打卡紀錄」證據；沒有 punches（日期還沒到）回空字串
export function punchEvidence(it) {
  if (!it.punches) return '';
  if (!it.punches.length) return '當天打卡紀錄：沒有任何打卡';
  return '當天打卡紀錄：\n' + it.punches.map(p => {
    const bad = String(p.status || '').indexOf('rejected_') === 0;
    return p.hm + ' ' + (p.type === 'in' ? '上班' : '下班') + (bad ? '（被擋'
      + (p.status === 'rejected_out_of_range' ? '：離店 ' + p.distance_m + 'm' + (p.accuracy_m != null ? '、定位誤差 ±' + p.accuracy_m + 'm' : '') : '') + '）'
      : p.status === 'pending_device_approval' ? '（待核准裝置）' : ' ✓');
  }).join('\n') + (it.kind === 'miss' && it.punches.some(p => p.status === 'rejected_out_of_range' && p.accuracy_m >= 500)
    ? '\n→ 有按但被擋，而且定位誤差很大＝多半是手機定位失準，申請時間合理' : '');
}
// 打卡時間照參考時數的規則取整到 15 分（上班進位、下班捨去）
export function round15(hm, up) {
  if (!hm) return hm;
  let m = hhmmToMin(hm); if (m === null) return hm;
  m = up ? Math.ceil(m / 15) * 15 : Math.floor(m / 15) * 15; m = m % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
// 忘打卡預填：當天打卡段（取整）＋申請補的那一邊；只有上下班都齊的段才成為時段列。回 [{start,end}]（空陣列＝不動畫面）
export function missPeriods(segments, r) {
  const segs = (segments || []).map(x => ({ in: round15(x.in, true), out: round15(x.out, false) }));
  if (r.miss_type === 'break') {
    // 中間休息沒打卡（2026-11-02，打卡系統 mala-clock-in 同名功能）：end＝休息開始、start＝回來上班；
    // 把含休息開始的那段拆兩段：上班卡～休息開始、回來上班～下班卡（同 manager.html）
    const rel = (hm, base) => (hhmmToMin(hm) - hhmmToMin(base) + 1440) % 1440;
    let bi = -1;
    segs.forEach((x, i) => { if (x.in && rel(r.end, x.in) > 0 && (!x.out || rel(r.end, x.in) < rel(x.out, x.in))) bi = i; });
    if (bi >= 0) segs.splice(bi, 1, { in: segs[bi].in, out: r.end }, { in: r.start, out: segs[bi].out });
  } else if (r.miss_type === 'both') segs.push({ in: r.start, out: r.end });
  else if (r.miss_type === 'out') { const o = segs.filter(x => x.in && !x.out).pop(); if (o) o.out = r.end; else segs.push({ in: null, out: r.end }); }
  else { const q = segs.filter(x => x.out && !x.in)[0]; if (q) q.in = r.start; else segs.push({ in: r.start, out: null }); }
  return segs.filter(x => x.in && x.out).map(x => ({ start: x.in, end: x.out }));
}
// 打卡 QR 掃描後開的 LINE 打卡頁
export const QR_LIFF = 'https://liff.line.me/2011292256-QFXEwFh4';
export const qrUrl = token => QR_LIFF + '?qr=' + encodeURIComponent(token);

// 本月補休帳的短字：「剩 4 小時」／「欠 4 小時」（2026-11-01：本月核准加班 − 本月補休，含審核中；同 manager.html compBalWord）
export function compBalWord(q) {
  const b = Math.round((Number(q && q.balance_h) || 0) * 100) / 100;
  return b < 0 ? '欠 ' + (-b) + ' 小時' : '剩 ' + b + ' 小時';
}
// 補休申請附上這位同仁本月的補休帳（薪酬後端算的；查不到就不顯示；同 manager.html compBalanceNote）
export function compBalanceNote(opts, it) {
  if (!it || it.kind !== 'leave' || it.leave_type !== '補休' || !opts || !Array.isArray(opts.types)) return '';
  const def = leaveDefOf(opts, '補休'), q = def ? quotaOf(opts, String(it.emp_id), def.code) : null;
  if (!q || !q.comp) return '';
  if (!q.allowed) return '\n補休：計時同仁沒有補休';
  return '\n本月補休帳：加班 ' + (Number(q.ot_h) || 0) + ' − 補休 ' + (Number(q.used_h) || 0) + ' ＝ ' + compBalWord(q)
    + (Number(q.balance_h) < 0 ? '（當月要用加班補平）' : '');
}

// ---- 核定工時的上下班時間跟班表連動（2026-10-29，docs/duty-shift-from-schedule/requirements.md）----
// 伺服器在 mgr_day 每人加 plan：{work:true, segs:[{start,end}], shift_name, station} 上班／{work:false, day_type, leave} 休假／null 或沒有＝那天沒排班（退回個人預設 shift_in–shift_out）。
const PLAN_OFF_TEXT = { R: '例假', H: '排休' };
const PLAN_LEAVE_TEXT = { '國': '國定', '特': '排特休', '補': '排補休' };
export function planOffText(plan) {
  if (!plan || plan.work) return '';
  if (plan.away) return '這天排在門市上班（門市那段在門市打卡、由店長核）';      // 總部同仁整天去門市（2026-11-07）
  return (plan.day_type === 'L' ? PLAN_LEAVE_TEXT[plan.leave] : PLAN_OFF_TEXT[plan.day_type]) || '排休';
}
const planSegsOk = plan => !!plan && plan.work === true && Array.isArray(plan.segs) && plan.segs.length > 0 && plan.segs.every(s => s && s.start && s.end);
/** 員工卡的班別文字與預填時段。回 { mode, text, initial, offPunch }：
 *  mode＝'plan'（班表上班）／'off'（班表休假）／'default'（沒排班，用個人預設時間）／'none'（都沒有）；
 *  text＝姓名旁的小字（null＝不顯示）；initial＝預填時段（[null]＝一列空白）；offPunch＝排休卻有打卡、還沒核定（提示補加班申請；有已核准加班申請時由畫面收掉）。
 *  已核定過：時段一律帶原核定（不變）。休息帶照舊：只有「一段」完整蓋過休息帶才拆兩段（目前只有央廚）。 */
export function planPrefill(emp, plan, br) {
  const approved = emp && emp.approved;
  const keep = approved ? (approved.periods && approved.periods.length ? approved.periods : [null]) : null;
  const one = (a, b) => (shiftCoversBreak(br, a, b) ? [{ start: a, end: br.start }, { start: br.end, end: b }].filter(p => p.start !== p.end) : [{ start: a, end: b }]);      // 班別剛好從休息帶開始／在休息帶結束時，不留零長度那段（會被算成 24 小時）
  const brTag = (a, b) => (shiftCoversBreak(br, a, b) ? '・休' + breakHoursText(br) + 'h' : '');
  if (planSegsOk(plan)) {
    const segs = plan.segs.map(s => ({ start: s.start, end: s.end }));
    const text = '班表 ' + (plan.shift_name ? plan.shift_name + ' ' : '') + segs.map(s => s.start + '–' + s.end).join('／') + (segs.length === 1 ? brTag(segs[0].start, segs[0].end) : '')
      + (plan.station ? '・' + plan.station : '');      // 班別名稱、工作站從下面比對那行搬上來（2026-11-03 Eason：班表不要顯示兩次）
    return { mode: 'plan', text, initial: keep || (segs.length === 1 ? one(segs[0].start, segs[0].end) : segs), offPunch: false };
  }
  if (plan && plan.work === false) {
    return { mode: 'off', text: planOffText(plan), initial: keep || [null], offPunch: !approved && !!(emp.segments && emp.segments.length) };
  }
  if (emp && emp.shift_in && emp.shift_out) {
    return { mode: 'default', text: '預設 ' + emp.shift_in + '–' + emp.shift_out + brTag(emp.shift_in, emp.shift_out), initial: keep || one(emp.shift_in, emp.shift_out), offPunch: false };
  }
  return { mode: 'none', text: null, initial: keep || [null], offPunch: false };
}
/** 排休那天已核准的加班申請 → 預填時段（每筆有起訖時間的加班一段）；上班日不用（加班只顯示，維持現狀） */
export function otPeriods(reqs) {
  return (reqs || []).filter(r => r && r.kind === 'ot' && r.start && r.end).map(r => ({ start: r.start, end: r.end }));
}
export const OFF_PUNCH_HINT = '排休卻有打卡：請同仁補加班申請，核准後會自動帶入';

// ---- 一天多種假別（2026-10-29，照 manager.html 2026-10-26；docs/duty-req-multi/spec.md §1.2）----
export const MAX_LEAVE_LINES = 4;
// mgr_day／mgr_approve 回 leaves:[{type,hours}]；舊後端只有 leave_type／leave_hours
export function leavesOf(o) {
  if (o && Array.isArray(o.leaves) && o.leaves.length) return o.leaves;
  return (o && o.leave_type) ? [{ type: o.leave_type, hours: o.leave_hours }] : [];
}
export const leavesSuffix = list => (list || []).map(x => leaveSuffix(x.type, x.hours)).join('');
export const leavesText = list => (list || []).map(x => x.type + (x.hours !== '' && x.hours != null ? ' ' + x.hours + ' 小時' : '')).join('、');
// 出差時數加總（只有出差算進核定；一天最多一列出差）
export const tripHoursOfList = list => round2((list || []).reduce((a, x) => a + tripHoursOf(x.type, x.hours), 0));
// 同一個假別選了兩次 → 回那個假別，否則 ''
export function dupLeaveType(list) {
  const ts = (list || []).map(x => x.type);
  return ts.filter((t, i) => ts.indexOf(t) !== i)[0] || '';
}

// ---- 同一天多張已核准的申請（2026-10-29，照 manager.html card.__applyReq；spec §1.1）----
// 種類鍵：出差＝'出差'、請假＝假別名、忘打卡＝'miss'。加班不算（只顯示、不填假別欄）。
export const reqKey = r => (r.kind === 'trip' ? '出差' : r.kind === 'leave' ? String(r.leave_type) : 'miss');
// 回 { fillables, multi, older(r) }：multi＝同一鍵兩張、或假別種數超過 4 → 不自動填，逐張給主管選／作廢；
// older(r)＝同一鍵（忘打卡還要同 miss_type）有較晚送出的另一張 → 這張可能是舊單
export function reqPlan(reqs) {
  const fillables = (reqs || []).filter(r => r.kind !== 'ot');
  const keys = fillables.map(reqKey);
  const multi = keys.some((k, i) => keys.indexOf(k) !== i) || keys.filter(k => k !== 'miss').length > MAX_LEAVE_LINES;
  const older = r => r.kind !== 'ot' && fillables.some(q => q !== r && reqKey(q) === reqKey(r)
    && (r.kind !== 'miss' || q.miss_type === r.miss_type) && !!r.created_at && !!q.created_at && String(q.created_at) > String(r.created_at));      // 缺送出時間就不判舊單（2026-10-29 Fable 審查第 7 條）
  return { fillables, multi, older };
}
// 申請預填的假別列：請假→{假別,時數}、出差→{出差,時數}
export const reqLeaveLines = list => (list || []).filter(r => r.kind === 'leave' || r.kind === 'trip')
  .map(r => ({ type: r.kind === 'trip' ? '出差' : (r.leave_type || ''), hours: (r.hours === 0 || r.hours) ? r.hours : '' }))
  .filter(x => x.type);

// 重複打卡（2026-11-06 Eason）：打卡後端 mgr_day 每人帶 dup_groups:[{type, cards:[{ts, hm}]}]＝同一天、同一型、相鄰、60 分鐘內的成功卡；
// 已核定的 approved.dup_ignore＝被店長認定重複的那幾張 ts。店長選「以哪張為準」＝留那張、其他張送 dup_ignore；不選＝照系統原判定（算忘刷）。
// 舊打卡後端沒有 dup_groups＝不顯示。正本規則在打卡後端 Code.gs dupPunchGroups_／dupIgnoreInvalid_。
export function dupGroupTitle(g) {
  const hms = g.cards.map(c => c.hm), kind = g.type === 'in' ? '上班卡' : '下班卡';
  const gap = Math.round((new Date(g.cards[g.cards.length - 1].ts) - new Date(g.cards[0].ts)) / 60000);
  const num = ['', '', '兩', '三', '四', '五'][hms.length] || String(hms.length);
  return hms.join(hms.length === 2 ? ' 和 ' : '、') + ' ' + num + '張' + kind + '（相隔 ' + gap + ' 分），中間沒有' + (g.type === 'in' ? '下班卡' : '上班卡');
}
// 每組目前選的那張（ts；'' ＝不處理）：已核定時從 dup_ignore 推回來
export function dupInitialPicks(groups, ignored) {
  const ign = ignored || [];
  return (groups || []).map(g => {
    if (!g.cards.some(c => ign.includes(c.ts))) return '';
    const keep = g.cards.find(c => !ign.includes(c.ts));
    return keep ? keep.ts : '';
  });
}
// 選擇 → 送給 mgr_approve 的 dup_ignore（每組沒被選的那幾張）
export function dupIgnoreFrom(groups, picks) {
  const out = [];
  (groups || []).forEach((g, i) => { const k = (picks || [])[i]; if (k) g.cards.forEach(c => { if (c.ts !== k) out.push(c.ts); }); });
  return out;
}
// 送出前確認框那一行：「重複打卡：以 17:26 為準（17:55 不算忘刷）」；沒選回 ''
export function dupConfirmLine(groups, picks) {
  const parts = [];
  (groups || []).forEach((g, i) => {
    const k = (picks || [])[i]; if (!k) return;
    const keep = g.cards.find(c => c.ts === k), rest = g.cards.filter(c => c.ts !== k).map(c => c.hm);
    if (keep) parts.push('以 ' + keep.hm + ' 為準（' + rest.join('、') + ' 不算忘刷）');
  });
  return parts.length ? '重複打卡：' + parts.join('；') : '';
}
// 「有打卡段還沒打下班卡」的警告不算重複上班卡組裡前面那幾張（它們配不到下班卡是因為後面又打了一張，不是還在上班）
export function hasOpenSegExceptDup(segments, groups) {
  const early = new Set();
  (groups || []).filter(g => g.type === 'in').forEach(g => g.cards.slice(0, -1).forEach(c => early.add(c.hm)));
  return (segments || []).some(s => s.in && !s.out && !early.has(s.in));
}
