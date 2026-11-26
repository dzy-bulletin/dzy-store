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
/**
 * 本月待核定提醒的分組（核定工時頁上方的黃框，2026-11-10）：依日期分組，同一天的人照來的順序全部列。
 *   mine＝那天至少有一位「這個人核得了工時」的人 → 算進「本月還有 N 天沒核定」；
 *   ro＝那天全部是只能看的人（督導看區內門市、原單位主管看支援帳號、個別給的只看考勤）→ 不是他的待辦，不算天數、列在後面。
 * 首頁待辦（server/att-alerts.js）是同一個算法，兩邊的天數才對得起來。canWrite(it)＝這一列這個人核不核得了。
 */
export function pendGroups(items, canWrite) {
  const groups = [], by = {};
  (Array.isArray(items) ? items : []).forEach(it => {
    if (!it) return;
    if (!by[it.date]) { by[it.date] = { date: it.date, names: [], can: false }; groups.push(by[it.date]); }
    by[it.date].names.push(it);
    if (canWrite(it)) by[it.date].can = true;
  });
  const pick = (g) => ({ date: g.date, names: g.names });
  return { mine: groups.filter(g => g.can).map(pick), ro: groups.filter(g => !g.can).map(pick) };
}
/**
 * 待核定提醒的標題（2026-11-19 Eason，考勤驗收 11-10 不符 5）：每月 1～5 號伺服器會把上個月沒核定的天併在前面、回 prev_ym。
 *   groups＝pendGroups 的 mine；prevYm＝回應的 prev_ym（沒有＝''）。上個月的天標「11 月」，其他照舊叫「本月」：
 *   只有本月 →「本月還有 3 天沒核定」（跟以前一字不差）；兩個月都有 →「11 月還有 2 天、本月還有 1 天沒核定」。
 */
