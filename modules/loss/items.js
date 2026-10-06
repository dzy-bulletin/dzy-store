// 成本設定分頁（＝品項維護）：新增、搜尋、改成本、停用。照原系統成本設定頁（~/mala-store-ops/spike/live/mzt-loss.html 第 1088–1172 行）。
// 改單價只影響之後的登記——歷史紀錄的單位成本與金額是登記當下的快照，永不重算。
import { esc } from '../../js/ui.js';
import { S, call, findItem, msgOf } from './state.js';
import { money } from './calc.js';

export function renderItems(ctx) {
  const el = ctx.el;
  const shared = S.mode === 'mzt' ? '成本表墨竹亭四家店共用一份，改單價會全部一起生效。' : '成本表是同品牌各店共用一份，改單價會全部一起生效。';
  el.innerHTML = `<div class="card ls-card"><p class="hint" id="lsShared">${shared}</p>
    <form id="lsItemForm" autocomplete="off" novalidate><h2 id="lsItemTitle">新增品項</h2>
      <div id="lsItemOk" class="okmsg" role="status" hidden></div><div id="lsItemErr" class="err" role="alert"></div>
      <div class="fld"><label for="lsIName">品名</label><input id="lsIName" type="text" maxlength="60"></div>
      <div class="ls-two"><div class="fld"><label for="lsICat">品類</label><select id="lsICat"><option value="" disabled selected>選品類</option>${S.categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select></div>
        <div class="fld"><label for="lsIUnit">單位</label><input id="lsIUnit" type="text" placeholder="包" maxlength="20"></div></div>
      <div class="fld"><label for="lsICost">單位成本（元）</label><input id="lsICost" type="number" step="0.01" min="0" inputmode="decimal"></div>
      <div class="row"><button class="btn" type="submit" id="lsISave">儲存品項</button><button class="btn ghost" type="button" id="lsICancel" hidden>取消編輯</button></div>
    </form></div>
    <div class="fld ls-card"><input type="search" id="lsSearch" placeholder="搜尋品名或品類"></div>
    <div id="lsListErr2" class="err" role="alert"></div>
    <ul class="ls-list ls-card" id="lsItems"></ul><p class="hint" id="lsItemsEmpty" hidden>成本表還是空的，先新增第一個品項。</p>`;
  const $ = id => el.querySelector('#' + id);
  const say = (id, t) => { const e = $(id); e.textContent = t || ''; if (id === 'lsItemOk') e.hidden = !t; };

  function resetForm() {
    S.editingName = null; $('lsItemTitle').textContent = '新增品項'; $('lsISave').textContent = '儲存品項'; $('lsICancel').hidden = true;
    $('lsIName').value = ''; $('lsIUnit').value = ''; $('lsICost').value = ''; $('lsICat').selectedIndex = 0;
  }
  function draw() {
    const q = $('lsSearch').value.trim();
    const rows = S.items.filter(i => !q || i.品名.indexOf(q) >= 0 || i.品類.indexOf(q) >= 0)
      .sort((a, b) => (a.品類 === b.品類 ? (a.品名 > b.品名 ? 1 : -1) : (a.品類 > b.品類 ? 1 : -1)));
    $('lsItems').innerHTML = rows.map(i => `<li class="ls-rec${i.停用 ? ' is-off' : ''}" data-name="${esc(i.品名)}"><div class="rec-main"><div class="rec-name">${esc(i.品名)}${i.停用 ? ' <span class="tag">已停用</span>' : ''}</div>
      <div class="rec-sub"><span class="tag">${esc(i.品類)}</span> ${money(i.單位成本)} / ${esc(i.單位)}</div></div>
      <button class="btn ghost sm" type="button" data-act="edit" data-name="${esc(i.品名)}">修改</button>
      <button class="btn ghost sm" type="button" data-act="toggle" data-name="${esc(i.品名)}">${i.停用 ? '啟用' : '停用'}</button></li>`).join('');
    $('lsItemsEmpty').hidden = rows.length > 0 || !!q;
  }

  $('lsICancel').onclick = () => { resetForm(); say('lsItemErr', ''); };
  $('lsSearch').oninput = draw;
  $('lsItemForm').onsubmit = async e => {
    e.preventDefault();
    const btn = $('lsISave'); if (btn.disabled) return;
    say('lsItemErr', ''); say('lsItemOk', '');
    const name = $('lsIName').value.trim(), cat = $('lsICat').value, unit = $('lsIUnit').value.trim(), cost = Number($('lsICost').value);
    if (!name || !unit || !(cost > 0) || !cat) return say('lsItemErr', '每一欄都要填，單位成本要大於 0');
    const dup = findItem(name);
    if (dup && dup.品名 !== S.editingName) return say('lsItemErr', `「${name}」已經在成本表裡了`);
    const item = { 品名: name, 品類: cat, 單位: unit, 單位成本: cost, 停用: false };
    if (S.editingName) { const old = findItem(S.editingName); item.停用 = !!(old && old.停用); item.舊品名 = S.editingName; }
    btn.disabled = true;
    try {
      const d = await call('saveItem', { item });
      S.items = d.items || S.items;
      say('lsItemOk', S.editingName ? '已更新（舊紀錄金額不變）' : `已新增 ${name}`);
      resetForm(); draw();
    } catch (er) { say('lsItemErr', msgOf(er)); }
    finally { btn.disabled = false; }
  };
  $('lsItems').onclick = async e => {
    const b = e.target.closest('button[data-act]'); if (!b || b.disabled) return;
    const it = findItem(b.dataset.name); if (!it) return;
    if (b.dataset.act === 'edit') {
      S.editingName = it.品名; $('lsItemTitle').textContent = '修改品項'; $('lsISave').textContent = '儲存修改'; $('lsICancel').hidden = false;
      $('lsIName').value = it.品名; $('lsICat').value = it.品類; $('lsIUnit').value = it.單位; $('lsICost').value = it.單位成本;
      say('lsItemErr', ''); say('lsItemOk', ''); window.scrollTo(0, 0); return;
    }
    b.disabled = true; say('lsListErr2', '');
    try {
      const d = await call('saveItem', { item: { 品名: it.品名, 品類: it.品類, 單位: it.單位, 單位成本: it.單位成本, 停用: !it.停用 } });
      S.items = d.items || S.items; draw();
    } catch (er) { b.disabled = false; say('lsListErr2', msgOf(er)); }
  };
  resetForm(); draw();
}
