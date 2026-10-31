// 頁面正要離開（重新整理、換網址、關分頁）時，瀏覽器會中斷還沒讀完的檔案與程式（WebKit 報「… due to access control checks」「Importing a module script failed」）。
// 這種錯誤不是程式壞了，舊頁面本來就要被丟掉；whileLeaving 讓它變成永遠不結束的等待，不再冒成錯誤。頁面還在時的失敗照常丟出。
// （2026-10-31：e2e「頁面無 JS 錯誤」WebKit 偶發失敗的根因，同種子重跑會過）
let leaving = false;
if (typeof addEventListener === 'function') {      // node 單元測試也會載入 api.js（沒有視窗事件）
  addEventListener('beforeunload', () => { leaving = true; });
  addEventListener('pagehide', () => { leaving = true; });
  addEventListener('pageshow', (e) => { if (e.persisted) leaving = false; });   // 從上一頁快取回來：頁面又活了
}
export const isLeaving = () => leaving;
export const whileLeaving = (p) => Promise.resolve(p).catch((e) => { if (leaving) return new Promise(() => {}); throw e; });