export function pendTitle(groups, prevYm) {
  const isPrev = (g) => !!prevYm && String(g.date).slice(0, 7) === prevYm;
  const p = groups.filter(isPrev).length, c = groups.length - p;
  const parts = [];
  if (p) parts.push(Number(prevYm.slice(5, 7)) + ' 月還有 ' + p + ' 天');
  if (c) parts.push('本月還有 ' + c + ' 天');
  return parts.join('、') + '沒核定';
}
// 月初（每月 1～5 日）本月沒有待辦時，畫面中央那一行（取代「到昨天為止都核定完了」；2026-11-20 驗收）：
//   wait＝上個月的還在讀取；miss＝上個月讀不到；has＝上個月讀回來、還有 n 天沒核定（點上方提醒去核）；其他回空字串（照常顯示都核定完了）
export const PREV_MISS_TEXT = '上個月的資料這次讀不到，請用上方日期選到上個月確認';
export function prevNoteText(kind, n) {
  if (kind === 'wait') return '本月到昨天為止都核定完了；上個月的還在讀取，請稍等…';
  if (kind === 'miss') return PREV_MISS_TEXT;
  if (kind === 'has' && n > 0) return '本月到昨天為止都核定完了；上個月還有 ' + n + ' 天沒核定，請點上方的提醒看名單、再點名字去核定';
  return '';
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
// 第二個參數（2026-11-10 Eason）：出差、全天請假、忘刷卡有已核准的申請單，內容和核定時數都對得上＝正常（綠色）；沒傳或對不上維持 warn
const LEAVE_ONLY_STATUS = ['出差', '全天請假'];
// 每項狀態代表漏幾張卡，和打卡端補單張數同一口徑（2026-11-10）：單張忘刷、第N段某張沒打各 1 張；整天沒打卡＝每段 2 張
const missCardsOf = (p, nPeriods) => (/^(第.+段)?(上班|下班)忘刷卡$/.test(p) || /^第.+段(上班|下班)無打卡$/.test(p)) ? 1 : p === '該段無打卡' ? 2 * Math.max(1, nPeriods || 1) : 0;
export function badgeClass(statusText, day) {
  if (!statusText || statusText === '正常') return 'normal';
  const parts = String(statusText).split('、').map(s => s.trim()).filter(Boolean);
  if (!day || !parts.length || !parts.every(p => LEAVE_ONLY_STATUS.includes(p) || missCardsOf(p))) return 'warn';
  const needLeave = parts.some(p => LEAVE_ONLY_STATUS.includes(p)) || (day.leaves || []).length > 0;
  const needCards = parts.reduce((a, p) => a + missCardsOf(p, (day.periods || []).length), 0);
  return (!needLeave || leavesMatchReqs(day)) && (!needCards || missMatchesReqs(day, needCards)) ? 'normal' : 'warn';
}
/** 兩個時鐘時間（分鐘）的差，取最近的方向，落在 [-720, 720)：23:55 對 00:00＝-5 */
const clockDiff = (a, b) => (a == null || b == null ? NaN : (((a - b + 720) % 1440) + 1440) % 1440 - 720);
/** 核定時段有沒有整段蓋住這張單的起訖（2026-11-17：改用分鐘比，結束不晚於開始＝隔天；原本直接比字串，核定 16:00–01:00 對加班單 00:00–01:00 永遠對不上）。
 *  核定時段先接起來再比；單的時間在午夜後（00:00–01:00）也試「隔天」那個位置。 */
export function periodsCoverReq(periods, r) {
  const sp = (a, b) => { const s = hhmmToMin(a); let e = hhmmToMin(b); if (s == null || e == null) return null; if (e <= s) e += 1440; return [s, e]; };
  const q = sp(r && r.start, r && r.end);
  if (!q) return false;
  const ps = (periods || []).map(p => p && sp(p.start, p.end)).filter(Boolean).sort((x, y) => x[0] - y[0]), u = [];
  ps.forEach(p => { const l = u[u.length - 1]; if (l && p[0] <= l[1]) l[1] = Math.max(l[1], p[1]); else u.push(p.slice()); });
  return u.some(p => (p[0] <= q[0] && p[1] >= q[1]) || (p[0] <= q[0] + 1440 && p[1] >= q[1] + 1440));
}
/** 已核准的忘打卡單補足缺的卡，補的時間在核定時段頭尾 15 分鐘內，核定時數也對得上。 */
function missMatchesReqs(day, needCards) {
  const reqs = (day.reqs || []).filter(r => r.kind === 'miss');
  const periods = day.periods || [];
  const have = reqs.reduce((a, r) => a + (r.miss_type === 'both' || r.miss_type === 'break' ? 2 : 1), 0);
  if (have < needCards || !periods.length) return false;
  const near = (t, side) => periods.some(p => Math.abs(clockDiff(hhmmToMin(t), hhmmToMin(p[side]))) <= 15);      // 跨午夜也比得對：補下班 23:55、核定到 00:00＝差 5 分（2026-11-17）
  const ok = reqs.every(r => (r.miss_type === 'out' || (r.start && near(r.start, 'start'))) && (r.miss_type === 'in' || (r.end && near(r.end, 'end'))));
  return ok && Math.abs(Number(day.approvedHours) - (sumPeriods(periods).total + tripHoursOfList(day.leaves))) < 0.01;
}
/** 核定的假別與時數＝當天已核准的請假／出差單，且核定時數＝上班時段＋出差時數。day：{approvedHours, periods, leaves, reqs} */
export function leavesMatchReqs(day) {
  const total = list => (list || []).reduce((m, x) => { m[x.type] = (m[x.type] || 0) + (x.hours === '' || x.hours == null ? NaN : Number(x.hours)); return m; }, {});
  const want = total(day.leaves), got = total(reqLeaveLines(day.reqs)), types = Object.keys(want);
  if (!types.length || types.length !== Object.keys(got).length) return false;
  if (!types.every(t => want[t] > 0 && Math.abs(want[t] - got[t]) < 0.01)) return false;
  return Math.abs(Number(day.approvedHours) - (sumPeriods(day.periods || []).total + tripHoursOfList(day.leaves))) < 0.01;
}
// 已核定過的日子，核定內容跟已核准的申請單一致嗎（2026-11-15 Eason：一致就綠框、不顯示「依申請重新填」）：
// 假別（含出差）依種類加總後時數相同、加班單時段都在核定時段內；有忘打卡單（看不出補的卡對不對）或對不上＝false（照舊黃框）
export function approvedMatchesReqs(approvedLeaves, approvedPeriods, reqs) {
  const list = (reqs || []);
  if (!list.length || list.some(r => r.kind === 'miss')) return false;
  const sum = ls => (ls || []).reduce((m, x) => { m[x.type] = (m[x.type] || 0) + (x.hours === '' || x.hours == null ? NaN : Number(x.hours)); return m; }, {});
  const have = sum(approvedLeaves), want = sum(reqLeaveLines(list));
  const ks = new Set(Object.keys(have).concat(Object.keys(want)));
  for (const k of ks) if (!(Math.abs((have[k] || 0) - (want[k] || 0)) < 0.01)) return false;
  const ps = (approvedPeriods || []).filter(p => p && p.start && p.end);
  return list.filter(r => r.kind === 'ot').every(o => !o.start || !o.end || periodsCoverReq(ps, o));
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
/**
 * 只看名單（session.dutyView／attStores[].view）下，這一列能不能寫。kind：'hours' 核定工時、'req' 申請審核。
 * 伺服器的寫入永遠只看工時名單／申請名單（proxy/duty.js），店長、人資主管、管理員也一樣；v.all 只多放行「姓名對不到編號」的列。
 * 沒有 v＝伺服器沒給只看資訊，維持原行為（都可寫，伺服器照舊擋）。（2026-11-15：原本 v.all 一律當可寫，店長名下只看的人畫面出現送出鈕、按了才 403）
 */
export function viewCanWrite(v, kind, empId) {
  if (!v) return true;
  const id = String(empId == null ? '' : empId), list = kind === 'req' ? v.req : v.hours;
  if (!id) return !!v.all;
  return Array.isArray(list) && list.indexOf(id) >= 0;
}
export const overDay = h => round2(h) > 10;   // 超過單日上限才標紅：先取到小數兩位再比，三段相加的浮點誤差不會把剛好 10 小時標紅（2026-11-15）
export const DAY_MAX_H = 10;   // 單日上限（2026-11-01 Eason）：照實核定、超過標紅；與打卡 Rest.gs、排班 rules.js 同一個數字
/* 單日滿 10 小時新定義（2026-11-23 主管定案，同打卡端 mala-clock-in #223 的 09:00 通知 Payroll.gs payDayLoadOver_）：
   當日出勤＝要核定的時數（上班＋出差，跟 approved_hours 同一個數）＋這次登記的請假（出差以外的假別，只填時數的也算＝事後），「滿」含剛好 10。
   開關：伺服器環境變數 CAP10_NEWDEF_ON＝'1' 時，mgr_day 每一列帶 cap10_new:1（server/proxy/duty.js）；沒帶＝跟改之前逐字相同（超過才紅、只看上班＋出差、舊字）。
   設計：PR 說明；打卡端 ~/加盟名單平台/_brain_out/cap10-newdef/design.md §8.2 */
export const cap10On = emp => !!(emp && emp.cap10_new === 1);
export const DAY_OVER_TEXT_OLD = '超過一天 ' + DAY_MAX_H + ' 小時上限（照實核定，會列進每日通知）';
export const DAY_OVER_TEXT_NEW = '滿一天 ' + DAY_MAX_H + ' 小時上限（含已核准請假；照實核定，會列進每日通知）';   // 主管 2026-11-23 同意的字
/** 這次登記的請假時數（出差已在核定時數裡不重算；時數空白、0、負數、不是數字＝0；同 payDayLoadOver_ 讀 leave 分頁的規則） */
export const leaveHoursNonTrip = list => round2((list || []).reduce((a, x) => {
  if (!x || !x.type || x.type === '出差') return a;
  const h = Number(x.hours);
  return a + (x.hours !== '' && x.hours != null && isFinite(h) && h > 0 ? h : 0);
}, 0));
/** 紅字要不要出現：workTripH＝上班＋出差（＝要核定的時數）；leaves＝這次登記的假別 [{type,hours}]。開關關著＝舊的 overDay(workTripH) */
export const dayLoadOver = (emp, workTripH, leaves) => cap10On(emp) ? round2((Number(workTripH) || 0) + leaveHoursNonTrip(leaves)) >= DAY_MAX_H : overDay(workTripH);
export const dayOverText = emp => (cap10On(emp) ? DAY_OVER_TEXT_NEW : DAY_OVER_TEXT_OLD);
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
  if (it && it.kind === 'miss' && it.miss_n) out.unshift('本月第 ' + it.miss_n + ' 天忘打卡' + (it.miss_n >= 3 ? '（第 3 天起出勤紀錄表會標記）' : ''));
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
  if (def && def.code === 'menstrual' && q && !q.comp) {   // 生理假改用「次」（2026-11-18 Eason：一天算一次、每年 3 次）；後端沒給次數就走下面舊顯示
    const n = menstrualUsed(q);
    if (n != null) return n >= MENSTRUAL_MAX_TIMES || q.blocked ? { text: name + '（今年已請 ' + n + '／' + MENSTRUAL_MAX_TIMES + ' 次，額度已用完）', disabled: true } : { text: name + '（今年已請 ' + n + '／' + MENSTRUAL_MAX_TIMES + ' 次）', disabled: false };
  }
  if (!def || !q || q.cap_days == null) return { text: name, disabled: false };
  const remain = Math.round((q.remain_days || 0) * 10) / 10;
  if (q.blocked && QUOTA_SOFT_CODES.indexOf(def.code) >= 0) return { text: name + '（已超過 ' + q.cap_days + ' 日）', disabled: false };      // 事假用完不反灰，送出前確認
  if (q.blocked) return { text: name + '（額度已用完）', disabled: true };
  if (q.basis === 'event') return { text: name + '（每次上限 ' + q.cap_days + ' 日）', disabled: false };
  if (def.code === 'parental') return { text: name + '（剩 ' + (Math.round(remain / 30 * 10) / 10) + ' 個月）', disabled: false };   // 育嬰留停以月計
  return { text: name + '（剩 ' + remain + ' 日）', disabled: false };
}
// ---- 額度用完怎麼處理（2026-11-10 Eason 定案）----
// 生理假、家庭照顧假額度用完＝硬擋；事假（personal）用完不擋，送出前確認框提示、超過的部分照曠職標紅；其他假別維持原本（blocked 就擋）
export const QUOTA_SOFT_CODES = ['personal'];
/** 核定送出：這個假別額度用完要硬擋嗎（補休走自己的規則，不在這裡） */
export function quotaHardBlocked(def, q) { return !!(q && q.blocked && !q.comp && !(def && QUOTA_SOFT_CODES.indexOf(def.code) >= 0)); }
/** 事假超額（只提示、不擋） */
export function personalOver(def, q) { return !!(def && def.code === 'personal' && q && q.blocked && !q.comp); }
export const personalOverText = (name, q) => name + ' 今年事假已超過 ' + ((q && q.cap_days != null) ? q.cap_days : 14) + ' 天，超過的部分會照曠職標紅，仍要送出嗎？';
export const MENSTRUAL_MAX_TIMES = 3;
/** 生理假一天最多 8 小時（2026-11-18 規則；打卡端核定也擋）。同一天幾列生理假加起來超過就回提示字串，沒超過回 ''。
 *  一頁核定（quick-calc leaveProblem）與完整核定頁（approve.js 送出前）共用同一句，免得送出才被打卡系統退回 */
export const MENSTRUAL_DAY_MAX_H = 8;
export function menstrualDayOverText(leaves) {
  const h = (leaves || []).filter(L => L && L.type === '生理假').reduce((n, L) => n + (Number(L.hours) || 0), 0);
  return h > MENSTRUAL_DAY_MAX_H + 0.001 ? '生理假一天最多 ' + MENSTRUAL_DAY_MAX_H + ' 小時，目前填了 ' + Math.round(h * 100) / 100 + ' 小時' : '';
}
// 薪資 payLeaveUsage 的生理假 used_days 就是次數（payLeaveQuotaDays_，4 小時也算 1 次）
const menstrualUsed = q => { for (const k of ['used_days', 'used_n', 'used_times', 'used_count', 'times_used']) if (q && q[k] != null && !isNaN(Number(q[k]))) return Number(q[k]); return null; };
/** 申請審核：這張請假單能不能核准。回 '' ＝可以；否則是核准鈕要顯示的原因。
 *  只管生理假（已用次數 ≥ 3；後端沒給次數欄位時看 blocked）與家庭照顧假（這張單時數÷8 天 > remain_days；沒填時數時看 blocked）。事假與其他假別不擋 */
export const REQ_QUOTA_BLOCK_TEXT = '額度已用完，不能核准';
export const REQ_MENS_BLOCK_TEXT = '生理假今年已請滿 3 次，不能核准，請同仁改辦理病假';
export function reqQuotaBlock(opts, it) {
  if (!it || it.kind !== 'leave' || !opts || !Array.isArray(opts.types)) return '';
  const def = leaveDefOf(opts, it.leave_type), q = def ? quotaOf(opts, String(it.emp_id), def.code) : null;
  if (!def || !q) return '';
  if (def.code === 'menstrual') {
    const n = menstrualUsed(q);
    return (n != null ? n >= MENSTRUAL_MAX_TIMES : !!q.blocked) ? REQ_MENS_BLOCK_TEXT : '';
  }
  if (def.code === 'family') {
    const h = Number(it.hours), remain = Number(q.remain_days);
    if (h > 0 && !isNaN(remain)) return h / 8 > remain + 1e-9 ? REQ_QUOTA_BLOCK_TEXT : '';
    return q.blocked ? REQ_QUOTA_BLOCK_TEXT : '';
  }
  return '';
}

// manager.html:659–673：期限規則（婚假 3 個月內、陪產假前後 15 日內…；與後端 payLeaveWindowCheck 同一套，改這裡兩邊都要改）。
// 以事件日為基準：婚假＝結婚登記日、陪產假＝分娩日。事件日沒登記就不擋、只提示。
export function windowCheck(def, events, empId, leaveDate) {
  // 空白、非數字、0 都當沒設期限（2026-11-14：薪資假別表期限格藏空格會讀成 0，沒期限的喪假也被要求登記事件日）
  if (!def || def.window_days == null || String(def.window_days).trim() === '' || !(Number(def.window_days) > 0)) return { ok: true };
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
// 忘打卡預填的上班時間：往前取整；比最近一段班表的開始還晚（遲到）或早不到 15 分鐘，留班表開始時間
// before＝這張上班卡之前各段打卡的時間（2026-11-17）：那段班開始之後、這張卡之前已經有別的打卡＝中途出去再回來，不是那段班的第一張上班卡 → 只取整、不拉回班表開頭
//   （打卡 09:00–12:00、13:05–？＋補下班 18:00，原本第二段也變 09:00、兩段重疊）。兩段班的第二段照舊對第二段班表。
function missIn(hm, planSegs, before) {
  if (!hm) return hm;
  const m = hhmmToMin(hm);
  if (m === null) return hm;
  let best = null, bestD = null, bestS = null;
  (planSegs || []).forEach(p => {
    const s = p && hhmmToMin(p.start);
    if (s === null || s === undefined) return;
    const d = ((m - s + 720) % 1440 + 1440) % 1440 - 720;
    if (bestD === null || Math.abs(d) < Math.abs(bestD)) { bestD = d; best = p.start; bestS = s; }
  });
  const back = bestD !== null && (before || []).some(t => { const c = hhmmToMin(t); if (c === null) return false; const d = clockDiff(c, bestS); return d > -15 && d < bestD; });
  return bestD !== null && bestD > -15 && !back ? best : round15(hm, false);      // 遲到，或早到不滿 15 分（差不到 15 分鐘算照班表）→ 班表時間
}
// 打卡時間照參考時數的規則取整到 15 分（上班進位、下班捨去）
export function round15(hm, up) {
  if (!hm) return hm;
  let m = hhmmToMin(hm); if (m === null) return hm;
  m = up ? Math.ceil(m / 15) * 15 : Math.floor(m / 15) * 15; m = m % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
// 忘打卡預填：當天打卡段（取整）＋申請補的那一邊；只有上下班都齊的段才成為時段列。回 [{start,end}]（空陣列＝不動畫面）
// 取整（2026-11-10 Eason）：打卡時間一律往前取整到 15 分（10:20→10:15）；上班卡比班表晚時，上班留班表時間，薪資才標得出遲到分鐘。
// planSegs＝當天班表各段 [{start,end}]（沒有就只取整）
export function missPeriods(segments, r, planSegs) {
  const list = segments || [];
  const segs = list.map((x, i) => ({ in: missIn(x.in, planSegs, list.slice(0, i).reduce((a, y) => a.concat(y.in || [], y.out || []), [])), out: round15(x.out, false) }));
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
  return '\n本月補休明細：加班 ' + (Number(q.ot_h) || 0) + ' − 補休 ' + (Number(q.used_h) || 0) + ' ＝ ' + compBalWord(q)
    + (Number(q.balance_h) < 0 ? '（當月要用加班補平）' : '');
}

// ---- 核定工時的上下班時間跟班表連動（2026-10-29，docs/duty-shift-from-schedule/requirements.md）----
// 伺服器在 mgr_day 每人加 plan：{work:true, segs:[{start,end}], shift_name, station} 上班／{work:false, day_type, leave} 休假／null 或沒有＝那天沒排班（退回個人預設 shift_in–shift_out）。
const PLAN_OFF_TEXT = { R: '例假', H: '排休' };
const PLAN_LEAVE_TEXT = { '國': '國定', '特': '排特休', '補': '排補休', '事': '排事假', '病': '排病假', '婚': '排婚假', '喪': '排喪假', '公': '排公假', '產': '排產假', '陪': '排陪產假', '生': '排生理假', '家': '排家庭照顧假' };      // 對照排班 rules.js LEAVES（2026-11-14：喪假原本顯示成「排休」）
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
/**
 * 已核准申請的時數合計（只給畫面「共 N 小時」用，不影響核定）。出差在核定時數裡等同打卡，加班單是「超過 8 小時」那段的憑證：
 * 加班單時段跟同日已核准出差／請假時段重疊的部分，是同一段時間開了兩張單，不重複計入（部分重疊只扣重疊段；沒填起訖時段的單照加）。
 * 回 { hours, dup: { [加班單 id]: { min: 重疊分鐘, by: '出差'｜'請假'｜'出差、請假', full: 整張都重疊, counted: 這張實際計入的小時 } } }
 */
export function reqHoursSummary(reqs) {
  const list = (reqs || []).filter(Boolean);
  const span = r => { const a = hhmmToMin(r.start), b = hhmmToMin(r.end); return a == null || b == null || a === b ? null : [a, b < a ? b + 1440 : b]; };
  const cover = list.filter(r => (r.kind === 'trip' || r.kind === 'leave') && span(r)).map(r => ({ r, s: span(r) }));
  const dup = {};
  let hours = 0;
  list.forEach(r => {
    if (r.kind === 'miss') return;
    let h = Number(r.hours) || 0;
    const o = r.kind === 'ot' ? span(r) : null;
    if (o && cover.length) {
      // 逐分鐘標記：多張出差／請假彼此重疊時，同一分鐘不會扣兩次；跨午夜的單前後一天都比
      const mark = new Set(), by = new Set(), tripMark = new Set();
      const inSpan = (c, t) => [-1440, 0, 1440].some(d => t >= c.s[0] + d && t < c.s[1] + d);
      for (let t = o[0]; t < o[1]; t++) cover.forEach(c => { if (inSpan(c, t)) { mark.add(t); by.add(c.r.kind === 'trip' ? '出差' : '請假'); if (c.r.kind === 'trip') tripMark.add(t); } });
      if (mark.size) {
        const full = mark.size >= o[1] - o[0];
        h = full ? 0 : Math.max(0, h - mark.size / 60);      // 整張都被蓋住直接計 0（hours 存兩位小數，減分鐘會留尾巴）；部分蓋住才扣分鐘；合計最後才取兩位
        // tripFull＝整張加班單都落在出差時段內（只認出差）：一頁核定預檢濾掉加班單的條件用它，請假蓋住的不算
        dup[r.id] = { min: mark.size, by: ['出差', '請假'].filter(x => by.has(x)).join('、'), full, tripFull: tripMark.size >= o[1] - o[0], counted: round2(h) };
      }
    }
    hours += h;
  });
  return { hours: round2(hours), dup };
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
// 分段請假（2026-11-15 Eason：張羽成 11/4 補休 23:15–23:30＋15:00–16:30 被當成重複）：同一種假（或出差）的幾張單，
// 每張都有填起訖時段、時段兩兩不重疊、時數加總不超過 8 小時＝同一天分段請，不是舊單——合併成一列自動填（reqLeaveLines 同類加總）。
// 沒填時段、時段重疊、加總超過 8 小時、忘打卡單：照舊不自動填，逐張給主管選。
const hmMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : null; };
export function splitLeaveGroup(list) {
  if (!list || list.length < 2 || list.some(r => r.kind !== 'leave' && r.kind !== 'trip')) return false;
  const iv = [];
  for (const r of list) {
    const a = hmMin(r.start), b = hmMin(r.end);
    if (a == null || b == null || b === a) return false;
    iv.push(b > a ? [a, b] : [a, b + 1440]);
  }
  iv.sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < iv.length; i++) if (iv[i][0] < iv[i - 1][1]) return false;
  const sum = list.reduce((t, r) => t + (Number(r.hours) || 0), 0);
  return sum > 0 && sum <= 8 + 1e-9;
}
export function reqPlan(reqs) {
  const fillables = (reqs || []).filter(r => r.kind !== 'ot');
  const keys = fillables.map(reqKey);
  const groupOf = k => fillables.filter(r => reqKey(r) === k);
  const split = new Set(keys.filter((k, i) => keys.indexOf(k) !== i && k !== 'miss' && splitLeaveGroup(groupOf(k))));
  const dup = keys.some((k, i) => keys.indexOf(k) !== i && !split.has(k));
  const multi = dup || new Set(keys.filter(k => k !== 'miss')).size > MAX_LEAVE_LINES;
  const older = r => r.kind !== 'ot' && !split.has(reqKey(r)) && fillables.some(q => q !== r && reqKey(q) === reqKey(r)
    && (r.kind !== 'miss' || q.miss_type === r.miss_type) && !!r.created_at && !!q.created_at && String(q.created_at) > String(r.created_at));      // 缺送出時間就不判舊單（2026-10-29 Fable 審查第 7 條）
  return { fillables, multi, older, split };
}
// 申請預填的假別列：請假→{假別,時數}、出差→{出差,時數}
// 同一種假別多張（分段請假）合併成一列、時數加總（2026-11-15）；任何一張沒填時數＝這列時數空白（請主管填）
export const reqLeaveLines = list => {
  const out = [];
  (list || []).filter(r => r.kind === 'leave' || r.kind === 'trip').forEach(r => {
    const type = r.kind === 'trip' ? '出差' : (r.leave_type || ''), hours = (r.hours === 0 || r.hours) ? r.hours : '';
    if (!type) return;
    const x = out.find(y => y.type === type);
    if (!x) { out.push({ type, hours }); return; }
    x.hours = x.hours === '' || hours === '' ? '' : Math.round((Number(x.hours) + Number(hours)) * 100) / 100;
  });
  return out;
};

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
    if (keep) parts.push('以 ' + keep.hm + ' 為準（' + rest.join('、') + ' 不算忘打卡）');
  });
  return parts.length ? '重複打卡：' + parts.join('；') : '';
}
// 「有打卡段還沒打下班卡」的警告不算重複上班卡組裡前面那幾張（它們配不到下班卡是因為後面又打了一張，不是還在上班）
export function hasOpenSegExceptDup(segments, groups) {
  const early = new Set();
  (groups || []).filter(g => g.type === 'in').forEach(g => g.cards.slice(0, -1).forEach(c => early.add(c.hm)));
  return (segments || []).some(s => s.in && !s.out && !early.has(s.in));
}

