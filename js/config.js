// API 基底網址。上線時改成 Mac mini Funnel 網址（例 https://<主機>.ts.net/store/api）。
// 開發：與網頁同一主機（伺服器同時供應 /store/api）。
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
// 正式：GitHub Pages 開頁 → 連公司 Mac mini（Tailscale Funnel 的 /store 路徑，與貨單、現金帳同一台）
export const API_BASE = LOCAL ? '/store/api' : 'https://dingzhaoyuandemac-mini.tailc27c34.ts.net/store/api';
// 網址帶 ?mode=mock → 改用 mock.js 的瀏覽器內假後端（示範與 e2e，不需要真伺服器）
export const MOCK = new URLSearchParams(location.search).get('mode') === 'mock';
export const KEYS = { code: 'dzystore_code', session: 'dzystore_session' };
