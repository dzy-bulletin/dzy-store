// 員工名冊：新進同仁報到（manager.html:1930–2010）＋同仁異動（離職＝停用不是真刪、可恢復，manager.html:2012–2120）。
// 2026-10-18 起新人統一在管理系統新增，這裡只剩備案（收合）；建立帳號只建打卡帳號，要通知總部在管理系統建檔。建立後專屬打卡連結收合成次要資訊（LINE 打卡上線後少用）；連結裡的 k 是該員工自己的打卡金鑰（不是主管金鑰）。
import { esc, confirmBox } from '../../js/ui.js';
import { DZY_ORIGIN } from '../../js/config.js';
import { S, dutyManager, call, h, failBar, viewNoHoursStore, supportText } from './state.js';
import { clockLink } from './calc.js';

export function renderRoster(ctx) {
  const el = ctx.el, dm = dutyManager(ctx.session), vo = viewNoHoursStore(ctx.session);      // vo＝這家店沒有可核工時的人、不是店長（只看或混合店）：名冊唯讀，也不顯示 LINE 綁定紀錄（那支讀取不開放只看）
  // 非店長／人資／管理員：名冊與 LINE 綁定紀錄照常看，不顯示新增同仁與設離職／恢復
  el.innerHTML = `${dm ? `<div class="card" id="duAdd"><h2>新進同仁報到</h2>
    <div class="row"><a class="btn" id="aeDzy" href="${DZY_ORIGIN}/#/staff" target="_blank" rel="noopener">到管理系統新增（建議）</a></div>
    <p class="hint">新同仁請在管理系統新增，會同時建好打卡帳號與管理系統帳號，本人當天就能認領。</p>
    <details class="fb-box" id="aeFallback"><summary>管理系統連不上時才用（備案）</summary>
    <div class="note warn mt" id="aeWarn">這裡新增只會建打卡帳號；新人要等總部在管理系統建檔後才能認領帳號，請事後通知總部。</div>
    <div class="row mt"><input type="text" id="aeName" class="grow" placeholder="同仁姓名" autocomplete="off" maxlength="20" aria-label="同仁姓名"><button type="button" class="btn" id="aeBtn">建立帳號</button></div>
    <div class="du-msg" id="aeResult" hidden></div></details></div>` : ''}
    <div id="duRosterFail"></div>
    <div class="card" id="rosterCard"><h2>${dm ? '同仁異動' : '員工名冊'}</h2>
    ${dm ? `<p class="hint">同仁離職就在這裡設為離職，他<b>立刻無法打卡</b>、也不再出現在核定清單；<b>過去的打卡紀錄與已核定的工時都會保留</b>。設錯可以按恢復。</p>
    <div class="row"><select id="reSelect" class="grow" aria-label="選擇同仁"><option value="">選擇同仁…</option></select><button type="button" class="btn du-danger" id="reBtn" disabled>設為離職</button></div>` : '<p class="hint">新增同仁與設離職／恢復在職，要由店長、人資主管或管理員操作。</p>'}
    <div class="du-msg" id="reResult" hidden></div><div id="reInactive"></div></div>
    ${vo ? '' : `<div id="duLineFail"></div>
    <div class="card" id="lineBindCard"><h2>LINE 綁定紀錄</h2>
    <p class="hint">同仁第一次用 LINE「鼎兆元打卡」打卡時，要<b>人在店裡</b>並輸入全名才能綁定。下面是最近 30 天的紀錄；<b>不是本人綁的請立刻按「解除」</b>，那位同仁下次打卡要重新輸入全名。</p>
    <div class="du-msg" id="lbResult" hidden></div><div id="lbList"></div></div>`}`;
  const live = () => el.isConnected;
  const q = s => el.querySelector(s);
  const aeBox = q('#aeResult'), reBox = q('#reResult'), sel = q('#reSelect'), reBtn = q('#reBtn'), gone = q('#reInactive');   // 非主管時前四個是 null，下面都只在 dm 時用
  let myName = '';
  const show = (box, html, isErr) => { box.hidden = false; box.className = 'du-msg' + (isErr ? ' bad' : ' good'); box.innerHTML = html; };
  const shortDate = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? Number(m[2]) + '/' + Number(m[3]) : ''; };

  // ---- 同仁異動 ----
  function drawRoster(rows) {
    const actives = rows.filter(r => r.active && r.name !== myName), off = rows.filter(r => !r.active);
    const sup = r => { const t = supportText(r); return t ? `<span class="du-support" data-support="${esc(r.support_from)}">${esc(t)}</span>` : ''; };      // 支援（原單位）
    if (dm) {
      sel.innerHTML = '<option value="">選擇同仁…</option>' + actives.map(r => `<option value="${esc(r.emp_id)}">${esc(r.name)}（${esc(r.emp_id)}）${supportText(r) ? '・' + esc(supportText(r)) : ''}</option>`).join('');
      reBtn.disabled = actives.length === 0;
    }
    if (!dm) gone.innerHTML = `<div class="du-subtitle">在職（${actives.length}）</div>` + actives.map(r => `<div class="du-item"><span class="du-item-body">${esc(r.name)}（${esc(r.emp_id)}）${sup(r)}</span></div>`).join('');
    if (!off.length) { if (dm) gone.innerHTML = ''; return; }
    if (!dm) gone.innerHTML += '<div class="du-subtitle">已離職（' + off.length + '）</div>' + off.map(r => `<div class="du-item"><span class="du-item-body">${esc(r.name)}（${esc(r.emp_id)}）${sup(r)}</span></div>`).join('');
    if (!dm) return;
    gone.innerHTML = `<div class="du-subtitle">已離職（${off.length}）</div>` + off.map(r => {
      const when = shortDate(r.removed_at), by = r.removed_by ? '由 ' + esc(r.removed_by) + ' 設定' : '';
      const meta = when || by ? `<span class="du-when">${[when, by].filter(Boolean).join('・')}</span>` : '';
      return `<div class="du-item" data-emp="${esc(r.emp_id)}"><span class="du-item-body">${esc(r.name)}（${esc(r.emp_id)}）${sup(r)}${meta}</span>
        <button type="button" class="btn sm ghost re-restore" data-emp="${esc(r.emp_id)}" data-name="${esc(r.name)}">恢復在職</button></div>`;
    }).join('');
    gone.querySelectorAll('.re-restore').forEach(b => b.onclick = async () => {
      if (!await confirmBox('要讓「' + b.dataset.name + '」恢復在職嗎？\n他會重新能夠打卡。', '恢復在職')) return;
      setActive(b.dataset.emp, true, b);
    });
  }
  function load() {
    call('mgr_roster').then(r => { if (!live()) return; q('#duRosterFail').innerHTML = ''; myName = String(r.manager_name || ''); drawRoster(r.roster || []); },
      e => { if (live()) failBar(q('#duRosterFail'), '同仁名冊', e, load); });
  }
  async function setActive(empId, active, srcBtn) {
    const label = srcBtn.textContent; srcBtn.disabled = true; srcBtn.textContent = '處理中…';
    try {
      const res = await call('mgr_set_active', { emp_id: empId, active });
      show(reBox, active ? '✓ <b>' + esc(res.name) + '</b> 已恢復在職，可以打卡了'
        : '✓ <b>' + esc(res.name) + '</b> 已設為離職，他不能再打卡了。過去的打卡與核定紀錄都還在，設錯的話按下面的「恢復在職」。');
      sel.value = ''; S.dayCache = {}; load();
    } catch (e) { show(reBox, '✕ ' + esc(e.message || '設定失敗，請再試一次'), true); }
    finally { srcBtn.disabled = false; srcBtn.textContent = label; }
  }
  if (dm) reBtn.onclick = async () => {
    const empId = sel.value;
    if (!empId) return show(reBox, '✕ 請先選擇同仁', true);
    const name = sel.options[sel.selectedIndex].text.replace(/（.*$/, '');
    if (!await confirmBox('要把「' + name + '」設為離職嗎？\n\n・他從現在起無法打卡\n・過去的打卡紀錄與已核定工時都會保留\n・如果今天的工時還沒核定，請先核定再設離職\n\n設錯可以在下方按「恢復在職」。', '設為離職')) return;
    setActive(empId, false, reBtn);
  };

  // ---- LINE 綁定紀錄（照原頁 manager.html initLineBinds）----
  const lbList = q('#lbList'), lbBox = q('#lbResult');
  const LB_TYPE = { bind_name: '輸入全名綁定', bind_auto: '跨店同名（本人確認）', bind: '用打卡連結綁定' };
  const lbWhen = iso => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/); return m ? Number(m[2]) + '/' + Number(m[3]) + ' ' + m[4] + ':' + m[5] : ''; };
  function drawBinds(items) {
    if (!items.length) { lbList.innerHTML = '<p class="hint">最近 30 天沒有人綁定或解除。</p>'; return; }
    lbList.innerHTML = items.map(it => {
      const type = String(it.type || '');
      const label = type.indexOf('unbind_by:') === 0 ? '由 ' + esc(type.slice(10)) + ' 解除' : esc(LB_TYPE[type] || type);
      const stale = type.indexOf('bind') === 0 && !it.still_bound ? '・已不是目前綁定' : '';
      const btn = it.still_bound ? `<button type="button" class="btn sm ghost lb-unbind" data-emp="${esc(it.emp_id)}" data-name="${esc(it.name)}">解除</button>` : '';
      return `<div class="du-item"><span class="du-item-body">${esc(it.name)}（${esc(it.emp_id)}）<span class="du-when">${esc(lbWhen(it.ts))}・${label}${stale}</span></span>${btn}</div>`;
    }).join('');
    lbList.querySelectorAll('.lb-unbind').forEach(b => b.onclick = async () => {
      const name = b.dataset.name;
      if (!await confirmBox('要解除「' + name + '」的 LINE 綁定嗎？\n\n解除後他下次用 LINE 打卡要重新輸入全名綁定（要人在店裡）。\n不影響他原本的打卡連結，也不影響過去的打卡紀錄。', '解除綁定')) return;
      b.disabled = true; b.textContent = '處理中…';
      try { await call('mgr_line_unbind', { emp_id: b.dataset.emp }); show(lbBox, '✓ 已解除 <b>' + esc(name) + '</b> 的 LINE 綁定'); loadBinds(); }
      catch (e) { show(lbBox, '✕ ' + esc(e.message || '解除失敗，請再試一次'), true); b.disabled = false; b.textContent = '解除'; }
    });
  }
  function loadBinds() {
    call('mgr_line_binds').then(r => { if (!live()) return; q('#duLineFail').innerHTML = ''; drawBinds(r.items || []); },
      e => { if (live()) failBar(q('#duLineFail'), 'LINE 綁定紀錄', e, loadBinds); });
  }

  // ---- 新進同仁 ----
  const nameIn = q('#aeName'), aeBtn = q('#aeBtn');
  async function create() {
    const name = nameIn.value.trim();
    if (!name) { show(aeBox, '✕ 請先輸入姓名', true); nameIn.focus(); return; }
    if (!await confirmBox('要幫「' + name + '」建立打卡帳號嗎？\n建立後他就能開始打卡，紀錄會顯示是由你建立的。', '建立')) return;
    aeBtn.disabled = true; aeBtn.textContent = '建立中…';
    try {
      const res = await call('mgr_add_employee', { name });
      const link = clockLink(S.meta.clockStore, res.key);
      show(aeBox, '✓ 已建立 <b>' + esc(res.name) + '</b>（編號 ' + esc(res.emp_id) + '）<br>請他打開 LINE「鼎兆元打卡」，第一次打卡時人在店裡、輸入全名綁定。記得到「自動排班 › 同仁」補報到日期與正職／計時，並通知總部到管理系統把他建檔。'
        + '<details id="aeLinkBox"><summary>舊版專屬打卡連結（沒用 LINE 打卡的人才需要）</summary>用 Safari 開 → 加入主畫面，以後都從主畫面進：'
        + '<span class="du-link" id="aeLink">' + esc(link) + '</span><button type="button" class="btn sm ghost" id="aeCopy">複製連結</button></details>');
      nameIn.value = '';
      const cp = q('#aeCopy');
      cp.onclick = () => {
        const done = () => { cp.textContent = '✓ 已複製'; setTimeout(() => { cp.textContent = '複製連結'; }, 2000); };
        const fallback = () => { const r = document.createRange(); r.selectNodeContents(q('#aeLink')); const sl = getSelection(); sl.removeAllRanges(); sl.addRange(r); cp.textContent = '已選取，請長按複製'; };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, fallback); else fallback();
      };
      S.dayCache = {}; load();          // 名單重載：新同仁立刻出現在核定清單與下拉裡
    } catch (e) { show(aeBox, '✕ ' + esc(e.message || '建立失敗，請再試一次'), true); }
    finally { aeBtn.disabled = false; aeBtn.textContent = '建立帳號'; }
  }
  if (dm) { aeBtn.onclick = create; nameIn.onkeydown = e => { if (e.key === 'Enter') create(); }; }
  load();
  if (!vo) loadBinds();
}
