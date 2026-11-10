// 選 API 主機：預設走新路（Cloudflare 櫃台）；櫃台故障記號（sessionStorage，5 分鐘內有效）存在時改走舊路。
// 純函式、不碰 location／window，方便單元測試（test/server/gateway.test.js）。
export const FAULT_KEY = 'dzystore_gw_fault';
export const FAULT_TTL_MS = 5 * 60 * 1000;

export function createGateway({ on, local, newBase, oldBase, storage, now = Date.now }) {
  const fault = () => {
    if (!storage) return false;
    try {
      const t = Number(storage.getItem(FAULT_KEY));
      if (!t) return false;
      if (now() - t < FAULT_TTL_MS && now() >= t) return true;
      storage.removeItem(FAULT_KEY);
    } catch (e) { /* 讀不到就當沒故障 */ }
    return false;
  };
  return {
    // 本機開發（同源）永遠用相對路徑；開關關掉＝舊網址；有故障記號＝舊網址；否則新網址
    apiBase() { return local ? '/store/api' : (!on || fault()) ? oldBase : newBase; },
    // 這個 base 是不是「新路」（只有新路出事才要記號與改道）
    isNew(base) { return !local && on && base === newBase; },
    oldBase() { return local ? '/store/api' : oldBase; },
    markFault() { if (local || !on || !storage) return; try { storage.setItem(FAULT_KEY, String(now())); } catch (e) { /* 存不了就算了，這次仍會重送讀取 */ } },
    faulted: fault,
  };
}

// 櫃台自己出錯：HTTP 502 ＋ JSON { ok:false, error:'GATEWAY' }
export const isGatewayError = (status, json) => status === 502 && !!json && json.error === 'GATEWAY';