/** 正職上班日滿 8 小時（2026-11-13 Eason）：卡片合計列。emp.ft===true 且班表是上班日（W）才回 {work, trip, leave, sum, gap}，否則 null。
 *  假單只算登記的（出差另計）；真正擋不擋看打卡端（看已核准的申請單、跨店相加），這裡只是先讓主管看到差多少。 */
export const FT8_H = 8;
export function ft8Summary(emp, workH, leaves) {
  if (!emp || emp.ft !== true || !emp.plan || emp.plan.day_type !== 'W') return null;
  const trip = tripHoursOfList(leaves || []);
  const leave = round2((leaves || []).reduce((a, x) => a + (x && x.type && x.type !== '出差' ? Number(x.hours) || 0 : 0), 0));
  // 同一天在同一單位別家店上班的時數也算進 8 小時（同打卡端跨店相加；2026-11-18 張淳 總部 6.75＋金山 2 被寫「還差 1.25 小時」）
  const others = elsewhereHours(emp), other = round2(others.reduce((a, x) => a + x.h, 0));
  const work = round2(Number(workH) || 0), sum = round2(work + trip + leave + other);
  const out = { work, trip, leave, sum, gap: sum >= FT8_H - 0.005 ? 0 : round2(FT8_H - sum) };
  return others.length ? Object.assign(out, { other, others }) : out;
}
export function ft8Text(s) {
  if (!s) return '';
  const oth = (s.others || []).map((x) => '＋' + x.label + ' ' + x.h).join('');
  return '正職上班日：上班 ' + s.work + '＋出差 ' + s.trip + '＋假單 ' + s.leave + oth + '＝' + s.sum + '／' + FT8_H + ' 小時' + (s.gap ? '，還差 ' + s.gap + ' 小時，要有已核准的假單或補休單' : '');
}
/* ── 卡片只顯示打卡系統的結論（2026-11-25 Eason 開工確認 A，docs 見 PR）──
   「連同別家夠不夠 8 小時、要不要加班單」規則只有打卡系統一份（11/24 起連別家已核准的出差單也算），營運系統看不到別家的出差單、假單，
   所以這家自己不滿 8 小時時，畫面不再自己寫「還差幾小時」：打卡系統還沒回覆＝待確認；檢查通過＝寫「連同同一天別家已滿 8 小時」；被擋＝照打卡系統原句。
   這家自己就滿 8 小時＝照舊（ft8Text）。 */
