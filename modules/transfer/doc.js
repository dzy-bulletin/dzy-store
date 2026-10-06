// 單據詳情：狀態列、品項（簽收／修改時逐列填實收、差異自動算＝實收−應撥）、出貨、簽收、修改、刪除、異動紀錄。
// 誰能做什麼（原系統 Code.gs 在後端把關，這裡只是不顯示按了會失敗的鈕）：
//   編輯草稿／出貨／刪除＝調出方（act_ship_ 第 933 行、act_deleteDoc_ 第 1179 行）；簽收＝調入方（act_receive_ 第 1007 行）；
//   修改（amend）＝雙方、只限已出貨（act_amend_ 第 1080 行：已簽收即鎖定）；已簽收的單刪除要會計處理，門市不能刪。
import { esc, busy, confirmBox } from '../../js/ui.js';
import { S, call, msgOf, shortOf, reasonName, STIDX, getName, setName, refreshMem } from './state.js';
import { money, diffQty, recvTotals, round2 } from './calc.js';

const timeOf = v => (v ? String(v).slice(5, 16).replace('T', ' ') : '');
const m2 = v => (v === '' || v === null || v === undefined ? '—' : money(Number(v)));

export function renderDoc(ctx) {
  const el = ctx.el, D = S.doc, d = D.doc, items = D.items, logs = D.logs;
  const st = String(d['狀態']), stIdx = STIDX[st] || 0, mineName = S.me ? S.me.name : '';
  const isOut = mineName === d['調出方'], isIn = mineName === d['調入方'];
  const canShip = st === '草稿' && isOut, canEdit = st === '草稿' && isOut, canRecv = st === '已出貨' && isIn;
  const canAmend = st === '已出貨' && (isOut || isIn), canDelete = isOut && st !== '已刪除' && st !== '已簽收';
  const editing = S.mode === 'receive' || S.mode === 'amend';
  const progIdx = st === '已刪除' ? (d['簽收時間'] ? 2 : d['出貨時間'] ? 1 : 0) : stIdx;   // 已刪除的單：進度條照刪除前走到哪裡畫
  const step = (i, label, ts) => `<div class="${progIdx >= i ? 'done' : ''}">${label}<b>${esc(timeOf(ts))}</b></div>`;

  const reasonOpts = S.reasons.map(r => `<option value="${esc(r.code)}">${esc(r.name)}</option>`).join('');
  const rows = items.map(it => {
    const plan = Number(it['應撥數量']) || 0, got = it['實收數量'], idx = String(it['列序']);
    const diff = got === '' || got === null ? null : round2(Number(got) - plan);
    let body = `<div class="xf-qty">應撥 <b>${plan}</b> ${esc(it['單位'])}`;
    if (diff !== null) { body += `　實收 <b>${esc(got)}</b>`; if (diff !== 0) body += `　<span class="xf-gap">${diff > 0 ? '+' + diff : diff}　${esc(reasonName(it['差異原因代碼']))}</span>`; }
    body += '</div>';
    let edit = '';
    if (editing) edit = `<div class="xf-rowin"><div class="fld"><label>實際簽收數量</label><input class="rq" data-idx="${idx}" type="number" inputmode="decimal" min="0" step="0.01" value="${got === '' || got === null ? '' : esc(got)}"></div>
      <div class="fld xf-rwrap" data-idx="${idx}" hidden><label>差異原因</label><select class="rr" data-idx="${idx}"><option value="">請選原因</option>${reasonOpts}<option value="OTHER">其他（自己打）</option></select></div></div>
      <div class="xf-diffline" data-idx="${idx}"></div>
      <div class="fld xf-rc" data-idx="${idx}" hidden><input class="rx" data-idx="${idx}" maxlength="20" placeholder="原因限 20 字，例：司機少搬一箱"></div>`;
    return `<div class="xf-line" data-idx="${idx}"><div class="t"><b>${esc(it['品項名稱'])}</b><i>${esc([it['類別'] || '食材', it['規格']].filter(Boolean).join(' · '))}</i><em>$${esc(Number(it['調撥單價']).toLocaleString('zh-TW'))} · 小計 ${money(Number(it['小計']))}</em></div>${body}${edit}</div>`;
  }).join('');

  const b = [];
  if (!editing) {
    if (canShip) b.push('<button class="btn ghost" id="xfEdit" type="button">回去編輯</button>', '<button class="btn" id="xfShip" type="button">確認出貨</button>');
    if (canRecv) b.push('<button class="btn" id="xfRecv" type="button">簽收這批貨</button>');
    if (!canRecv && canAmend) b.push('<button class="btn ghost" id="xfAmend" type="button">修改</button>');
    if (canDelete) b.push('<button class="btn ghost danger" id="xfDel" type="button">刪除</button>');
  }
  const needName = editing || b.length;
  el.innerHTML = `<div class="xf-dochead"><button class="btn ghost sm" id="xfBack" type="button">‹ 返回</button><div class="xf-docno" id="xfDocNo">${esc(d['單號'])}</div><span class="xf-pill s${stIdx}" id="xfStatus">${esc(st)}</span></div>
    <div class="card"><div class="xf-flow">${esc(shortOf(d['調出方']))} <span>→</span> ${esc(shortOf(d['調入方']))}</div>
      <div class="xf-steps">${step(0, '草稿', d['建立時間'])}${step(1, '已出貨', d['出貨時間'])}${step(2, '已簽收', d['簽收時間'])}</div>
      <dl class="xf-kv"><dt>調撥日期</dt><dd>${esc(d['調撥日期'])}</dd><dt>預計到貨</dt><dd>${esc(d['預計到貨日'])}</dd>
        <dt>打包人</dt><dd>${esc(d['打包人']) || '—'}</dd><dt>簽收人</dt><dd>${esc(d['簽收人']) || '—'}</dd>${d['備註'] ? `<dt>備註</dt><dd>${esc(d['備註'])}</dd>` : ''}
        <dt>應撥總額</dt><dd><b id="xfPlanTotal">${m2(d['應撥總額'])}</b></dd>
        ${d['實收總額'] !== '' ? `<dt>實收總額</dt><dd id="xfRecvTotal">${m2(d['實收總額'])}</dd><dt>差異金額</dt><dd id="xfDiffTotal" class="${Number(d['差異總額']) ? 'xf-gap' : ''}">${m2(d['差異總額'])}</dd>` : ''}</dl></div>
    <div class="card"><h2>品項 ${items.length} 項</h2>${rows}${editing ? `<div class="xf-previewbar" id="xfPreview">實收總額 <b id="xfPvRecv">—</b>　差異總額 <b id="xfPvDiff">—</b></div>` : ''}</div>
    ${needName ? `<div class="card xf-namecard"><div class="fld"><label for="xfName">${S.mode === 'receive' ? '簽收人' : '操作人'}姓名<span class="req">＊</span>（記在異動紀錄）</label><input id="xfName" maxlength="20" autocomplete="off" value="${esc(getName())}"></div></div>` : ''}
    <div id="xfDocMsg" class="err" role="alert"></div>
    ${editing ? `<div class="row xf-actions"><button class="btn ghost" id="xfCancel" type="button">取消</button><button class="btn" id="xfSubmit" type="button">${S.mode === 'receive' ? '確認簽收' : '儲存修改'}</button></div>`
      : b.length ? `<div class="row xf-actions">${b.join('')}</div>` : ''}
    ${st === '已簽收' && isOut ? '<p class="hint" id="xfSignedNote">這張單已簽收，不能修改；如果要刪除，請洽會計處理。</p>' : ''}
    <div class="card"><h2>異動紀錄</h2><div class="xf-logs">${logs.length ? logs.map(l => `<div>${esc(timeOf(l['時間']))}　<b>${esc(l['動作'])}</b>${l['欄位'] ? '　' + esc(l['欄位']) + '：' + esc(l['原值']) + ' → ' + esc(l['新值']) : ''}　${esc(l['操作人'])}</div>`).join('') : '<div>還沒有異動</div>'}</div></div>`;
  const $ = id => el.querySelector('#' + id);
  const msg = (t, ok) => { const m = $('xfDocMsg'); if (m) { m.textContent = t || ''; m.className = ok ? 'okmsg' : 'err'; } };
  const nameInput = $('xfName');
  if (nameInput) nameInput.addEventListener('input', () => setName(nameInput.value.trim()));
  $('xfBack').onclick = () => { S.docNo = ''; S.doc = null; S.mode = ''; ctx.rerender(); };

  async function reload(no) { S.doc = await call('getDoc', { '單號': no }); S.mode = ''; await refreshMem(); if (el.isConnected) ctx.rerender(); }
  const who = () => { const n = (nameInput ? nameInput.value : getName()).trim(); if (!n) { msg(S.mode === 'receive' ? '請填簽收人姓名。' : '請填操作人姓名，紀錄要記是誰做的。'); if (nameInput) nameInput.focus(); return ''; } return n; };
  // 需要姓名但畫面沒有姓名欄（草稿的「確認出貨」按鈕列有姓名欄；刪除也有）——都在上面 needName 內
  const run = (btn, fn) => busy(btn, async () => { msg(''); try { await fn(); } catch (e) { if (el.isConnected) msg(msgOf(e)); } });

  if ($('xfEdit')) $('xfEdit').onclick = () => { S.editNo = d['單號']; S.form = null; S.docNo = ''; S.doc = null; location.hash = '#/transfer/new'; };
  if ($('xfShip')) $('xfShip').onclick = () => run($('xfShip'), async () => { const n = who(); if (!n) return; setName(n); await call('ship', { '單號': d['單號'], '操作人': n }); await reload(d['單號']); });
  if ($('xfRecv')) $('xfRecv').onclick = () => { S.mode = 'receive'; ctx.rerender(); };
  if ($('xfAmend')) $('xfAmend').onclick = () => { S.mode = 'amend'; ctx.rerender(); };
  if ($('xfDel')) $('xfDel').onclick = async () => {
    const n = who(); if (!n) return;
    if (!(await confirmBox(`確定刪除 ${d['單號']}？\n\n單據不會消失：會標成「已刪除」留在紀錄裡，查單找得到，但月報不再計入。`, '刪除'))) return;
    await run($('xfDel'), async () => { setName(n); await call('deleteDoc', { '單號': d['單號'], '操作人': n }); await reload(d['單號']); });
  };
  if (!editing) return;

  // ---- 簽收／修改：逐列實收、差異即時算、有差異才出現原因 ----
  const lineOf = idx => items.find(i => String(i['列序']) === idx);
  const readLines = () => [...el.querySelectorAll('.rq')].map(inp => {
    const idx = inp.dataset.idx, sel = el.querySelector(`.rr[data-idx="${idx}"]`), cus = el.querySelector(`.rx[data-idx="${idx}"]`);
    return { idx, recv: inp.value, code: sel ? sel.value : '', custom: cus ? cus.value : '' };
  });
  function preview() {
    const ls = readLines().map(l => { const it = lineOf(l.idx); return { sub: it['小計'], price: it['調撥單價'], recv: l.recv }; });
    const t = recvTotals(ls);
    $('xfPvRecv').textContent = t.recv === null ? '—' : money(t.recv); $('xfPvDiff').textContent = t.diff === null ? '—' : money(t.diff);
    $('xfPvDiff').className = t.diff ? 'xf-gap' : '';
  }
  function sync(idx) {
    const it = lineOf(idx), inp = el.querySelector(`.rq[data-idx="${idx}"]`), sel = el.querySelector(`.rr[data-idx="${idx}"]`);
    const diff = diffQty(inp.value, it['應撥數量']);
    const line = el.querySelector(`.xf-diffline[data-idx="${idx}"]`);
    line.textContent = diff === null ? '' : diff === 0 ? '數量相符' : `差異 ${diff > 0 ? '+' + diff : diff}（實收 − 應撥）`;
    line.className = 'xf-diffline' + (diff ? ' xf-gap' : '');
    el.querySelector(`.xf-rwrap[data-idx="${idx}"]`).hidden = !diff;
    el.querySelector(`.xf-rc[data-idx="${idx}"]`).hidden = !(diff && sel.value === 'OTHER');
    preview();
  }
  el.querySelectorAll('.rq').forEach(inp => {
    const idx = inp.dataset.idx, it = lineOf(idx), sel = el.querySelector(`.rr[data-idx="${idx}"]`);
    sel.value = it['差異原因代碼'] || '';
    inp.addEventListener('input', () => { inp.classList.remove('bad'); sync(idx); });
    sel.addEventListener('change', () => { sel.classList.remove('bad'); sync(idx); });
    sync(idx);
  });
  $('xfCancel').onclick = () => { S.mode = ''; ctx.rerender(); };
  $('xfSubmit').onclick = () => run($('xfSubmit'), async () => {
    const n = who(); if (!n) return;
    const ls = readLines();
    if (S.mode === 'receive') {                                       // 逐列都要填實收；有差異必選原因（後端也會擋，這裡先擋讓紅框好找）
      el.querySelectorAll('.bad').forEach(e => e.classList.remove('bad'));
      for (const l of ls) {
        const it = lineOf(l.idx), inp = el.querySelector(`.rq[data-idx="${l.idx}"]`);
        if (l.recv === '' || !(Number(l.recv) >= 0)) { inp.classList.add('bad'); inp.focus(); return msg(`第 ${l.idx} 列（${it['品項名稱']}）：請填實際簽收數量（0 以上）。`); }
        if (diffQty(l.recv, it['應撥數量']) && !l.code) { el.querySelector(`.rr[data-idx="${l.idx}"]`).classList.add('bad'); return msg(`第 ${l.idx} 列（${it['品項名稱']}）：數量和應撥不一樣，必須選一個差異原因。`); }
        if (diffQty(l.recv, it['應撥數量']) && l.code === 'OTHER' && !l.custom.trim()) { el.querySelector(`.rx[data-idx="${l.idx}"]`).classList.add('bad'); return msg(`第 ${l.idx} 列（${it['品項名稱']}）：選了「其他」就要填原因。`); }
      }
      setName(n);
      await call('receive', { '單號': d['單號'], '簽收人': n, lines: ls.map(l => ({ '列序': l.idx, '實收數量': l.recv, '差異原因代碼': diffQty(l.recv, lineOf(l.idx)['應撥數量']) ? l.code : '', '自訂原因': l.code === 'OTHER' ? l.custom.trim() : '' })) });
      return reload(d['單號']);
    }
    const changes = [];                                                // 修改：只送真的有改的欄位（照原系統 transfer.html 的 amend）
    ls.forEach(l => {
      const it = lineOf(l.idx), oldQ = it['實收數量'] === '' || it['實收數量'] === null ? '' : String(it['實收數量']);
      if (l.recv !== '' && l.recv !== oldQ) changes.push({ path: `明細#${l.idx}.實收數量`, value: l.recv });
      const oldR = it['差異原因代碼'] || '';
      if (l.code !== oldR) changes.push({ path: `明細#${l.idx}.差異原因代碼`, value: l.code, custom: l.code === 'OTHER' ? l.custom.trim() : '' });
    });
    if (!changes.length) return msg('沒有改到任何東西。');
    setName(n);
    await call('amend', { '單號': d['單號'], '操作人': n, changes });
    return reload(d['單號']);
  });
}
