// 手動修改後重算紅框（2026-11-25 Eason「10 題全照推薦」；開工確認 _brain_out/overblock-manual/kickoff.html 第 2 題 B2）。純函式，不碰畫面，伺服器測試直接載入。
//
// 規則白話：
//   紅框「要補加班單」原本只看系統建議（core-calc corePeriods 的 over／overMin：打卡在班表＋加班單以外、超過當天 8 小時、又沒有加班單的時段）。
//   主管按「手動修改」改了時段之後：系統標的那幾段超額，已經被主管填進核定時段的分鐘不算，剩下的達 OVER_BLOCK_MIN（30 分）才出紅框。
//   ‧只會比改之前少擋、不會多擋（剩下的 ≤ 原本的）；沒改時段＝跟改之前一字不差（直接用原本的 over／overMin）。
//   ‧加班時數夠不夠、核定比打卡多（填了沒打卡的時間）由打卡系統檢查（Requests.gs reqBindCheck_ 的 ot_hours、over_credit），這裡不碰。
//   ‧遲到照舊由打卡系統拿核定時段對打卡算（Code.gs computeApprovalStatus），送出的遲到分鐘不變（開工確認第 1 題 A）；這裡只產生「這段不記遲到」的提示。
// 畫面文字（逐字照開工確認〈新文字逐句表〉，不可增刪）：第 1 句 coveredText、第 2 句 lateText、第 4 句 overTitle、第 5 句 OVER_NOTE、第 6、7 句 overSubmitLabel。

