// 申請審核（2026-10-09）：同仁從 LINE 送的加班／請假／忘打卡申請，主管在這裡核准或退回。
// 照 ~/mala-clock-in manager.html（feature/requests-qr）的 loadPendingRequests／buildReqItem 搬，文案不改；外觀換成營運系統風格。
// 核准申請「不會」直接寫入核定：只是讓那天的核定頁先幫主管填好，主管核定那天時確認送出才算數（見 approve.js 的 __applyReq）。
import { confirmBox } from '../../js/ui.js';
import { S, call, h, failBar } from './state.js';
import { tsLabel, shortDate, punchEvidence, REQ_KIND_LABEL } from './calc.js';

export function renderRequest(ctx) {
  const el = ctx.el;
  el.innerHTML = '<div id="duReqBox"><div class="card du-center">載入中…</div></div>';
  const box = el.querySelector('#duReqBox');
  function load() {
    call('mgr_req_pending').then(r => {
      if (!el.isConnected) return;
      box.innerHTML = '';
      const items = Array.isArray(r.items) ? r.items : [];
      if (!items.length) { box.append(h('div', 'card du-center', '目前沒有待審的申請。')); return; }
      const card = h('div', 'du-rq-list');
      const title = h('div', 'du-rq-title', '待審申請 ' + items.length + ' 筆（最舊的在上面）');
      card.append(title);
      items.forEach(it => card.append(buildItem(it, card, title)));
      box.append(card);
    }, e => { if (!el.isConnected) return; box.innerHTML = ''; const c = h('div', 'card'); box.append(c); failBar(c, '待審申請', e, load); });
  }
  load();
}

function buildItem(it, card, title) {
  const el = h('div', 'du-rq'); el.dataset.reqId = String(it.id);
  const l1 = h('div', 'du-rq-l1'), who = h('span', 'du-rq-who');
  who.append(h('span', 'du-rq-kind ' + (REQ_KIND_LABEL[it.kind] ? it.kind : ''), REQ_KIND_LABEL[it.kind] || it.kind), h('span', 'du-rq-name', it.name));
  l1.append(who, h('span', 'du-rq-date', shortDate(it.date)));
  el.append(l1, h('div', 'du-rq-l2', it.summary + (it.reason ? '\n原因：' + it.reason : '') + '\n送出：' + tsLabel(it.created_at)));
  const ev = punchEvidence(it);
  if (ev) el.append(h('div', 'du-rq-evid', ev));

  const acts = h('div', 'du-rq-acts');
  const ok = h('button', 'du-rq-ok btn', '核准', { type: 'button' }), no = h('button', 'du-rq-no btn ghost', '退回', { type: 'button' });
  acts.append(ok, no);
  if (it.attach_id) {
    const at = h('button', 'du-rq-att btn ghost', '看附件', { type: 'button' });
    at.onclick = async () => {
      at.disabled = true; at.textContent = '載入中…';
      try {
        const r = await call('line_hub_attach_get', { attach_id: it.attach_id });
        const mime = String(r.mime || ''), data = String(r.data || '');
        if (!data) throw new Error('empty');
        at.remove();
        if (/^image\/(png|jpe?g|gif|webp|heic|heif)$/i.test(mime)) {
          const img = h('img', 'du-rq-img', null, { alt: it.name + ' 的申請附件' }); img.src = 'data:' + mime + ';base64,' + data; el.append(img);
        } else {
          const a = h('a', 'du-rq-file', '下載附件（PDF）', { download: 'attachment.pdf' });
          a.href = 'data:' + (mime === 'application/pdf' ? mime : 'application/octet-stream') + ';base64,' + data; el.append(a);
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
    const body = { id: it.id, decision };
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
      el.textContent = '';
      el.classList.add('done');
      el.append(h('div', 'du-rq-l2', (decision === 'approve' ? '✓ 已核准：' : '✕ 已退回：') + it.name + ' ' + it.summary));
      const left = card.querySelectorAll('.du-rq-acts').length;
      title.textContent = left ? '待審申請 ' + left + ' 筆（最舊的在上面）' : '待審申請都處理完了';
      if (decision === 'approve') delete S.dayCache[it.date];     // 那天的核定頁要重抓才看得到預填
    } catch (e) { ok.disabled = no.disabled = false; say('bad', '✕ ' + (e.message || '沒有成功，請再試一次')); }
  }
  ok.onclick = () => decide('approve'); no.onclick = () => decide('reject');
  return el;
}
