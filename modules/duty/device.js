// 裝置核准：照 manager.html:1767–1880（待核准裝置區）。核准邏輯全在後端 applyDeviceDecision（含「核准只解裝置這關、店外打的卡仍不入帳」），這裡只顯示與送出。
// 原頁沒有待核准時整區不畫；這裡是獨立分頁，所以沒有時顯示一行「目前沒有待核准的裝置」。
import { confirmBox } from '../../js/ui.js';
import { S, call, h, failBar } from './state.js';
import { tsLabel } from './calc.js';

export function renderDevice(ctx) {
  const el = ctx.el;
  el.innerHTML = '<div id="duDevBox"><div class="card du-center">載入中…</div></div>';
  const box = el.querySelector('#duDevBox');
  function load() {
    call('mgr_pending_devices').then(r => {
      if (!el.isConnected) return;
      box.innerHTML = '';
      const list = r.pending || [];
      if (!list.length) { box.append(h('div', 'card du-center', '目前沒有待核准的裝置。')); return; }
      list.forEach(g => box.append(buildCard(g)));
    }, e => { if (!el.isConnected) return; box.innerHTML = ''; const c = h('div', 'card'); box.append(c); failBar(c, '待核准裝置', e, load); });
  }
  load();
}

function buildCard(g) {
  const card = h('div', 'du-dev'); card.dataset.empId = String(g.emp_id);
  card.append(h('div', 'du-dev-title', '⚠ ' + g.name + '　新裝置待核准'));
  const range = g.count > 1 ? tsLabel(g.first_ts) + ' ～ ' + tsLabel(g.last_ts) : tsLabel(g.first_ts);
  card.append(h('div', 'du-dev-meta', g.count + ' 筆待核准打卡・' + range + '　最遠 ' + g.max_distance_m + ' 公尺\n裝置碼 …' + String(g.device_id).slice(-6)));
  // 全部都在範圍內＝人確實在店裡打的，可安心核准；有超出範圍的要主管自己判斷
  if (!g.all_within_range) card.append(h('div', 'du-dev-warn', '有打卡超出門市範圍。核准只會解除「裝置」這一關，超出範圍的那幾筆仍然不會入帳。'));
  const ok = h('button', 'btn du-dev-ok', '核准', { type: 'button' }), no = h('button', 'btn ghost du-dev-no', '拒絕', { type: 'button' });
  const actions = h('div', 'row'); actions.append(ok, no);
  const result = h('div', 'du-dev-result'); result.setAttribute('role', 'status');
  card.append(actions, result);
  async function decide(approve) {
    const msg = approve ? '核准 ' + g.name + ' 的新裝置？\n\n這 ' + g.count + ' 筆打卡會開始計入出勤，且她之後只能用這個裝置打卡。'
      : '拒絕 ' + g.name + ' 的新裝置？\n\n這 ' + g.count + ' 筆打卡將不予計入，原本綁定的裝置維持不變。';
    if (!await confirmBox(msg + '\n\n確定?', approve ? '核准' : '拒絕')) return;
    ok.disabled = no.disabled = true; result.className = 'du-dev-result'; result.textContent = '處理中…';
    try {
      const res = await call('mgr_device_decision', { emp_id: g.emp_id, device_id: g.device_id, approve });
      result.className = 'du-dev-result okmsg';
      result.textContent = (approve ? '✓ 已核准' : '✓ 已拒絕') + '，更新 ' + res.changed + ' 筆打卡';
      actions.hidden = true;
      S.dayCache = {};                // 核准會讓當日打卡狀態改變（pending→ok），清快取讓核定頁拿到新的打卡段
    } catch (e) { ok.disabled = no.disabled = false; result.className = 'du-dev-result err'; result.textContent = '✕ 失敗：' + e.message; }
  }
  ok.onclick = () => decide(true); no.onclick = () => decide(false);
  return card;
}
