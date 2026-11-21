// 核定「資料更新中」自動等待（2026-11-21，先讀到自己的寫入；Eason 2026-11-21 定案第 1–3 題）：
//   伺服器回 CONFLICT＋reason:'duty_syncing'＝Mac mini 的副本還沒包含這位同仁剛收下的寫入。前端顯示「資料更新中，請稍候…」，
//   照 retry_ms 自動再送同一份內容（核定也一樣，base_ver 會擋錯核），最多等 90 秒；超過就停，顯示「資料還在更新，請稍後再試一次」，主管再按一次會整個重來。
//   取消（#354 驗收必修）：離開頁面、換店、換人、換日期、換登入時呼叫 cancelAll()（或 stale() 回 true）→ 不再重送、橫幅收掉、
//   還在路上的那一次回來也不採用（丟 DUTY_SYNC_CANCELLED，呼叫端不顯示任何東西）。
//   不碰畫面（DOM）：顯示交給呼叫端的 onWait，方便測試。
//   寫回卡住（2026-11-21 設計稿 7b）：reason 'duty_stuck'（這位同仁上一筆超過 3 分鐘還沒寫回）不是 duty_syncing → 這裡不等、不重送，錯誤照丟，
//   呼叫端照原本顯示錯誤的方式顯示伺服器那句（不新增版面元件）。
export const SYNC_WAIT_MSG = '資料更新中，請稍候…';
export const SYNC_GIVEUP_MSG = '資料還在更新，請稍後再試一次';
export const SYNC_MAX_MS = 90000;
export const isSyncing = (e) => !!(e && e.code === 'CONFLICT' && e.reason === 'duty_syncing');
export const isSyncCancelled = (e) => !!(e && e.code === 'DUTY_SYNC_CANCELLED');
const cancelledErr = () => { const x = new Error(''); x.code = 'DUTY_SYNC_CANCELLED'; return x; };

/** run：送一次（回 Promise）；first：已經收到的那個 duty_syncing 錯誤；o.token：{cancelled, wake}（cancelAll 用）；o.stale()：回 true＝畫面已換（取消）。
 *  回最後成功的結果；別的錯誤照丟；超過上限丟 SYNC_GIVEUP_MSG（code DUTY_SYNC_GIVEUP）；取消丟 DUTY_SYNC_CANCELLED */
export async function waitSyncing(run, first, o) {
  o = o || {};
  const now = o.now || Date.now, tok = o.token || { cancelled: false, wake: null };
  const sleep = o.sleep || ((ms) => new Promise((r) => { const t = setTimeout(r, ms); tok.wake = () => { clearTimeout(t); r(); }; }));
  const mx = typeof o.maxMs === 'function' ? o.maxMs() : o.maxMs;
  const max = mx === undefined || mx === null ? SYNC_MAX_MS : mx, t0 = now();
  const gone = () => tok.cancelled || (typeof o.stale === 'function' && o.stale());
  let e = first;
  if (o.onWait) o.onWait(true);
  try {
    for (;;) {
      if (gone()) throw cancelledErr();
      const left = max - (now() - t0);
      if (left <= 0) { const x = new Error(SYNC_GIVEUP_MSG); x.code = 'DUTY_SYNC_GIVEUP'; throw x; }
      await sleep(Math.min(Math.max(o.minRetryMs === undefined ? 500 : o.minRetryMs, Number(e && e.retryMs) || 2000), left));
      tok.wake = null;
      if (gone()) throw cancelledErr();
      let r;
      try { r = await run(); } catch (err) { if (gone()) throw cancelledErr(); if (!isSyncing(err)) throw err; e = err; continue; }
      if (gone()) throw cancelledErr();      // 等待中畫面換了：晚回來的結果不採用
      return r;
    }
  } finally { if (o.onWait) o.onWait(false); }
}

/** 同一個動作＋同一份內容正在等的時候，再叫一次＝拿同一個結果（主管連按不會多送）；不在等的時候照常各送各的。
 *  gate.cancelAll()：取消所有正在等的（換頁、換店、換人、換日期） */
export function makeSyncGate(o) {
  o = o || {};
  const waiting = new Map(), toks = new Set();
  async function gate(key, run, extra) {
    if (waiting.has(key)) return waiting.get(key);
    try { return await run(); }
    catch (e) {
      if (!isSyncing(e)) throw e;
      if (waiting.has(key)) return waiting.get(key);
      const tok = { cancelled: false, wake: null };
      toks.add(tok);
      const p = waitSyncing(run, e, Object.assign({}, o, extra || {}, { token: tok }));
      waiting.set(key, p);
      try { return await p; } finally { if (waiting.get(key) === p) waiting.delete(key); toks.delete(tok); }
    }
  }
  gate.cancelAll = () => { for (const t of toks) { t.cancelled = true; if (t.wake) t.wake(); } toks.clear(); waiting.clear(); };
  gate.waiting = () => waiting.size;
  return gate;
}
