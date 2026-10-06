// 明細分頁：看、改、作廢。沒有刪除鍵——送出後的每一筆都留在帳上（2026-09-08 Eason 指示：刪除一律留痕）。
// 作廢的筆灰掉、劃線、標「已作廢」，不列入合計，但它還在。清單是分隔線列表，點該列才展開操作鍵（一頁看得到 6～7 筆）。
import { esc } from '../../js/ui.js';
import { money } from './calc.js';
import { S, call, isLocked, monthOf, loadMonth, subjectsOf, msgOf } from './state.js';
import { runBusy } from './busy.js';
import { summaryHtml } from './entry.js';

export const readMsg = e => (e.code === 'TIMEOUT' || e.code === 'NETWORK') ? '讀取這個月的資料時網路沒有回應，請確認連線後再試一次。' : msgOf(e);

function editForm(r) {
  const opts = subjectsOf(r.kind).map(s => `<option value="${esc(s)}"${s === r.subject ? ' selected' : ''}>${esc(s)}</option>`).join('');
  return `<div class="cb-actions col">
    <div class="fld"><label>日期</label><input type="date" data-f="date" value="${esc(r.date)}"></div>
    <div class="fld"><label>科目</label><select data-f="subject">${opts}</select></div>
    <div class="fld"><label>項目名稱</label><input type="text" data-f="name" value="${esc(r.name)}"></div>
    <div class="fld"><label>金額</label><input type="number" data-f="amount" inputmode="numeric" value="${esc(r.amount)}"></div>
    <div class="fld"><label>單據</label><select data-f="hasInvoice"><option value="0"${r.hasInvoice ? '' : ' selected'}>收據／無發票</option><option value="1"${r.hasInvoice ? ' selected' : ''}>統一發票</option></select></div>
    <div class="row"><button class="btn sm" type="button" data-act="save" data-id="${esc(r.id)}" data-busy="儲存中">儲存修改</button><button class="btn ghost sm" type="button" data-act="cancel">取消</button></div>
  </div>`;
}

function rowHtml(r, locked) {
  const voided = r.status === '作廢';
  const open = (S.openId === r.id || S.editingId === r.id) && !voided && !locked;
  const meta = `${r.subject}　#${r.seq}${r.hasInvoice ? `　發票（稅 ${r.tax}）` : '　收據'}${r.photo ? '　📎' : ''}`;
  const actions = !open ? '' : S.editingId === r.id ? editForm(r)
    : `<div class="cb-actions"><button class="btn ghost sm" type="button" data-act="edit" data-id="${esc(r.id)}">修改</button><button class="btn ghost sm" type="button" data-act="void" data-id="${esc(r.id)}">作廢</button></div>`;
  return `<li class="cb-item ${r.kind === '收入' ? 'income' : 'expense'}${voided ? ' voided' : ''}${open ? ' open' : ''}" data-id="${esc(r.id)}">
    <span class="d">${esc(r.date.slice(5))}</span>
    <span class="b"><span class="n">${esc(r.name)}</span><span class="m">${voided ? '<span class="cb-void">已作廢</span>　' : ''}${esc(meta)}${r.voidReason ? `<br>作廢原因：${esc(r.voidReason)}` : ''}</span></span>
    <span class="a">${r.kind === '收入' ? '+' : '−'}${Number(r.amount).toLocaleString('en-US')}${voided || locked ? '' : '<i class="chev">▾</i>'}</span>
    ${actions}</li>`;
}

