// 這位同仁這天還有沒有待審的申請（2026-11-19 第三輪審查）：前端與伺服器共用同一條規則（伺服器以 require(esm) 載入，同 schedule/period.js）。
//   前端：完整頁 applyPendingReqs 的 byAll、送出前重讀 freshCheck（approve.js）；伺服器：新版前端（mf）核定寫入前最後一道（server/proxy/duty.js）。
// 規則同 quick-calc.js pendSplit（mine＋upper 都擋）：待審清單（mgr_req_pending 的 items）裡這個人、這一天的每一張都算——
//   加班、請假、忘打卡、出差都算，不分種類；連本人自己送的、要上層審的也算（這位主管審不了，仍是待審）。
//   store：全部門市／總部併組的回應每筆帶 store（營運系統門市代號）；指定一家店讀的回應不帶，不帶的就當那家店的。

/** items＝mgr_req_pending 的 items；回這個人這天的待審單（陣列，空＝沒有） */
export function pendingFor(items, empId, date, store) {
  const s = store || '';
  return (Array.isArray(items) ? items : []).filter((it) => it && typeof it === 'object'
    && it.date === date && String(it.emp_id) === String(empId) && (!it.store || it.store === s));
}

export const PEND_BLOCK_MSG = '這天還有待審的申請，請先審單（審完才能核定）';
export const PEND_READ_MSG = '待審的申請暫時讀不到（打卡系統沒有回應），為了避免核錯這次沒有送出，請稍後再按一次';
export const PEND_SENDING_MSG = '這天有申請的核准還在送出中，請稍候幾秒再核定';
