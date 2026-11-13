// 考勤副本背景送出（2026-11-14 Eason，docs/duty-replica-b）：核定、核准先顯示，Mac mini 背景送到打卡系統。
// 這裡負責：每 2 秒問一次 mirror_jobs 直到自己送出的都有結果、把結果交回給那張卡片、頁頂「被退回 N 筆」。
import { S, call } from './state.js';
import { h } from './state.js';

const waiting = new Map();        // job id → 結果回呼
let timer = null, lastItems = [];

/** 這筆資料能不能依副本背景送：資料是從 Mac mini 副本讀的、而且有版本（核定要比對） */
export const canBg = (row) => !!(row && row.__mirror && typeof row.ver === 'string' && row.ver);

/** 送出後回 queued 的：記下來等結果。onState({state:'done'|'rejected'|'failed', msg, result}) */
export function watchJob(id, onState) {
  if (!id) return;
  waiting.set(Number(id), onState);
  schedule(1500);
}
function schedule(ms) {
  if (timer) return;
  timer = setTimeout(async () => { timer = null; await refreshJobs(); if (waiting.size) schedule(2000); }, ms);
}
export async function refreshJobs() {
  let r;
  try { r = await call('mirror_jobs', {}); } catch (e) { return lastItems; }
  lastItems = Array.isArray(r && r.items) ? r.items : [];
  S.bgJobs = lastItems;
  for (const it of lastItems) {
    const f = waiting.get(Number(it.id));
    if (f && it.state !== 'pending') { waiting.delete(Number(it.id)); try { f(it); } catch (e) { /* 卡片已經不在畫面上 */ } }
  }
  // 已經不在清單裡的（超過 10 分鐘的完成紀錄）：當作完成，不要一直問
  for (const id of [...waiting.keys()]) if (!lastItems.some((x) => Number(x.id) === id)) { const f = waiting.get(id); waiting.delete(id); try { f({ id, state: 'done', msg: '' }); } catch (e) { /* 同上 */ } }
  window.dispatchEvent(new CustomEvent('duty-bgjobs'));
  return lastItems;
}
export const rejectedJobs = () => (S.bgJobs || []).filter((j) => j.state === 'rejected' || j.state === 'failed');

/** 頁頂「被退回 N 筆」：點一筆跳到那天那位（onGo(date, empId, code)），「知道了」收起來 */
export function rejectBar(onGo) {
  const bar = h('div', 'du-bgbar', null, { id: 'duBgBar', role: 'status' });
  const names = () => {
    const m = {};
    for (const card of document.querySelectorAll('.du-card')) if (card.dataset.empId) m[card.dataset.empId] = (card.querySelector('.du-name') || {}).textContent || '';
    return m;
  };
  const draw = () => {
    const list = rejectedJobs();
    bar.textContent = '';
    bar.hidden = !list.length;
    if (!list.length) return;
    const nm = names();
    bar.append(h('div', 'du-bgbar-t', '被退回 ' + list.length + ' 筆：打卡系統沒有接受，請重新處理'));
    for (const j of list) {
      const row = h('div', 'du-bgbar-r');
      const who = j.act === 'mgr_approve' ? (j.date.slice(5).replace('-', '/') + ' ' + (nm[j.emp_id] || j.emp_id) + ' 的核定') : '一筆申請審核';
      row.append(h('span', 'du-bgbar-w', who + '：' + (j.msg || '請重新處理')));
      if (j.act === 'mgr_approve' && onGo) {
        const go = h('button', 'btn sm', '去重新核定', { type: 'button' });
        go.onclick = () => onGo(j.date, j.emp_id, j.code);
        row.append(go);
      }
      const ok = h('button', 'btn sm ghost', '知道了', { type: 'button' });
      ok.onclick = async () => { ok.disabled = true; try { await call('mirror_ack', { id: j.id }); } catch (e) { /* 下次再收 */ } await refreshJobs(); };
      row.append(ok);
      bar.append(row);
    }
  };
  draw();
  const onEv = () => { if (!bar.isConnected) { window.removeEventListener('duty-bgjobs', onEv); return; } draw(); };
  window.addEventListener('duty-bgjobs', onEv);
  return bar;
}
