// 一鍵核定整批檢查假別額度（2026-11-19）：這一批含新請假的人，用同一份「剛向打卡讀的」額度依序判斷。
// 額度是每人各自的（薪資 Payroll.gs payLeaveUsage 以員編算），不同人不會互扣；同一人同一天幾個假別扣到同一個額度時（同一假別，或子假別併入目標假別，見下方 leaveShort），前面的先扣掉再判斷後面的。
// 硬上限的判斷跟畫面上同一套（quickcalc leaveProblem：額度已用完 blocked、期限、計時沒有補休）；只有「曆年制／每子女制、非事假」這種硬上限才扣（同 calc.js quotaHardBlocked＋上游 blocked 只看 calendar/child）。
import * as C from './calc.js';
import { leaveProblem } from './quick-calc.js';

/** 這次要登記的假別比原本多出來的部分（同一假別從 1 小時改成 8 小時＝多 7 小時要查；出差不查；沒增加的不查）（2026-11-19 第二輪審查） */
export function leaveIncrements(leaves, prev) {
  const before = new Map();
  for (const x of prev || []) if (x && x.type) before.set(x.type, (before.get(x.type) || 0) + (Number(x.hours) || 0));
  const out = [];
  for (const L of leaves || []) {
    if (!L || !L.type || L.type === '出差') continue;
    const inc = (Number(L.hours) || 0) - (before.get(L.type) || 0);
    if (!before.has(L.type)) out.push({ type: L.type, hours: L.hours });
    else if (inc > 0.0001) out.push({ type: L.type, hours: Math.round(inc * 100) / 100 });
  }
  return out;
}

// 額度「夠不夠這次增加」（2026-11-19 第三輪審查）：硬上限假別（同 calc.js quotaHardBlocked：不是事假、不是補休，有 cap_days 與剩餘日數）
//   本批前面已扣的日數＋這次增加的時數／day_hours ≤ remain_days 才送。
//   main 只擋「已經用完（blocked）」：剩 0.5 日還能一次登記 8 小時。這裡改成增加量超過剩餘也不送；LEAVE_ENOUGH=false 回到 main 的「用完才擋」。
//   生理假的額度是次數（4 小時也算 1 次），不用時數換算，照舊只看用完沒有。待 Eason 確認（第三輪審查第 3 項）。
// 併入（merge_into，2026-11-20 第五輪審查）：對齊上游 mala-clock-in Payroll.gs payLeaveUsage（約 2459–2470）與計薪 used_before（約 2105–2111）——
//   子假別先用「自己那一列」的額度（例：家庭照顧假自己 7 日、生理假自己 3 次），在自己上限內不佔目標假別；只有超過自己上限的部分併入目標假別。
//   子假別沒有自己的上限（額度裡沒有它那一列、或 cap_days 空白）＝整筆併入（Payroll.gs:2110 `cap_days == null ? u`）。
//   目標假別是硬上限時：本批同一人直接登記的＋併入的，一起跟目標假別的剩餘比。不同人各算各的。
//   事件制（婚喪產檢 basis=event）上游 blocked 永遠 false（一年可能好幾次事件，硬擋會擋錯），這裡也不扣、不擋。
export const LEAVE_ENOUGH = true;
const r1 = (x) => Math.round(x * 10) / 10;
const capped = (q) => !!(q && q.cap_days != null && q.remain_days != null && isFinite(Number(q.remain_days)));
/** 這個假別這一列要不要照剩餘硬擋：曆年制／每子女制（上游 blocked 的條件）、不是事假、不是補休。額度沒帶 basis 時保守當硬上限 */
function hardCap(def, q) {
  if (!def || !capped(q)) return false;
  const b = q.basis != null ? String(q.basis) : (def.cap_basis != null ? String(def.cap_basis) : '');
  if (b && b !== 'calendar' && b !== 'child') return false;
  return C.quotaHardBlocked(def, Object.assign({}, q, { blocked: true }));
}
const typeByCode = (LO, code) => ((LO && Array.isArray(LO.types)) ? LO.types.filter((x) => x && x.code === code)[0] : null) || null;
/** 一個人這次增加的假別（inc＝leaveIncrements 的結果）能不能送。used：Map(員編|假別代號 → 本批前面已扣的日數)，不會改它。
 *  回 { why: ''＝可以送／不送的原因, add: Map(同鍵 → 這個人扣完後的日數) }；單筆送出（leaveFreshOk）與一鍵整批（batchLeaveDecide）共用 */
