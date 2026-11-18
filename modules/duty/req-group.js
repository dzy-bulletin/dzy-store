// 「同一次送出」（2026-11-18 一次填兩段）：同仁一天兩段加班／請假／出差一次送出，打卡端拆成兩張普通的單、標上同一個組別。
// 這支只做「畫面分組」的純函式（沒有 DOM、不碰網路；node 測試直接 require）：核定、預檢、薪資都不看這個欄位，一行都不動。
// 欄位：打卡端 reqPublic_ 回 group（同一次送出的標記）與 seg（第幾段）；舊資料沒有這兩欄＝照舊單張顯示。
// 也收 grp（試算表欄位名）——兩種寫法都認，免得後端對外欄位名改了畫面就失靈。

export const SEG_MAX_OT_ADMIN = 10;   // 店長代開加班兩段合計上限小時（Eason 2026-11-18 N1 再確認：代開也是 10 小時）；要改只改這一個數字（mock.js 示範後端、打卡端各有自己的一份）
export const SEG_MAX_PROXY_SEGS = 2;  // 一次最多兩段（第三段照現在另送一張）

// 這張單的「同一次送出」標記；沒有＝空字串
export function groupOf(it) {
  if (!it || typeof it !== 'object') return '';
  const g = it.group != null && it.group !== '' ? it.group : it.grp;
  return g == null ? '' : String(g).trim();
}
// 這張單是第幾段（打卡端給的 seg；沒給或不是 1 以上整數＝0，由呼叫端依時間排）
export function segOf(it) {
  const n = Number(it && it.seg);
  return Number.isInteger(n) && n >= 1 ? n : 0;
}
// 同組的鍵：同店、同組別、同人、同日四個都對才算同一組（組別標記理論上全域唯一，仍多比三項防呆）
export function groupKey(it) {
  const g = groupOf(it);
  if (!g) return '';
  return [it.store || '', g, it.emp_id || '', it.date || ''].join('|');
}
const hm = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
// 組內排序：有 seg 先照 seg；沒有再照開始時間（第二段時間比第一段早，打卡端存檔時也是依時間先後排）、最後照 id
function segSort(a, b) {
  const sa = segOf(a), sb = segOf(b);
  if (sa && sb && sa !== sb) return sa - sb;
  const ta = hm(a.start), tb = hm(b.start);
  if (ta !== null && tb !== null && ta !== tb) return ta - tb;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
}
// 把待審清單分成「單張」與「同一次送出的組」，順序照原清單（組放在它第一張單的位置）。
//   items：清單（已是要列的那幾張）；eligible(it)：這張單能不能進組（預設全部；申請審核傳「按得下去」的，唯讀的照單張列）
//   回傳 [{ type:'single', it } | { type:'group', key, items:[…依段排好] }]；同組只剩一張（或被排除到剩一張）＝不成組
export function groupPairs(items, eligible) {
  const ok = typeof eligible === 'function' ? eligible : () => true;
  const list = Array.isArray(items) ? items : [];
  const byKey = new Map();
  list.forEach(it => { const k = it && ok(it) ? groupKey(it) : ''; if (k) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(it); } });
  const out = [], seen = new Set();
  list.forEach(it => {
    const k = it && ok(it) ? groupKey(it) : '';
    const mem = k ? byKey.get(k) : null;
    if (!mem || mem.length < 2) { out.push({ type: 'single', it }); return; }
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ type: 'group', key: k, items: mem.slice().sort(segSort) });
  });
  return out;
}
// 組內某張是第幾段（1 起算）：有 seg 用 seg，沒有用排序後的位置
export function segIndex(group, it) {
  const s = segOf(it);
  return s || (group.indexOf(it) + 1);
}
// 已核准的申請列：這張是「同一次送出」的第 N／M 段？同天同人同組有 2 張以上才標；回 { n, m } 或 null
//   reqs：那位同仁那天已核准的申請（mgr_req_day by_emp）。只看這一批裡的張數，作廢掉的不在裡面＝剩一張就不標
export function approvedSegTag(reqs, it) {
  const g = groupOf(it);
  if (!g) return null;
  const mem = (Array.isArray(reqs) ? reqs : []).filter(x => groupOf(x) === g).slice().sort(segSort);
  if (mem.length < 2) return null;
  const at = mem.indexOf(it);
  if (at < 0) return null;
  return { n: segOf(it) || at + 1, m: mem.length };
}
// 組標頭的合計小時（每張都有數字才算；有一張沒有就回 null）
export function groupHours(group) {
  let t = 0;
  for (const it of group) { const h = Number(it.hours); if (it.hours == null || it.hours === '' || !isFinite(h)) return null; t += h; }
  return Math.round(t * 100) / 100;
}
const num = ['零', '一', '兩', '三', '四', '五', '六', '七', '八', '九'];
export const segWord = n => (n >= 0 && n <= 9 ? (n === 2 ? '兩' : num[n]) : String(n)) + '段';

// ---- 店長代開加班兩段：送出前的檢查（只管畫面送出的內容；真正的擋由打卡端做，這裡只是先擋掉明顯錯的，省一次來回）----
// segs：[{start:'11:00', end:'14:00'}, …]；回 { ok, msg, total, norm:[{start,end,hours}] }。跨夜（結束 ≤ 開始）算到隔天
export function proxyOtSegs(segs, maxH) {
  const cap = Number(maxH) > 0 ? Number(maxH) : SEG_MAX_OT_ADMIN;
  const norm = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i], a = hm(s.start), b0 = hm(s.end);
    if (a === null || b0 === null) return { ok: false, msg: '請填' + (segs.length > 1 ? '第 ' + (i + 1) + ' 段的' : '') + '加班開始與結束時間', total: 0, norm };
    const len = (b0 <= a ? b0 + 1440 : b0) - a;
    const night = a < 360 ? 1440 : 0;      // 06:00 前開始的那段當成跨過午夜、排後面（同打卡端 Requests.gs 的排序）
    norm.push({ start: s.start, end: s.end, a: a + night, b: a + night + len, hours: Math.round(len / 60 * 100) / 100 });
  }
  const total = Math.round(norm.reduce((t, x) => t + x.hours, 0) * 100) / 100;
  if (norm.length > SEG_MAX_PROXY_SEGS) return { ok: false, msg: '最多兩段', total, norm };
  if (norm.length === 2) {
    const [x, y] = norm[0].a <= norm[1].a ? [norm[0], norm[1]] : [norm[1], norm[0]];
    if (y.a < x.b) return { ok: false, msg: '兩段時間重疊了，請改成不重疊的時段', total, norm };
    if (y.a === x.b) return { ok: false, msg: '兩段時間剛好接在一起，請填成一段', total, norm };
  }
  if (total > cap) return { ok: false, msg: (norm.length > 1 ? '兩段合計 ' : '加班 ') + total + ' 小時，店長代開最多 ' + cap + ' 小時', total, norm };
  return { ok: true, msg: '', total, norm };
}
