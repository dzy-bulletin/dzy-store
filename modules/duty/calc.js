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

// 假別清單：後端 LEAVE_TYPES 白名單（~/mala-gas/mala-clock-in/程式碼.js:134–142），選什麼後端都收。
// 原頁還會向薪酬系統問「剩餘額度、期限規則」（payroll_leave_options），那個動作不在營運系統放行的 11 個動作內，所以這裡沒有額度提示。
export const LEAVE_TYPES = [
  '特休假', '事假', '病假', '住院傷病假', '安胎休養假', '生理假', '家庭照顧假', '喪假（父母・配偶）', '喪假（祖父母・子女・配偶父母）',
  '喪假（曾祖父母・兄弟姊妹）', '婚假', '天災假', '公傷病假', '產假（分娩）', '流產假（妊娠3個月以上）', '流產假（妊娠2～未滿3個月）',
  '流產假（妊娠未滿2個月）', '產檢假', '陪產檢及陪產假', '公假', '謀職假', '育嬰假', '喪假', '產假', '出差',
];

// manager.html:1956–1959：員工專屬打卡連結（各店頁面檔名不同）
export function clockLink(clockStore, key) {
  const page = clockStore ? 'clock-' + clockStore + '.html' : 'clock.html';
  return 'https://eason0728.github.io/mala-clock-in/' + page + '?k=' + key;
}
