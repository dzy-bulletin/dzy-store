// 出勤核定比對班表（spec 10.3）：只提示、不擋核定、不鎖定。差超過 15 分鐘標橘色（Eason 2026-10-11）。
// plan：{ day_type, leave, shift_name, start, end, segs?, station?, label? }（segs＝分段班各段 [['10:00','14:00'],['17:00','21:00']]，2 段以上才有）（dayPlan 的一筆；label＝月曆版休假名稱，例：休假、指定休）或 undefined；segments：打卡段 [{in:'HH:MM', out:'HH:MM'|null}]
export const THRESHOLD_MIN = 15;
const toMin = (hm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hm || ''); return m ? +m[1] * 60 + +m[2] : null; };
const LEAVE = { '特': '特休', '補': '補休', '國': '國定假日' };

export function comparePlan(plan, segments, opts) {
  const segs = (segments || []).filter((s) => s && (s.in || s.out));
  const punched = segs.length > 0;
  const past = !opts || opts.past !== false;              // 今天以前（含今天）才提示「沒打卡」
  if (!plan) return punched ? { text: '班表：這天沒有排', flags: ['沒排班卻有打卡'] } : null;
  if (!plan.start && plan.day_type === 'W') return { text: '班表：' + (plan.label || plan.shift_name || '上班'), flags: [] };   // 月曆版要上班但沒有時段（例：被設成上班的「公休」）
  if (!plan.start) {
    const label = plan.label ? plan.label : plan.day_type === 'L' ? (LEAVE[plan.leave] || '請假') : plan.day_type === 'R' ? '例假' : '休息日';
    return { text: '班表：' + label, flags: punched ? [label + '卻有打卡'] : [] };
  }
  const multi = Array.isArray(plan.segs) && plan.segs.length >= 2;
  const times = multi ? plan.segs.map((x) => x[0] + '–' + x[1]).join('、') : `${plan.start}–${plan.end}`;
  const text = `班表：${plan.shift_name || ''} ${times}`.replace('：  ', '：') + (plan.station ? '・' + plan.station : '');   // 有排工作站別時後面加「・炒鍋」
  if (!punched) return { text, flags: past ? ['有排班沒打卡'] : [] };
  if (multi) return { text, flags: compareSegs(plan.segs, segs, past) };
  const flags = [];
  const s = toMin(plan.start);
  let e = toMin(plan.end);
  if (e !== null && s !== null && e <= s) e += 1440;
  let firstIn = toMin((segs.find((x) => x.in) || {}).in);
  if (firstIn !== null && s !== null && e > 1440 && firstIn < s && firstIn < e - 1440) firstIn += 1440;   // 跨夜班凌晨才到：打卡時間換到隔天，才算得出晚到（2026-10-11 Codex 審查）
  const lastOutRaw = toMin((segs.slice().reverse().find((x) => x.out) || {}).out);
  if (firstIn !== null && s !== null && firstIn - s > THRESHOLD_MIN) flags.push(`晚到 ${firstIn - s} 分`);
  if (lastOutRaw !== null && e !== null) {
    const out = lastOutRaw < s ? lastOutRaw + 1440 : lastOutRaw;
    if (e - out > THRESHOLD_MIN) flags.push(`早退 ${e - out} 分`);
  }
  return { text, flags };
}

const CN = ['一', '二', '三'];
/** 分段班：每段各比一次上班、下班（Eason 2026-10-27 第 3 題）。打卡段跟班表哪一段重疊就算那一段的；
 *  一筆打卡跨過兩段（中間沒打下班卡）提醒「中間沒打卡離開」。 */
function compareSegs(planSegs, punches, past) {
  // 班表各段換成分鐘（照先後，跨夜往後加一天）
  const P = []; let prev = -1;
  for (const [a0, b0] of planSegs) {
    let a = toMin(a0), b = toMin(b0);
    while (a < prev) a += 1440;
    while (b <= a) b += 1440;
    P.push([a, b]); prev = b;
  }
  const first = P[0][0], last = P[P.length - 1][1];
  const fix = (t) => (t !== null && last > 1440 && t < first && t + 1440 <= last + 360 ? t + 1440 : t);   // 跨夜班凌晨的卡換到隔天
  const now = 48 * 60;                                                  // 還沒打下班卡＝當作還在（不算早退）
  const I = punches.map((x) => { const i = fix(toMin(x.in)); let o = fix(toMin(x.out)); if (i !== null && o !== null && o < i) o += 1440; return [i, o]; });
  const flags = [];
  P.forEach(([a, b], k) => {
    const mine = I.filter(([i, o]) => (i === null ? o > a && o <= b + 240 : i < b && (o === null ? now : o) > a));
    const name = '第' + CN[k] + '段';
    if (!mine.length) { if (past) flags.push(name + '沒打卡'); return; }
    const ins = mine.map((x) => x[0]).filter((x) => x !== null), outs = mine.map((x) => x[1]).filter((x) => x !== null);
    if (ins.length) { const fi = Math.min(...ins); if (fi - a > THRESHOLD_MIN) flags.push(`${name}晚到 ${fi - a} 分`); }
    if (outs.length && !mine.some((x) => x[1] === null)) { const lo = Math.max(...outs); if (b - lo > THRESHOLD_MIN) flags.push(`${name}早退 ${b - lo} 分`); }
  });
  for (let k = 0; k + 1 < P.length; k++) {
    const gapA = P[k][1], gapB = P[k + 1][0];
    if (I.some(([i, o]) => i !== null && o !== null && i < gapA && o > gapB)) flags.push(`第${CN[k]}段和第${CN[k + 1]}段中間沒打卡離開`);
  }
  return flags;
}
