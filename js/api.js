import { API_BASE, MOCK } from './config.js';

let hooks = { getToken: () => null, onAuth: () => {}, onMust: () => {} };
export function setHooks(h) { hooks = { ...hooks, ...h }; }

// 回傳 data；失敗丟 Error（.code=error 代碼，.message=後端白話訊息）
export async function api(method, path, body) {
  const token = hooks.getToken();
  let res;
  try {
    if (MOCK) {
      const { handle } = await import('./mock.js');
      res = await handle(method, path, body, token);
    } else {
      const r = await fetch(API_BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      });
      res = await r.json();
    }
  } catch (e) {
    const err = new Error('連不上伺服器，請確認網路後再試');
    err.code = 'NETWORK';
    throw err;
  }
  return settle(res, path, token);
}

function settle(res, path, token) {
  if (res && res.ok) return res.data;
  const err = new Error((res && res.message) || '發生錯誤，請稍後再試');
  err.code = (res && res.error) || 'SERVER_ERROR';
  // 這幾支的 AUTH 只是「密碼不對」，不代表登入過期，不能踢人
  const wrongPw = path === '/duty/unlock' || path === '/password' || path === '/login';
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
      const { handle } = await import('./mock.js');
      res = await handle('POST', path, formData, token);
    } else {
      const r = await fetch(API_BASE + path, { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: formData });
      res = await r.json();
    }
  } catch (e) {
    const err = new Error('連不上伺服器，請確認網路後再試');
    err.code = 'NETWORK';
    throw err;
  }
  return settle(res, path, token);
}

// 取圖片（GET）：入口通行證放標頭，不放網址；回 Blob，呼叫端用 URL.createObjectURL 顯示
export async function apiBlob(path) {
  const token = hooks.getToken();
  const netErr = () => { const err = new Error('連不上伺服器，請確認網路後再試'); err.code = 'NETWORK'; return err; };
  if (MOCK) {
    const { handleBlob } = await import('./mock.js');
    const res = await handleBlob(path, token);
    if (res instanceof Blob) return res;
    return settle(res, path, token);
  }
  let r;
  try { r = await fetch(API_BASE + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); } catch (e) { throw netErr(); }
  if (r.ok) return r.blob();
  let j = null; try { j = await r.json(); } catch (e) { /* 非 JSON */ }
  return settle(j || { ok: false }, path, token);
}
