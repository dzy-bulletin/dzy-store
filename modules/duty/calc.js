// 值班核定：純函式（沒有 DOM）。規則全部照原系統 ~/mala-clock-in/manager.html 搬，來源行號標在各函式上。
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
export function badgeClass(statusText) { return !statusText || statusText === '正常' ? 'normal' : 'warn'; }
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
  if (q && q.comp) {                                // 補休（manager.html:1256–1260）：只有正職、只能用已定案月份換到的餘額，以小時計
    if (!q.allowed) return { text: name + '（只有正職）', disabled: true };
    if (!(q.balance_h > 0)) return { text: name + '（沒有餘額）', disabled: true };
    return { text: name + '（剩 ' + q.balance_h + ' 小時）', disabled: false };
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
  if (r.miss_type === 'both') segs.push({ in: r.start, out: r.end });
  else if (r.miss_type === 'out') { const o = segs.filter(x => x.in && !x.out).pop(); if (o) o.out = r.end; else segs.push({ in: null, out: r.end }); }
  else { const q = segs.filter(x => x.out && !x.in)[0]; if (q) q.in = r.start; else segs.push({ in: r.start, out: null }); }
  return segs.filter(x => x.in && x.out).map(x => ({ start: x.in, end: x.out }));
}
// 打卡 QR 掃描後開的 LINE 打卡頁
export const QR_LIFF = 'https://liff.line.me/2011292256-QFXEwFh4';
export const qrUrl = token => QR_LIFF + '?qr=' + encodeURIComponent(token);

// manager.html:1849–1856：補休申請附上這位同仁目前的補休餘額（薪酬後端算的；查不到就不顯示）
export function compBalanceNote(opts, it) {
  if (!it || it.kind !== 'leave' || it.leave_type !== '補休' || !opts || !Array.isArray(opts.types)) return '';
  const def = leaveDefOf(opts, '補休'), q = def ? quotaOf(opts, String(it.emp_id), def.code) : null;
  if (!q || !q.comp) return '';
  return '\n補休餘額：' + (q.allowed ? q.balance_h + ' 小時' + (Number(it.hours) > q.balance_h ? '（不夠）' : '') : '計時同仁沒有補休');
}
