// 核定時段照「打卡＋單」算（2026-11-14 Eason 定案「打卡＋單＝核定時數」，docs/punch-plus-req/）。純函式，不碰畫面，伺服器測試直接載入。
// 原則（Eason 確認的 12 個例子）：
//   1. 打卡（含已核准忘打卡單補的卡）＋已核准的單，就是核定時數；班表只拿來交叉比對與設上限。
//   2. 時段取「打卡」和「班表＋已核准加班單」的交集；班表以外的打卡（早到、晚走、班表空檔來上班）照打卡算，
//      當天加起來超過 8 小時的部分才要加班單、沒單不算（2026-11-16 Eason：「只要當天出勤滿八小時以上才需要加班單，不是依照班表的時間」，取代 11/14 的「比班表多 30 分鐘就要加班單」）。
//   3. 遲到：開頭留班表（打卡端照標遲到 N 分、薪資照扣）；早退、中途離開照打卡算（正職不足 8 小時要假單，由打卡端檢查）。
//   4. 忘打卡單補的時間超出班表的部分不算；加班單要有打卡涵蓋（打卡端檢查）。
//   5. 打卡跟班表（或加班單）邊界差 15 分鐘內算對得上；其他只往少的方向取整到 15 分（上班往後、下班往前）。
// 沒班表也沒加班單（例：排休卻來上班）：照打卡算，讓打卡端回「要有加班單」。沒打卡又有班表：照班表，讓打卡端回「要有忘打卡單」。

const TOL = 15;
/** 超過當天 8 小時、又沒有加班單的打卡合計達這麼多分鐘：不給一鍵核定，要補加班單或主管「自己調」確認（2026-11-14 Eason 選 B；2026-11-16 起只算超過 8 小時的部分） */
export const OVER_BLOCK_MIN = 30;
/** 一天不用加班單的上限（分鐘）：班表內＋班表外加起來到這裡為止都照打卡算 */
export const DAY_FREE_MIN = 480;
/** 每張卡跟核定時間差（2026-11-16 Eason：「每一次打卡時間跟核定時間相差超過 30 分鐘以上，都需要填寫原因」；剛好 30 分不用）。
 *  跟打卡端 Requests.gs reqCardDiffs_ 同一套：一段打卡對到重疊的核定時段，上班卡比最早那段的開始、下班卡比最晚那段的結束；
 *  整段沒被核定就比最近的開始／結束；只有單邊的卡只比有的那邊。CARD_REASON_FROM 起的日子才要（打卡端 REQ_CARD_REASON_FROM）。 */
export const CARD_DIFF_MIN = 30;
export const CARD_REASON_FROM = '2026-11-17';
export function cardDiffs(segs, periods) {
  const ps = (periods || []).map((p) => span(toMin(p.start), toMin(p.end))).filter(Boolean);
  if (!ps.length) return [];
  const near = (t, i) => ps.reduce((a, p) => (a == null || Math.abs(p[i] - t) < Math.abs(a - t) ? p[i] : a), null);
  const out = [];
  for (const g of segs || []) {
    if (!g) continue;
    let a = toMin(g.in), b = toMin(g.out);
    if (a != null && b != null && (g.cross || b < a)) b += 1440;
    let st = null, en = null;
    if (a != null && b != null) {
      const ov = ps.filter((p) => Math.min(b, p[1]) > Math.max(a, p[0]));
      if (ov.length) { st = Math.min(...ov.map((p) => p[0])); en = Math.max(...ov.map((p) => p[1])); }
    }
    if (a != null) { const c = st != null ? st : near(a, 0), d = Math.abs(a - c); if (d > CARD_DIFF_MIN) out.push({ side: 'in', card: toHm(a), core: toHm(c), min: d }); }
    if (b != null) { const c = en != null ? en : near(b, 1), d = Math.abs(b - c); if (d > CARD_DIFF_MIN) out.push({ side: 'out', card: toHm(b), core: toHm(c), min: d }); }
  }
  return out;
}
/** 「上班卡 08:20（核定 09:00，早 40 分）」 */
export function cardLabel(c) {
  const early = c.side === 'in' ? toMin(c.card) < toMin(c.core) : toMin(c.card) < toMin(c.core);
  return (c.side === 'in' ? '上班卡 ' : '下班卡 ') + c.card + '（核定 ' + c.core + '，' + (early ? '早 ' : '晚 ') + c.min + ' 分）';
}
/** 每張卡的原因合成一句存進 diff_reason：「上班卡 08:20：臨時調班；下班卡 17:45：主管同意」 */
export const cardReasonText = (cards, picks) => cards.map((c, i) => (c.side === 'in' ? '上班卡 ' : '下班卡 ') + c.card + '：' + picks[i]).join('；');
/** 建議補的加班單時段（2026-11-16 Eason：15 分鐘內不計、以整數建議）：每段開始往後、結束往前取到 15 分，取完不到 15 分的整段不列。
 *  例 08:57–09:00、13:00–14:34、16:57–18:00、22:00–22:03 → 13:00–14:30、17:00–18:00（2.5 小時）。全部都不到 15 分時回原本的時段（照實寫，不讓建議變空白） */
