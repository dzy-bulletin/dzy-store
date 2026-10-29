// 申請審核（2026-10-09）：同仁從 LINE 送的加班／請假／出差／忘打卡申請，主管在這裡核准或退回。
// 批次核准（2026-10-09 第二批）：勾選＋全選＋「核准勾選的 N 筆」→ mgr_req_decide_batch（只能核准；退回要理由，一筆一筆退）。
// 照 ~/mala-clock-in manager.html（feature/requests-qr）的 loadPendingRequests／buildReqItem 搬，文案不改；外觀換成營運系統風格。
// 核准申請「不會」直接寫入核定：只是讓那天的核定頁先幫主管填好，主管核定那天時確認送出才算數（見 approve.js 的 __applyReq）。
import { confirmBox } from '../../js/ui.js';
import { S, call, callAll, h, failBar, failedStores, setReqBadge, loadLeave, leaveFor, canWriteRow, supportTag, reqTodo } from './state.js';
import { tsLabel, shortDate, punchEvidence, compBalanceNote, REQ_KIND_LABEL, REQ_BATCH_MAX } from './calc.js';

export function renderRequest(ctx) {
  const el = ctx.el;
  el.innerHTML = '<div id="duReqBox"><div class="card du-center">載入中…</div></div>';
  const box = el.querySelector('#duReqBox');
  function load() {
    // 補休申請要附餘額：假別額度和待審清單一起抓；額度抓不到不擋人，只是不顯示餘額（原頁同）
    Promise.all([S.all ? callAll('mgr_req_pending') : call('mgr_req_pending'), loadLeave()]).then(([r]) => {
      if (!el.isConnected) return;
      box.innerHTML = '';
      const items = reqTodo(r.items);
      const mine = (Array.isArray(r.items) ? r.items : []).filter(it => it && it.self === true);      // 店長本人自己送的：送上層審核中，放最下面、不算數字（2026-10-29 Eason 4A）
      setReqBadge(items.length);
      if (S.all) failedStores(box, r.failed, load);           // 全部門市：讀不到的店標出來，其他店照常審
      const mineCard = () => {
        if (!mine.length) return null;
        const c = h('div', 'du-rq-mine');
        c.append(h('div', 'du-rq-title', '我自己送出的（' + mine.length + ' 筆）'), h('div', 'du-rq-mine-hint', '值班主管本人的申請由上層主管（區督導或總監）審核，這裡只給你看進度。'));
        mine.forEach(it => c.append(buildMine(it)));
        return c;
      };
      if (!items.length) { box.append(h('div', 'card du-center', r.failed && r.failed.length ? '讀得到的門市目前沒有待審的申請。' : '目前沒有待審的申請。')); const m = mineCard(); if (m) box.append(m); return; }
      const card = h('div', 'du-rq-list');
      const title = h('div', 'du-rq-title', '待審申請 ' + items.length + ' 筆（最舊的在上面）');
      card.append(title, buildBatchBar(card, title));
      items.forEach(it => card.append(buildItem(it, card, title)));
      if (!card.querySelector('.du-rq-pick')) { const bw = card.querySelector('.du-rq-batchwrap'); if (bw) bw.hidden = true; }      // 全是唯讀（只看）：沒有批次核准列
      box.append(card);
      syncBatch(card);
      const m = mineCard(); if (m) box.append(m);
    }, e => { if (!el.isConnected) return; box.innerHTML = ''; const c = h('div', 'card'); box.append(c); failBar(c, '待審申請', e, load); });
  }
  load();
}

