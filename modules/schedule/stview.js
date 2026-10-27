// 班表「隱藏工作站」切換（Eason 2026-10-27）：只影響畫面（列印跟著畫面），不動資料、不影響改站別的面板。
// 選擇記在這台瀏覽器（央廚班表與門市排班共用一個設定）；瀏覽器不給存就只記到重新整理為止。
const KEY = 'dzystore_sched_hide_station';
let mem = null;
export function stHidden() {
  if (mem !== null) return mem;
  try { mem = localStorage.getItem(KEY) === '1'; } catch (e) { mem = false; }
  return mem;
}
export function setStHidden(v) {
  mem = !!v;
  try { if (mem) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch (e) { /* 只記在記憶體 */ }
}
export const stToggleHtml = (id) => `<button type="button" class="btn ghost" id="${id}" aria-pressed="${stHidden()}">${stHidden() ? '顯示工作站' : '隱藏工作站'}</button>`;
