// 開單／編輯草稿。規則照原系統（~/mala-transfer/web 的開單頁、Code.gs 第 431–497 行 validateDoc_／validateItems_）：
// 單據資訊除備註全必填；品項名稱必填、單價與數量都要 > 0、類別一定要自己點（預設不選）。調出方＝登入的店，不能改。
// 後端的檢查才是真防線，這裡先擋一次讓同仁不用送出才知道漏什麼。
import { esc, busy } from '../../js/ui.js';
import { S, call, msgOf, shortOf, blankForm, blankItem, saveForm, getName, setName, refreshMem, todayISO } from './state.js';
import { subtotal, planTotal, money } from './calc.js';
import { openDoc } from './list.js';

function formState() { if (!S.form) S.form = blankForm(); return S.form; }

export async function renderForm(ctx) {
  const el = ctx.el;
  // 從「回去編輯」來的：把那張草稿載進表單
  if (S.editNo && (!S.form || S.form.editNo !== S.editNo)) {
    el.innerHTML = '<div class="card"><p class="hint" style="margin:0">讀取中…</p></div>';
    try {
      const d = await call('getDoc', { '單號': S.editNo }), x = d.doc;
      S.form = { editNo: S.editNo, to: x['調入方'], date: x['調撥日期'], eta: x['預計到貨日'], packer: x['打包人'], note: x['備註'],
        items: d.items.map(i => ({ name: i['品項名稱'], spec: i['規格'], unit: i['單位'], price: String(i['調撥單價']), qty: String(i['應撥數量']), cat: i['類別'] })) };
      saveForm();
    } catch (e) { S.editNo = ''; if (el.isConnected) el.innerHTML = `<div class="card"><div class="err" role="alert">${esc(msgOf(e))}</div></div>`; return; }
    if (!el.isConnected) return;
  }
  const F = formState();
  const others = S.nodes.filter(n => !S.me || n.name !== S.me.name);
  if (!F.to || !others.some(n => n.name === F.to)) F.to = '';
  const optHtml = ['<option value="">請選調入方</option>'].concat(others.map(n => `<option value="${esc(n.name)}"${n.name === F.to ? ' selected' : ''}>${esc(n.short)}</option>`)).join('');
  const editing = !!F.editNo;
  el.innerHTML = `<div class="card xf-form"><h2>${editing ? '編輯草稿　' + esc(F.editNo) : '開單'}</h2>
    ${editing ? '<p class="hint">調出方與調撥日期已鎖定（單號依這兩項產生）。</p>' : ''}
    <div class="grid2">
      <div class="fld"><label>調出方</label><input id="xfFrom" value="${esc(S.me ? S.me.short : '')}" readonly aria-readonly="true"></div>
      <div class="fld"><label for="xfTo">調入方<span class="req">＊</span></label><select id="xfTo">${optHtml}</select></div>
      <div class="fld"><label for="xfDate">調撥日期<span class="req">＊</span></label><input id="xfDate" type="date" ${editing ? 'disabled' : ''}></div>
      <div class="fld"><label for="xfEta">預計到貨日<span class="req">＊</span></label><input id="xfEta" type="date"></div>
      <div class="fld"><label for="xfPacker">打包人<span class="req">＊</span></label><input id="xfPacker" maxlength="20" placeholder="打包的人名字" autocomplete="off"></div>
      <div class="fld"><label for="xfNote">備註（選填）</label><input id="xfNote" maxlength="200" autocomplete="off"></div>
    </div></div>
    <div id="xfItems"></div>
    <div class="row xf-addrow"><button class="btn ghost" id="xfAdd" type="button">＋ 加一個品項</button></div>
    <div class="card xf-totalbar"><span>應撥總額</span><b id="xfTotal">0</b><span class="hint">元</span></div>
    <div id="xfMsg" class="err" role="alert"></div>
    <div class="row xf-actions">${editing ? '<button class="btn ghost" id="xfCancelEdit" type="button">放棄編輯</button>' : '<button class="btn ghost" id="xfClear" type="button">清空重填</button>'}<button class="btn" id="xfSave" type="button">${editing ? '更新草稿' : '存草稿'}</button></div>`;
  const $ = id => el.querySelector('#' + id);
  $('xfDate').value = F.date; $('xfEta').value = F.eta; $('xfPacker').value = F.packer || getName(); $('xfNote').value = F.note;
  const msg = (t, ok) => { const m = $('xfMsg'); m.textContent = t || ''; m.className = ok ? 'okmsg' : 'err'; };

  // 單據欄位 ↔ 表單狀態
  [['xfTo', 'to'], ['xfDate', 'date'], ['xfEta', 'eta'], ['xfPacker', 'packer'], ['xfNote', 'note']].forEach(([id, k]) => {
    $(id).addEventListener('input', () => { F[k] = $(id).value; $(id).classList.remove('bad'); if (k === 'packer') setName($(id).value.trim()); saveForm(); });
    $(id).addEventListener('change', () => { F[k] = $(id).value; saveForm(); });
  });

  // 品項卡
  const box = $('xfItems');
  function total() { const t = planTotal(F.items); $('xfTotal').textContent = money(t); }
  function drawItems() {
    box.innerHTML = '';
    F.items.forEach((it, idx) => box.appendChild(itemCard(it, idx)));
    total();
  }
  function itemCard(it, idx) {
    const d = document.createElement('div'); d.className = 'card xf-item'; d.dataset.idx = idx;
    d.innerHTML = `<button class="xf-del" type="button" aria-label="刪除第 ${idx + 1} 個品項">✕</button>
      <div class="fld xf-nmwrap"><label>品項名稱<span class="req">＊</span></label><input class="nm" autocomplete="off" placeholder="打字會帶出用過的品項"><div class="xf-cands"></div></div>
      <div class="fld"><label>類別<span class="req">＊</span></label><div class="xf-cats">${S.cats.map(c => `<button type="button" data-v="${esc(c)}">${esc(c)}</button>`).join('')}</div></div>
      <div class="grid2"><div class="fld"><label>規格（選填）</label><input class="sp" placeholder="500g"></div><div class="fld"><label>單位（選填）</label><input class="un" placeholder="包"></div>
      <div class="fld"><label>調撥單價<span class="req">＊</span></label><input class="pr" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="必填"></div>
      <div class="fld"><label>應撥數量<span class="req">＊</span></label><input class="qt" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="必填"></div></div>
      <div class="xf-why"></div><div class="xf-subline">小計 <b class="st">0</b></div>`;
    const q = c => d.querySelector(c);
    q('.nm').value = it.name; q('.sp').value = it.spec; q('.un').value = it.unit; q('.pr').value = it.price; q('.qt').value = it.qty;
    const setCat = v => { it.cat = v || ''; d.querySelectorAll('.xf-cats button').forEach(b => { b.classList.toggle('on', b.dataset.v === it.cat); b.setAttribute('aria-pressed', String(b.dataset.v === it.cat)); }); };
    setCat(it.cat);
    d.querySelectorAll('.xf-cats button').forEach(b => { b.onclick = () => { setCat(b.dataset.v); d.querySelector('.xf-cats').classList.remove('bad'); saveForm(); }; });
    const upd = () => { q('.st').textContent = money(subtotal(it.price, it.qty)); total(); };
    [['.nm', 'name'], ['.sp', 'spec'], ['.un', 'unit'], ['.pr', 'price'], ['.qt', 'qty']].forEach(([sel, k]) => q(sel).addEventListener('input', () => { it[k] = q(sel).value; q(sel).classList.remove('bad'); upd(); saveForm(); }));
    q('.xf-del').onclick = () => { F.items.splice(idx, 1); if (!F.items.length) F.items.push(blankItem()); saveForm(); drawItems(); };
    // 品項記憶：前綴比對、最多 8 筆、使用次數多的在前（S.mem 已排序）
    const cands = q('.xf-cands'), hide = () => cands.classList.remove('on');
    q('.nm').addEventListener('input', () => {
      const kw = q('.nm').value.trim().toLowerCase();
      const hits = kw ? S.mem.filter(m => m.name.toLowerCase().indexOf(kw) === 0).slice(0, 8) : [];
      if (!hits.length) return hide();
      cands.innerHTML = hits.map((h, i) => `<div data-i="${i}" role="button" tabindex="0">${esc(h.name)}<span>${[h.spec, h.unit, h.price != null ? '$' + h.price : ''].filter(Boolean).map(esc).join(' · ')}</span></div>`).join('');
      cands.querySelectorAll('div').forEach((c, i) => {
        c.onmousedown = e => e.preventDefault();         // 別讓輸入框先失焦把清單收掉
        c.onclick = () => {
          const h = hits[i];
          it.name = h.name; it.spec = h.spec || ''; it.unit = h.unit || ''; if (!String(q('.pr').value)) it.price = h.price != null ? String(h.price) : '';
          q('.nm').value = it.name; q('.sp').value = it.spec; q('.un').value = it.unit; q('.pr').value = it.price;
          setCat(S.cats.includes(h.cat) ? h.cat : '');          // 記憶有存類別才帶出來；沒有就維持不選，不替同仁猜
          hide(); upd(); saveForm();
        };
      });
      cands.classList.add('on');
    });
    q('.nm').addEventListener('blur', () => setTimeout(hide, 180));
    q('.st').textContent = money(subtotal(it.price, it.qty));
    return d;
  }
  drawItems();
  $('xfAdd').onclick = () => { F.items.push(blankItem()); saveForm(); drawItems(); const l = box.lastElementChild; if (l) l.querySelector('.nm').focus(); };
  const clearBad = () => { el.querySelectorAll('.bad').forEach(e => e.classList.remove('bad')); el.querySelectorAll('.xf-why').forEach(e => { e.className = 'xf-why'; e.textContent = ''; }); };

  function validate() {
    clearBad();
    const miss = [];
    [['xfTo', '調入方'], ['xfDate', '調撥日期'], ['xfEta', '預計到貨日'], ['xfPacker', '打包人']].forEach(([id, label]) => { if (!$(id).value.trim()) { $(id).classList.add('bad'); miss.push(label); } });
    if ($('xfDate').value && $('xfEta').value && $('xfEta').value < $('xfDate').value) { $('xfEta').classList.add('bad'); miss.push('預計到貨日不可早於調撥日期'); }
    box.querySelectorAll('.xf-item').forEach((d, i) => {
      const it = F.items[i], probs = [];
      if (!it.name.trim()) { d.querySelector('.nm').classList.add('bad'); probs.push('品項名稱要填'); }
      if (!(Number(it.price) > 0)) { d.querySelector('.pr').classList.add('bad'); probs.push('單價要填，且大於 0'); }
      if (!(Number(it.qty) > 0)) { d.querySelector('.qt').classList.add('bad'); probs.push('數量要填，且大於 0'); }
      if (!it.cat) { d.querySelector('.xf-cats').classList.add('bad'); probs.push('類別要選一個'); }
      if (!probs.length) return;
      const w = d.querySelector('.xf-why'); w.textContent = probs.join('　·　'); w.className = 'xf-why on'; miss.push('第 ' + (i + 1) + ' 個品項');
    });
    if (!miss.length) return true;
    msg('還有沒填完的：' + miss.join('、') + '。紅框的欄位補一下就可以存了。');
    const first = el.querySelector('.bad'); if (first) { first.scrollIntoView({ block: 'center' }); }
    return false;
  }

  $('xfSave').onclick = () => busy($('xfSave'), async () => {
    msg('');
    if (!validate()) return;
    const packer = $('xfPacker').value.trim(); setName(packer);
    const body = { doc: { '調入方': F.to, '調撥日期': F.date, '預計到貨日': F.eta, '打包人': packer, '備註': F.note.trim() },
      items: F.items.map(i => ({ '品項名稱': i.name.trim(), '規格': i.spec.trim(), '單位': i.unit.trim(), '類別': i.cat, '調撥單價': Number(i.price), '應撥數量': Number(i.qty) })), '操作人': packer };
    if (editing) body['單號'] = F.editNo;
    let res;
    try { res = await call(editing ? 'updateDraft' : 'createDraft', body); }
    catch (e) { if (el.isConnected) msg(msgOf(e)); return; }       // 失敗：填的東西都還在，改好再按
    const no = res['單號'];
    await refreshMem();
    S.form = null; S.editNo = ''; saveForm();
    if (!el.isConnected) return;
    renderForm(ctx).then(() => {
      if (!el.isConnected) return;
      const m = el.querySelector('#xfMsg'); m.className = 'okmsg';
      m.innerHTML = `${editing ? '已更新草稿' : '已存成草稿'}　<b id="xfSavedNo">${esc(no)}</b>　<a href="#" id="xfOpenSaved">看這張單（可確認出貨）</a>`;
      m.querySelector('#xfOpenSaved').onclick = ev => { ev.preventDefault(); openDoc(ctx, no, 'new').catch(e2 => { m.className = 'err'; m.textContent = msgOf(e2); }); };
    });
  });
  const reset = () => { S.form = null; S.editNo = ''; saveForm(); renderForm(ctx); };
  if ($('xfClear')) $('xfClear').onclick = reset;
  if ($('xfCancelEdit')) $('xfCancelEdit').onclick = reset;
}