/** 這家自己的合計（不含別家）：{work, trip, leave, sum, gap}；不是正職上班日＝null */
export function ft8Own(emp, workH, leaves) {
  return emp ? ft8Summary(Object.assign({}, emp, { elsewhere: [] }), workH, leaves) : null;
}
export const FT8_WAIT_TAG = '未滿 8 小時（待確認）';
/** 這次打卡系統會不會檢查「正職上班日滿 8 小時」（伺服器 mgr_day 每列的 ft8_on，2026-11-25 #409 審查第 2、3 項）：
 *  ＝個人帳號登入（核定帶 acting_name，打卡端 Code.gs 才採信 sched_ft）而且 schedFtHome 判正職上班日（支援帳號看原單位）。
 *  不是 true（門市共用登入、舊伺服器沒給）＝打卡系統不檢查或不知道 → 滿 8 小時的卡片與那一行照主線（11/25 以前）寫法，不套待確認、不套保險 */
export const ft8Live = (emp) => !!emp && emp.ft8_on === true;
/** 保險用的「這家合計」：只在 ft8Live 時有值；支援帳號在這家 emp.ft 常是 null，照打卡端（sched_ft＝原單位正職）當正職算；
 *  這家班表是休息日／例假（H／R）＝打卡端不套滿 8 → null */
