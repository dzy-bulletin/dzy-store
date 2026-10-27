// 排班前檢查清單（docs/autoschedule/checklist-requirements.md，Eason 2026-10-27）：
// 班別、同仁身分是必要（沒設好擋自動排班），每天每班人數是建議（黃字），工作站／指定／營業額選填。
// D＝load 回傳；純函式，畫面（board.js）與測試共用。
import { termAt, employed } from './rules.js';

const NAME_MAX = 5;
// ids：只算這些班別／站別（停用的不算）
const anyMin = (tpl, ids) => Object.values(tpl || {}).some((byId) => Object.entries(byId || {}).some(([id, x]) => ids.has(id) && (typeof x === 'number' ? x : (x && x.min) || 0) > 0));

export function setupChecklist(D) {
  const dates = D.dates || [];
  const items = [];
  const nShift = (D.shifts || []).filter((s) => s.active).length;
  items.push({ key: 'shifts', label: '班別', level: 'must', ok: nShift > 0, text: nShift ? `班別：${nShift} 個` : '班別：還沒建', tab: 'shifts' });

  const inPeriod = (D.staff || []).filter((st) => dates.some((d) => employed(st, d)));
  const missing = inPeriod.filter((st) => dates.some((d) => employed(st, d) && !termAt(D.terms || {}, st.emp_id, d)));
  const names = missing.slice(0, NAME_MAX).map((st) => st.name).join('、') + (missing.length > NAME_MAX ? ` 等 ${missing.length} 人` : '');
  items.push({ key: 'terms', label: '同仁身分', level: 'must', ok: inPeriod.length > 0 && !missing.length,
    text: !inPeriod.length ? '同仁身分：這一期還沒有在職的同仁，請先到「同仁」確認名單'
      : missing.length ? `同仁身分：${missing.length} 人還沒設正職或計時：${names}` : `同仁身分：${inPeriod.length} 人都設好`, tab: 'staff' });

  const demandOk = anyMin(D.demandTpl, new Set((D.shifts || []).filter((s) => s.active).map((s) => s.id)));
  items.push({ key: 'demand', label: '每天每班要幾個人', level: 'rec', ok: demandOk,
    text: demandOk ? '每天每班要幾個人：已設' : '每天每班要幾個人：還沒設，排出來人力可能不對', tab: 'needs' });

  if ((D.stations || []).some((s) => s.active)) {
    const stOk = anyMin(D.stationNeedTpl, new Set(D.stations.filter((s) => s.active).map((s) => s.id)));
    items.push({ key: 'stations', label: '工作站', level: 'opt', ok: stOk, text: stOk ? '工作站：各站最少人數已設' : '工作站：各站最少人數還沒設（選填）', tab: 'shifts' });
  }

  let nPin = 0;
  for (const e of Object.keys(D.pins || {})) for (const d of Object.keys(D.pins[e] || {})) if (dates.includes(d) && D.pins[e][d]) nPin++;
  items.push({ key: 'pins', label: '指定休假／上班', level: 'opt', ok: true, text: `指定休假／上班：${nPin} 筆（選填）`, tab: 'needs' });

  const revOk = (D.months || []).length > 0 && D.months.every((m) => m.revenue != null);
  const revMiss = (D.months || []).find((m) => m.revenue == null);
  items.push({ key: 'revenue', label: '月預估營業額', level: 'opt', ok: revOk,
    text: revOk ? '月預估營業額：已填' : '月預估營業額：還沒填（選填，只影響每工時營業額）', tab: null, field: revMiss ? 'scRev-' + revMiss.ym : null });

  return {
    items,
    blockers: items.filter((i) => i.level === 'must' && !i.ok).map((i) => i.label),
    allDone: items.every((i) => i.level === 'opt' || i.ok),
  };
}
