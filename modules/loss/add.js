// 登記分頁：品名自動完成（品項記憶）、金額即時自算、送出、下方「今天這幾筆」可作廢。流程照原系統登記頁（~/mala-store-ops/spike/live/mzt-loss.html 第 905–1087 行）。
import { esc } from '../../js/ui.js';
import { S, call, findItem, msgOf } from './state.js';
import { amountOf, makeRecord, money, ymd, summarize, newId } from './calc.js';

// 這一次送出的紀錄（含固定的 id）。內容沒變就沿用同一個 id——逾時後重按送出，後端靠 id 擋掉重複，絕不會記成兩筆；內容一改就換新的。
function pendingFor(key) {
  if (!S.pending || S.pending.key !== key) S.pending = { key, id: newId(), at: new Date() };
  return S.pending;
}

export function renderAdd(ctx) {
  const el = ctx.el;
  if (!S.day) S.day = ymd(new Date());
  const D = S.draft || (S.draft = { name: '', cat: '', unit: '', cost: '', qty: '', reason: '', note: '', memo: '' });
  const opts = (list, ph, val) => `<option value=""${val ? '' : ' selected'} disabled>${ph}</option>` + list.map(v => `<option value="${esc(v)}"${v === val ? ' selected' : ''}>${esc(v)}</option>`).join('');
  el.innerHTML = `<div class="card ls-card">
    <p class="hint" id="lsWho">登記到：${esc(S.storeLabel)}${S.mode === 'mzt' ? '（墨竹亭四店共用品項表）' : ''}</p>
    <div id="lsOk" class="okmsg" role="status" hidden></div>
    <div id="lsErr" class="err" role="alert"></div>
    <form id="lsForm" autocomplete="off" novalidate>
      <div class="fld"><label for="lsDate">日期</label><input id="lsDate" type="date" required></div>
      <div class="fld ls-acwrap"><label for="lsName">品名</label><input id="lsName" type="text" maxlength="60" placeholder="輸入品名，會自動帶出成本表的品項" autocomplete="off"><ul id="lsAc" class="ls-ac" hidden></ul></div>
      <div class="ls-two"><div class="fld"><label for="lsCat">品類</label><select id="lsCat">${opts(S.categories, '選品類', D.cat)}</select></div>
        <div class="fld"><label for="lsUnit">單位</label><input id="lsUnit" type="text" readonly placeholder="—"></div></div>
      <div class="ls-two"><div class="fld"><label for="lsQty">耗損量</label><input id="lsQty" type="number" step="0.01" min="0" inputmode="decimal" placeholder="0"></div>
        <div class="fld"><label for="lsCost">單位成本</label><input id="lsCost" type="number" step="0.01" min="0" inputmode="decimal" readonly placeholder="—"></div></div>
      <div class="hint warn" id="lsNewHint" hidden>這是成本表沒有的新品項：請補上單位與單位成本，送出後會自動加進成本設定。</div>
      <div class="ls-amount"><span>金額</span><b id="lsAmount">$0</b></div>
      <div class="fld"><label for="lsReason">原因</label><select id="lsReason">${opts(S.reasons, '選原因', D.reason)}</select></div>
      <div class="fld" id="lsNoteWrap" hidden><label for="lsNote">原因說明</label><input id="lsNote" type="text" maxlength="100" placeholder="請簡短說明"></div>
      <div class="fld"><label for="lsMemo">備註（選填）</label><input id="lsMemo" type="text" maxlength="200"></div>
      <button class="btn wide mt" id="lsSubmit" type="submit">送出登記</button>
    </form></div>
    <div class="card ls-card"><div class="ls-head"><h2 id="lsTodayTitle">今天這幾筆</h2><b id="lsTodaySum">$0</b></div>
      <div id="lsListErr" class="err" role="alert"></div>
      <ul id="lsToday" class="ls-list"></ul><p id="lsTodayEmpty" class="hint" hidden></p></div>`;
  const $ = id => el.querySelector('#' + id);
  let picked = null, newMode = false;

  const showMsg = (id, t) => { const e = $(id); if (!e) return; e.textContent = t || ''; if (id === 'lsOk') e.hidden = !t; };
  const calcAmount = () => { const q = Number($('lsQty').value), c = Number($('lsCost').value); $('lsAmount').textContent = money(q > 0 && c > 0 ? amountOf(q, c) : 0); };
  function setNewMode(on) {
    newMode = on;
    $('lsUnit').readOnly = !on; $('lsCost').readOnly = !on;
    $('lsUnit').placeholder = on ? '包' : '—'; $('lsCost').placeholder = on ? '單價' : '—';
    $('lsNewHint').hidden = !on;
  }
  function applyItem(it) {
    picked = it; setNewMode(false);
    $('lsCat').value = it.品類; $('lsUnit').value = it.單位; $('lsCost').value = it.單位成本;
    D.cat = it.品類; D.unit = it.單位; D.cost = it.單位成本; calcAmount();
  }
  function clearPicked() { picked = null; $('lsUnit').value = ''; $('lsCost').value = ''; D.unit = ''; D.cost = ''; calcAmount(); }
  const closeAc = () => { $('lsAc').hidden = true; $('lsAc').innerHTML = ''; };
  const reasonSync = () => { const other = $('lsReason').value === '其他'; $('lsNoteWrap').hidden = !other; };

  // 還原草稿（切分頁回來）
  $('lsDate').value = S.day; $('lsName').value = D.name; $('lsQty').value = D.qty; $('lsNote').value = D.note; $('lsMemo').value = D.memo;
  const it0 = findItem(D.name);
  if (it0 && !it0.停用) { picked = it0; $('lsUnit').value = it0.單位; $('lsCost').value = it0.單位成本; }
  else if (D.name && D.unit) { setNewMode(true); $('lsUnit').value = D.unit; $('lsCost').value = D.cost; }
  reasonSync(); calcAmount();

  $('lsName').oninput = function () {
    const q = this.value.trim(); D.name = this.value;
    const exact = findItem(q);
    if (exact && !exact.停用) applyItem(exact); else clearPicked();
    if (!q) { closeAc(); setNewMode(false); return; }
    const hits = S.items.filter(i => !i.停用 && i.品名.indexOf(q) >= 0).slice(0, 8);   // 停用品項不進提示
    setNewMode(!exact && hits.length === 0);
    if (!hits.length) return closeAc();
    const ul = $('lsAc');
    ul.innerHTML = hits.map(i => `<li data-name="${esc(i.品名)}"><span>${esc(i.品名)}</span><small>${esc(i.品類)} · ${money(i.單位成本)}/${esc(i.單位)}</small></li>`).join('');
    ul.hidden = false;
  };
  $('lsAc').onmousedown = e => {
    const li = e.target.closest('li'); if (!li) return;
    e.preventDefault();
    const it = findItem(li.dataset.name); if (!it) return;
    $('lsName').value = it.品名; D.name = it.品名; applyItem(it); closeAc(); $('lsQty').focus();
  };
  $('lsName').onblur = () => setTimeout(closeAc, 150);
  $('lsQty').oninput = () => { D.qty = $('lsQty').value; calcAmount(); };
  $('lsCost').oninput = () => { D.cost = $('lsCost').value; calcAmount(); };
  $('lsUnit').oninput = () => { D.unit = $('lsUnit').value; };
  $('lsCat').onchange = () => { D.cat = $('lsCat').value; };
  $('lsReason').onchange = () => { D.reason = $('lsReason').value; reasonSync(); };
  $('lsNote').oninput = () => { D.note = $('lsNote').value; };
  $('lsMemo').oninput = () => { D.memo = $('lsMemo').value; };

  // ---- 今天這幾筆 ----
  let seq = 0;
  async function loadDay() {
    const mine = ++seq, day = S.day;
    showMsg('lsListErr', '');
    let rows;
    try { rows = (await call('listLoss', { from: day, to: day })).records || []; }
    catch (e) { if (mine === seq && el.isConnected) showMsg('lsListErr', '讀不到這一天的紀錄：' + msgOf(e)); return; }
    if (mine !== seq || !el.isConnected) return;
    rows.sort((a, b) => (a.建立時間 < b.建立時間 ? 1 : -1));
    const todayStr = ymd(new Date());
    $('lsTodayTitle').textContent = day === todayStr ? '今天這幾筆' : day.slice(5).replace('-', '/') + ' 這幾筆';
    $('lsTodaySum').textContent = money(summarize(rows, day, day).總金額);
    $('lsToday').innerHTML = rows.map(r => `<li class="ls-rec${r.作廢 ? ' is-void' : ''}" data-id="${esc(r.id)}"><div class="rec-main"><div class="rec-name">${esc(r.品名)}${r.作廢 ? ' <span class="tag">已作廢</span>' : ''}</div>
      <div class="rec-sub">${esc(r.耗損量)} ${esc(r.單位)} · ${esc(r.原因)}${r.原因說明 ? '（' + esc(r.原因說明) + '）' : ''}</div></div><div class="rec-amt">${money(r.金額)}</div>
      ${r.作廢 ? '' : '<button class="btn ghost sm ls-void" type="button" data-id="' + esc(r.id) + '">作廢</button>'}</li>`).join('');
    const empty = $('lsTodayEmpty'); empty.hidden = rows.length > 0; empty.textContent = day === todayStr ? '今天還沒有登記。' : '這一天沒有紀錄。';
  }
  $('lsDate').onchange = () => { S.day = $('lsDate').value || ymd(new Date()); loadDay(); };
  // 兩段式點按取代 confirm()：LINE 等內嵌瀏覽器的原生對話框不可靠
  $('lsToday').onclick = async e => {
    const b = e.target.closest('.ls-void'); if (!b || b.disabled) return;
    if (!b.classList.contains('armed')) {
      b.classList.add('armed'); b.textContent = '確定作廢？';
      setTimeout(() => { if (b.isConnected) { b.classList.remove('armed'); b.textContent = '作廢'; } }, 6000);
      return;
    }
    b.disabled = true; showMsg('lsListErr', '');
    try { await call('voidLoss', { id: b.dataset.id }); showMsg('lsOk', '已作廢'); await loadDay(); }
    catch (er) { b.disabled = false; showMsg('lsListErr', msgOf(er)); }
  };

  // ---- 送出 ----
  $('lsForm').onsubmit = async e => {
    e.preventDefault();
    const btn = $('lsSubmit'); if (btn.disabled) return;
    showMsg('lsErr', ''); showMsg('lsOk', '');
    const name = $('lsName').value.trim(), qty = Number($('lsQty').value), cat = $('lsCat').value, reason = $('lsReason').value;
    if (!$('lsDate').value) return showMsg('lsErr', '請選日期');
    if (!name) return showMsg('lsErr', '請填品名');
    if (!(qty > 0)) return showMsg('lsErr', '耗損量要大於 0');
    if (!cat) return showMsg('lsErr', '請選品類');
    if (!reason) return showMsg('lsErr', '請選原因');
    if (reason === '其他' && !$('lsNote').value.trim()) return showMsg('lsErr', '原因選「其他」要寫簡短說明');
    let item = findItem(name), fresh = null;
    if (!item) {
      const unit = $('lsUnit').value.trim(), cost = Number($('lsCost').value);
      if (!unit || !(cost > 0)) { setNewMode(true); return showMsg('lsErr', '新品項要補單位與單位成本'); }
      fresh = { 品名: name, 品類: cat, 單位: unit, 單位成本: cost, 停用: false };
    } else if (item.停用) return showMsg('lsErr', '這個品項已停用，請先到成本設定啟用');
    const input = { 日期: $('lsDate').value, 品類: cat, 耗損量: qty, 原因: reason, 原因說明: $('lsNote').value.trim(), 備註: $('lsMemo').value.trim() };
    const p = pendingFor(JSON.stringify([input, name, fresh && [fresh.單位, fresh.單位成本]]));
    btn.disabled = true; const old = btn.textContent; btn.textContent = '送出中';
    try {
      if (fresh) { const d = await call('saveItem', { item: fresh }); S.items = d.items || S.items; item = findItem(name) || fresh; }
      const rec = makeRecord(Object.assign({ id: p.id }, input), item, p.at);
      const res = await call('addLoss', { records: [rec] });
      // 重複（duplicated）通常是「上一次其實已經記進去了」（逾時重按，同一個 id），算成功；但 id 是全域唯一鍵，撞到別店的 id 時
      // 這筆其實沒存。所以回 duplicated 時要到本店當天的紀錄確認那個 id 真的在，不在就不能顯示「已登記」。
      if (res && Array.isArray(res.duplicated) && res.duplicated.includes(rec.id)) {
        const mine = ((await call('listLoss', { from: rec.日期, to: rec.日期 })).records || []);
        if (!mine.some(r => r.id === rec.id)) { S.pending = null; throw Object.assign(new Error('編號衝突，這筆沒有存進去。請按「送出登記」再送一次（會換新編號）。'), { code: 'ID_CLASH' }); }
      }
      S.pending = null;
      Object.assign(D, { name: '', cat: '', unit: '', cost: '', qty: '', reason: '', note: '', memo: '' });
      if (!el.isConnected) return;
      $('lsName').value = ''; $('lsQty').value = ''; $('lsMemo').value = ''; $('lsNote').value = ''; $('lsCat').selectedIndex = 0; $('lsReason').selectedIndex = 0;
      clearPicked(); setNewMode(false); reasonSync(); closeAc();
      showMsg('lsOk', `已登記 ${rec.品名}　${money(rec.金額)}` + (fresh ? '（已加進成本設定）' : ''));
      $('lsName').focus();
      await loadDay();
    } catch (er) { if (el.isConnected) showMsg('lsErr', msgOf(er)); }
    finally { if (el.isConnected) { btn.disabled = false; btn.textContent = old; } }
  };

  loadDay();
}