// 待審數字：標題、分頁徽章（單筆與批次共用）
function refreshTitle(card, title) {
  const left = card.querySelectorAll('.du-rq-acts').length;
  title.textContent = left ? '待審申請 ' + left + ' 筆（最舊的在上面）' : '待審申請都處理完了';
  setReqBadge(left);
  const bar = card.querySelector('.du-rq-batch'); if (bar && !left) bar.hidden = true;
}
function syncBatch(card) {
  const picks = [...card.querySelectorAll('.du-rq-pick')], on = picks.filter(x => x.checked).length;
  const all = card.querySelector('.du-rq-all'), btn = card.querySelector('.du-rq-batchgo');
  if (!all || !btn) return;
  all.checked = picks.length > 0 && on === picks.length;
  all.indeterminate = on > 0 && on < picks.length;
  btn.textContent = '核准勾選的 ' + on + ' 筆';
  btn.disabled = on === 0;
}
function buildBatchBar(card, title) {
  const wrap = h('div', 'du-rq-batchwrap');
  const bar = h('div', 'du-rq-batch'), lab = h('label');
  const all = h('input', 'du-rq-all', null, { type: 'checkbox', 'aria-label': '全選待審申請' });
  lab.append(all, document.createTextNode('全選'));
  const btn = h('button', 'du-rq-batchgo btn', '核准勾選的 0 筆', { type: 'button' }); btn.disabled = true;
  const msg = h('div', 'du-rq-msg'); msg.setAttribute('role', 'status');
  bar.append(lab, btn); wrap.append(bar, msg);
  all.onchange = () => { card.querySelectorAll('.du-rq-pick').forEach(x => { x.checked = all.checked; }); syncBatch(card); };
  btn.onclick = async () => {
    const els = [...card.querySelectorAll('.du-rq')].filter(el => { const c = el.querySelector('.du-rq-pick'); return c && c.checked; });
    if (!els.length) return;
    if (els.length > REQ_BATCH_MAX) { msg.className = 'du-rq-msg bad'; msg.textContent = '一次最多核准 ' + REQ_BATCH_MAX + ' 筆，請少勾幾筆'; return; }
    const list = els.map(el => '・' + (el.__req.storeName ? el.__req.storeName + ' ' : '') + el.__req.name + '：' + el.__req.summary).join('\n');
    if (!await confirmBox('核准以下 ' + els.length + ' 筆申請？\n' + list + '\n\n核准後，那幾天的核定會先幫你填好，你核定那天時確認送出才算數。', '核准 ' + els.length + ' 筆')) return;
    btn.disabled = all.disabled = true; msg.className = 'du-rq-msg'; msg.textContent = '送出中…';
    // 跨店時依店分批（每批一次 mgr_req_decide_batch，帶那一批的店）；任一批沒通過只影響那一批，結果逐店回報
    const groups = new Map();
    els.forEach(el => { const k = el.__req.store || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(el); });
    const bad = [];
    let nDone = 0, nSkip = 0;
    await Promise.all([...groups.entries()].map(async ([store, gEls]) => {
      try {
        const r = await call('mgr_req_decide_batch', { ids: gEls.map(el => el.__req.id), decision: 'approve', store: store || undefined });
        const done = Array.isArray(r.done) ? r.done.map(String) : [], skipped = Array.isArray(r.skipped) ? r.skipped : [];
        gEls.forEach(el => {
          const it = el.__req, tag = (it.storeName ? it.storeName + ' ' : '');
          if (done.indexOf(String(it.id)) >= 0) { nDone++; el.__markDone('✓ 已核准：' + tag + it.name + ' ' + it.summary); delete S.dayCache[it.date]; return; }
          const sk = skipped.filter(x => String(x.id) === String(it.id))[0];
          if (sk) { nSkip++; el.__markDone('— 略過：' + tag + it.name + ' ' + it.summary + '（' + sk.reason + '）'); }
        });
      } catch (e) { bad.push({ store, storeName: (gEls[0].__req.storeName || ''), names: gEls.map(el => el.__req.name + ' ' + el.__req.summary), message: (e && e.message) || '沒有成功，請再試一次' }); }
    }));
    if (bad.length) {
      msg.className = 'du-rq-msg bad';
      msg.textContent = groups.size === 1 ? '✕ ' + bad[0].message
        : '✕ ' + bad.map(b => (b.storeName ? b.storeName + '：' : '') + b.message + '（沒送出：' + b.names.join('、') + '）').join('\n') + (nDone ? '\n其餘已核准 ' + nDone + ' 筆' : '');
    } else msg.textContent = nSkip ? '已核准 ' + nDone + ' 筆，略過 ' + nSkip + ' 筆（已被處理過）' : '';
    all.disabled = false;
    refreshTitle(card, title); syncBatch(card);
  };
  return wrap;
}

