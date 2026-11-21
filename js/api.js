import { gateway, MOCK } from './config.js';
import { isGatewayError } from './gateway.js';
import { whileLeaving } from './leaving.js';

// 連不上時給人看的話（2026-11-22 停機演練後 Eason 同意）：預設短版；考勤管理（核定）的呼叫帶 opts.netMsg 換成含「核定期限會順延」的長版（見 modules/duty/state.js NET_MSG_DUTY）
const NET_MSG = '連不上系統。網路正常的話，可能是系統暫停中，請稍後再試。';

let hooks = { getToken: () => null, onAuth: () => {}, onMust: () => {} };
export function setHooks(h) { hooks = { ...hooks, ...h }; }

// 回傳 data；失敗丟 Error（.code=error 代碼，.message=後端白話訊息）
// tokenOverride：用指定的 token 打（嵌入模式要登出「舊的」或「剛建的多餘」session 時用），不影響目前登入
// opts.netMsg：連不上時顯示的話（預設 NET_MSG）
// opts.keepalive：頁面／iframe 在請求途中被拆掉也讓瀏覽器把它送完（嵌入登出用，2026-11-20）
// opts.read：這支 POST 其實是讀取（例如考勤的讀取動作），新路出事時可以放心用舊路重送一次。GET 與 body.peek===true 自動算讀取
export async function api(method, path, body, tokenOverride, opts) {
  const token = tokenOverride || hooks.getToken();
  let res;
  try {
    if (MOCK) {
      const { handle } = await whileLeaving(import('./mock.js'));
      res = await handle(method, path, body, token);
    } else {
      const isRead = method === 'GET' || !!(opts && opts.read) || !!(body && body.peek === true);
      res = await viaGateway(isRead, async base => {
        const r = await fetch(base + path, {
          method,
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
          body: method === 'GET' ? undefined : JSON.stringify(body || {}),
          ...(opts && opts.keepalive ? { keepalive: true } : {}),
        });
        const j = await r.json();
        return { value: j, fault: isGatewayError(r.status, j) };
      });
    }
  } catch (e) {
    const err = new Error((opts && opts.netMsg) || NET_MSG);
    err.code = 'NETWORK';
    throw err;
  }
  return settle(res, path, token);
}

function settle(res, path, token) {
  if (res && res.ok) return res.data;
  const err = new Error((res && res.message) || '發生錯誤，請稍後再試');
  err.code = (res && res.error) || 'SERVER_ERROR';
  if (res && typeof res.reason === 'string') err.reason = res.reason;      // 核定「資料更新中」（2026-11-21）：前端自動等待用
  if (res && Number(res.retry_ms) > 0) err.retryMs = Number(res.retry_ms);
  // 這幾支的 AUTH 只是「密碼不對」，不代表登入過期，不能踢人
  const wrongPw = path === '/duty/unlock' || path === '/password' || path === '/login' || path === '/sso' || path === '/sso/select';   // /sso 的 AUTH＝入場券不能用，不是目前的登入過期
  // 只有「現在這個登入」的請求才踢人：登出後還在路上的舊請求回來 AUTH，不能把剛重新登入的人也踢掉
  if (err.code === 'AUTH' && token && token === hooks.getToken() && !wrongPw) hooks.onAuth();
  if (err.code === 'MUST_CHANGE_PASSWORD') hooks.onMust();
  throw err;
}

// 上傳（multipart）：body 是 FormData，不要自己設 Content-Type（瀏覽器會帶 boundary）
export async function apiUpload(path, formData) {
  const token = hooks.getToken();
  let res;
  try {
    if (MOCK) {
      const { handle } = await whileLeaving(import('./mock.js'));
      res = await handle('POST', path, formData, token);
    } else {
      res = await viaGateway(false, async base => {   // 上傳是寫入：不自動重送
        const r = await fetch(base + path, { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: formData });
        const j = await r.json();
        return { value: j, fault: isGatewayError(r.status, j) };
      });
    }
  } catch (e) {
    const err = new Error(NET_MSG);
    err.code = 'NETWORK';
    throw err;
  }
  return settle(res, path, token);
}

// 取圖片（GET）：入口通行證放標頭，不放網址；回 Blob，呼叫端用 URL.createObjectURL 顯示
export async function apiBlob(path) {
  const token = hooks.getToken();
  const netErr = () => { const err = new Error(NET_MSG); err.code = 'NETWORK'; return err; };
  if (MOCK) {
    const { handleBlob } = await whileLeaving(import('./mock.js'));
    const res = await handleBlob(path, token);
    if (res instanceof Blob) return res;
    return settle(res, path, token);
  }
  let out;
  try {
    out = await viaGateway(true, async base => {
      const r = await fetch(base + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
      if (r.ok) return { value: { blob: await r.blob() }, fault: false };
      let j = null; try { j = await r.json(); } catch (e) { /* 非 JSON */ }
      return { value: { json: j }, fault: isGatewayError(r.status, j) };
    });
  } catch (e) { throw netErr(); }
  if (out.blob) return out.blob;
  return settle(out.json || { ok: false }, path, token);
}

// 走新路（Cloudflare 櫃台）；網路錯誤或櫃台自己回 502 GATEWAY ＝ 櫃台故障：記下記號（之後 5 分鐘都走舊路）。
// 讀取立刻改用舊路重送一次；寫入不重送（可能已經寫進去了），照原本的錯誤顯示。
// req(base) 回 { value, fault }；網路錯誤直接丟出。
// 頁面正在離開（重新整理、換頁）時瀏覽器會中斷還沒回來的請求，丟出跟斷網一樣的錯誤：這時不判定櫃台故障（2026-11-10 正式站實測誤判）
let leaving = false;
try { addEventListener('pagehide', () => { leaving = true; }); addEventListener('beforeunload', () => { leaving = true; }); } catch (e) { /* node 測試沒有 window */ }
// 網路錯誤後確認櫃台是不是真的壞了：2.5 秒內打一次 /__gw/ping，打不通才算
async function gatewayAlive(base) {
  try {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(String(base).replace(/\/store\/api$/, '') + '/__gw/ping', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(t);
    return !!r && r.ok;
  } catch (e) { return false; }
}
async function viaGateway(isRead, req) {
  const base = gateway.apiBase();
  let first, err;
  try { first = await req(base); } catch (e) { err = e; }
  const failed = !!err || first.fault;
  if (!failed || !gateway.isNew(base)) { if (err) throw err; return first.value; }
  let down = true;                                   // 櫃台自己回 502 GATEWAY＝確定故障
  if (err) down = !leaving && !(await gatewayAlive(base)) && !leaving;   // 網路錯誤：先確認
  if (down) gateway.markFault();
  if (!isRead) { if (err) throw err; return first.value; }
  return (await req(down ? gateway.oldBase() : base)).value;
}
