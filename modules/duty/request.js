// 申請審核（2026-10-09）：同仁從 LINE 送的加班／請假／出差／忘打卡申請，主管在這裡核准或退回。
// 批次核准（2026-10-09 第二批）：勾選＋全選＋「核准勾選的 N 筆」→ mgr_req_decide_batch（只能核准；退回要理由，一筆一筆退）。
// 照 ~/mala-clock-in manager.html（feature/requests-qr）的 loadPendingRequests／buildReqItem 搬，文案不改；外觀換成營運系統風格。
// 核准申請「不會」直接寫入核定：只是讓那天的核定頁先幫主管填好，主管核定那天時確認送出才算數（見 approve.js 的 __applyReq）。
import { confirmBox } from '../../js/ui.js';
import { S, call, callAll, h, failBar, failedStores, setReqBadge, loadLeave, leaveFor, supportTag, reqShown, reqCanDecide } from './state.js';
import { watchJob } from './bg.js';
import { tsLabel, shortDate, punchEvidence, compBalanceNote, reqQuotaBlock, reqWarnLines, REQ_KIND_LABEL, REQ_BATCH_MAX } from './calc.js';
import { groupPairs, groupHours, segWord } from './req-group.js';

export function renderRequest(ctx) {
  const el = ctx.el;
  el.innerHTML = '<div id="duReqBox"><div class="card du-center">載入中…</div></div>';
  const box = el.querySelector('#duReqBox');
  function load() {
    // 補休申請要附餘額：假別額度和待審清單一起抓；額度抓不到不擋人，只是不顯示餘額（原頁同）
    Promise.all([S.all ? callAll('mgr_req_pending') : call('mgr_req_pending'), loadLeave()]).then(([r]) => {
      if (!el.isConnected) return;
      box.innerHTML = '';
      const items = reqShown(r.items), todoN = items.filter(reqCanDecide).length, roN = items.length - todoN;      // 數字只算按得下去的；只能看的照列（2026-11-10）
      const mine = (Array.isArray(r.items) ? r.items : []).filter(it => it && it.self === true);      // 店長本人自己送的：送上層審核中，放最下面、不算數字（2026-10-29 Eason 4A）
      setReqBadge(todoN);
      failedStores(box, r.failed, load);           // 全部門市，或總部那組併進來的別家：讀不到的店標出來，其他照常審           // 全部門市：讀不到的店標出來，其他店照常審
      const mineCard = () => {
        if (!mine.length) return null;
        const c = h('div', 'du-rq-mine');
        c.append(h('div', 'du-rq-title', '我自己送出的（' + mine.length + ' 筆）'), h('div', 'du-rq-mine-hint', '值班主管本人的申請由上層主管（區督導或總監）審核，這裡只給你看進度。'));
        if (mine.some(it => it.upper_kind === 'director' || !!it.proxy_by)) c.append(h('div', 'du-rq-mine-hint', '主管幫你開的單也列在這裡，同樣不能自己審，由上層主管或系統管理員審核。'));
        mine.forEach(it => c.append(buildMine(it)));
        return c;
      };
      if (!items.length) { box.append(h('div', 'card du-center', r.failed && r.failed.length ? '讀得到的門市目前沒有待審的申請。' : '目前沒有待審的申請。')); const m = mineCard(); if (m) box.append(m); return; }
      const card = h('div', 'du-rq-list');
      const title = h('div', 'du-rq-title', todoN ? '待審申請 ' + todoN + ' 筆（最舊的在上面）' : '目前沒有要你審的申請');
      card.append(title);
      if (roN) card.append(h('div', 'du-rq-ronote', '另有 ' + roN + ' 筆只能看，不算在待審數字裡'));
      card.append(buildBatchBar(card, title));
      // 同一次送出（2026-11-18 一次填兩段）：同店、同組別、同人、同日、而且都按得下去的兩張框成一組；沒有組別標記的舊資料照舊一張一張列
      groupPairs(items, reqCanDecide).forEach(g => card.append(g.type === 'group' ? buildGroup(g.items, card, title) : buildItem(g.it, card, title)));
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
  const left = card.querySelectorAll('.du-rq-ok').length;      // 還有核准鈕的列＝還沒處理、而且按得下去的（唯讀列不算）
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
    const picked = [...card.querySelectorAll('.du-rq')].filter(el => { const c = el.querySelector('.du-rq-pick'); return c && c.checked; });
    await runBatch(picked, card, title, msg, on => { btn.disabled = all.disabled = on; });
    all.disabled = false;
    refreshTitle(card, title); syncBatch(card);
  };
  return wrap;
}

// 批次核准的實際動作（「核准勾選的 N 筆」與同一次送出的「兩筆一起核准」共用，判斷與文字一字不改）：
//   picked＝要核准的那幾列；msg＝結果寫在哪；lock(true)＝送出中鎖住按鈕（結束後由呼叫端放開）
//   組框在批次進行中不重算（一張一張標完成時不能先把框拆掉），整批結束才統一整理
async function runBatch(picked, card, title, msg, lock) {
  card.__batching = true;
  try { await runBatchInner(picked, card, title, msg, lock); }
  finally { card.__batching = false; card.querySelectorAll('.du-rq-grp').forEach(g => { if (g.__refresh) g.__refresh(); }); }
}
async function runBatchInner(picked, card, title, msg, lock) {
  const skipQ = picked.filter(el => el.__quotaBlock), els = picked.filter(el => !el.__quotaBlock);      // 額度已用完的略過並提示
  const skipNote = skipQ.length ? '已略過 ' + skipQ.length + ' 筆（額度已用完，不能核准）：' + skipQ.map(el => el.__req.name + ' ' + el.__req.summary).join('、') : '';
  skipQ.forEach(el => { const c = el.querySelector('.du-rq-pick'); if (c) c.checked = false; });
  if (!els.length) { if (skipNote) { msg.className = 'du-rq-msg bad'; msg.textContent = '✕ ' + skipNote; syncBatch(card); } return; }
  if (els.length > REQ_BATCH_MAX) { msg.className = 'du-rq-msg bad'; msg.textContent = '一次最多核准 ' + REQ_BATCH_MAX + ' 筆，請少勾幾筆'; return; }
  const list = els.map(el => '・' + (el.__req.storeName ? el.__req.storeName + ' ' : '') + el.__req.name + '：' + el.__req.summary).join('\n');
  const elseL = els.filter(el => elsewhereText(el.__req)).map(el => '・' + elsewhereText(el.__req));
  if (!await confirmBox('核准以下 ' + els.length + ' 筆申請？\n' + list + (elseL.length ? '\n\n⚠ 其中有這天沒在本店打卡的（可能送錯店）：\n' + elseL.join('\n') : '') + '\n\n核准後，那幾天的核定會先幫你填好，你核定那天時確認送出才算數。', '核准 ' + els.length + ' 筆')) return;
  lock(true); msg.className = 'du-rq-msg'; msg.textContent = '送出中…';
  // 跨店時依店分批（每批一次 mgr_req_decide_batch，帶那一批的店）；任一批沒通過只影響那一批，結果逐店回報
  const groups = new Map();
  els.forEach(el => { const k = el.__req.store || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(el); });
  const bad = [];
  let nDone = 0, nSkip = 0, nLock = 0;
  await Promise.all([...groups.entries()].map(async ([store, gEls]) => {
    try {
      const r = await call('mgr_req_decide_batch', { ids: gEls.map(el => el.__req.id), decision: 'approve', store: store || undefined });
      const done = Array.isArray(r.done) ? r.done.map(String) : [], skipped = Array.isArray(r.skipped) ? r.skipped : [];
      const warns = Array.isArray(r.warn_items) ? r.warn_items : [];      // 那天已核定、要重新核定的幾筆（2026-11-13 a2）
      gEls.forEach(el => {
        const it = el.__req, tag = (it.storeName ? it.storeName + ' ' : '');
        const wn = warns.filter(x => String(x.id) === String(it.id))[0];
        if (done.indexOf(String(it.id)) >= 0) { nDone++; el.__markDone('✓ 已核准：' + tag + it.name + ' ' + it.summary + (wn ? '\n⚠ ' + (wn.message || '那天已經核定過，請重新核定一次') : '')); delete S.dayCache[it.date]; return; }
        const sk = skipped.filter(x => String(x.id) === String(it.id))[0];
        // 薪資鎖月（2026-11-15）：那筆沒有被處理，留在清單上、寫出原因（解鎖後可以再核），不算「已被處理過」
        if (sk && /薪資已鎖定/.test(String(sk.reason || ''))) { nLock++; const c = el.querySelector('.du-rq-pick'); if (c) c.checked = false; el.__say('bad', '✕ ' + sk.reason); return; }
        if (sk) { nSkip++; el.__markDone('— 略過：' + tag + it.name + ' ' + it.summary + '（' + sk.reason + '）'); }
      });
    } catch (e) { bad.push({ store, storeName: (gEls[0].__req.storeName || ''), names: gEls.map(el => el.__req.name + ' ' + el.__req.summary), message: (e && e.message) || '沒有成功，請再試一次' }); }
  }));
  if (bad.length) {
    msg.className = 'du-rq-msg bad';
    msg.textContent = groups.size === 1 ? '✕ ' + bad[0].message
      : '✕ ' + bad.map(b => (b.storeName ? b.storeName + '：' : '') + b.message + '（沒送出：' + b.names.join('、') + '）').join('\n') + (nDone ? '\n其餘已核准 ' + nDone + ' 筆' : '');
  } else {
    msg.textContent = (nSkip ? '已核准 ' + nDone + ' 筆，略過 ' + nSkip + ' 筆（已被處理過）' : '') + (skipNote ? (nSkip ? '\n' : '') + skipNote : '');
    if (nLock) { msg.className = 'du-rq-msg bad'; msg.textContent = '✕ ' + nLock + ' 筆沒有核准：那個月薪資已鎖定，請先到薪資頁解鎖' + (nDone ? '（其餘已核准 ' + nDone + ' 筆）' : '') + (msg.textContent ? '\n' + msg.textContent : ''); }
  }
}

// ---- 同一次送出（2026-11-18 一次填兩段）：兩張單框成一組 ----
// 打卡端把同仁一次送出的兩段拆成兩張普通的單、標同一個 group；這裡只是畫面上框在一起，每張仍各自核准、退回（按鈕與 buildItem 完全相同）。
// 「兩筆一起核准」＝沿用批次核准 mgr_req_decide_batch（runBatch，同一份程式、同樣的確認與略過規則）。
// 核定、預檢、薪資都不看 group。組內只剩一張還沒處理（另一張已核准或退回）→ 框、標題、按鈕消失，剩下那張照常；兩張一起核准完 → 框留著寫「已核准」。
function buildGroup(its, card, title) {
  const els = its.map(it => buildItem(it, card, title));
  const first = its[0], n = its.length;
  const wrap = h('div', 'du-rq-grp'); wrap.dataset.group = String(first.group || first.grp || '');
  const kindWord = first.kind === 'leave' && first.leave_type ? first.leave_type : (REQ_KIND_LABEL[first.kind] || first.kind);
  const hrs = groupHours(its);
  const head = h('div', 'du-rq-gh');
  head.append(h('span', 'du-rq-gt', first.name + ' ' + shortDate(first.date) + ' ' + kindWord + segWord(n) + (hrs !== null ? '・共 ' + hrs + ' 小時' : '')), h('small', null, '同一次送出'));
  const ev = punchEvidence(its.find(x => x.punches) || first);      // 打卡紀錄只列一次
  const evEl = ev ? h('div', 'du-rq-evid du-rq-grp-ev', ev) : null;
  const rows = h('div', 'du-rq-grp-rows');
  const reasons = [...new Set(its.map(x => x.reason).filter(Boolean))];      // 原因只列一次（兩張寫的不一樣才各列）
  const bal = compBalanceNote(leaveFor(first.store), first);
  const info = h('div', 'du-rq-l2 du-rq-grp-info', (reasons.length ? '原因：' + reasons.join('／') : '') + bal + ((reasons.length || bal) ? '\n' : '') + '送出：' + tsLabel(first.created_at));
  const gbtn = h('button', 'du-rq-gbtn btn', n === 2 ? '兩筆一起核准' : n + ' 筆一起核准', { type: 'button' });
  const gmsg = h('div', 'du-rq-msg du-rq-grp-msg'); gmsg.setAttribute('role', 'status');
  els.forEach((el, i) => {
    const p = el.__parts, it = its[i];
    p.nameEl.textContent = '第 ' + (Number(it.seg) >= 1 ? Number(it.seg) : i + 1) + ' 段 ' + (it.start && it.end ? it.start + '–' + it.end : it.summary);
    if (Number(it.hours) > 0) p.dateEl.textContent = Number(it.hours) + ' 小時';
    p.l2.hidden = true; if (p.evEl) p.evEl.hidden = true;
    if (p.ewEl && i > 0 && els[0].__parts.ewEl) p.ewEl.hidden = true;      // 「這天沒在本店打卡」兩張一樣，列一次
    el.classList.add('du-rq-in-grp'); el.__grp = () => wrap.__refresh();
    rows.append(el);
  });
  gbtn.onclick = async () => {
    const pend = els.filter(el => el.querySelector('.du-rq-ok'));
    await runBatch(pend, card, title, gmsg, on => { gbtn.disabled = on; });
    gbtn.disabled = false;
    if (!pend.some(el => el.querySelector('.du-rq-ok')) && !/✕|略過/.test(gmsg.textContent)) { gmsg.className = 'du-rq-msg du-rq-grp-msg ok'; gmsg.textContent = '核准後，那天的核定會先幫你填好，你核定那天時確認送出才算數。'; }
    refreshTitle(card, title); syncBatch(card);
  };
  wrap.__refresh = () => {
    if (card.__batching || wrap.__gone) return;
    const left = els.filter(el => el.querySelector('.du-rq-ok')).length;
    if (left >= 2) return;
    if (left === 0) { wrap.classList.add('done'); return; }      // 兩張都處理完（一起核准）：框留著給主管看結果
    wrap.__gone = true;      // 只剩一張：拆組，剩下那張照現在的樣子
    els.forEach(el => {
      const p = el.__parts;
      if (el.querySelector('.du-rq-ok')) { p.nameEl.textContent = p.name0; p.dateEl.textContent = p.date0; p.l2.hidden = false; if (p.evEl) p.evEl.hidden = false; if (p.ewEl) p.ewEl.hidden = false; }
      el.classList.remove('du-rq-in-grp'); el.__grp = null;
      wrap.before(el);
    });
    wrap.remove();
  };
  wrap.append(head, ...(evEl ? [evEl] : []), rows, info, gbtn, gmsg);
  return wrap;
}

// 本人自己送的申請（只看）：沒有勾選、核准、退回、看附件
function buildMine(it) {
  const el = h('div', 'du-rq du-rq-self'); el.dataset.reqId = String(it.id); if (it.store) el.dataset.store = it.store;
  const l1 = h('div', 'du-rq-l1'), who = h('span', 'du-rq-who');
  const proxied = it.upper_kind === 'director' || !!it.proxy_by;      // 主管替本人代開的（2026-11-10）：本人不能審，標出來
  who.append(h('span', 'du-rq-kind ' + (REQ_KIND_LABEL[it.kind] ? it.kind : ''), REQ_KIND_LABEL[it.kind] || it.kind), h('span', 'du-rq-name', it.name), ...(proxied ? [h('span', 'du-rq-kind upper', proxyLabel(it))] : []), ...(it.storeName ? [h('span', 'du-where', '打卡地點：' + it.storeName, { 'data-where': it.store })] : []));
  l1.append(who, h('span', 'du-rq-date', shortDate(it.date)));
  el.append(l1, h('div', 'du-rq-l2', it.summary + (it.reason ? '\n原因：' + it.reason : '') + '\n送出：' + tsLabel(it.created_at)));
  const acts = h('div', 'du-rq-acts du-rq-acts-self');
  const ok = h('button', 'du-rq-ok btn', '核准', { type: 'button' }), no = h('button', 'du-rq-no btn ghost', '退回', { type: 'button' });
  ok.disabled = no.disabled = true;
  acts.append(h('span', 'du-rq-upper', '等上一層主管審核'), ok, no);
  el.append(acts);
  return el;
}
// 打卡端 upper_kind（2026-10-29）：mgr＝值班主管本人；dept＝總部同仁在門市（申請照原身分）；home＝不算本店支援。舊打卡後端沒有這欄＝值班主管本人
function upperIsDept(it) { return it.upper_kind === 'dept' || it.upper_kind === 'home'; }
function upperLabel(it) { return it.upper_kind === 'director' || it.proxy_by ? proxyLabel(it) : upperIsDept(it) ? '支援同仁' : '值班主管本人'; }      // 2026-11-15：原寫「部門同仁」，11/4 起是所有支援的同仁
// 這天在別家打卡（伺服器 markElsewhere 附 elsewhere）：本店那天沒打卡、別家有 → 紅字提醒、核准前再確認（2026-11-15）
function elsewhereText(it) { return it && Array.isArray(it.elsewhere) && it.elsewhere.length ? it.name + ' 這天沒有在本店打卡，在' + it.elsewhere.map(x => x.store + '（' + x.punch + '）').join('、') + '打卡。這張可能送錯店，要送到打卡那家才對' : ''; }
// 代開標籤顯示代開人姓名（2026-11-14 Eason：不顯示職稱）：proxy_by 是「姓名（工號）」，只取姓名；舊資料沒有才退回「主管代開」
function proxyLabel(it) { const n = String(it.proxy_by || '').replace(/（[^（）]*）\s*$/, '').trim(); return (n || '主管') + '幫開'; }

// 核定工時卡片裡審申請（2026-11-14 考勤管理好上手第 2 項）：同一個元件，不放勾選（批次留在申請審核分頁），核准／退回完成後通知卡片
export function buildReqItem(it, onDone) { return buildItem(it, null, null, onDone); }
function buildItem(it, card, title, onDone) {
  const el = h('div', 'du-rq'); el.dataset.reqId = String(it.id); el.__req = it; if (it.store) el.dataset.store = it.store;
  const l1 = h('div', 'du-rq-l1'), who = h('span', 'du-rq-who');
  const isProxy = it.upper_kind === 'director' || !!it.proxy_by;      // 主管代開（2026-11-06）：只有總監層級能核，伺服器給 can_decide
  const canDecide = reqCanDecide(it);      // 不在名單（只看）：沒有勾選、核准、退回、看附件，改顯示「唯讀」；忘刷單看工時名單（2026-11-04）、代開看伺服器的 can_decide；跟分頁數字同一個判斷
  const upOn = it.upper === true && (it.kind !== 'miss' || isProxy);      // 忘刷單歸打卡店店長（2026-11-04），打卡端的「部門同仁／值班主管本人」標記不套用
  const pick = h('input', 'du-rq-pick', null, { type: 'checkbox', 'aria-label': '勾選 ' + it.name + ' ' + it.summary });
  pick.onchange = () => syncBatch(card);
  if (canDecide && card) who.append(pick);
  const sup = supportTag(it);      // 支援（原單位）
  const nameEl = h('span', 'du-rq-name', it.name), dateEl = h('span', 'du-rq-date', shortDate(it.date));
  who.append(h('span', 'du-rq-kind ' + (REQ_KIND_LABEL[it.kind] ? it.kind : ''), REQ_KIND_LABEL[it.kind] || it.kind), nameEl, ...(sup ? [sup] : []), ...(upOn && canDecide ? [h('span', 'du-rq-kind upper', upperLabel(it))] : []), ...(it.storeName ? [h('span', 'du-where', '打卡地點：' + it.storeName, { 'data-where': it.store })] : []));
  l1.append(who, dateEl);
  const l2 = h('div', 'du-rq-l2', it.summary + (it.reason ? '\n原因：' + it.reason : '') + compBalanceNote(leaveFor(it.store), it) + '\n送出：' + tsLabel(it.created_at));
  el.append(l1, l2);
  const ev = punchEvidence(it);
  const evEl = ev ? h('div', 'du-rq-evid', ev) : null;
  if (evEl) el.append(evEl);
  const ew = elsewhereText(it);
  const ewEl = ew ? h('div', 'du-rq-warn du-rq-else', '⚠ ' + ew) : null;
  if (ewEl) el.append(ewEl);
  el.__parts = { nameEl, dateEl, l2, evEl, ewEl, name0: nameEl.textContent, date0: dateEl.textContent };      // 同一次送出的組框要換掉其中幾行（見 buildGroup），拆組時還原
  const wl = reqWarnLines(it);                    // 事假前一天／出差前一週／本月事假第 3 次起／本月第 N 次忘刷（2026-11-06，提醒不擋）
  if (wl.length) el.append(h('div', 'du-rq-warn', wl.map(w => '⚠ ' + w).join('\n') + '（提醒，不影響核准）'));

  const acts = h('div', 'du-rq-acts');
  const ok = h('button', 'du-rq-ok btn', '核准', { type: 'button' }), no = h('button', 'du-rq-no btn ghost', '退回', { type: 'button' });
  const qBlock = canDecide ? reqQuotaBlock(leaveFor(it.store), it) : '';      // 生理假／家庭照顧假額度用完不能核准（2026-11-10 Eason）；事假不擋
  el.__quotaBlock = qBlock;
  if (qBlock) { ok.disabled = true; ok.title = qBlock; acts.append(h('span', 'du-rq-upper du-rq-quota', qBlock)); }
  if (canDecide) acts.append(ok, no); else acts.append(h('span', 'du-ro', upOn ? (isProxy ? '等總監審核' : upperIsDept(it) ? '原單位主管審核中' + (it.support_from ? '（' + it.support_from + '）' : '') : '等上一層主管審核') : '唯讀'));
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
    } else if (!await confirmBox((elsewhereText(it) ? '⚠ ' + elsewhereText(it) + '\n\n確定要在本店核准嗎？\n\n' : '') + '核准 ' + it.name + '：' + it.summary + '？\n核准後，那天的核定會先幫你填好，你核定那天時確認送出才算數。', '核准')) return;
    ok.disabled = no.disabled = true; say('', '送出中…');
    if (it.__mirror) body.bg = true;      // Mac mini 副本讀的清單：先顯示、背景送（2026-11-14），打卡端照樣檢查還是不是待審
    try {
      const r = await call('mgr_req_decide', body);
      if (r && r.queued) {
        say('', (decision === 'approve' ? '已核准' : '已退回') + '，正在背景送到打卡系統…');
        watchJob(r.job, (j) => {
          if (j.state === 'done') {
            const r2 = j.result || {};      // 那天已經核定過的提醒（r.warn）背景送出也要給主管看
            el.__markDone((decision === 'approve' ? '✓ 已核准：' : '✕ 已退回：') + it.name + ' ' + it.summary + (r2.warn ? '\n⚠ ' + (r2.message || '那天已經核定過，請重新核定一次') : ''));
            if (card) { refreshTitle(card, title); syncBatch(card); }
            if (decision === 'approve') delete S.dayCache[it.date];
            if (onDone) onDone(decision, r2);
          } else { ok.disabled = no.disabled = false; say('bad', '✕ 被退回：' + (j.msg || '打卡系統沒有接受，請重新整理再處理')); }
        });
        return;
      }
      // 那天已經核定過（Eason 2026-11-13 紅燈 a2 選 A）：照常核准，提醒重新核定一次，假別才會寫進薪資
      el.__markDone((decision === 'approve' ? '✓ 已核准：' : '✕ 已退回：') + it.name + ' ' + it.summary + (r && r.warn ? '\n⚠ ' + (r.message || '那天已經核定過，請重新核定一次') : ''));
      if (card) { refreshTitle(card, title); syncBatch(card); }
      if (decision === 'approve') delete S.dayCache[it.date];     // 那天的核定頁要重抓才看得到預填
      if (onDone) onDone(decision, r);
    } catch (e) { ok.disabled = no.disabled = false; say('bad', '✕ ' + (e.message || '沒有成功，請再試一次')); }
  }
  el.__say = say;                                 // 批次核准被擋（例：薪資鎖月）時把原因寫在這一筆上
  el.__markDone = text => { el.textContent = ''; el.classList.add('done'); el.append(h('div', 'du-rq-l2', text)); if (el.__grp) el.__grp(); };   // 單筆與批次共用；在組框裡的通知組框重算（只剩一張就拆組）
  ok.onclick = () => decide('approve'); no.onclick = () => decide('reject');
  return el;
}
