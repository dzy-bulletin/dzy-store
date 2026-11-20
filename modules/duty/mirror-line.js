// 「資料更新於」那一行（核定工時 quick.js、完整頁 approve.js 共用；打卡正本收回 mini 第 1 階段，設計 phase1-design.md 4.2–4.4、第 11 節）。
// 伺服器沒開「只讀 mini」（回應沒有 mirror_ro）＝字樣跟以前一模一樣：「資料更新於 HH:MM・從 Mac mini 讀取」。
// 開了以後：
//   平常：「資料更新於 HH:MM・打卡系統有異動會自動更新」（不再出現 Mac mini）
//   過期（mirror_state:'stale'＝打卡系統的變動暫時沒傳過來）：日期列下方一條黃底提示＋「直接向打卡系統讀取」外框按鈕；超過 24 小時改紅底、加「請通知資訊部」
//   按下：按鈕變「讀取中…」；成功＝灰色「已向打卡系統讀到最新（HH:MM）」3 秒後收回一般那一行；失敗＝黃條多一行「還是讀不到，請稍後再試」
// 核定按鈕不擋：送出照原本的保護（副本舊值時先向打卡端重讀、base_ver）。
import { h, snapLabel } from './state.js';

const SLOW = '・打卡系統回應較慢，先顯示這份；送出時仍以打卡系統為準';
const DAY_MS = 24 * 3600e3;

/** o：{ at, stale, ro, feed, freshAt, freshBusy, freshErr, onFresh, id }。回元素或 null（沒有可顯示的） */
export function mirrorLine(o) {
  if (o.freshAt) return h('div', 'du-mirror-at du-mirror-fresh', '已向打卡系統讀到最新（' + snapLabel(o.freshAt) + '）', { id: o.id, role: 'status' });
  if (!o.at) return null;
  if (!o.ro) return h('div', 'du-mirror-at', '資料更新於 ' + snapLabel(o.at) + '・從 Mac mini 讀取' + (o.stale ? SLOW : ''), { id: o.id });
  if (!o.feed) return h('div', 'du-mirror-at', '資料更新於 ' + snapLabel(o.at) + '・打卡系統有異動會自動更新' + (o.stale ? SLOW : ''), { id: o.id });
  const old = Date.now() - o.at > DAY_MS;
  const bar = h('div', 'du-mirror-stale' + (old ? ' red' : ''), null, { id: o.id, role: 'status' });
  const txt = h('div', 'du-mirror-stale-txt', '⚠ 打卡系統的最新資料暫時沒有傳過來（最後更新 ' + snapLabel(o.at) + '）。畫面可能不是最新，送出核定時仍會以打卡系統為準。' + (old ? '已超過一天，請通知資訊部。' : ''));
  bar.append(txt);
  const b = h('button', 'btn ghost du-mirror-fresh-btn', o.freshBusy ? '讀取中…' : '直接向打卡系統讀取', { type: 'button', id: (o.id || 'du') + 'Fresh' });
  b.disabled = !!o.freshBusy;
  b.onclick = () => { if (!o.freshBusy && typeof o.onFresh === 'function') o.onFresh(); };
  bar.append(b);
  if (o.freshErr) bar.append(h('div', 'du-mirror-stale-err', '還是讀不到，請稍後再試'));
  return bar;
}

/** 名冊、裝置、公告這幾頁（DUTY_MIRROR_EXTRA，伺服器從副本給時回 mirror_x_at）：一行灰字；沒有＝null（跟以前一樣什麼都不加） */
export function xLine(r, id, tail) {
  return r && r.mirror_x_at ? h('div', 'du-mirror-at', '資料更新於 ' + snapLabel(r.mirror_x_at) + (tail || '・打卡系統有異動會自動更新'), { id }) : null;
}
/** 申請單總表、核定紀錄（整月申請 mgr_req_month，2026-11-20）：這兩頁讀進來就放著、不會自己換新，所以不寫「會自動更新」，只寫換月份會重讀。全部門市＝最早的那家時間 */
export const MONTH_TAIL = '・換月份會重新讀取';

/** 回應 → 這一行要的四個旗標（幾份回應任一份是只讀 mini／過期就算） */
export function mirrorFlags(...rs) {
  const xs = rs.filter((r) => r && typeof r === 'object');
  return { ro: xs.some((r) => r.mirror_ro === true), feed: xs.some((r) => r.mirror_state === 'stale') };
}
