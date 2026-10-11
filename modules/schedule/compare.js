// 出勤核定比對班表（spec 10.3）：只提示、不擋核定、不鎖定。差超過 15 分鐘標橘色（Eason 2026-10-11）。
// plan：{ day_type, leave, shift_name, start, end, label? }（dayPlan 的一筆；label＝月曆版休假名稱，例：休假、指定休）或 undefined；segments：打卡段 [{in:'HH:MM', out:'HH:MM'|null}]
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
  const text = `班表：${plan.shift_name || ''} ${plan.start}–${plan.end}`.replace('：  ', '：');
  if (!punched) return { text, flags: past ? ['有排班沒打卡'] : [] };
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
