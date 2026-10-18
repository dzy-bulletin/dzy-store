// API 基底網址。上線時改成 Mac mini Funnel 網址（例 https://<主機>.ts.net/store/api）。
// 開發：與網頁同一主機（伺服器同時供應 /store/api）。
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
// 正式：GitHub Pages 開頁 → 連公司 Mac mini（Tailscale Funnel 的 /store 路徑，與貨單、現金帳同一台）
export const API_BASE = LOCAL ? '/store/api' : 'https://dingzhaoyuandemac-mini.tailc27c34.ts.net/store/api';
// 網址帶 ?mode=mock → 改用 mock.js 的瀏覽器內假後端（示範與 e2e，不需要真伺服器）。只在本機開發有效：正式網址加這個參數不理它（2026-10-11 審查）
export const MOCK = LOCAL && new URLSearchParams(location.search).get('mode') === 'mock';
export const KEYS = { code: 'dzystore_code', session: 'dzystore_session' };

// ---- 個人帳號登入／嵌入管理系統（docs/approver/spec.md §2、§11；契約 test/fixtures/dzy-store-contract-v2.json 的 postMessage 段）----
export const DZY_ORIGIN = 'https://dzy.mozhuting.com';
export const DZY_LOGIN_URL = DZY_ORIGIN + '/#/storeops';
const QS = new URLSearchParams(location.search);
// 嵌入管理系統時只認這個 origin。本機測試可用 ?embedOrigin=http://localhost:埠 換掉，而且只在 localhost 開頁（LOCAL）時生效，正式網址加了也不理
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
export const EMBED_ORIGIN = LOCAL && LOCAL_ORIGIN.test(QS.get('embedOrigin') || '') ? QS.get('embedOrigin') : DZY_ORIGIN;
// ?embed=dzy 只在真的被嵌在別的頁面裡（window.parent 不是自己）才算嵌入模式
export const EMBED = QS.get('embed') === 'dzy' && window.parent !== window;
// ?only=duty：只顯示出勤核定（含換考勤店），其他功能與首頁都不顯示
export const ONLY_DUTY = QS.get('only') === 'duty';