const TOL_DAY = 1440;
const toMin = (hm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const toHm = (n) => { const x = ((n % TOL_DAY) + TOL_DAY) % TOL_DAY; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
const spanOf = (a, b) => { const x = toMin(a), y = toMin(b); if (x == null || y == null) return null; return y <= x ? [x, y + TOL_DAY] : [x, y]; };
const merge = (list) => {
  const s = list.filter((x) => x && x[1] > x[0]).sort((p, q) => p[0] - q[0]), out = [];
  for (const x of s) { const l = out[out.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else out.push([x[0], x[1]]); }
  return out;
};
const minus = (A, B) => {
  let cur = merge(A);
  for (const b of merge(B)) {
    const next = [];
    for (const a of cur) { if (b[1] <= a[0] || b[0] >= a[1]) next.push(a); else { if (b[0] > a[0]) next.push([a[0], b[0]]); if (b[1] < a[1]) next.push([b[1], a[1]]); } }
    cur = next;
  }
  return cur;
};
const total = (list) => list.reduce((t, x) => t + x[1] - x[0], 0);
// 跨午夜：時段寫成 23:00–01:00 是 [1380, 1500]、凌晨的 00:15–00:45 是 [15, 45]；比對時把每段也試前一天、隔天的位置
const around = (list) => list.flatMap(([a, b]) => [[a, b], [a - TOL_DAY, b - TOL_DAY], [a + TOL_DAY, b + TOL_DAY]]);
const spansOfRows = (rows) => (rows || []).map((r) => r && spanOf(r.start, r.end)).filter(Boolean);
const asRows = (list) => list.map(([a, b]) => ({ start: toHm(a), end: toHm(b) }));
const r2 = (n) => Math.round(n * 100) / 100;
const normRows = (rows) => spansOfRows(rows).map(([a, b]) => a + '-' + b).sort().join(',');

/** 主管有沒有改時段：輸入框的時段（有起有訖的）跟系統建議逐段相同＝沒改 */
export function rowsChanged(rows, sysPeriods) { return normRows(rows) !== normRows(sysPeriods); }

/** 系統標的超額時段（over）扣掉主管時段蓋到的部分 → { left, leftMin, covered, coveredMin }（時段是 {start, end}） */
export function overLeft(over, rows) {
  const O = merge(spansOfRows(over)), R = around(spansOfRows(rows));
  const left = minus(O, R);
  const covered = minus(O, left);
  return { left: asRows(left), leftMin: total(left), covered: asRows(covered), coveredMin: total(covered) };
}

/** 紅框要不要擋。pr＝系統建議（corePeriods 的結果）；rows＝輸入框目前的時段；ckOk＝打卡系統只檢查回可以；min＝門檻（OVER_BLOCK_MIN）。
 *  回 { block, changed, over（紅框要寫的時段）, overMin, covered, coveredMin, oldBlock（改之前會不會擋） } */
export function overDecision(pr, rows, ckOk, min) {
  const oldBlock = !!(ckOk && pr && pr.overMin >= min);
  if (!pr) return { block: false, changed: false, over: [], overMin: 0, covered: [], coveredMin: 0, oldBlock };
  const changed = rowsChanged(rows, pr.periods || []);
  if (!changed) return { block: oldBlock, changed, over: pr.over || [], overMin: pr.overMin || 0, covered: [], coveredMin: 0, oldBlock };
  const ol = overLeft(pr.over || [], rows);
  return { block: oldBlock && ol.leftMin >= min, changed, over: ol.left, overMin: ol.leftMin, covered: ol.covered, coveredMin: ol.coveredMin, oldBlock };
}

const spansText = (list) => (list || []).map((x) => x.start + '–' + x.end).join('、');
/** 第 4 句：紅框標題 */
export const overTitle = (over, overMin) => '還不能核定：打卡多出的 ' + spansText(over) + '（共 ' + r2(overMin / 60) + ' 小時）沒算進核定時段，也沒有加班單';
/** 第 5 句：紅框說明 */
export const OVER_NOTE = '同仁有加班：請同仁在 LINE「加班請假」補申請，核准後這裡會自動重算。這段要算工時：把它填進上面的核定時段。同仁沒加班（例：下班後私人逗留）：選下面的原因後送出，這段不算。';
/** 第 6、7 句：送出鈕（沒改時段＝照舊「照班表」；改過時段＝照你填的時段） */
export const overSubmitLabel = (changed, hours) => (changed ? '確認這段不算工時，照你填的時段核定 ' : '確認沒加班，照班表核定 ') + hours + ' 小時';
/** 送出鈕是不是「要先選不算工時的原因」那一種（第 6、7 句） */
export const isNotCountLabel = (t) => /^確認沒加班|^確認這段不算工時/.test(String(t || ''));
/** 第 1 句：手動時段蓋到系統標的超額 */
export const coveredText = (covered) => '你填的時段已經把打卡多出的 ' + spansText(covered) + ' 算進去，不用選不算工時的原因。';

/** 第 2 句要不要出現：每一段班表，打卡比班表開始晚（會記遲到），主管填的那段又從打卡之後才開始 → 這段不記遲到。
 *  plan＝班表（{work, segs:[{start,end}]}）；segs＝打卡段（{in, out, cross}）；rows＝輸入框時段。回 [{label, a, b, c}]（班表開始、打卡、你填的開始）。
 *  段名：每段班表分屬上午、下午各一段（或只有一段）寫「上午／下午」，否則寫「第 N 段」。
 *  lateMin＝「遲到分鐘」欄現在的字（#412 外部審查第一輪 BLOCKER 5）：打卡系統手填優先（留空＝自動、0＝不算遲到、N＝照 N 分記），
 *  填了大於 0 的數字＝送出就是遲到 N 分，這時寫「這段不記遲到」會跟送出的內容矛盾 → 不出。留空、0 送出後真的不記遲到 → 照舊出。 */
export function lateDropped(plan, segs, rows, lateMin) {
  if (Number(lateMin) > 0) return [];      // 主管手填了遲到分鐘：照他填的記，不說不記遲到（Number('')＝0、null＝0、'abc'＝NaN 都不擋）
  if (!plan || plan.work !== true || !Array.isArray(plan.segs) || !plan.segs.length) return [];
  const ps = plan.segs.map((s) => s && spanOf(s.start, s.end)).filter(Boolean);
  const half = ps.map(([a]) => ((a % TOL_DAY) < 720 ? '上午' : '下午'));
  const useHalf = new Set(half).size === half.length;
  const punch = (segs || []).filter((s) => s && s.in && s.out).map((s) => spanOf(s.in, s.out)).filter(Boolean);      // 下班時間比上班早＝跨夜（spanOf 加一天）
  const R = spansOfRows(rows);
  const best = (list, a, b) => { let pick = null, ov = 0; for (const x of list) { const o = Math.min(b, x[1]) - Math.max(a, x[0]); if (o > ov) { ov = o; pick = x; } } return pick; };
  const out = [];
  ps.forEach(([a, b], i) => {
    const p = best(punch, a, b);
    if (!p || p[0] <= a) return;                 // 準時或早到：本來就不記遲到
    const r = best(R, a, b);
    if (!r || r[0] <= a || r[0] < p[0]) return;  // 從班表開始填（照記遲到）、或填在打卡之前（打卡系統照記遲到分鐘）
    out.push({ label: useHalf ? half[i] : '第 ' + (i + 1) + ' 段', a: toHm(a), b: toHm(p[0]), c: toHm(r[0]) });
  });
  return out;
}
/** 第 2 句 */
export const lateText = (x) => x.label + '班表 ' + x.a + ' 開始、打卡 ' + x.b + '，你填 ' + x.c + ' 起：這段不記遲到。';

/** 紅框因主管手動時段蓋住而消失時，要不要清掉「不算工時的原因」（2026-11-26 #412 驗收補修）。
 *  只清紅框流程自己填進原因欄的那一句（wrote＝紅框下拉最後寫進去的字，原因欄現在還是一字不差）；
 *  已核定帶回來的原因、打卡系統要的卡差原因、主管自己打的原因都不是這個流程寫的，不清。
 *  只在「改過時段、改之前會擋、現在不擋」時清；打卡系統沒過（oldBlock＝false）、仍有剩餘超額、沒改時段都不清。 */
export const shouldClearNotCount = (od, diffValue, wrote) => !!(od && od.changed && od.oldBlock && !od.block && wrote && String(diffValue || '') === wrote);