export function leaveShort(LO, empId, inc, date, used, enough) {
  const on = enough === undefined ? LEAVE_ENOUGH : !!enough;
  const prob = leaveProblem(LO, empId, inc, date);
  if (prob) return { why: '假別額度剛更新：' + prob + '，這次沒有送出', add: new Map() };
  const dayH = Number(LO.day_hours) > 0 ? Number(LO.day_hours) : 8;
  const mine = new Map(), u = used || new Map();
  const got = (k) => (mine.has(k) ? mine.get(k) : (u.get(k) || 0));
  for (const L of inc || []) {
    const d0 = C.leaveDefOf(LO, L.type);
    if (!d0) continue;
    const q0 = C.quotaOf(LO, String(empId), d0.code), need = (Number(L.hours) || 0) / dayH;
    let spill = 0;
    // ① 自己那一列
    if (capped(q0)) {
      const k = String(empId) + '|' + d0.code, before = got(k), remain = Number(q0.remain_days);
      if (hardCap(d0, q0)) {
        if (remain - before <= 1e-9) return { why: '假別額度剛更新：' + L.type + ' 額度已用完，這次沒有送出', add: new Map() };
        if (on && d0.code !== 'menstrual' && before + need > remain + 1e-9) return { why: '假別額度不夠：' + L.type + ' 只剩 ' + r1((remain - before) * dayH) + ' 小時，這次要再登記 ' + r1(Number(L.hours) || 0) + ' 小時，這次沒有送出', add: new Map() };
      }
      mine.set(k, before + need);
      // 超過自己剩餘的部分才併入（生理假的額度是次數、一天一次，過了上面「用完」那關就不會超過，不用時數換算）
      if (d0.merge_into && d0.code !== 'menstrual') spill = Math.max(0, before + need - remain) - Math.max(0, before - remain);
    } else if (d0.merge_into) spill = need;      // 沒有自己的上限：整筆併入
    // ② 併入目標假別
    if (d0.merge_into && spill > 1e-9) {
      const dT = typeByCode(LO, d0.merge_into), qT = dT ? C.quotaOf(LO, String(empId), dT.code) : null;
      if (hardCap(dT, qT)) {
        const k = String(empId) + '|' + dT.code, before = got(k), remain = Number(qT.remain_days);
        const tail = ' 只剩 ' + r1(Math.max(0, remain - before) * dayH) + ' 小時，這次要再登記 ' + r1(spill * dayH) + ' 小時（' + L.type + ' 併入 ' + dT.name + ' 的額度計算），這次沒有送出';
        if (remain - before <= 1e-9) return { why: '假別額度剛更新：' + L.type + ' 額度已用完：' + dT.name + tail, add: new Map() };
        if (on && before + spill > remain + 1e-9) return { why: '假別額度不夠：' + L.type + tail, add: new Map() };
        mine.set(k, before + spill);
      }
    }
  }
  return { why: '', add: mine };
}

/** people：[{ key, emp_id, date, leaves:[{type,hours}] }]（leaves＝這次新登記的假別）；LO：這家店剛讀到的額度（null＝讀不到）。
 *  回 Map(key → '' 可以送／不送的原因) */
export function batchLeaveDecide(LO, people, enough) {
  const res = new Map(), used = new Map();
  for (const p of people || []) {
    if (!LO || !Array.isArray(LO.types)) { res.set(p.key, '假別額度讀不到，含請假的核定這次沒有送出，請稍後再試'); continue; }
    const r = leaveShort(LO, p.emp_id, p.leaves, p.date, used, enough);
    if (r.why) { res.set(p.key, r.why); continue; }
    r.add.forEach((v, k) => used.set(k, v));      // 這個人全部可以才算進本批已扣
    res.set(p.key, '');
  }
  return res;
}
