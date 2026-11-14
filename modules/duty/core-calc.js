// 核定時段照「打卡＋單」算（2026-11-14 Eason 定案「打卡＋單＝核定時數」，docs/punch-plus-req/）。純函式，不碰畫面，伺服器測試直接載入。
// 原則（Eason 確認的 12 個例子）：
//   1. 打卡（含已核准忘打卡單補的卡）＋已核准的單，就是核定時數；班表只拿來交叉比對與設上限。
//   2. 時段取「打卡」和「班表＋已核准加班單」的交集：早到、晚走沒有加班單的部分不算（不用寫原因）。
//   3. 遲到：開頭留班表（打卡端照標遲到 N 分、薪資照扣）；早退、中途離開照打卡算（正職不足 8 小時要假單，由打卡端檢查）。
//   4. 忘打卡單補的時間超出班表的部分不算；加班單要有打卡涵蓋（打卡端檢查）。
//   5. 打卡跟班表（或加班單）邊界差 15 分鐘內算對得上；其他只往少的方向取整到 15 分（上班往後、下班往前）。
// 沒班表也沒加班單（例：排休卻來上班）：照打卡算，讓打卡端回「要有加班單」。沒打卡又有班表：照班表，讓打卡端回「要有忘打卡單」。

const TOL = 15;
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
 * @returns {null | {periods:[{start,end}], hours, notes:[string], late:number}}
 */
export function corePeriods(o) {
  const plan = o.plan && o.plan.work && Array.isArray(o.plan.segs) ? o.plan.segs : [];
  const S = merge(plan.map((x) => span(toMin(x.start), toMin(x.end))));
  const reqs = Array.isArray(o.reqs) ? o.reqs : [];
  const OT = merge(reqs.filter((r) => r.kind === 'ot').map((r) => span(toMin(r.start), toMin(r.end))));
  const brkS = toMin(o.brk && o.brk.start), brkE = toMin(o.brk && o.brk.end);
  const BRK = brkS != null && brkE != null && brkE > brkS ? [[brkS, brkE]] : [];
  const bounds = [].concat(...S, ...OT, ...BRK);
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
    W = S.map((x) => x.slice());                                 // 沒打卡但有班：照班表（打卡端回要忘打卡單）
  }
  const Wraw = W.map((x) => x.slice());
  W = merge(W.map(([a, b]) => [snapIn(a, bounds), snapOut(b, bounds)]));

  // 2. 上限＝班表＋已核准加班單；都沒有（排休、沒排班又沒加班單）就照打卡（打卡端回要加班單）
  const A = merge(S.concat(OT));
  let core = A.length ? intersect(W, A) : W.map((x) => x.slice());

  // 3. 遲到：開頭留班表（只看第一段：第一張上班卡比它對到的班表開頭晚）
  let late = 0;
  if (S.length && core.length && Wraw.length) {
    const firstIn = Wraw[0][0], s0 = S.find((y) => y[1] > firstIn) || S[0];
    if (firstIn > s0[0] + 0 && firstIn < s0[1] && core[0][0] > s0[0]) { late = firstIn - s0[0]; core[0][0] = s0[0]; }
  }
  // 4. 不打卡休息帶：核定時段蓋過休息帶就拆開（同現在的預填）
  if (BRK.length) core = minus(core, BRK);
  core = merge(core);
  if (!core.length) return null;

  // 5. 給主管看的說明
  for (const x of minus(Wraw, A.length ? A : Wraw)) if (x[1] - x[0] > TOL) notes.push(toHm(x[0]) + '–' + toHm(x[1]) + ' 沒有加班單，不算');
  for (const x of raw) if (x.fromReq.out && S.length && x.out != null && x.out > S[S.length - 1][1] + TOL && !OT.some((y) => x.out <= y[1] + TOL)) {
    const tail = '–' + toHm(x.out) + ' 沒有加班單，不算';
    for (let i = notes.length - 1; i >= 0; i--) if (notes[i].endsWith(tail)) notes.splice(i, 1);      // 同一段改用忘打卡單的說法，不重複
    notes.push('忘打卡單 ' + toHm(x.out) + ' 超過班表，只算到 ' + toHm(S[S.length - 1][1]));
  }
  const extra = total(minus(core, S));
  if (S.length && extra > 0 && OT.length) notes.push('比班表多 ' + Math.round(extra / 6) / 10 + ' 小時（已核准加班單）');
  if (late > 0) notes.push('遲到 ' + late + ' 分（薪資照扣）');

  const periods = core.map(([a, b]) => ({ start: toHm(a), end: toHm(b) }));
  return { periods, hours: Math.round(total(core) / 60 * 100) / 100, notes, late };
}

export const _t = { toMin, toHm, merge, intersect, minus };