export function otSuggest(over) {
  const out = [];
  for (const x of over || []) {
    const sp = span(toMin(x.start), toMin(x.end)); if (!sp) continue;
    const a = Math.ceil(sp[0] / TOL) * TOL, b = Math.floor(sp[1] / TOL) * TOL;
    if (b - a >= TOL) out.push({ start: toHm(a), end: toHm(b), min: b - a });
  }
  if (!out.length) return { list: (over || []).map((x) => ({ start: x.start, end: x.end })), text: (over || []).map((x) => x.start + '–' + x.end).join('、'), min: null, rounded: false };
  const min = out.reduce((t, x) => t + x.min, 0);
  return { list: out, text: out.map((x) => x.start + '–' + x.end).join('、'), min, rounded: true };
}
/** 「要補加班單 13:00–14:30、17:00–18:00（共 2.5 小時）」；取不到整數時段時照實寫分鐘 */
export function otSuggestText(over, overMin) {
  const g = otSuggest(over);
  return g.text + (g.rounded ? '（共 ' + Math.round(g.min / 60 * 100) / 100 + ' 小時）' : '（' + overMin + ' 分鐘）');
}
const toMin = (hm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const toHm = (n) => { const x = ((n % 1440) + 1440) % 1440; return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); };
const span = (a, b) => (a == null || b == null ? null : (b <= a ? [a, b + 1440] : [a, b]));
const merge = (list) => {
  const s = list.filter((x) => x && x[1] > x[0]).sort((a, b) => a[0] - b[0]), out = [];
  for (const x of s) { const l = out[out.length - 1]; if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else out.push([x[0], x[1]]); }
  return out;
};
const intersect = (A, B) => { const out = []; for (const a of A) for (const b of B) { const s = Math.max(a[0], b[0]), e = Math.min(a[1], b[1]); if (e > s) out.push([s, e]); } return merge(out); };
const minus = (A, B) => {
  let cur = merge(A);
  for (const b of merge(B)) {
    const next = [];
    for (const a of cur) { if (b[1] <= a[0] || b[0] >= a[1]) next.push(a); else { if (b[0] > a[0]) next.push([a[0], b[0]]); if (b[1] < a[1]) next.push([b[1], a[1]]); } }
    cur = next;
  }
  return cur;
};
const total = (list) => list.reduce((a, x) => a + x[1] - x[0], 0);

/** 邊界（班表、加班單的開始／結束、休息帶兩端）：差 15 分內對齊；否則上班往後、下班往前取整到 15 分 */
function snapIn(t, bounds) { const b = bounds.find((x) => Math.abs(x - t) <= TOL); return b != null ? b : Math.ceil(t / 15) * 15; }
function snapOut(t, bounds) { const b = bounds.find((x) => Math.abs(x - t) <= TOL); return b != null ? b : Math.floor(t / 15) * 15; }

/**
 * @param {object} o
 *   segs：打卡段 [{in, out, cross}]（mgr_day 的 segments；缺卡＝null）
 *   plan：班表（mgr_day 的 plan：{work, segs:[{start,end}]}）；null／work:false＝沒班或排休
 *   reqs：那天已核准的申請 [{kind:'ot'|'miss'|'leave'|'trip', start, end, miss_type}]
 *   brk：不打卡休息帶 {start, end}（沒有就空字串）
 * @returns {null | {periods:[{start,end}], hours, notes:[string], late:number, over:[{start,end}], overMin:number}}（over＝打卡在班表＋加班單以外的時段）
 */