// 本人自己送的申請（只看）：沒有勾選、核准、退回、看附件
function buildMine(it) {
  const el = h('div', 'du-rq du-rq-self'); el.dataset.reqId = String(it.id); if (it.store) el.dataset.store = it.store;
  const l1 = h('div', 'du-rq-l1'), who = h('span', 'du-rq-who');
  who.append(h('span', 'du-rq-kind ' + (REQ_KIND_LABEL[it.kind] ? it.kind : ''), REQ_KIND_LABEL[it.kind] || it.kind), h('span', 'du-rq-name', it.name), ...(it.storeName ? [h('span', 'du-where', '打卡地點：' + it.storeName, { 'data-where': it.store })] : []));
  l1.append(who, h('span', 'du-rq-date', shortDate(it.date)));
  el.append(l1, h('div', 'du-rq-l2', it.summary + (it.reason ? '\n原因：' + it.reason : '') + '\n送出：' + tsLabel(it.created_at)));
  const acts = h('div', 'du-rq-acts du-rq-acts-self');
  const ok = h('button', 'du-rq-ok btn', '核准', { type: 'button' }), no = h('button', 'du-rq-no btn ghost', '退回', { type: 'button' });
  ok.disabled = no.disabled = true;
  acts.append(h('span', 'du-rq-upper', '送上層審核中'), ok, no);
  el.append(acts);
  return el;
}
// 打卡端 upper_kind（2026-10-29）：mgr＝值班主管本人；dept＝總部同仁在門市（申請照原身分）；home＝不算本店支援。舊打卡後端沒有這欄＝值班主管本人
function upperIsDept(it) { return it.upper_kind === 'dept' || it.upper_kind === 'home'; }
function upperLabel(it) { return upperIsDept(it) ? '部門同仁' : '值班主管本人'; }