export function ft8GuardOwn(emp, workH, leaves) {
  if (!ft8Live(emp)) return null;
  const dt = emp.plan && emp.plan.day_type;
  if (dt === 'H' || dt === 'R') return null;
  return ft8Own(Object.assign({}, emp, { ft: true, plan: Object.assign({}, emp.plan || {}, { day_type: 'W' }) }), workH, leaves);
}
/** 一頁核定「待確認」那句；how＝'wait' 確認中、'fail' 讀不到、其他＝還沒確認 */
export function ft8WaitNote(own, how) {
  const tail = how === 'wait' ? '（確認中…）' : how === 'fail' ? '（打卡系統讀不到，還沒確認）' : '（還沒確認，請按「手動修改」）';
  return '這家 ' + own + ' 小時。打卡系統會連同同一天別家的核定、假單、出差單一起算' + tail;
}
/** 打卡系統檢查結果裡「正職上班日要滿 8 小時」的原句（照抄，不改寫） */
export function ft8ProbTexts(ck) {
  return (ck && Array.isArray(ck.probs) ? ck.probs : []).filter((p) => p && /^ft8/.test(String(p.rule || '')) && p.text).map((p) => String(p.text));
}
/** 打卡系統「滿 8 小時、兩家合計要不要加班單」那幾句（Requests.gs reqFt8_ 出的：rule ft8，或 ot_hours／ot_peer 以「兩家上班合計」開頭）——一頁核定卡片照原文顯示 */
export const isFt8Raw = (p) => !!p && !!p.text && (/^ft8/.test(String(p.rule || '')) || ((p.rule === 'ot_hours' || p.rule === 'ot_peer') && /^兩家上班合計/.test(String(p.text))));
/* ── 滿 8 小時的保險（2026-11-25 主管裁示 A，#409）──
   打卡系統有兩種「先放行」：同一天別家有打卡還沒核定、讀不到別家——這兩種情況這家不滿 8 小時也會檢查通過。
   所以這家不滿 8、打卡系統說可以時，營運系統自己也要在副本看得到別家夠：
     看得到的合計＝這家（上班＋出差＋假單）＋同一單位每家別店［已核定＝核定時數；沒核定也沒打卡＝已核准出差單；沒核定有打卡＝0］＋別店已核准假單
     （伺服器 attachElsewhere 附的 emp.ft8_peer，口徑同打卡端 reqPeerOne_／reqPeerAdd_；server/duty-elsewhere.js peerOf）。
     副本讀不到或不新鮮的那家＝看不到（伺服器不列），只會讓合計變少；沒有 ft8_peer（舊伺服器、副本沒開）或 ok 不是 true（這家同名兩位）＝全部看不到。
   合計滿 8＝放進核定通過、可以一鍵；不滿 8＝待確認（寫原因、要核定按手動修改）。
   只當保險：合計不拿來顯示「還差幾小時」。 */