// 作廢確認＋原因（可不填）
function askVoid() {
  return new Promise(resolve => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal" role="dialog" id="cbVoidBox"><p><b>作廢這一筆？</b></p><p class="hint">作廢不是刪除：這筆會留在帳上並標記為已作廢，只是不再計入合計。</p>
      <div class="fld"><label for="cbVoidReason">作廢原因（可以不填）</label><input id="cbVoidReason" type="text" maxlength="200"></div>
      <div class="row mt"><button class="btn" type="button" data-ok>確定作廢</button><button class="btn ghost" type="button" data-no>取消</button></div></div>`;
    document.body.appendChild(bg);
    const done = v => { bg.remove(); resolve(v); };
    bg.querySelector('[data-ok]').onclick = () => done(bg.querySelector('#cbVoidReason').value.trim());
    bg.querySelector('[data-no]').onclick = () => done(null);
  });
}

export function renderList(ctx) {
  const el = ctx.el;
  el.innerHTML = `${summaryHtml(S.rows, S.month)}
    <div class="card cb-card"><div class="fld"><label for="cbMonth">月份</label><input id="cbMonth" type="month"></div>
      <div id="cbListLock" class="note warn" hidden>這個月已結帳鎖定，只能看不能改。</div>
      <div id="cbListErr" class="err" role="alert"></div></div>
    <ul class="cb-list" id="cbList"></ul><div class="hint" id="cbEmpty" hidden>這個月還沒有任何紀錄</div>`;
  const $ = id => el.querySelector('#' + id);
  $('cbMonth').value = S.month;
  const err = t => { const e = $('cbListErr'); if (e) e.textContent = t || ''; };

  function draw() {
    const rows = S.rows.slice().sort((a, b) => a.date !== b.date ? (a.date < b.date ? 1 : -1) : ((b.createdAt || '') < (a.createdAt || '') ? -1 : 1));   // 最新的在上面
    const locked = isLocked(S.month);
    $('cbListLock').hidden = !locked;
    $('cbList').innerHTML = rows.map(r => rowHtml(r, locked)).join('');
    $('cbEmpty').hidden = rows.length > 0;
    el.querySelector('#cbSum').outerHTML = summaryHtml(S.rows, S.month);
  }
  draw();

  function replaceRow(row) {
    const i = S.rows.findIndex(r => r.id === row.id);
    if (monthOf(row.date) !== S.month) { if (i >= 0) S.rows.splice(i, 1); }   // 日期改到別月：不再屬於這個月的清單
    else if (i >= 0) S.rows[i] = row; else S.rows.push(row);
  }

  $('cbMonth').onchange = async () => {
    const m = $('cbMonth').value;
    if (!/^\d{4}-\d{2}$/.test(m)) return;
    err('');
    try { await loadMonth(m); } catch (e) { if (el.isConnected) { err(readMsg(e)); $('cbMonth').value = S.month; } return; }
    if (el.isConnected) draw();
  };

  $('cbList').onclick = async e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) {   // 點在列的空白處＝展開／收合這一列
      const li = e.target.closest('.cb-item');
      if (!li || li.classList.contains('voided') || e.target.closest('.cb-actions')) return;
      S.openId = S.openId === li.dataset.id ? null : li.dataset.id; S.editingId = null; err(''); draw(); return;
    }
    const act = btn.dataset.act;
    if (act === 'edit') { S.editingId = btn.dataset.id; S.openId = btn.dataset.id; draw(); return; }
    if (act === 'cancel') { S.editingId = null; draw(); return; }
    err('');
    if (act === 'void') {
      const reason = await askVoid();
      if (reason === null) return;
      try { const res = await call('void', { id: btn.dataset.id, reason }); replaceRow(res.row); S.openId = null; }
      catch (er) { if (el.isConnected) err(msgOf(er)); return; }
      if (el.isConnected) draw();
    } else if (act === 'save') {
      const li = btn.closest('.cb-item'), patch = {};
      li.querySelectorAll('[data-f]').forEach(inp => {
        const f = inp.dataset.f;
        if (f === 'amount') patch.amount = Number(inp.value); else if (f === 'hasInvoice') patch.hasInvoice = inp.value === '1'; else patch[f] = inp.value;
      });
      if (!(patch.amount > 0) || !String(patch.name || '').trim()) return err('項目名稱要填，金額要大於 0。');
      await runBusy(btn, async () => {
        const res = await call('update', Object.assign({ id: btn.dataset.id }, patch));
        replaceRow(res.row); S.editingId = null; S.openId = null;
        if (el.isConnected) draw();
      }, { label: '儲存中', doneText: '已儲存 ✓', onError: m => { if (el.isConnected) err(m); } });
    }
  };
}
