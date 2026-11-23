// 系統鎖卡標示（2026-11-23 Eason：「如果是系統鎖卡，在核定工時的打卡紀錄上有（）備註系統鎖定」）。
// 資料：打卡端 mgr_day 每人 cap_sys＝['21:49']（Cap10.gs capAnnotateDay_：那天 00:00 到隔天 06:00 寫的系統下班卡，source＝system_cap），
//   mini 考勤副本原樣存、營運系統 proxy 不濾欄位，所以前端拿得到。只改顯示：不碰核定計算、預填、送出內容。
// 對法：打卡段的下班時間（HH:MM）跟 cap_sys 其中一個相同＝那張下班卡是系統鎖卡，時間後面加「（系統鎖定）」。
//   已知限制：cap_sys 只有時鐘時間，隔天 00:00–06:00 的系統卡跟當天同一個時鐘時間的本人下班卡分不出來（要同一分鐘，實務上不會碰到）。
export const CAP_LOCK_MARK = '（系統鎖定）';

const hm5 = (v) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v == null ? '' : v).trim());
  return m ? m[1].padStart(2, '0') + ':' + m[2] : null;
};

/** 這個時間（'HH:MM'）是系統鎖卡 → '（系統鎖定）'；不是、或沒有 cap_sys → '' */
export function capLockMark(hm, capSys) {
  const k = hm5(hm);
  if (!k || !Array.isArray(capSys) || !capSys.length) return '';
  return capSys.some((x) => hm5(x) === k) ? CAP_LOCK_MARK : '';
}

/** cap_sys 裡對不到任何一段下班卡的時間（例：系統卡沒配到上班卡）——完整頁照原本的寫法另外註明，不讓資訊消失 */
export function capUnmatched(capSys, segments) {
  const outs = new Set((Array.isArray(segments) ? segments : []).map((s) => hm5(s && s.out)).filter(Boolean));
  return (Array.isArray(capSys) ? capSys : []).filter((x) => { const k = hm5(x); return k && !outs.has(k); });
}