/** {ok:true} 或 {ok:false, why:'pending'（副本看得到同一天別家有打卡還沒核定）|'unread'（營運系統看不到夠的時數，原因不一定：別家讀不到、副本不新鮮、同名兩位…，句子不寫原因）} */
export function ft8Seen(emp, own) {
  const p = emp && emp.ft8_peer;
  if (!p || typeof p !== 'object' || p.ok !== true || !Array.isArray(p.by)) return { ok: false, why: 'unread' };
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  let sum = n(own), pending = false;
  p.by.forEach((x) => {
    if (!x || typeof x !== 'object') return;
    if (x.approved != null && Number.isFinite(Number(x.approved))) sum += n(x.approved);      // 那家已核定：核定時數（已含登記的出差，不再加出差單）
    else if (x.punched) pending = true;                                                         // 那家有打卡還沒核定：打卡系統先放行，營運系統不算
    else sum += n(x.tp);                                                                        // 那家沒核定也沒打卡：已核准出差單
    sum += n(x.lv);                                                                             // 那家已核准假單：都算（同打卡端）
  });
  return round2(sum) >= FT8_H - 0.005 ? { ok: true } : { ok: false, why: pending ? 'pending' : 'unread' };
}
/** 一頁核定：打卡系統說可以、營運系統看不到夠（ft8Seen 不 ok）時卡片那句（待確認，不能一鍵） */
export function ft8GuardNote(own, why) {
  return '這家 ' + own + ' 小時。' + (why === 'pending'
    ? '同一天別家有打卡還沒核定，打卡系統先放行；營運系統還看不到別家核定的時數，要核定請按「手動修改」'
    : '打卡系統檢查通過，但營運系統看不到同一天別家有沒有滿 ' + FT8_H + ' 小時，要核定請按「手動修改」');
}
/** 這家自己不滿 8、打卡系統檢查通過、營運系統也看得到夠（ft8Seen ok）：核定通過卡那一行 */
export function ft8PassText() {
  return '連同同一天別家已滿 ' + FT8_H + ' 小時';
}
/** 待確認的卡上「同一天也在別家」那句（2026-11-25 #409 第 3 件）：確認前只寫看得到的事實，不寫合計、要不要加班單這種像結論的話。
 *  waiting＝打卡系統還在確認（句尾說等確認）；不是正職上班日、沒有同一單位別家的時數＝null */
