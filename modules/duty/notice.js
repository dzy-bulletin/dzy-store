// 公告：店內公告（manager.html:2120–2260）。發布後馬上出現在同仁打卡頁最上方，多則每 5 秒輪流、最多顯示 N 則（新的優先）。
// 「下架」是停用不是真刪；日期留空＝一直顯示直到手動下架；120 字上限（後端回 max_len）。公告是自由文字，一律 esc 後才進 innerHTML。
import { esc, confirmBox } from '../../js/ui.js';
import { call, failBar } from './state.js';
import { taipeiToday } from './calc.js';

export function renderNotice(ctx) {
  const el = ctx.el;
  el.innerHTML = `<div id="duNtFail"></div><div class="card" id="noticeCard"><h2>店內公告</h2>
    <p class="hint">發布後<b>馬上</b>出現在同仁打卡頁的最上方。多則會每 5 秒輪流顯示，最多顯示 <b id="ntMaxShow">5</b> 則（新的優先）。</p>
    <textarea id="ntText" class="du-textarea" maxlength="120" rows="3" aria-label="公告內容" placeholder="例如：9/1 起中午休息時間為 12:00–13:00，休息不用打卡。"></textarea>
    <div class="row mt"><label for="ntEnds" class="du-lb">顯示到</label><input type="date" id="ntEnds"><span class="du-count-n" id="ntCount">0 / 120</span></div>
    <div class="row mt"><button type="button" class="btn" id="ntBtn">發布公告</button><span class="hint" style="margin:0">日期留空＝一直顯示，直到手動下架</span></div>
    <div class="du-msg" id="ntResult" hidden></div><div id="ntList"></div></div>`;
  const q = s => el.querySelector(s);
  const ta = q('#ntText'), ends = q('#ntEnds'), btn = q('#ntBtn'), box = q('#ntResult'), list = q('#ntList'), cnt = q('#ntCount');
  let maxLen = 120;
  const show = (html, bad) => { box.hidden = false; box.className = 'du-msg ' + (bad ? 'bad' : 'good'); box.textContent = ''; box.innerHTML = html; };
  const shortDate = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? Number(m[2]) + '/' + Number(m[3]) : ''; };
  function updateCount() { const n = ta.value.trim().length; cnt.textContent = n + ' / ' + maxLen; cnt.className = 'du-count-n' + (n > maxLen ? ' over' : ''); }

  function draw(rows) {
    if (!rows.length) { list.innerHTML = '<div class="du-subtitle">目前沒有任何公告，同仁的打卡頁不會出現公告區。</div>'; return; }
    const live = rows.filter(r => r.active && !r.expired);
    list.innerHTML = `<div class="du-subtitle">目前顯示中（${live.length}）／已發布過（${rows.length}）</div>` + rows.map(r => {
      const off = !r.active || r.expired;
      const tag = !r.active ? '<span class="tag">已下架</span>' : r.expired ? '<span class="tag">已過期</span>' : '';
      const meta = [shortDate(r.created_at) + ' 發布', r.created_by ? '由 ' + r.created_by : '', r.ends_on ? '顯示到 ' + r.ends_on : ''].filter(Boolean).join('・');
      return `<div class="du-item${off ? ' off' : ''}" data-id="${esc(r.id)}"><span class="du-item-body"><span class="du-nt-text">${esc(r.text)}</span> ${tag}<span class="du-when">${esc(meta)}</span></span>
        <button type="button" class="btn sm ghost nt-act" data-id="${esc(r.id)}" data-on="${r.active ? '0' : '1'}">${r.active ? '下架' : '重新顯示'}</button></div>`;
    }).join('');
    list.querySelectorAll('.nt-act').forEach(b => b.onclick = async () => {
      const on = b.dataset.on === '1';
      if (!await confirmBox(on ? '要讓這則公告重新出現在同仁的打卡頁嗎？' : '要把這則公告從同仁的打卡頁下架嗎？\n紀錄會保留，之後可以再按「重新顯示」。', on ? '重新顯示' : '下架')) return;
      const label = b.textContent; b.disabled = true; b.textContent = '處理中…';
      try {
        await call('mgr_set_notice_active', { id: b.dataset.id, active: on });
        show(on ? '✓ 已重新顯示，同仁打卡頁會再看到這則公告' : '✓ 已下架，同仁打卡頁不會再顯示這則公告'); load();
      } catch (e) { b.disabled = false; b.textContent = label; show('✕ ' + esc(e.message || '設定失敗，請再試一次'), true); }
    });
  }
  function load() {
    call('mgr_notices').then(r => {
      if (!el.isConnected) return;
      q('#duNtFail').innerHTML = '';
      if (Number(r.max_len) > 0) { maxLen = Number(r.max_len); ta.setAttribute('maxlength', String(maxLen)); }
      if (Number(r.max_show) > 0) q('#ntMaxShow').textContent = String(r.max_show);
      ends.min = taipeiToday();          // 下架日不給選過去的日子（後端也會擋）
      updateCount(); draw(r.notices || []);
    }, e => { if (el.isConnected) failBar(q('#duNtFail'), '店內公告', e, load); });
  }
  ta.oninput = updateCount;
  btn.onclick = async () => {
    const text = ta.value.trim();
    if (!text) return show('✕ 請先輸入公告內容', true);
    if (text.length > maxLen) return show('✕ 公告最多 ' + maxLen + ' 個字（目前 ' + text.length + ' 個字）', true);
    const until = ends.value ? '顯示到 ' + ends.value + ' 為止' : '一直顯示，直到你手動下架';
    if (!await confirmBox('這則公告會馬上出現在所有同仁的打卡頁最上方：\n\n' + text + '\n\n' + until + '。\n\n確定要發布嗎？', '發布')) return;
    const label = btn.textContent; btn.disabled = true; btn.textContent = '發布中…';
    try {
      await call('mgr_add_notice', { text, ends_on: ends.value || '' });
      show('✓ 已發布，同仁下次打開打卡頁就會看到'); ta.value = ''; ends.value = ''; updateCount(); load();
    } catch (e) { show('✕ ' + esc(e.message || '發布失敗，請再試一次'), true); }
    finally { btn.disabled = false; btn.textContent = label; }
  };
  updateCount(); load();
}