function buildItem(it, card, title) {
  const el = h('div', 'du-rq'); el.dataset.reqId = String(it.id); el.__req = it; if (it.store) el.dataset.store = it.store;
  const l1 = h('div', 'du-rq-l1'), who = h('span', 'du-rq-who');
  const canDecide = canWriteRow('req', it.emp_id, it.store);      // 不在申請審核名單（只看）：沒有勾選、核准、退回、看附件，改顯示「唯讀」
  const pick = h('input', 'du-rq-pick', null, { type: 'checkbox', 'aria-label': '勾選 ' + it.name + ' ' + it.summary });
  pick.onchange = () => syncBatch(card);
  if (canDecide) who.append(pick);
  const sup = supportTag(it);      // 支援（原單位）
  who.append(h('span', 'du-rq-kind ' + (REQ_KIND_LABEL[it.kind] ? it.kind : ''), REQ_KIND_LABEL[it.kind] || it.kind), h('span', 'du-rq-name', it.name), ...(sup ? [sup] : []), ...(it.upper === true && canDecide ? [h('span', 'du-rq-kind upper', upperLabel(it))] : []), ...(it.storeName ? [h('span', 'du-where', '打卡地點：' + it.storeName, { 'data-where': it.store })] : []));
  l1.append(who, h('span', 'du-rq-date', shortDate(it.date)));
  el.append(l1, h('div', 'du-rq-l2', it.summary + (it.reason ? '\n原因：' + it.reason : '') + compBalanceNote(leaveFor(it.store), it) + '\n送出：' + tsLabel(it.created_at)));
  const ev = punchEvidence(it);
  if (ev) el.append(h('div', 'du-rq-evid', ev));

  const acts = h('div', 'du-rq-acts');
  const ok = h('button', 'du-rq-ok btn', '核准', { type: 'button' }), no = h('button', 'du-rq-no btn ghost', '退回', { type: 'button' });
  if (canDecide) acts.append(ok, no); else acts.append(h('span', 'du-ro', it.upper === true ? (upperIsDept(it) ? '部門主管審核中' : '送上層審核中') : '唯讀'));
  if (it.attach_id && canDecide) {
    const at = h('button', 'du-rq-att btn ghost', '看附件', { type: 'button' });
    at.onclick = async () => {
      at.disabled = true; at.textContent = '載入中…';
      try {
        const r = await call('line_hub_attach_get', { attach_id: it.attach_id, store: it.store });
        const mime = String(r.mime || ''), data = String(r.data || '');
        if (!data) throw new Error('empty');
        at.remove();
        if (/^image\/(png|jpe?g|gif|webp|heic|heif)$/i.test(mime)) {
          const img = h('img', 'du-rq-img', null, { alt: it.name + ' 的申請附件' }); img.src = 'data:' + mime + ';base64,' + data; el.append(img);
        } else {
          // 依實際格式給檔名與文字；不認得的格式不假裝成 PDF（2026-10-11 審查）
          const KNOWN = { 'application/pdf': ['pdf', 'PDF'], 'application/msword': ['doc', 'Word'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx', 'Word'],
            'application/vnd.ms-excel': ['xls', 'Excel'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx', 'Excel'] };
          const k = KNOWN[String(mime).toLowerCase()];
          const a = h('a', 'du-rq-file', k ? `下載附件（${k[1]}）` : '下載附件（格式無法預覽，下載後用對應的程式開）', { download: 'attachment.' + (k ? k[0] : 'bin') });
          a.href = 'data:' + (k ? mime : 'application/octet-stream') + ';base64,' + data; el.append(a);
        }
      } catch (e) { at.disabled = false; at.textContent = '附件讀不到，再試一次'; }
    };
    acts.append(at);
  }
  el.append(acts);
  const msg = h('div', 'du-rq-msg'); msg.setAttribute('role', 'status'); el.append(msg);
  let reason = null;
  const say = (cls, text) => { msg.className = 'du-rq-msg ' + cls; msg.textContent = text; };

  async function decide(decision) {
    const body = { id: it.id, decision, store: it.store };
    if (decision === 'reject') {
      if (!reason) {                               // 第一次按「退回」只打開理由欄；理由必填，會原文給同仁看
        reason = h('input', 'du-rq-reason', null, { type: 'text', maxlength: '100', placeholder: '退回理由（必填，會原文給同仁看）', 'aria-label': '退回理由' });
        reason.oninput = () => { if (msg.classList.contains('bad')) say('', ''); };
        el.insertBefore(reason, acts); no.textContent = '確定退回'; reason.focus(); return;
      }
      if (!reason.value.trim()) return say('bad', '請寫退回理由');
      body.reason = reason.value.trim();
    } else if (!await confirmBox('核准 ' + it.name + '：' + it.summary + '？\n核准後，那天的核定會先幫你填好，你核定那天時確認送出才算數。', '核准')) return;
    ok.disabled = no.disabled = true; say('', '送出中…');
    try {
      await call('mgr_req_decide', body);
      el.__markDone((decision === 'approve' ? '✓ 已核准：' : '✕ 已退回：') + it.name + ' ' + it.summary);
      refreshTitle(card, title); syncBatch(card);
      if (decision === 'approve') delete S.dayCache[it.date];     // 那天的核定頁要重抓才看得到預填
    } catch (e) { ok.disabled = no.disabled = false; say('bad', '✕ ' + (e.message || '沒有成功，請再試一次')); }
  }
  el.__markDone = text => { el.textContent = ''; el.classList.add('done'); el.append(h('div', 'du-rq-l2', text)); };   // 單筆與批次共用
  ok.onclick = () => decide('approve'); no.onclick = () => decide('reject');
  return el;
}