export function crossFact(emp, waiting) {
  if (!emp || emp.ft !== true || !emp.plan || emp.plan.day_type !== 'W') return null;
  const xs = elsewhereHours(emp);
  if (!xs.length) return null;
  return '今天也在' + xs.map((x) => x.label + (x.est ? '有打卡，約 ' + x.h + ' 小時（那邊還沒核定）' : '上班 ' + x.h + ' 小時（那邊已核定）')).join('、') +
    (waiting ? '；兩家合計、要不要加班單，等打卡系統確認後才會寫' : '');
}
/** 手動修改頁「正職上班日」那一行 → {text, cls}（cls：'' 照舊、'short' 紅字、'pass' 黑字、'wait' 灰字）；不是正職上班日＝null。
 *  s＝ft8Summary（含別家，照舊那句用）、own＝ft8Own、ck＝這組時段的檢查結果（null＝還沒回來、逾時、讀不到、時段改過） */
export function ft8Line(emp, s, own, ck) {
  if (!ft8Live(emp)) return s ? { text: ft8Text(s), cls: s.gap ? 'short' : '' } : null;      // 打卡系統不檢查滿 8（門市共用登入、舊伺服器）：照主線那一行
  if (!s || !own) return null;
  if (!own.gap) return { text: ft8Text(s), cls: s.gap ? 'short' : '' };      // 這家自己就滿 8：逐字照舊
  const raw = ft8ProbTexts(ck);
  if (raw.length) return { text: raw.join('；'), cls: 'short' };
  if (ck && ck.ok === true) {
    const g = ft8Seen(emp, own.sum);      // 保險（主管裁示 A）：營運系統也看得到別家夠才寫「已滿 8 小時」；看不到＝灰字寫原因（不下結論，送出時的檢查照舊）
    if (g.ok) return { text: '正職上班日：這家 ' + own.sum + ' 小時，' + ft8PassText() + '（打卡系統檢查通過）', cls: 'pass' };
    return { text: '正職上班日：這家 ' + own.sum + ' 小時。' + (g.why === 'pending'
      ? '同一天別家有打卡還沒核定，打卡系統先放行（營運系統看不到別家核定的時數，請自己確認別家的時數再送出）'
      : '打卡系統檢查通過，但營運系統看不到同一天別家有沒有滿 ' + FT8_H + ' 小時（請自己確認再送出）'), cls: 'wait' };
  }
  return { text: '正職上班日：這家 上班 ' + own.work + '＋出差 ' + own.trip + '＋假單 ' + own.leave + '＝' + own.sum + ' 小時（打卡系統會連同同一天別家的核定、假單、出差單一起算）', cls: 'wait' };
}

/* ── 跨店加班歸屬（2026-11-18 Eason；同打卡端 Requests.gs reqFt8Split_）──
   同一天在原單位和支援單位都上班（同一單位才相加：墨竹亭↔總部、總部↔小辛辣；小辛辣↔墨竹亭不算），合計超過 8 小時的加班算支援單位，
   最多到那家自己上班的時數，超過的留原單位；支援兩家以上只在支援單位之間比，時數長的吸收，一樣長算後上班那家。
   這裡只產生卡片提醒，擋不擋看打卡端。別家還沒核定時照打卡估（上班卡往後、下班卡往前取到 15 分）。 */
const q15up = (m) => Math.ceil(m / 15) * 15, q15dn = (m) => Math.floor(m / 15) * 15;
const hmMinL = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
/** emp.elsewhere 裡同一單位、有上班的店 → [{label, code, h, est, fs}] */
export function elsewhereHours(emp) {
  return (Array.isArray(emp && emp.elsewhere) ? emp.elsewhere : []).filter((x) => x && x.unit !== false).map((x) => {
    const segs = Array.isArray(x.segs) ? x.segs : [];
    let fs = null, est = 0;
    segs.forEach((sg) => {
      const a = hmMinL(sg && sg.in); let b = hmMinL(sg && sg.out);
      if (a != null && (fs == null || a < fs)) fs = a;
      if (a == null || b == null) return;
      if (sg.cross || b <= a) b += 1440;
      const qa = q15up(a), qb = q15dn(b);
      if (qb > qa) est += qb - qa;
    });
    const ap = x.approved != null && isFinite(Number(x.approved)) ? Number(x.approved) : null;
    return { label: String(x.label || '別店'), code: String(x.code || ''), h: round2(ap != null ? ap : est / 60), est: ap == null, fs };
  }).filter((x) => x.h > 0);
}
/** 卡片提醒：{text, comb, need, absLabel, atSup, here}；不是正職上班日、沒有同一單位別家的上班 → null。ownH＝這家要核定的時數、ownFs＝這家最早開始（分鐘，可省） */
export function crossOt(emp, ownH, ownFs) {
  if (!emp || emp.ft !== true || !emp.plan || emp.plan.day_type !== 'W') return null;
  const others = elsewhereHours(emp);
  if (!others.length) return null;
  const own = round2(Number(ownH) || 0);
  const comb = round2(own + others.reduce((a, x) => a + x.h, 0)), need = Math.max(0, round2(comb - FT8_H));
  const role = (emp && emp.cross_role) || {}, support = role.support === true, home = String(role.home || '');
  const sups = support ? [{ label: '這家', self: true, h: own, fs: ownFs == null ? null : ownFs }].concat(home ? others.filter((x) => x.code !== home) : []) : others.slice();
  let abs = null;
  sups.forEach((x) => {
    if (!(x.h > 0)) return;
    if (!abs || x.h > abs.h + 0.005) { abs = x; return; }
    if (Math.abs(x.h - abs.h) <= 0.005 && x.fs != null && (abs.fs == null || x.fs > abs.fs)) abs = x;
  });
  const atSup = abs ? round2(Math.min(need, abs.h)) : 0, atHome = round2(need - atSup);
  const here = abs && abs.self ? atSup : (support ? 0 : atHome);
  const est = others.some((x) => x.est);
  let text = '今天也在' + others.map((x) => x.label + '上班 ' + x.h + ' 小時').join('、') + (est ? '（那邊還沒核定，照打卡估）' : '') + '，合計 ' + comb + ' 小時';
  if (need <= 0.005) text += '，沒超過 ' + FT8_H + ' 小時，不用加班單';
  else if (abs && abs.self) text += '；超過 ' + FT8_H + ' 小時的 ' + atSup + ' 小時算這家的加班，要有 ' + atSup + ' 小時加班單' + (atHome > 0.005 ? '（另外 ' + atHome + ' 小時算原單位）' : '');
  else if (abs) text += '；' + abs.label + '的 ' + abs.h + ' 小時裡有 ' + atSup + ' 小時是加班，加班單開在' + abs.label + (here > 0.005 ? '；這家另外要開 ' + here + ' 小時加班單' : '，這家不用開');
  return { text, comb, need, absLabel: abs ? abs.label : '', atSup, here };
}
/** 核定說明：有跨店提醒時，拿掉只看本店的「班表外多做…不用加班單」（core-calc.js 的說明；結尾要維持「不用加班單）」，下面用它認），換成跨店那句 */
export function crossNotes(emp, notes, ownH, ownFs) {
  const list = Array.isArray(notes) ? notes.slice() : [];
  const x = crossOt(emp, ownH, ownFs);
  if (!x) return list;
  return list.filter((n) => !/不用加班單）$/.test(String(n))).concat([x.text]);
}
/** 代開假單預填時數：還差的時數往上取到半小時（LINE 申請最小 0.5 小時） */
export const ft8Round = (gap) => Math.max(0.5, Math.ceil((Number(gap) || 0) * 2 - 1e-9) / 2);