export function corePeriods(o) {
  const plan = o.plan && o.plan.work && Array.isArray(o.plan.segs) ? o.plan.segs : [];
  const S = merge(plan.map((x) => span(toMin(x.start), toMin(x.end))));
  const reqs = Array.isArray(o.reqs) ? o.reqs : [];
  const otRaw = reqs.filter((r) => r.kind === 'ot').map((r) => span(toMin(r.start), toMin(r.end)));
  const brkS = toMin(o.brk && o.brk.start), brkE = toMin(o.brk && o.brk.end);
  const BRK = brkS != null && brkE != null && brkE > brkS ? [[brkS, brkE]] : [];
  // 半天班（2026-11-17 Eason）：班表從第一段開始到最後一段結束沒有整段蓋過休息帶（例 央廚 09:00–12:30、總部 14:15–22:15）→ 班表裡的時間不扣休息帶。
  // 沒班表、或班表整段蓋過（含兩段班中間剛好空著休息帶）照舊扣。班表以外多出來的打卡仍照休息帶算（BRK）。
  const BRKcut = BRK.length && S.length && !(S[0][0] <= BRK[0][0] && S[S.length - 1][1] >= BRK[0][1]) ? [] : BRK;
  const notes = [];

  // 1. 打卡段（忘打卡單補上缺的那張；補的時間超出班表的部分不算，見下面交集）
  const raw = (Array.isArray(o.segs) ? o.segs : []).map((x) => ({ in: toMin(x.in), out: toMin(x.out), cross: !!x.cross, fromReq: {} }));
  for (const r of reqs.filter((x) => x.kind === 'miss')) {
    const a = toMin(r.start), b = toMin(r.end);
    if (r.miss_type === 'both' && a != null && b != null) raw.push({ in: a, out: b, fromReq: { in: true, out: true } });
    else if (r.miss_type === 'in' && a != null) { const s = raw.find((x) => x.in == null); if (s) { s.in = a; s.fromReq.in = true; } }
    else if (r.miss_type === 'out' && b != null) { const s = raw.find((x) => x.out == null); if (s) { s.out = b; s.fromReq.out = true; } }
    else if (r.miss_type === 'break' && a != null && b != null) {          // 中間休息沒打卡：end＝出去、start＝回來（同打卡端）
      const s = raw.find((x) => x.in != null && x.out != null && x.in < b && (x.cross ? x.out + 1440 : x.out) > a);
      if (s) { raw.push({ in: a, out: s.out, cross: s.cross, fromReq: { in: true } }); s.out = b; s.cross = false; s.fromReq.out = true; }
    }
  }
  // 還缺的卡：用班表邊界補上（打卡端會回「要有忘打卡單」）
  for (const x of raw) {
    if (x.in == null && x.out != null) { const s = S.find((y) => y[1] >= x.out - TOL) || S[0]; x.in = s ? s[0] : null; x.guess = true; }
    if (x.out == null && x.in != null) { const s = S.find((y) => y[0] <= x.in + TOL && y[1] > x.in) || S[S.length - 1]; x.out = s ? s[1] : null; x.guess = true; }
  }
  let W = merge(raw.filter((x) => x.in != null && x.out != null).map((x) => span(x.in, x.out)));
  if (!W.length) {
    if (!S.length) return null;                                  // 沒打卡也沒班：沒得算
    // 沒打卡、有已核准整天的假單／出差單（沒填時段，時數合計蓋滿班表或滿 8 小時）＝整天請假：不照班表填時段（2026-11-15 游家輝事假 8 小時被要求補 4 張忘打卡單）
    const noTime = reqs.filter((r) => (r.kind === 'leave' || r.kind === 'trip') && !r.start).reduce((a, r) => a + (Number(r.hours) || 0), 0);
    if (noTime > 0 && (noTime >= total(minus(S, BRKcut)) / 60 - 0.01 || noTime >= 8)) return null;      // 班表時數要扣不打卡休息帶（央廚 09–17＝7 小時，事假 7 小時就是整天）
    W = S.map((x) => x.slice());                                 // 沒打卡但有班：照班表（打卡端回要忘打卡單）
  }
  const Wraw = W.map((x) => x.slice());
  // 跨夜班之後接續的加班單（例：班表 22:00–06:00、加班單 06:00–08:00）：單上只有時鐘時間，其實是隔天早上 → 換到跨日後的時間再比。
  // 只搬「當天那個時間沒有打卡對到、加一天後落在這天班表或打卡的範圍內（差 15 分內算接得上）」的單；其他照舊（2026-11-15 考勤驗收 C6-6）
  const dayEnd = Math.max(...Wraw.concat(S).map((x) => x[1]));
  const OT = merge(otRaw.map((x) => (x && dayEnd > 1440 && x[1] <= 1440 && x[0] + 1440 <= dayEnd + TOL && !total(intersect([x], Wraw)) ? [x[0] + 1440, x[1] + 1440] : x)));
  // 1b. 班別設定的休息（break_min）：同一段班中間出去休息有打卡 → 從出去那張卡起扣滿休息分鐘；休超過的照實扣到回來那張卡（2026-11-17 Eason「照班別休息分鐘扣，超過的照實扣」）。
  //     原本兩張卡各往內取整到 15 分，休 23 分會被扣成 45 分（陳盈如 11/2 E班 09:00–17:30 休 30：13:25 出、13:48 回 → 7.75 小時，主管手動核 13:25–13:55＝8 小時）。
  //     做法：出去、回來那兩張卡先接成一段（不取整），最後再把休息挖掉。每段班只認第一個空檔；空檔要整個在那段班裡。
  const RESTS = [];
  for (const p of plan) {
    const bm = Math.round(Number(p.break_min) || 0), sp = span(toMin(p.start), toMin(p.end));
    if (!(bm > 0) || !sp) continue;
    for (let i = 1; i < W.length; i++) {
      const a = W[i - 1][1], b = W[i][0];
      if (!(a > sp[0] && b < sp[1] && b > a)) continue;
      RESTS.push(b - a <= bm ? [a, a + bm] : [a, b]);
      W = merge(W.slice(0, i - 1).concat([[W[i - 1][0], W[i][1]]], W.slice(i + 1)));
      break;
    }
  }
  if (RESTS.length) notes.push('休息 ' + RESTS.map(([a, b]) => toHm(a) + '–' + toHm(b)).join('、') + '（班別休息從出去那張卡起算' + (RESTS.some(([a, b]) => b - a > 0 && plan.some((p) => Number(p.break_min) > 0 && b - a > Number(p.break_min))) ? '，休超過的照實扣' : '') + '）');
  const bounds = [].concat(...S, ...OT, ...BRK);
  W = merge(W.map(([a, b]) => [snapIn(a, bounds), snapOut(b, bounds)]));

  // 2. 班表＋已核准加班單裡的打卡照算；都沒有（排休、沒排班又沒加班單）就照打卡（打卡端回要加班單）
  const A = merge(S.concat(OT));
  let core = A.length ? intersect(W, A) : W.map((x) => x.slice());
  // 3. 遲到：開頭留班表（只看第一段：第一張上班卡比它對到的班表開頭晚）
  let late = 0;
  if (S.length && core.length && Wraw.length) {
    const firstIn = Wraw[0][0], s0 = S.find((y) => y[1] > firstIn) || S[0];
    // 只補「第一張上班卡那段打卡」的開頭：那段取整後還在、而且就在這段班裡（2026-11-17 Eason）。
    // 第一段打卡短到取整後消失（09:31–09:44）、或第一張卡在這段班快結束才打（兩段班 13:51），core[0] 是後面別段打卡 → 不補，中間沒打卡的不算。
    if (firstIn > s0[0] + 0 && firstIn < s0[1] && core[0][0] > s0[0] && core[0][0] < s0[1] && core[0][0] <= snapIn(firstIn, bounds)) { late = firstIn - s0[0]; core[0][0] = s0[0]; }
  }
  // 3b. 班表以外的打卡（S 有班表時）：當天不含加班單的時數還沒滿 8 小時，就照時間先後算進去，滿 8 小時為止；超過的部分要加班單（2026-11-16）。
  //     放在遲到補開頭之後算：遲到的那段照「開頭留班表」算在 8 小時裡（打卡端是看核定時數超過 8 小時就要加班單）
  let freeExtra = [];
  if (S.length) {
    let budget = Math.max(0, DAY_FREE_MIN - total(minus(minus(core, OT), BRKcut.concat(RESTS))));      // 班別休息也不算      // 不打卡休息帶不算上班時間
    // 只算真的打卡（忘打卡單補的時間超出班表照舊不算，例 10），也不算照班表猜的缺卡
    const real = merge(raw.filter((x) => x.in != null && x.out != null && !x.guess && !x.fromReq.in && !x.fromReq.out).map((x) => span(x.in, x.out)).map(([a, b]) => [snapIn(a, bounds), snapOut(b, bounds)]));
    for (const [a, b] of minus(intersect(minus(W, A), real), BRK)) {
      if (budget <= 0) break;
      const take = Math.min(b - a, budget);
      freeExtra.push([a, a + take]); budget -= take;
    }
    freeExtra = merge(freeExtra);
    core = merge(core.concat(freeExtra));
  }

  // 4. 不打卡休息帶：核定時段蓋過休息帶就拆開（同現在的預填）
  if (BRKcut.length) core = minus(core, BRKcut);
  else if (BRK.length) core = merge(intersect(core, S).concat(minus(minus(core, S), BRK)));      // 半天班：班表裡不扣，班表外多出來的照扣
  if (RESTS.length) core = minus(core, RESTS);
  core = merge(core);
  if (!core.length) return null;

  // 5. 給主管看的說明
  const FREE = merge(A.concat(freeExtra));
  // 不打卡休息帶（央廚 12–13、總部 14–15）：中間沒打下班卡照樣是休息，不算多出來的時段（2026-11-16 Eason：吳佳宜 08:25–17:42 被要求補 12:15–12:45 加班單）
  const WnoBrk = minus(Wraw, BRK);
  for (const x of minus(WnoBrk, FREE.length ? FREE : WnoBrk)) if (x[1] - x[0] > TOL) notes.push(toHm(x[0]) + '–' + toHm(x[1]) + ' 超過當天 8 小時、沒有加班單，不算');
  const freeMin = total(freeExtra);
  if (freeMin > 0) notes.push('比班表多 ' + Math.round(freeMin / 6) / 10 + ' 小時（當天沒滿 8 小時，不用加班單）');
  for (const x of raw) if (x.fromReq.out && S.length && x.out != null && x.out > S[S.length - 1][1] + TOL && !OT.some((y) => x.out <= y[1] + TOL)) {
    const tail = '–' + toHm(x.out) + ' 超過當天 8 小時、沒有加班單，不算';
    for (let i = notes.length - 1; i >= 0; i--) if (notes[i].endsWith(tail)) notes.splice(i, 1);      // 同一段改用忘打卡單的說法，不重複
    notes.push('忘打卡單 ' + toHm(x.out) + ' 超過班表，只算到 ' + toHm(S[S.length - 1][1]));
  }
  const extra = total(minus(minus(core, S), freeExtra));
  if (S.length && extra > 0 && OT.length) notes.push('比班表多 ' + Math.round(extra / 6) / 10 + ' 小時（已核准加班單）');
  if (late > 0) notes.push('遲到 ' + late + ' 分（薪資照扣）');

  // 超過當天 8 小時、又不在加班單裡的打卡時段；沒班表也沒加班單時不算（打卡端會要加班單）。
  // 2026-11-16 Eason：「時段的認定是以 15 分鐘為一單位，上班前 15 分鐘打卡跟下班後 15 分鐘打卡都不算在薪資內」
  //   → 緊接在班表或已核准加班單前後的那 15 分鐘先扣掉（「滿 8 小時」那個點不是上下班，不扣），剩下的再往內取整到 15 分，不到 15 分的整段不列。
  //   例 班表 12:00–16:00、18:00–22:15，打卡 11:58–16:19、17:54–22:20 → 0 分（原本照實際打卡算 32 分、被擋）。
  const outside = A.length ? overUnits(minus(WnoBrk, FREE), A.concat(BRK)) : [];
  const over = outside.map(([a, b]) => ({ start: toHm(a), end: toHm(b) }));
  const overMin = total(outside);
  const periods = core.map(([a, b]) => ({ start: toHm(a), end: toHm(b) }));
  return { periods, hours: Math.round(total(core) / 60 * 100) / 100, notes, late, over, overMin };
}

/** 超出的打卡時段 → 要加班單的時段：接在班表／加班單（bounds）後面的開頭、前面的結尾各扣 15 分寬限，再往內取整到 15 分，不到 15 分不列 */
function overUnits(list, bounds) {
  const ends = new Set(bounds.map((x) => x[1])), starts = new Set(bounds.map((x) => x[0])), out = [];
  for (const [a0, b0] of list) {
    const a = Math.ceil((ends.has(a0) ? a0 + TOL : a0) / TOL) * TOL, b = Math.floor((starts.has(b0) ? b0 - TOL : b0) / TOL) * TOL;
    if (b - a >= TOL) out.push([a, b]);
  }
  return out;
}

export const _t = { toMin, toHm, merge, intersect, minus };
