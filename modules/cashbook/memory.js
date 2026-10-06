// 常用項目記憶：打過的廠商／項目，下次打字就自動帶出來，連科目一起填好。
// 規則照抄原系統 ~/mala-cashbook/js/memory.js；資料正本在後端（每店各自一份），這裡只是對 S.frequent 做篩選。
//
// 記憶的方向是「項目名稱 → 科目」，不是反過來——店長看著收據時想到的是廠商名，不是「食材」。
// 所以表單把項目名稱放在科目上面，科目由記憶推出來。
export const MAX_CHIPS = 8;   // 2026-09-08 Eason 拍板：候選固定 8 個，不要更多

/* 進來就正規化成字串：試算表時代會把純數字的項目名稱回成 Number，後面 .toLowerCase() 會炸 */
export function norm(f) {
  return {
    subject: String(f && f.subject != null ? f.subject : ''),
    name: String(f && f.name != null ? f.name : ''),
    count: Number(f && f.count) || 0,
    lastUsed: String(f && f.lastUsed != null ? f.lastUsed : ''),
  };
}

/* 排序一律用「最後使用時間」而不是「使用次數」——店裡換了廠商之後，
   舊廠商的累積次數還是最高，用次數排會一直把已經不用的東西推到最前面（2026-09-08 Eason 確認）。 */
function byRecent(a, b) { return (b.lastUsed || '') < (a.lastUsed || '') ? -1 : 1; }
function inScope(f, subjects) { return !subjects || subjects.indexOf(f.subject) >= 0; }

/* 還沒打字時：最近用過的 8 個。subjects＝目前收支別的科目清單，避免在「收入」畫面跳出支出的廠商。 */
export function recent(list, subjects) {
  return list.map(norm).filter(f => inScope(f, subjects)).sort(byRecent).slice(0, MAX_CHIPS);
}

/* 打字中：名稱含有這段字的候選。空字串就回最近用過的。 */
export function suggest(list, text, subjects) {
  const q = String(text || '').trim();
  if (!q) return recent(list, subjects);
  const lower = q.toLowerCase();
  return list.map(norm).filter(f => inScope(f, subjects) && f.name.toLowerCase().indexOf(lower) >= 0).sort(byRecent).slice(0, MAX_CHIPS);
}

/* 這個項目名稱以前用過嗎？用過就回它上次記在哪個科目；找不到＝新項目。 */
export function subjectOf(list, name, subjects) {
  const q = String(name || '').trim();
  if (!q) return null;
  const hits = list.map(norm).filter(f => inScope(f, subjects) && f.name.trim() === q).sort(byRecent);
  return hits.length ? hits[0].subject : null;
}

/* 記一筆之後在本地補記（後端回了 frequent 就直接用後端的，這支只在「逾時後查回來」那條路用）。 */
export function remember(list, subject, name) {
  const out = list.map(norm);
  const now = new Date().toISOString();
  const hit = out.find(f => f.subject === subject && f.name === name);
  if (hit) { hit.count += 1; hit.lastUsed = now; } else out.push({ subject, name, count: 1, lastUsed: now });
  return out;
}