// 「要處理」改成直接講要怎麼改單（2026-11-15 Eason：不說明原因，直接跟主管說要什麼單才能通過；所有同仁一體適用）。
// p＝打卡端回的 {rule, text}；ps＝核定時段字串（「11:30–17:30、18:30–20:15」）。認不出的格式照原文。
const HM_RE = /(\d{1,2}:\d{2})[–-](\d{1,2}:\d{2})/g;
const fxMin = s => { const [a, b] = s.split(':').map(Number); return a * 60 + b; };
const fxHm = m => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
function spansOf(s) { const out = []; let m; HM_RE.lastIndex = 0; while ((m = HM_RE.exec(String(s || '')))) { const a = fxMin(m[1]); let b = fxMin(m[2]); if (b <= a) b += 1440; out.push([a, b]); } return out; }
export function fixText(p, ps) {
  const t = String((p && p.text) || ''), rule = p && p.rule;
  let m;
  if (rule === 'ot_void' && (m = /卻有 ([\d.]+) 小時的已核准加班單/.exec(t))) return '把已核准的加班單（' + m[1] + ' 小時）作廢';
  if (rule === 'ot_hours' && (m = /^加班單 ([\d.]+) 小時比應有的 ([\d.]+) 小時多/.exec(t))) return '加班單改成 ' + m[2] + ' 小時（現在 ' + m[1] + ' 小時）';
  if (rule === 'ot_slot' && (m = /^加班單 (\d{1,2}:\d{2})[–-](\d{1,2}:\d{2})/.exec(t))) {
    const [ot] = spansOf(m[1] + '–' + m[2]);
    const hit = spansOf(ps).map(([a, b]) => [Math.max(a, ot[0]), Math.min(b, ot[1])]).filter(([a, b]) => b > a);
    if (hit.length === 1) return '加班單 ' + m[1] + '–' + m[2] + ' 改成 ' + fxHm(hit[0][0]) + '–' + fxHm(hit[0][1]);
    return '加班單 ' + m[1] + '–' + m[2] + ' 改到核定時段內' + (ps ? '（' + ps + '）' : '');
  }
  if (rule === 'ot_in_sched' && (m = /^加班單 (\d{1,2}:\d{2})[–-](\d{1,2}:\d{2}).*?在班表上班時段內（(.*)）/.exec(t))) {
    const [ot] = spansOf(m[1] + '–' + m[2]);
    const ends = spansOf(m[3]).map(x => x[1]).filter(e => e > ot[0] && e < ot[1]);
    if (ends.length) return '加班單 ' + m[1] + '–' + m[2] + ' 改成 ' + fxHm(Math.max(...ends)) + '–' + m[2] + '（從班表下班開始）';
    return '加班單 ' + m[1] + '–' + m[2] + ' 改到班表下班之後';
  }
  if (rule === 'leave') {
    if ((m = /^登記了(.+?) ([\d.]+) 小時，但沒有已核准的(假單|出差單)$/.exec(t))) return '補' + m[1] + ' ' + m[2] + ' 小時的' + m[3] + '（或核定拿掉這筆' + m[1] + '）';
    if ((m = /^(.+?)核定登記 ([\d.]+) 小時，已核准的單是 ([\d.]+) 小時$/.exec(t))) return '核定的' + m[1] + '改成 ' + m[3] + ' 小時';
    if ((m = /^有已核准的(.+?) ([\d.]+) 小時，核定沒有登記$/.exec(t))) return '核定登記' + m[1] + ' ' + m[2] + ' 小時';
  }
  return t;
}

// 重複打卡選了「以 X 為準」：打卡段照選的那張重組，給「打卡＋單」重算用（2026-11-15 Eason：按了要馬上看到結果）。
// 下班卡組：沒選的那張若是「？–沒選」孤卡就拿掉；若是配對段的下班（07:54–17:28 而選 17:39）→ 下班改成選的那張、拿掉「？–17:39」孤卡。上班卡組對稱。
// 只回新陣列，不改原本的 segments；送給打卡端的仍是 dup_ignore（正本在打卡端 dupIgnoreInvalid_）。
export function segsWithDupPicks(segs, groups, picks) {
  let out = (segs || []).map(s => Object.assign({}, s));
  (groups || []).forEach((g, i) => {
    const k = (picks || [])[i]; if (!k) return;
    const keep = g.cards.find(c => c.ts === k); if (!keep) return;
    const side = g.type === 'in' ? 'in' : 'out', other = side === 'in' ? 'out' : 'in';
    g.cards.filter(c => c.ts !== k).forEach(c => {
      const s = out.find(x => x[side] === c.hm); if (!s) return;
      if (!s[other]) { out = out.filter(x => x !== s); return; }                     // 孤卡：拿掉
      const orphan = out.find(x => x !== s && x[side] === keep.hm && !x[other]);     // 選的那張是孤卡：併進配對段
      s[side] = keep.hm;
      if (orphan) out = out.filter(x => x !== orphan);
    });
  });
  return out;
}
